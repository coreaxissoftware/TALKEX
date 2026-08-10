import { useCallback, useEffect, useRef, useState } from "react";

// Same STUN + optional TURN via env vars as useCall.js — see that file
// for the full setup instructions.
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

// Same reasoning as useCall.js's identical constants — unconstrained video
// asks for the camera's/display's native max resolution and frame rate,
// which is real, measurable CPU/GPU heat. It matters MORE here than in a
// 1:1 call: a mesh group call encodes this same stream once per OTHER
// participant (see the O(n²) note on useGroupCall below), so an
// unconstrained encode is multiplied by however many people are on the call.
const CAMERA_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  // Same "start with the front camera on phones" fix as useCall.js — see
  // the identical comment there for the full reasoning. Without it,
  // Android joined a group video call on the rear camera by default and
  // switchCamera's front↔back toggle started out backwards.
  facingMode: "user",
};
const SCREEN_SHARE_CONSTRAINTS = { frameRate: { ideal: 15, max: 24 } };

// Reliable front/back flip — see the identical helper in useCall.js for the
// full reasoning. A plain `facingMode` preference is silently ignored by many
// Android WebViews (the flip did nothing); `{ exact: … }` forces it, with a
// deviceId-based fallback for devices that reject an exact facingMode.
async function openCameraFacing(nextFacing, currentTrack) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...CAMERA_CONSTRAINTS, facingMode: { exact: nextFacing } },
    });
  } catch { /* fall through to the deviceId approach */ }

  try {
    const cameras = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "videoinput");
    if (cameras.length < 2) return null;
    const currentId = currentTrack?.getSettings?.().deviceId;
    const other = cameras.find((device) => device.deviceId && device.deviceId !== currentId) || cameras[0];
    return await navigator.mediaDevices.getUserMedia({
      video: {
        width: CAMERA_CONSTRAINTS.width, height: CAMERA_CONSTRAINTS.height,
        frameRate: CAMERA_CONSTRAINTS.frameRate, deviceId: { exact: other.deviceId },
      },
    });
  } catch {
    return null;
  }
}

const GROUP_CALL_EVENT_TYPES = new Set([
  "group_call_invite", "group_call_roster", "group_call_participant_joined",
  "group_call_participant_left", "group_call_offer", "group_call_answer", "group_call_ice",
  "group_call_host_changed", "group_call_force_muted", "group_call_kicked", "group_call_ended",
  "call_error", "whiteboard_open", "whiteboard_close",
  "group_call_reaction", "group_call_raise_hand", "group_call_lower_hand",
  "group_call_caption", "breakout_rooms_created", "breakout_rooms_closed",
  "group_call_waiting", "group_call_admitted", "group_call_join_denied", "group_call_join_request",
  "group_call_muted_by_host", "group_call_participant_muted", "group_call_participant_unmuted",
  "group_call_screen_share_started", "group_call_screen_share_stopped",
  "group_call_permissions_changed", "group_call_action_denied", "group_call_spotlight_changed",
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
export function useGroupCall(events, send, toast, reconnectedAt) {
  const [call, setCall] = useState(null);
  // call = null | {
  //   phase: "incoming" | "active",
  //   chatId, callKind, muted, cameraOff,
  //   inviterName, inviterAvatar, inviterColor,  // only set during "incoming"
  //   permissions: { screen_share, whiteboard },  // "host" | "everyone", host-set policy
  //   screenSharerId,  // null | userId — authoritative, from the server, not a local guess
  //   spotlightUserId, // null | userId — host-pinned main-stage target
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

  // The socket dropping and reconnecting (a WiFi hiccup, a phone briefly
  // locking) used to silently end a group call for this device — the
  // server's grace window (see _leave_all_group_calls in main.py) now
  // holds this participant's slot open for a few seconds, but only IF the
  // client actually re-sends group_call_start once the socket is back;
  // nothing did that before this effect existed. The existing
  // RTCPeerConnections are untouched here — they don't depend on the
  // signaling socket staying open once established, only on it being
  // available again for whatever renegotiation the resume needs.
  useEffect(() => {
    if (!reconnectedAt) return;
    const current = callRef.current;
    if (current?.phase !== "active") return;
    sendRef.current({ type: "group_call_start", chat_id: current.chatId, call_kind: current.callKind });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectedAt]);

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
        audio: true, video: callKind === "video" ? CAMERA_CONSTRAINTS : false,
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
      phase: "active", chatId, callKind, muted: false, cameraOff: false, facingMode: "user",
      localStream, participants: current?.participants || {},
      permissions: { screen_share: "everyone", whiteboard: "everyone" },
      screenSharerId: null, spotlightUserId: null,
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
    // Tells the room to drop this participant's "muted by host" badge —
    // sent on every unmute, not just one that followed a host mute,
    // because the server has no record of why THIS client thinks it's
    // muted; harmless no-op for everyone else if the badge wasn't set.
    if (!nowMuted) {
      sendRef.current({ type: "group_call_self_unmuted", chat_id: current.chatId });
    }
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
      videoStream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
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
    setCall((c) => (c ? { ...c, callKind: "video", cameraOff: false, facingMode: "user" } : c));
  }, []);

  // Same idea as useCall.js's switchCamera, applied to every peer connection
  // in the mesh at once (like shareScreen below does for a screen track) —
  // one fresh getUserMedia with the opposite facingMode, replaceTrack'd onto
  // each connection's existing video sender, no renegotiation needed.
  const switchCamera = useCallback(async () => {
    const current = callRef.current;
    if (!current?.localStream || current.sharingScreen) return;
    const existingTrack = current.localStream.getVideoTracks()[0];
    if (!existingTrack) return;

    const nextFacing = current.facingMode === "environment" ? "user" : "environment";
    const newStream = await openCameraFacing(nextFacing, existingTrack);
    if (!newStream) {
      toastRef.current?.("Could not switch camera");
      return;
    }
    const newTrack = newStream.getVideoTracks()[0];
    newTrack.enabled = existingTrack.enabled;

    const senders = Object.values(peersRef.current)
      .map((pc) => pc.getSenders().find((s) => s.track?.kind === "video"))
      .filter(Boolean);
    await Promise.all(senders.map((sender) => sender.replaceTrack(newTrack)));

    // Fresh MediaStream (carrying the existing audio track) rather than an
    // in-place mutation — see useCall.js's switchCamera for why: mutating the
    // stream that's already a <video>'s srcObject doesn't repaint the preview
    // on mobile WebViews, so the flip looked dead. A new object forces
    // SelfTile's VideoTag to re-run its srcObject effect. localStreamRef is
    // also updated so a peer joining mid-call builds from the current camera.
    const newLocal = new MediaStream();
    current.localStream.getAudioTracks().forEach((t) => newLocal.addTrack(t));
    newLocal.addTrack(newTrack);
    existingTrack.stop();
    localStreamRef.current = newLocal;

    setCall((c) => (c ? { ...c, localStream: newLocal, facingMode: nextFacing } : c));
  }, []);

  // Same replaceTrack idea as useCall.js's version, but across every peer in
  // the mesh at once — one screen-capture track, swapped onto each
  // connection's existing video sender. Same scope limit: needs an existing
  // video track already flowing, since adding a fresh one to a voice-only
  // call is a renegotiation this pass doesn't do.
  const shareScreen = useCallback(async () => {
    const current = callRef.current;
    const peers = Object.entries(peersRef.current);
    if (!current?.localStream || peers.length === 0) return;
    const senders = peers
      .map(([, pc]) => pc.getSenders().find((s) => s.track?.kind === "video"))
      .filter(Boolean);

    let screenStream;
    try {
      // audio: true asks for the shared tab/window's own audio (video
      // playback, background music) — see useCall.js for the same fix
      // rationale.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_SHARE_CONSTRAINTS,
        audio: true,
      });
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

    if (senders.length > 0) {
      // A video track is already flowing (camera was on) — swap it for the
      // screen capture on each connection's existing sender, no
      // renegotiation needed. localStream itself also has to be swapped
      // (removeTrack the camera, addTrack the screen — same as
      // switchCamera does above), not just the peer connections' senders:
      // SelfTile renders straight from call.localStream, and a brand new
      // peer joining mid-share builds its outgoing tracks from
      // localStreamRef.current — without this, the presenter's own main-
      // stage tile kept showing their camera instead of the screen they
      // were sharing, and anyone joining mid-share got the camera feed.
      // The camera track is kept alive (not stopped) so it can be restored
      // on the way back out below.
      await Promise.all(senders.map((sender) => sender.replaceTrack(screenTrack)));
      if (cameraTrack) current.localStream.removeTrack(cameraTrack);
      current.localStream.addTrack(screenTrack);
    } else {
      // No video track yet — this was a voice-only call, or the camera was
      // never turned on. Mirrors toggleCamera's identical situation above:
      // add the track to every peer connection and renegotiate, rather than
      // silently refusing to share (the previous behavior — a share that
      // required the camera to already be on is why sharing sometimes
      // looked like it did nothing).
      current.localStream.addTrack(screenTrack);
      await Promise.all(peers.map(async ([peerId, pc]) => {
        pc.addTrack(screenTrack, current.localStream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendRef.current({ type: "group_call_offer", chat_id: current.chatId, to: peerId, sdp: offer });
      }));
    }

    setCall((c) => (c ? {
      ...c, sharingScreen: true, screenOptimizeFor: "motion",
      // SelfTile only draws localStream's video when callKind is "video" —
      // a call that started voice-only needs this flipped or your own
      // screen-share preview would stay hidden from you (remote
      // participants aren't affected: their tiles key off the stream's
      // actual tracks, not callKind).
      callKind: senders.length > 0 ? c.callKind : "video",
    } : c));
    sendRef.current({ type: "group_call_screen_share_start", chat_id: current.chatId });

    screenTrack.onended = async () => {
      screenTrackRef.current = null;
      const c = callRef.current;
      if (senders.length > 0) {
        if (cameraTrack) {
          await Promise.all(senders.map((sender) => sender.replaceTrack(cameraTrack).catch(() => {})));
          c?.localStream?.removeTrack(screenTrack);
          c?.localStream?.addTrack(cameraTrack);
        }
      } else {
        c?.localStream?.removeTrack(screenTrack);
      }
      setCall((current2) => (current2 ? {
        ...current2, sharingScreen: false, screenOptimizeFor: null,
        callKind: senders.length > 0 || cameraTrack ? current2.callKind : "voice",
      } : current2));
      if (c) sendRef.current({ type: "group_call_screen_share_stop", chat_id: c.chatId });
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

  const muteParticipant = useCallback((userId) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_mute_participant", chat_id: current.chatId, target: userId });
  }, []);

  const spotlight = useCallback((userId) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_spotlight", chat_id: current.chatId, target: userId });
  }, []);

  const transferHost = useCallback((userId) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_transfer_host", chat_id: current.chatId, target: userId });
  }, []);

  // "everyone" or "host" for feature "screen_share" | "whiteboard" — the
  // server is the actual enforcement point (see group_call_set_permission
  // in main.py); this just asks it to change the policy.
  const setPermission = useCallback((feature, policy) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_set_permission", chat_id: current.chatId, feature, policy });
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
          // host_id/permissions/screen_sharer_id/spotlight_user_id are the
          // room's current facts, not just this join's — a reconnect or a
          // late joiner needs to start from wherever the room already is,
          // not from these fields' defaults.
          setCall((c) => (c ? {
            ...c, hostId: event.host_id,
            permissions: event.permissions || c.permissions,
            screenSharerId: event.screen_sharer_id ?? null,
            spotlightUserId: event.spotlight_user_id ?? null,
          } : c));
          for (const participant of event.participants) {
            // Already connected — this roster is a resume-after-reconnect
            // (see the reconnectedAt effect above), not a fresh join, and
            // the existing peer connection to this person is untouched.
            // Without this check every already-live connection in the
            // mesh would get a redundant, duplicate one on top of it.
            if (peersRef.current[participant.user_id]) continue;
            await connectOutward(event.chat_id, participant);
          }
        } else if (event.type === "group_call_host_changed") {
          setCall((c) => (c ? { ...c, hostId: event.host_id } : c));
        } else if (event.type === "group_call_force_muted") {
          if (!current.muted) toggleMute();
          toastRef.current?.("The host muted everyone");
        } else if (event.type === "group_call_muted_by_host") {
          if (!current.muted) toggleMute();
          toastRef.current?.("The host muted you");
        } else if (event.type === "group_call_participant_muted") {
          addParticipant(event.user_id, { mutedByHost: true });
        } else if (event.type === "group_call_participant_unmuted") {
          addParticipant(event.user_id, { mutedByHost: false });
        } else if (event.type === "group_call_screen_share_started") {
          setCall((c) => (c ? { ...c, screenSharerId: event.user_id } : c));
        } else if (event.type === "group_call_screen_share_stopped") {
          setCall((c) => (c && c.screenSharerId === event.user_id ? { ...c, screenSharerId: null } : c));
        } else if (event.type === "group_call_permissions_changed") {
          setCall((c) => (c ? { ...c, permissions: event.permissions } : c));
        } else if (event.type === "group_call_spotlight_changed") {
          setCall((c) => (c ? { ...c, spotlightUserId: event.user_id } : c));
        } else if (event.type === "group_call_action_denied") {
          toastRef.current?.(event.reason || "That's not available right now");
          if (event.action === "whiteboard") {
            // Correct an optimistic open the server just rejected — see
            // toggleWhiteboard's own comment for why the sender never gets
            // a positive echo back on the allowed path.
            setCall((c) => (c ? { ...c, whiteboardOpen: false } : c));
          }
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
    call, join, declineIncoming, leave, toggleMute, toggleCamera, switchCamera, shareScreen, setScreenOptimization,
    forceMuteAll, kickParticipant, addPeople, toggleWhiteboard, sendReaction, toggleRaiseHand,
    toggleCaptions, sendCaption, joinBreakoutRoom, returnToMainCall,
    admitParticipant, denyParticipant,
    muteParticipant, spotlight, transferHost, setPermission,
  };
}
