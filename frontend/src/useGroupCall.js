import { useCallback, useEffect, useRef, useState } from "react";

// Same STUN-only, no-TURN tradeoff as useCall.js — see that file for why.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const GROUP_CALL_EVENT_TYPES = new Set([
  "group_call_invite", "group_call_roster", "group_call_participant_joined",
  "group_call_participant_left", "group_call_offer", "group_call_answer", "group_call_ice",
  "group_call_host_changed", "group_call_force_muted", "group_call_kicked", "group_call_ended",
  "call_error", "whiteboard_open", "whiteboard_close",
  "group_call_reaction", "group_call_raise_hand", "group_call_lower_hand",
  "group_call_caption", "breakout_rooms_created", "breakout_rooms_closed",
  "group_call_waiting", "group_call_admitted", "group_call_join_denied", "group_call_join_request",
]);

let reactionKeyCounter = 0; // a plain module counter, not Date.now()/Math.random() — this file has no such restriction, but a counter is simpler and collision-free either way
const MAX_CAPTION_LINES = 3;

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
  const screenTrackRef = useRef(null);       // active getDisplayMedia video track, while sharing
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

  const join = useCallback(async (chatId, callKind, password) => {
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

    // Optimistically "active" — a waiting-room-gated room downgrades this
    // to "waiting" the moment the server's group_call_waiting reply lands,
    // same idea as call_error undoing an optimistic join that turns out to
    // be rejected for some other reason.
    setCall((current) => ({
      phase: "active", chatId, callKind, muted: false, cameraOff: false,
      localStream, participants: current?.participants || {},
    }));

    sendRef.current({ type: "group_call_start", chat_id: chatId, call_kind: callKind, password });
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

  const toggleCamera = useCallback(async () => {
    const current = callRef.current;
    if (!current?.localStream) return;

    const existingTrack = current.localStream.getVideoTracks()[0];
    if (existingTrack) {
      const nowOff = !current.cameraOff;
      existingTrack.enabled = !nowOff;
      setCall((c) => (c ? { ...c, cameraOff: nowOff } : c));
      return;
    }

    // No video track yet — this call started voice-only. Renegotiate with
    // EVERY peer in the mesh (each is its own RTCPeerConnection), reusing
    // the existing group_call_offer/answer relay — the receiving handler
    // already reuses an existing connection when one's there rather than
    // assuming every offer is a brand new peer, so no server or receiving-
    // side change was needed for this to work.
    let videoStream;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (problem) {
      toastRef.current?.(problem.name === "NotAllowedError"
        ? "Camera permission was denied" : "No camera is available");
      return;
    }
    const videoTrack = videoStream.getVideoTracks()[0];
    current.localStream.addTrack(videoTrack);
    await Promise.all(Object.entries(peersRef.current).map(async ([peerId, pc]) => {
      pc.addTrack(videoTrack, current.localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendRef.current({ type: "group_call_offer", chat_id: current.chatId, to: peerId, sdp: offer });
    }));
    setCall((c) => (c ? { ...c, callKind: "video", cameraOff: false } : c));
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
    // "motion" is the right default for most screen shares (video playback,
    // scrolling) — the encoder favors frame rate over per-frame sharpness.
    // "detail" trades that back for a slide deck or a code editor, where a
    // crisp static frame matters more than smoothness.
    screenTrack.contentHint = "motion";
    screenTrackRef.current = screenTrack;
    await Promise.all(senders.map((sender) => sender.replaceTrack(screenTrack)));
    setCall((c) => (c ? { ...c, sharingScreen: true, screenOptimizeFor: "motion" } : c));

    screenTrack.onended = async () => {
      screenTrackRef.current = null;
      if (cameraTrack) {
        await Promise.all(senders.map((sender) => sender.replaceTrack(cameraTrack).catch(() => {})));
      }
      setCall((c) => (c ? { ...c, sharingScreen: false, screenOptimizeFor: null } : c));
    };
  }, []);

  // Mirrors Teams' "optimize for video/text" screen-share toggle via the real
  // MediaStreamTrack.contentHint API — a hint the encoder is free to use, not
  // a guarantee, but it's the actual platform mechanism for this trade-off.
  const setScreenOptimization = useCallback((mode) => {
    const track = screenTrackRef.current;
    if (!track) return;
    track.contentHint = mode;
    setCall((c) => (c ? { ...c, screenOptimizeFor: mode } : c));
  }, []);

  // Host-only actions — the server independently checks the sender really
  // is this room's host before honoring any of these, so a stale/wrong
  // isHost on the client can only ever fail closed, never act on someone
  // else's behalf.
  const forceMuteAll = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_force_mute_all", chat_id: current.chatId });
  }, []);

  const kickParticipant = useCallback((userId) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_kick", chat_id: current.chatId, target: userId });
  }, []);

  const addPeople = useCallback((userIds) => {
    const current = callRef.current;
    if (!current || userIds.length === 0) return;
    sendRef.current({
      type: "group_call_add_people", chat_id: current.chatId,
      call_kind: current.callKind, targets: userIds,
    });
  }, []);

  const admitParticipant = useCallback((userId) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_admit", chat_id: current.chatId, target: userId });
    setCall((c) => (c ? { ...c, joinRequests: (c.joinRequests || []).filter((r) => r.user_id !== userId) } : c));
  }, []);

  const denyParticipant = useCallback((userId) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_deny", chat_id: current.chatId, target: userId });
    setCall((c) => (c ? { ...c, joinRequests: (c.joinRequests || []).filter((r) => r.user_id !== userId) } : c));
  }, []);

  // Open/close is shared state (broadcast so it appears on everyone's
  // screen, not just whoever tapped it) — the strokes themselves are NOT
  // routed through here at all. Every draw point would mean a re-render of
  // this whole hook's state on every pixel of mouse movement; the
  // Whiteboard component instead reads the same raw `events` array directly
  // and paints straight onto its canvas, bypassing React state for that hot
  // path entirely.
  const toggleWhiteboard = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    const next = !current.whiteboardOpen;
    setCall((c) => (c ? { ...c, whiteboardOpen: next } : c));
    sendRef.current({ type: next ? "whiteboard_open" : "whiteboard_close", chat_id: current.chatId });
  }, []);

  // A reaction is a fire-and-forget animation, not a fact about the call —
  // it isn't stored anywhere; `lastReaction` just changes value each time so
  // a UI effect watching it knows to play the next one, even the same emoji
  // sent twice in a row.
  const sendReaction = useCallback((emoji) => {
    const current = callRef.current;
    if (!current) return;
    reactionKeyCounter += 1;
    setCall((c) => (c ? { ...c, lastReaction: { emoji, from: "me", key: reactionKeyCounter } } : c));
    sendRef.current({ type: "group_call_reaction", chat_id: current.chatId, emoji });
  }, []);

  const toggleRaiseHand = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    const next = !current.handRaised;
    setCall((c) => (c ? { ...c, handRaised: next } : c));
    sendRef.current({ type: next ? "group_call_raise_hand" : "group_call_lower_hand", chat_id: current.chatId });
  }, []);

  // Purely a local viewing preference — whether YOU see captions and whether
  // YOUR OWN speech gets transcribed and broadcast. Not synced to anyone
  // else's screen the way whiteboard open/close is, since captions-on is
  // "do I want subtitles," not a fact about the meeting.
  const toggleCaptions = useCallback(() => {
    setCall((c) => (c ? { ...c, captionsOn: !c.captionsOn, captions: c.captionsOn ? c.captions : [] } : c));
  }, []);

  // Called by whatever's running local speech recognition (see
  // GroupCallOverlay's LiveCaptions) once it has a recognized line — echoes
  // it into your own caption log immediately rather than waiting on a round
  // trip through the server first.
  const sendCaption = useCallback((text) => {
    const current = callRef.current;
    if (!current || !text.trim()) return;
    setCall((c) => (c ? {
      ...c, captions: [...(c.captions || []), { from: "me", text, key: `${Date.now()}-me` }].slice(-MAX_CAPTION_LINES),
    } : c));
    sendRef.current({ type: "group_call_caption", chat_id: current.chatId, text });
  }, []);

  // A breakout room is an ordinary group call in an ordinary group chat —
  // moving into one is just leaving whatever call you're on and joining
  // that chat's, the same as tapping any other chat's call button. The only
  // thing special is remembering where you came from, so "return to main
  // call" later is possible.
  const joinBreakoutRoom = useCallback(async (roomChatId, parentChatId, callKind) => {
    leave();
    await join(roomChatId, callKind);
    setCall((c) => (c ? { ...c, breakoutParentChatId: parentChatId } : c));
  }, [leave, join]);

  const returnToMainCall = useCallback(async () => {
    const current = callRef.current;
    if (!current?.breakoutParentChatId) return;
    const parentChatId = current.breakoutParentChatId;
    const kind = current.callKind;
    leave();
    await join(parentChatId, kind);
  }, [leave, join]);

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

        // Both bypass the general "must match my current call's chat_id"
        // gate below — a breakout announcement arrives tagged with the
        // PARENT chat's id, which is exactly the one case where that's
        // still relevant after you've moved into a different room's call.
        if (event.type === "breakout_rooms_created") {
          if (current && event.chat_id === current.chatId) {
            setCall((c) => (c ? { ...c, breakoutRooms: event.rooms } : c));
          }
          continue;
        }
        if (event.type === "breakout_rooms_closed") {
          if (current && (event.chat_id === current.chatId || event.chat_id === current.breakoutParentChatId)) {
            setCall((c) => (c ? { ...c, breakoutRoomsClosed: true } : c));
          }
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
          setCall((c) => (c ? { ...c, hostId: event.host_id } : c));
          for (const participant of event.participants) {
            await connectOutward(event.chat_id, participant);
          }
        } else if (event.type === "group_call_host_changed") {
          setCall((c) => (c ? { ...c, hostId: event.host_id } : c));
        } else if (event.type === "group_call_force_muted") {
          if (!current.muted) toggleMute();
          toastRef.current?.("The host muted everyone");
        } else if (event.type === "group_call_kicked") {
          toastRef.current?.("You were removed from the call");
          teardown();
          setCall(null);
        } else if (event.type === "group_call_ended") {
          // The host tapped "End" on the meeting this call belongs to —
          // main.py's end_meeting tears down the whole room server-side, so
          // every participant's client needs to hang up in step rather than
          // being left talking into a call the meeting record now says is over.
          toastRef.current?.("The host ended this meeting");
          teardown();
          setCall(null);
        } else if (event.type === "group_call_waiting") {
          setCall((c) => (c ? { ...c, phase: "waiting" } : c));
        } else if (event.type === "group_call_admitted") {
          setCall((c) => (c ? { ...c, phase: "active" } : c));
        } else if (event.type === "group_call_join_denied") {
          toastRef.current?.("The host didn't let you into this call");
          teardown();
          setCall(null);
        } else if (event.type === "group_call_join_request") {
          setCall((c) => (c ? {
            ...c,
            joinRequests: [...(c.joinRequests || []), {
              user_id: event.user_id, name: event.name, avatar: event.avatar_letter, color: event.color,
            }],
          } : c));
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
        } else if (event.type === "whiteboard_open") {
          setCall((c) => (c ? { ...c, whiteboardOpen: true } : c));
        } else if (event.type === "whiteboard_close") {
          setCall((c) => (c ? { ...c, whiteboardOpen: false } : c));
        } else if (event.type === "group_call_reaction") {
          reactionKeyCounter += 1;
          setCall((c) => (c ? {
            ...c, lastReaction: { emoji: event.emoji, from: event.from, key: reactionKeyCounter },
          } : c));
        } else if (event.type === "group_call_raise_hand") {
          addParticipant(event.from, { handRaised: true });
        } else if (event.type === "group_call_lower_hand") {
          addParticipant(event.from, { handRaised: false });
        } else if (event.type === "group_call_caption") {
          if (!current.captionsOn) continue;
          const name = current.participants[event.from]?.name || "Someone";
          setCall((c) => (c ? {
            ...c,
            captions: [...(c.captions || []), { from: name, text: event.text, key: `${event._n}` }]
              .slice(-MAX_CAPTION_LINES),
          } : c));
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

  return {
    call, join, declineIncoming, leave, toggleMute, toggleCamera, shareScreen, setScreenOptimization,
    forceMuteAll, kickParticipant, addPeople, toggleWhiteboard, sendReaction, toggleRaiseHand,
    toggleCaptions, sendCaption, joinBreakoutRoom, returnToMainCall,
    admitParticipant, denyParticipant,
  };
}
