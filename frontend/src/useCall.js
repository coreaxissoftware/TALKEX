import { useCallback, useEffect, useRef, useState } from "react";
import { Messages, newClientMessageId } from "./api.js";

// A free public STUN server is enough to discover a caller's own reflexive
// address, which is all two peers on the same network (or with an
// unrestrictive NAT) need to connect directly. TURN — a media relay for
// peers that CAN'T reach each other directly (strict/symmetric NATs, some
// corporate networks) — is opt-in via env vars, so the app runs on STUN
// alone by default and picks up TURN the moment you set:
//
//   VITE_TURN_URL="turn:turn.example.com:3478"
//   VITE_TURN_USERNAME="…"
//   VITE_TURN_CREDENTIAL="…"
//
// in .env.production (or your Hostinger/hosting build env). Recommended
// providers: Twilio Network Traversal, Metered.ca (free tier), or a
// self-hosted coturn instance.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  ...(import.meta.env.VITE_TURN_URL
    ? [{
        urls: import.meta.env.VITE_TURN_URL,
        username: import.meta.env.VITE_TURN_USERNAME,
        credential: import.meta.env.VITE_TURN_CREDENTIAL,
      }]
    : []),
];

// Every getUserMedia/getDisplayMedia call below used to ask for video with
// no resolution/frame-rate constraints at all, which means "give me
// whatever this camera's/display's native maximum is" — often 1080p+ at
// 30-60fps. Encoding that in real time is the actual reason a call makes a
// laptop or phone run hot: 720p24 looks the same on a chat call's video
// tile and costs a fraction of the CPU/GPU work to encode. `ideal` lets the
// browser pick something close on hardware that can't hit these exactly;
// `max` is the hard ceiling that actually matters for the heat.
const CAMERA_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  // Plain-value facingMode (not an `exact` clause) is treated as a
  // preference: Android picks the front camera to start a video call, a
  // laptop with only one webcam still returns its only camera fine.
  // Without this, phones would default to whatever the OS thought was
  // "camera 0" — usually the rear one — while the state below below
  // (facingMode: "user") assumed it was front, so switchCamera's
  // front↔back toggle started out backwards on every video call.
  facingMode: "user",
};
// Screen content is rarely motion-heavy (a slide, a code editor, a shared
// doc) — capping the capture frame rate is the single biggest lever here,
// since a display's native refresh rate (60Hz+) costs far more to encode
// than anyone reading a shared screen actually benefits from.
const SCREEN_SHARE_CONSTRAINTS = { frameRate: { ideal: 15, max: 24 } };

// Getting a stream from the OTHER camera, reliably, on the widest range of
// devices — this is what the front/back flip button actually calls.
//
// A plain `facingMode: "environment"` is only a *preference*: many Android
// WebViews (and Capacitor's in particular) just hand back the same camera
// that's already open, so the flip button looked completely dead. Asking
// with `{ exact: … }` forces the browser to honour it or fail loudly, which
// is what makes the switch actually switch. When even that fails (a device
// that won't take an exact facingMode, or a laptop that reports its cameras
// without facing info), we fall back to enumerating the video inputs and
// explicitly opening one whose deviceId differs from the current track's.
// Returns the new stream, or null if there genuinely is only one camera.
async function openCameraFacing(nextFacing, currentTrack) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...CAMERA_CONSTRAINTS, facingMode: { exact: nextFacing } },
    });
  } catch { /* fall through to the deviceId approach */ }

  try {
    const cameras = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "videoinput");
    if (cameras.length < 2) return null; // nothing to flip to
    const currentId = currentTrack?.getSettings?.().deviceId;
    const other = cameras.find((device) => device.deviceId && device.deviceId !== currentId) || cameras[0];
    return await navigator.mediaDevices.getUserMedia({
      // facingMode dropped here on purpose — deviceId is the exact,
      // unambiguous selector, and pairing it with a facingMode constraint
      // can over-constrain and fail on some devices.
      video: {
        width: CAMERA_CONSTRAINTS.width, height: CAMERA_CONSTRAINTS.height,
        frameRate: CAMERA_CONSTRAINTS.frameRate, deviceId: { exact: other.deviceId },
      },
    });
  } catch {
    return null;
  }
}

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
        audio: true, video: callKind === "video" ? CAMERA_CONSTRAINTS : false,
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

    // Wraps every WebRTC negotiation step below — createOffer,
    // setLocalDescription — because any of them can throw (peer
    // connection in the wrong state, SDP parse error, hardware media
    // stall) and used to leave the call state set with no cleanup, so
    // "Calling…" spun forever with no way out.
    let offer;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (problem) {
      toastRef.current?.("Call could not start — please try again");
      teardown();
      setCall(null);
      return;
    }
    // send() returns false when the WebSocket is dead — this used to be
    // silently ignored (call_invite dropped on the floor, "Calling…"
    // spinning forever until the 30-second ring timeout eventually logged
    // "No answer" for a call the other side never heard of). Now we
    // surface it as a real error and give up immediately: send() also
    // kicks a reconnect internally, so the next attempt has a fresh
    // socket to work with.
    const sent = sendRef.current({
      type: "call_invite", to: peerId, chat_id: chat.id, call_kind: callKind, sdp: offer,
    });
    if (!sent) {
      toastRef.current?.("Connection lost — try again in a moment");
      teardown();
      setCall(null);
      return;
    }

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
        audio: true, video: current.callKind === "video" ? CAMERA_CONSTRAINTS : false,
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

    // Same error-swallow story as startCall above: setRemote/createAnswer/
    // setLocal all throw on bad SDPs or wrong-state peer connections, and
    // used to be un-awaited-catch, so a failed accept left the incoming
    // ring on screen with no path forward except closing the app.
    let answer;
    try {
      await pc.setRemoteDescription(pendingOfferRef.current);
      for (const candidate of pendingCandidatesRef.current) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
      pendingCandidatesRef.current = [];

      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch (problem) {
      toastRef.current?.("Could not accept the call");
      sendRef.current({ type: "call_reject", to: current.peerId, chat_id: current.chatId });
      teardown();
      setCall(null);
      return;
    }
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
      videoStream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
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
    const newStream = await openCameraFacing(nextFacing, existingTrack);
    if (!newStream) {
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
      // audio: true asks the browser to capture the shared tab/window's
      // audio too — critical for sharing a video with sound, a music
      // player, or a call/meeting recording. Non-tab surfaces (a whole
      // display, an app window) commonly return video only anyway, so
      // this is a best-effort ask, not a hard requirement.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_SHARE_CONSTRAINTS,
        audio: true,
      });
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
