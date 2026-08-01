import { useCallback, useEffect, useRef, useState } from "react";

// Same STUN-only, no-TURN tradeoff as useCall.js — see that file for why.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const GROUP_CALL_EVENT_TYPES = new Set([
  "group_call_invite", "group_call_roster", "group_call_participant_joined",
  "group_call_participant_left", "group_call_offer", "group_call_answer", "group_call_ice",
  "call_error",
]);

/**
 * A mesh group call: every participant holds one RTCPeerConnection per OTHER
 * participant, connected directly to each of them — there is no media
 * server in the middle. That is the right shape for a handful of people and
 * the wrong shape for a large group (bandwidth and CPU both scale with the
 * square of the participant count); an SFU is the real answer past that,
 * and is a separate project on the scale of this whole app, not something
 * this pass includes. Restricted server-side to `type: "group"` chats.
 *
 * The join rule that keeps offer/answer from racing: whoever ARRIVES second
 * always initiates the connection to whoever was already there. A brand new
 * joiner gets the current roster and opens one connection to each name on
 * it; everyone already in the room just waits for that incoming offer
 * instead of also trying to connect outward — one initiator per pair, never
 * both sides at once.
 */
export function useGroupCall(events, send, toast) {
  const [call, setCall] = useState(null);
  // call = null | {
  //   phase: "incoming" | "active",
  //   chatId, callKind, muted, cameraOff,
  //   inviterName, inviterAvatar, inviterColor,  // only set during "incoming"
  //   localStream,
  //   participants: { [userId]: { name, avatar, color, stream } },
  // }

  const callRef = useRef(null);
  callRef.current = call;

  const peersRef = useRef({});               // userId -> RTCPeerConnection
  const localStreamRef = useRef(null);
  const pendingCandidatesRef = useRef({});   // userId -> [candidate, ...] queued pre-remoteDescription
  const lastApplied = useRef(0);

  const sendRef = useRef(send);
  sendRef.current = send;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const teardown = useCallback(() => {
    Object.values(peersRef.current).forEach((pc) => pc.close());
    peersRef.current = {};
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    pendingCandidatesRef.current = {};
  }, []);

  useEffect(() => teardown, [teardown]);

  const buildPeerConnection = useCallback((chatId, peerId) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendRef.current({ type: "group_call_ice", chat_id: chatId, to: peerId, candidate: event.candidate });
      }
    };
    pc.ontrack = (event) => {
      setCall((current) => (current ? {
        ...current,
        participants: {
          ...current.participants,
          [peerId]: { ...current.participants[peerId], stream: event.streams[0] },
        },
      } : current));
    };
    return pc;
  }, []);

  const addParticipant = useCallback((userId, info) => {
    setCall((current) => (current ? {
      ...current,
      participants: { ...current.participants, [userId]: { ...current.participants[userId], ...info } },
    } : current));
  }, []);

  const connectOutward = useCallback(async (chatId, participant) => {
    const pc = buildPeerConnection(chatId, participant.user_id);
    peersRef.current[participant.user_id] = pc;
    localStreamRef.current?.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
    addParticipant(participant.user_id, {
      name: participant.name, avatar: participant.avatar_letter, color: participant.color, stream: null,
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendRef.current({ type: "group_call_offer", chat_id: chatId, to: participant.user_id, sdp: offer });
  }, [buildPeerConnection, addParticipant]);

  // ── Local actions ────────────────────────────────────────────────────────

  const join = useCallback(async (chatId, callKind) => {
    if (callRef.current?.phase === "active") {
      toastRef.current?.("You're already in a call");
      return;
    }
    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true, video: callKind === "video",
      });
    } catch (problem) {
      toastRef.current?.(problem.name === "NotAllowedError"
        ? "Camera/microphone permission was denied"
        : "No camera or microphone is available");
      setCall(null); // clears a pending "incoming" ring if accepting just failed
      return;
    }
    localStreamRef.current = localStream;

    setCall((current) => ({
      phase: "active", chatId, callKind, muted: false, cameraOff: false,
      localStream, participants: current?.participants || {},
    }));

    sendRef.current({ type: "group_call_start", chat_id: chatId, call_kind: callKind });
  }, []);

  const declineIncoming = useCallback(() => {
    // Group calls have no per-invitee "declined" signal the way a 1:1 call
    // does — simply never joining IS declining, nothing to tell the room.
    setCall(null);
  }, []);

  const leave = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    if (current.phase === "active") {
      sendRef.current({ type: "group_call_leave", chat_id: current.chatId });
    }
    teardown();
    setCall(null);
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const current = callRef.current;
    if (!current?.localStream) return;
    const nowMuted = !current.muted;
    current.localStream.getAudioTracks().forEach((track) => { track.enabled = !nowMuted; });
    setCall((c) => (c ? { ...c, muted: nowMuted } : c));
  }, []);

  const toggleCamera = useCallback(() => {
    const current = callRef.current;
    if (!current?.localStream) return;
    const nowOff = !current.cameraOff;
    current.localStream.getVideoTracks().forEach((track) => { track.enabled = !nowOff; });
    setCall((c) => (c ? { ...c, cameraOff: nowOff } : c));
  }, []);

  // Same replaceTrack idea as useCall.js's version, but across every peer in
  // the mesh at once — one screen-capture track, swapped onto each
  // connection's existing video sender. Same scope limit: needs an existing
  // video track already flowing, since adding a fresh one to a voice-only
  // call is a renegotiation this pass doesn't do.
  const shareScreen = useCallback(async () => {
    const current = callRef.current;
    const peers = Object.values(peersRef.current);
    if (!current?.localStream || peers.length === 0) return;
    const senders = peers
      .map((pc) => pc.getSenders().find((s) => s.track?.kind === "video"))
      .filter(Boolean);
    if (senders.length === 0) {
      toastRef.current?.("Turn your camera on first to share your screen");
      return;
    }
    let screenStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return;
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    const cameraTrack = current.localStream.getVideoTracks()[0];
    await Promise.all(senders.map((sender) => sender.replaceTrack(screenTrack)));
    setCall((c) => (c ? { ...c, sharingScreen: true } : c));

    screenTrack.onended = async () => {
      if (cameraTrack) {
        await Promise.all(senders.map((sender) => sender.replaceTrack(cameraTrack).catch(() => {})));
      }
      setCall((c) => (c ? { ...c, sharingScreen: false } : c));
    };
  }, []);

  // ── Remote events ────────────────────────────────────────────────────────

  useEffect(() => {
    const fresh = events.filter((event) =>
      event._n > lastApplied.current && GROUP_CALL_EVENT_TYPES.has(event.type));
    if (fresh.length === 0) return;
    lastApplied.current = events[events.length - 1]._n;

    (async () => {
      for (const event of fresh) {
        const current = callRef.current;

        if (event.type === "group_call_invite") {
          if (current) continue; // already on a call somewhere — miss this one silently
          setCall({
            phase: "incoming", chatId: event.chat_id, callKind: event.call_kind,
            inviterName: event.name, inviterAvatar: event.avatar_letter, inviterColor: event.color,
            localStream: null, participants: {},
          });
          continue;
        }

        if (!current || event.chat_id !== current.chatId) continue;

        if (event.type === "call_error") {
          // The optimistic "active" state join() sets before the server has
          // actually confirmed the room join needs undoing here — most
          // commonly because calling_permitted() rejected it server-side.
          toastRef.current?.(event.reason || "Could not join the call");
          teardown();
          setCall(null);
        } else if (event.type === "group_call_roster") {
          for (const participant of event.participants) {
            await connectOutward(event.chat_id, participant);
          }
        } else if (event.type === "group_call_participant_joined") {
          addParticipant(event.user_id, {
            name: event.name, avatar: event.avatar_letter, color: event.color, stream: null,
          });
        } else if (event.type === "group_call_participant_left") {
          peersRef.current[event.user_id]?.close();
          delete peersRef.current[event.user_id];
          delete pendingCandidatesRef.current[event.user_id];
          setCall((c) => {
            if (!c) return c;
            const participants = { ...c.participants };
            delete participants[event.user_id];
            return { ...c, participants };
          });
        } else if (event.type === "group_call_offer") {
          let pc = peersRef.current[event.from];
          if (!pc) {
            pc = buildPeerConnection(event.chat_id, event.from);
            peersRef.current[event.from] = pc;
            localStreamRef.current?.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
          }
          await pc.setRemoteDescription(event.sdp);
          for (const candidate of pendingCandidatesRef.current[event.from] || []) {
            await pc.addIceCandidate(candidate).catch(() => {});
          }
          pendingCandidatesRef.current[event.from] = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendRef.current({ type: "group_call_answer", chat_id: event.chat_id, to: event.from, sdp: answer });
        } else if (event.type === "group_call_answer") {
          const pc = peersRef.current[event.from];
          if (!pc) continue;
          await pc.setRemoteDescription(event.sdp);
          for (const candidate of pendingCandidatesRef.current[event.from] || []) {
            await pc.addIceCandidate(candidate).catch(() => {});
          }
          pendingCandidatesRef.current[event.from] = [];
        } else if (event.type === "group_call_ice") {
          const pc = peersRef.current[event.from];
          if (pc?.remoteDescription) {
            pc.addIceCandidate(event.candidate).catch(() => {});
          } else {
            pendingCandidatesRef.current[event.from] =
              [...(pendingCandidatesRef.current[event.from] || []), event.candidate];
          }
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, buildPeerConnection, connectOutward, addParticipant]);

  return { call, join, declineIncoming, leave, toggleMute, toggleCamera, shareScreen };
}
