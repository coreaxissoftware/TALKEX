import { useCallback, useEffect, useRef, useState } from "react";
import { Messages, newClientMessageId } from "./api.js";

// A free public STUN server is enough to discover a caller's own reflexive
// address, which is all two peers on the same network (or with an
// unrestrictive NAT) need to connect directly. There is no TURN server here —
// a relay for peers that can't reach each other directly — so a call between
// two people behind strict/symmetric NATs can still fail to connect. Running
// a TURN relay is real infrastructure (bandwidth, a server, TLS certs) that
// is out of scope for this pass; noted as a known limitation rather than
// silently pretended away.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// How long an outgoing call rings before the caller gives up on it.
const RING_TIMEOUT_MS = 30000;

const CALL_EVENT_TYPES = new Set([
  "call_invite", "call_answer", "call_ice", "call_reject", "call_end", "call_busy", "call_error",
  "call_upgrade_offer", "call_upgrade_answer", "call_ringing",
]);

/**
 * Owns one WebRTC call at a time: the RTCPeerConnection, both media streams,
 * and the signaling state machine that drives them through offer/answer/ICE
 * exchange over the app's existing WebSocket.
 *
 * Exactly one side of a call ever writes its outcome into the chat as a
 * message — the caller. Every teardown path below checks `isCaller` before
 * logging, specifically so a call ending (however it ends: declined, hung up,
 * unanswered, busy) never produces two log entries for the same call.
 */
export function useCall(events, send, toast) {
  const [call, setCall] = useState(null);
  const callRef = useRef(null);
  callRef.current = call;

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingOfferRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const ringTimerRef = useRef(null);
  const durationTimerRef = useRef(null);
  const lastApplied = useRef(0);

  const sendRef = useRef(send);
  sendRef.current = send;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const teardown = useCallback(() => {
    clearTimeout(ringTimerRef.current);
    clearInterval(durationTimerRef.current);
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    pendingOfferRef.current = null;
    pendingCandidatesRef.current = [];
  }, []);

  const logOutcome = useCallback((snapshot, status, durationSecs = 0) => {
    Messages.send({
      chat_id: snapshot.chatId,
      kind: "call",
      payload: {
        call_kind: snapshot.callKind,
        status,
        duration_secs: Math.max(0, Math.round(durationSecs)),
      },
      client_msg_id: newClientMessageId(),
    }).catch(() => {}); // best-effort — a lost call log is not worth surfacing an error for
  }, []);

  const buildPeerConnection = useCallback((peerId) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendRef.current({
          type: "call_ice", to: peerId,
          chat_id: callRef.current?.chatId, candidate: event.candidate,
        });
      }
    };
    pc.ontrack = (event) => {
      setCall((current) => (current ? { ...current, remoteStream: event.streams[0] } : current));
    };
    return pc;
  }, []);

  // ── Local actions ────────────────────────────────────────────────────────

  const startCall = useCallback(async (chat, callKind) => {
    if (callRef.current) {
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
      return;
    }
    localStreamRef.current = localStream;

    const peerId = chat.peer_id;
    const pc = buildPeerConnection(peerId);
    pcRef.current = pc;
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    setCall({
      phase: "outgoing", chatId: chat.id, peerId,
      peerName: chat.name, peerAvatar: chat.avatar_letter, peerColor: chat.color,
      callKind, isCaller: true,
      localStream, remoteStream: null, muted: false, cameraOff: false, facingMode: "user",
      startedAt: null, duration: 0,
      // False until the server confirms the invite actually reached a
      // live, focused device (call_ringing, below) — OutgoingCall shows
      // "Calling…" until then and "Ringing…" only once this is true, so a
      // logged-out or unreachable peer never gets falsely reported as
      // having a phone that's actually ringing somewhere.
      ringConfirmed: false,
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendRef.current({
      type: "call_invite", to: peerId, chat_id: chat.id, call_kind: callKind, sdp: offer,
    });

    ringTimerRef.current = setTimeout(() => {
      const current = callRef.current;
      if (current && current.phase === "outgoing") {
        sendRef.current({ type: "call_end", to: current.peerId, chat_id: current.chatId });
        logOutcome(current, "unanswered");
        teardown();
        setCall(null);
      }
    }, RING_TIMEOUT_MS);
  }, [buildPeerConnection, logOutcome, teardown]);

  const acceptIncoming = useCallback(async () => {
    const current = callRef.current;
    if (!current || current.phase !== "incoming") return;

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true, video: current.callKind === "video",
      });
    } catch (problem) {
      toastRef.current?.(problem.name === "NotAllowedError"
        ? "Camera/microphone permission was denied"
        : "No camera or microphone is available");
      sendRef.current({ type: "call_reject", to: current.peerId, chat_id: current.chatId });
      teardown();
      setCall(null);
      return;
    }
    localStreamRef.current = localStream;

    const pc = buildPeerConnection(current.peerId);
    pcRef.current = pc;
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    await pc.setRemoteDescription(pendingOfferRef.current);
    for (const candidate of pendingCandidatesRef.current) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
    pendingCandidatesRef.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendRef.current({
      type: "call_answer", to: current.peerId, chat_id: current.chatId, sdp: answer,
    });

    const startedAt = Date.now();
    setCall((c) => (c ? { ...c, phase: "active", localStream, startedAt } : c));
    durationTimerRef.current = setInterval(() => {
      setCall((c) => (c ? { ...c, duration: Math.round((Date.now() - startedAt) / 1000) } : c));
    }, 1000);
  }, [buildPeerConnection, teardown]);

  const rejectIncoming = useCallback((quickReplyText) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "call_reject", to: current.peerId, chat_id: current.chatId });
    // The caller logs "declined" when they receive the call_reject event —
    // logging here too would put two entries in the chat for one call.
    if (quickReplyText) {
      // An ordinary text message, sent the same way any other message is —
      // the caller sees it in the chat right under the missed-call log entry
      // they're about to write, same as WhatsApp's "can't talk right now"
      // quick replies on a declined call.
      Messages.send({
        chat_id: current.chatId, text: quickReplyText, client_msg_id: newClientMessageId(),
      }).catch(() => {});
    }
    teardown();
    setCall(null);
  }, [teardown]);

  const endCall = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "call_end", to: current.peerId, chat_id: current.chatId });
    if (current.isCaller) {
      const durationSecs = current.phase === "active" ? (Date.now() - current.startedAt) / 1000 : 0;
      logOutcome(current, current.phase === "active" ? "completed" : "unanswered", durationSecs);
    }
    // If we are the callee hanging up on an active call, we deliberately log
    // nothing — the caller logs "completed" when the call_end we just sent
    // reaches them, in the event handler below.
    teardown();
    setCall(null);
  }, [logOutcome, teardown]);

  const toggleMute = useCallback(() => {
    const current = callRef.current;
    if (!current?.localStream) return;
    const nowMuted = !current.muted;
    current.localStream.getAudioTracks().forEach((track) => { track.enabled = !nowMuted; });
    setCall((c) => (c ? { ...c, muted: nowMuted } : c));
  }, []);

  const toggleCamera = useCallback(async () => {
    const current = callRef.current;
    const pc = pcRef.current;
    if (!current?.localStream || !pc) return;

    const existingTrack = current.localStream.getVideoTracks()[0];
    if (existingTrack) {
      const nowOff = !current.cameraOff;
      existingTrack.enabled = !nowOff;
      setCall((c) => (c ? { ...c, cameraOff: nowOff } : c));
      return;
    }

    // No video track yet — this call started as voice-only. The original
    // offer/answer never negotiated a video m-line, so adding one now needs
    // a full second offer/answer round trip on the same connection, not
    // just a track swap. Turning the camera on is the only way this ever
    // happens; there is no separate "upgrade to video" button.
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
    pc.addTrack(videoTrack, current.localStream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendRef.current({
      type: "call_upgrade_offer", to: current.peerId, chat_id: current.chatId, sdp: offer,
    });
    setCall((c) => (c ? { ...c, callKind: "video", cameraOff: false, facingMode: "user" } : c));
  }, []);

  // Flips between front/back camera — a fresh getUserMedia with the
  // opposite facingMode, swapped in via the same no-renegotiation
  // replaceTrack trick shareScreen uses below (same track kind, same
  // m-line). Also swaps the LOCAL preview's track, not just what the peer
  // receives, so your own mirror shows the new camera too.
  const switchCamera = useCallback(async () => {
    const pc = pcRef.current;
    const current = callRef.current;
    if (!pc || !current?.localStream || current.sharingScreen) return;
    const existingTrack = current.localStream.getVideoTracks()[0];
    if (!existingTrack) return; // voice-only call — nothing to flip

    const nextFacing = current.facingMode === "environment" ? "user" : "environment";
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextFacing } });
    } catch {
      toastRef.current?.("Could not switch camera");
      return;
    }
    const newTrack = newStream.getVideoTracks()[0];
    newTrack.enabled = existingTrack.enabled; // preserve cameraOff state across the switch

    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    await sender?.replaceTrack(newTrack);

    current.localStream.removeTrack(existingTrack);
    existingTrack.stop();
    current.localStream.addTrack(newTrack);

    setCall((c) => (c ? { ...c, facingMode: nextFacing } : c));
  }, []);

  // Swaps the outgoing video track for a screen-capture track via
  // RTCRtpSender.replaceTrack — no renegotiation needed because it's the
  // SAME track kind on the SAME m-line the call started with. That's also
  // exactly why this only works on a call that already has a video track:
  // adding a video track to a voice call from scratch needs a fresh
  // offer/answer round trip, which is real, separate work this doesn't do.
  const shareScreen = useCallback(async () => {
    const pc = pcRef.current;
    const current = callRef.current;
    if (!pc || !current?.localStream) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) {
      toastRef.current?.("Turn your camera on first to share your screen");
      return;
    }
    let screenStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return; // the person cancelled the OS share picker — not an error
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    const cameraTrack = current.localStream.getVideoTracks()[0];
    await sender.replaceTrack(screenTrack);
    setCall((c) => (c ? { ...c, sharingScreen: true } : c));

    // The browser's own "Stop sharing" control (not any button of ours) is
    // how most people end a share — this is the only reliable way to hear
    // about that and swap the camera back on.
    screenTrack.onended = async () => {
      if (cameraTrack && pcRef.current === pc) {
        await sender.replaceTrack(cameraTrack).catch(() => {});
      }
      setCall((c) => (c ? { ...c, sharingScreen: false } : c));
    };
  }, []);

  const stopSharingScreen = useCallback(() => {
    const current = callRef.current;
    const pc = pcRef.current;
    if (!pc || !current?.localStream) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    const cameraTrack = current.localStream.getVideoTracks()[0];
    sender?.track?.stop(); // fires the screenTrack.onended handler above, which does the actual swap-back
    if (!sender?.track && cameraTrack) sender?.replaceTrack(cameraTrack);
  }, []);

  // ── Remote events ────────────────────────────────────────────────────────

  useEffect(() => {
    const fresh = events.filter((event) =>
      event._n > lastApplied.current && CALL_EVENT_TYPES.has(event.type));
    if (fresh.length === 0) return;
    lastApplied.current = events[events.length - 1]._n;

    for (const event of fresh) {
      const current = callRef.current;

      if (event.type === "call_invite") {
        if (current) {
          // Already on a call — the caller finds out immediately rather than
          // ringing into silence until they eventually time out.
          sendRef.current({ type: "call_busy", to: event.from, chat_id: event.chat_id });
          continue;
        }
        pendingOfferRef.current = event.sdp;
        pendingCandidatesRef.current = [];
        setCall({
          phase: "incoming", chatId: event.chat_id, peerId: event.from,
          peerName: event.from_name, peerAvatar: event.from_avatar, peerColor: event.from_color,
          callKind: event.call_kind, isCaller: false,
          localStream: null, remoteStream: null, muted: false, cameraOff: false, facingMode: "user",
          startedAt: null, duration: 0,
        });
        continue;
      }

      if (!current || event.from !== current.peerId) continue;

      if (event.type === "call_ringing" && current.phase === "outgoing") {
        setCall((c) => (c ? { ...c, ringConfirmed: true } : c));
      } else if (event.type === "call_answer" && current.phase === "outgoing") {
        clearTimeout(ringTimerRef.current);
        pcRef.current?.setRemoteDescription(event.sdp).then(async () => {
          for (const candidate of pendingCandidatesRef.current) {
            await pcRef.current?.addIceCandidate(candidate).catch(() => {});
          }
          pendingCandidatesRef.current = [];
        });
        const startedAt = Date.now();
        setCall((c) => (c ? { ...c, phase: "active", startedAt } : c));
        durationTimerRef.current = setInterval(() => {
          setCall((c) => (c ? { ...c, duration: Math.round((Date.now() - startedAt) / 1000) } : c));
        }, 1000);
      } else if (event.type === "call_ice") {
        if (pcRef.current?.remoteDescription) {
          pcRef.current.addIceCandidate(event.candidate).catch(() => {});
        } else {
          pendingCandidatesRef.current.push(event.candidate);
        }
      } else if (event.type === "call_upgrade_offer") {
        // The other side just turned their camera on for a call that
        // started voice-only. Answering this (rather than needing our own
        // camera too) is what actually unlocks the video call UI on our
        // side — pc.ontrack already adds their new video track to
        // remoteStream through the existing handler once this completes.
        const pc = pcRef.current;
        if (pc) {
          pc.setRemoteDescription(event.sdp)
            .then(() => pc.createAnswer())
            .then((answer) => pc.setLocalDescription(answer).then(() => answer))
            .then((answer) => {
              sendRef.current({
                type: "call_upgrade_answer", to: current.peerId, chat_id: current.chatId, sdp: answer,
              });
            })
            .catch(() => {});
        }
        setCall((c) => (c ? { ...c, callKind: "video" } : c));
      } else if (event.type === "call_upgrade_answer") {
        pcRef.current?.setRemoteDescription(event.sdp).catch(() => {});
      } else if (event.type === "call_reject") {
        if (current.isCaller) logOutcome(current, "declined");
        teardown();
        setCall(null);
      } else if (event.type === "call_busy") {
        if (current.isCaller) logOutcome(current, "busy");
        teardown();
        setCall(null);
      } else if (event.type === "call_end") {
        // Only the caller ever logs — see endCall() above for why.
        if (current.isCaller && current.phase === "active") {
          logOutcome(current, "completed", (Date.now() - current.startedAt) / 1000);
        }
        teardown();
        setCall(null);
      } else if (event.type === "call_error") {
        toastRef.current?.(event.reason || "Could not reach them");
        teardown();
        setCall(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, logOutcome, teardown]);

  useEffect(() => teardown, [teardown]);

  return {
    call, startCall, acceptIncoming, rejectIncoming, endCall, toggleMute, toggleCamera, switchCamera,
    shareScreen, stopSharingScreen,
  };
}
