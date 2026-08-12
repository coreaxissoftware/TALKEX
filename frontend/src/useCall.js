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
  "call_upgrade_offer", "call_upgrade_answer", "call_ringing", "call_media_state",
  // Callee (opened from a call notification) asking the caller to re-send the
  // offer — the caller answers this by re-emitting call_invite.
  "call_reoffer_request",
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
  // The outgoing SDP offer, kept so the caller can re-send it if the callee
  // opens the app from a call notification and asks for it again.
  const outgoingOfferRef = useRef(null);
  // Set when the app is opened by tapping "Accept" on a call notification:
  // { fromId } — the next matching call_invite is auto-answered.
  const autoAcceptRef = useRef(null);
  const ringTimerRef = useRef(null);
  const durationTimerRef = useRef(null);
  const lastApplied = useRef(0);
  // The camera-effects canvas pipeline, when an effect is active:
  // { raf, video, canvas, rawTrack, filter }. rawTrack is the genuine camera
  // feed; the sender/preview run off the filtered canvas capture instead.
  const effectRef = useRef(null);

  const sendRef = useRef(send);
  sendRef.current = send;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Tear down the camera-effects canvas loop, returning the raw camera track
  // it was fed from (so a caller can restore or stop it). Safe to call when no
  // effect is running.
  const stopEffectPipeline = useCallback(() => {
    const eff = effectRef.current;
    if (!eff) return null;
    cancelAnimationFrame(eff.raf);
    if (eff.video) eff.video.srcObject = null;
    effectRef.current = null;
    return eff.rawTrack;
  }, []);

  const teardown = useCallback(() => {
    clearTimeout(ringTimerRef.current);
    clearInterval(durationTimerRef.current);
    pcRef.current?.close();
    pcRef.current = null;
    // Stop the effects pipeline and its raw camera track — the raw track lives
    // outside localStream while an effect is active, so it wouldn't be stopped
    // by the loop below on its own.
    const rawTrack = stopEffectPipeline();
    rawTrack?.stop();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    pendingOfferRef.current = null;
    pendingCandidatesRef.current = [];
    outgoingOfferRef.current = null;
  }, [stopEffectPipeline]);

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
    outgoingOfferRef.current = { peerId, chatId: chat.id, callKind, sdp: offer };
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

  // Tells the peer our current mic/camera state so their UI can show a
  // "muted" pill / camera-off placeholder on our tile (WhatsApp's in-call
  // indicators). Pure status ping — no SDP/ICE — relayed like any other call
  // signal. Best-effort: a dropped one just means their indicator lags by one
  // toggle until the next.
  const sendMediaState = useCallback((muted, cameraOff) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({
      type: "call_media_state", to: current.peerId, chat_id: current.chatId,
      muted, camera_off: cameraOff,
    });
  }, []);

  const toggleMute = useCallback(() => {
    const current = callRef.current;
    if (!current?.localStream) return;
    const nowMuted = !current.muted;
    current.localStream.getAudioTracks().forEach((track) => { track.enabled = !nowMuted; });
    setCall((c) => (c ? { ...c, muted: nowMuted } : c));
    sendMediaState(nowMuted, current.cameraOff);
  }, [sendMediaState]);

  const toggleCamera = useCallback(async () => {
    const current = callRef.current;
    const pc = pcRef.current;
    if (!current?.localStream || !pc) return;

    const existingTrack = current.localStream.getVideoTracks()[0];
    if (existingTrack) {
      const nowOff = !current.cameraOff;
      existingTrack.enabled = !nowOff;
      setCall((c) => (c ? { ...c, cameraOff: nowOff } : c));
      sendMediaState(current.muted, nowOff);
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
    sendMediaState(current.muted, false);
  }, [sendMediaState]);

  // Flips between front/back camera — a fresh getUserMedia with the
  // opposite facingMode, swapped in via the same no-renegotiation
  // replaceTrack trick shareScreen uses below (same track kind, same
  // m-line). Also swaps the LOCAL preview's track, not just what the peer
  // receives, so your own mirror shows the new camera too.
  const switchCamera = useCallback(async () => {
    const pc = pcRef.current;
    const current = callRef.current;
    if (!pc || !current?.localStream || current.sharingScreen) return;
    // An active camera effect means the localStream carries the CANVAS track,
    // not the real camera — flip from the genuine camera track and tear the
    // effect down (it can be re-enabled after the flip). Otherwise flip from
    // whatever's live.
    const effectRaw = stopEffectPipeline();
    const existingTrack = effectRaw || current.localStream.getVideoTracks()[0];
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

    // Rebuild the local stream as a BRAND-NEW MediaStream (carrying over the
    // existing audio track) rather than mutating the current one in place.
    // Mutating tracks on the stream that's already a <video>'s srcObject does
    // NOT reliably repaint the preview on mobile WebViews (Capacitor/Android
    // in particular) — it freezes on the old, now-stopped track, so the flip
    // looked completely dead even though the peer was already receiving the
    // other camera. Handing VideoTag a fresh stream object forces its
    // srcObject effect to re-run and the mirror to actually update.
    const newLocal = new MediaStream();
    current.localStream.getAudioTracks().forEach((t) => newLocal.addTrack(t));
    newLocal.addTrack(newTrack);
    existingTrack.stop();
    localStreamRef.current = newLocal;

    setCall((c) => (c ? { ...c, localStream: newLocal, facingMode: nextFacing, videoEffect: "none" } : c));
  }, [stopEffectPipeline]);

  // Applies a live camera effect (a CSS-style filter) to the OUTGOING video —
  // not just the local preview — by piping the raw camera through a hidden
  // canvas that redraws each frame with ctx.filter set, then sending the
  // canvas's captureStream in place of the camera. Passing "none" restores the
  // untouched camera. Video calls only, and not while sharing the screen.
  const setVideoEffect = useCallback(async (filter) => {
    const pc = pcRef.current;
    const current = callRef.current;
    if (!pc || !current?.localStream || current.callKind !== "video" || current.sharingScreen) return;
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;

    const rawTrack = effectRef.current?.rawTrack || current.localStream.getVideoTracks()[0];
    if (!rawTrack) return;

    if (!filter || filter === "none") {
      stopEffectPipeline();
      await sender.replaceTrack(rawTrack).catch(() => {});
      const restored = new MediaStream();
      current.localStream.getAudioTracks().forEach((t) => restored.addTrack(t));
      restored.addTrack(rawTrack);
      localStreamRef.current = restored;
      setCall((c) => (c ? { ...c, localStream: restored, videoEffect: "none" } : c));
      return;
    }

    // Already running — just change the filter; the draw loop reads it live.
    if (effectRef.current) {
      effectRef.current.filter = filter;
      setCall((c) => (c ? { ...c, videoEffect: filter } : c));
      return;
    }

    const settings = rawTrack.getSettings?.() || {};
    const w = settings.width || 640;
    const h = settings.height || 480;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([rawTrack]);
    await video.play().catch(() => {});
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const eff = { video, canvas, rawTrack, filter, raf: 0 };
    const draw = () => {
      ctx.filter = eff.filter;
      try { ctx.drawImage(video, 0, 0, w, h); } catch { /* frame not ready yet */ }
      eff.raf = requestAnimationFrame(draw);
    };
    eff.raf = requestAnimationFrame(draw);
    effectRef.current = eff;

    const canvasTrack = canvas.captureStream(24).getVideoTracks()[0];
    await sender.replaceTrack(canvasTrack).catch(() => {});
    const filtered = new MediaStream();
    current.localStream.getAudioTracks().forEach((t) => filtered.addTrack(t));
    filtered.addTrack(canvasTrack);
    localStreamRef.current = filtered;
    setCall((c) => (c ? { ...c, localStream: filtered, videoEffect: filter } : c));
  }, [stopEffectPipeline]);

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
    // If a camera effect is running, restore to the RAW camera track for the
    // swap-back (the canvas track would be a frozen, orphaned feed once the
    // pipeline stops). Turning the effect off here keeps screen-share simple.
    const effectRaw = stopEffectPipeline();
    const cameraTrack = effectRaw || current.localStream.getVideoTracks()[0];
    await sender.replaceTrack(screenTrack);
    setCall((c) => (c ? { ...c, sharingScreen: true, videoEffect: "none" } : c));

    // The browser's own "Stop sharing" control (not any button of ours) is
    // how most people end a share — this is the only reliable way to hear
    // about that and swap the camera back on.
    screenTrack.onended = async () => {
      if (cameraTrack && pcRef.current === pc) {
        await sender.replaceTrack(cameraTrack).catch(() => {});
      }
      setCall((c) => (c ? { ...c, sharingScreen: false } : c));
    };
  }, [stopEffectPipeline]);

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
        // Opened from a call notification's Accept → answer this (re-sent) offer
        // automatically instead of making the user tap Accept a second time.
        if (autoAcceptRef.current && autoAcceptRef.current.fromId === event.from) {
          autoAcceptRef.current = null;
          setTimeout(() => { acceptIncoming(); }, 0); // callRef is set by the render this triggers
        }
        continue;
      }

      if (!current || event.from !== current.peerId) continue;

      if (event.type === "call_reoffer_request") {
        // The callee opened the app from our call notification and needs the
        // offer again (they never got the first one). Re-send it if we're still
        // trying to reach them.
        const o = outgoingOfferRef.current;
        if (o && o.peerId === event.from && current.phase === "outgoing") {
          sendRef.current({
            type: "call_invite", to: o.peerId, chat_id: o.chatId,
            call_kind: o.callKind, sdp: o.sdp,
          });
        }
      } else if (event.type === "call_ringing" && current.phase === "outgoing") {
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
      } else if (event.type === "call_media_state") {
        // Peer toggled their mic/camera — reflect it on their tile.
        setCall((c) => (c ? { ...c, remoteMuted: Boolean(event.muted), remoteCameraOff: Boolean(event.camera_off) } : c));
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

  // Bridge the native (Android) call notification's "Accept" to the web app:
  // MainActivity calls window.talkexAcceptCall(chatId, fromId) via
  // evaluateJavascript. We ask the caller to re-send the offer (the killed app
  // never got the first one) and arm auto-accept for the invite that follows.
  useEffect(() => {
    window.talkexAcceptCall = (chatId, fromId) => {
      if (!fromId) return;
      autoAcceptRef.current = { fromId };   // auto-answer the invite that follows
      sendRef.current({ type: "call_reoffer_request", to: fromId, chat_id: chatId });
    };
    // Tapping the notification body / full-screen: just bring the ringing UI up
    // (request the offer again) and let the user choose Accept/Decline in-app.
    window.talkexShowCall = (chatId, fromId) => {
      if (!fromId) return;
      sendRef.current({ type: "call_reoffer_request", to: fromId, chat_id: chatId });
    };
    return () => {
      if (window.talkexAcceptCall) delete window.talkexAcceptCall;
      if (window.talkexShowCall) delete window.talkexShowCall;
    };
  }, []);

  return {
    call, startCall, acceptIncoming, rejectIncoming, endCall, toggleMute, toggleCamera, switchCamera,
    shareScreen, stopSharingScreen, setVideoEffect,
  };
}
