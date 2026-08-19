import { useCallback, useEffect, useRef, useState } from "react";
import { Sfu } from "./api.js";

const CAMERA_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
};

let reactionKeyCounter = 0;
const MAX_CAPTION_LINES = 3;

async function loadLiveKitClient() {
  if (window.__livekit) return window.__livekit;
  // eslint-disable-next-line no-unsanitized/method
  const mod = await import(/* @vite-ignore */ "https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs");
  window.__livekit = mod;
  return mod;
}

export function useGroupCallSfu(events, send, toast) {
  const [call, setCall] = useState(null);
  const callRef = useRef(null);
  callRef.current = call;

  const roomRef = useRef(null);
  const localStreamRef = useRef(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const teardown = useCallback(() => {
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const join = useCallback(async (chatId, callKind) => {
    if (callRef.current?.phase === "active") {
      toastRef.current?.("You're already in a call");
      return;
    }

    let lk;
    try {
      lk = await loadLiveKitClient();
    } catch {
      toastRef.current?.("Could not load video call library");
      return;
    }

    let tokenData;
    try {
      tokenData = await Sfu.token(chatId);
    } catch (err) {
      toastRef.current?.(err.message || "Could not get SFU token");
      return;
    }

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: callKind === "video" ? CAMERA_CONSTRAINTS : false,
      });
    } catch {
      toastRef.current?.("Could not access camera/microphone");
      return;
    }
    localStreamRef.current = localStream;

    const room = new lk.Room({
      adaptiveStream: true,
      dynacast: true,
    });
    roomRef.current = room;

    const participants = {};

    room.on(lk.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const mediaTrack = track.attach();
      const stream = mediaTrack.srcObject || new MediaStream([track.mediaStreamTrack]);
      setCall((cur) => cur ? {
        ...cur,
        participants: {
          ...cur.participants,
          [participant.identity]: {
            ...cur.participants[participant.identity],
            stream,
            name: participant.name || participant.identity,
          },
        },
      } : cur);
    });

    room.on(lk.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      track.detach();
    });

    room.on(lk.RoomEvent.ParticipantConnected, (participant) => {
      setCall((cur) => cur ? {
        ...cur,
        participants: {
          ...cur.participants,
          [participant.identity]: {
            name: participant.name || participant.identity,
            avatar: (participant.name || "?")[0],
            color: "#6366f1",
            stream: null,
            user_id: participant.identity,
          },
        },
      } : cur);
    });

    room.on(lk.RoomEvent.ParticipantDisconnected, (participant) => {
      setCall((cur) => {
        if (!cur) return cur;
        const next = { ...cur.participants };
        delete next[participant.identity];
        return { ...cur, participants: next };
      });
    });

    room.on(lk.RoomEvent.Disconnected, () => {
      teardown();
      setCall(null);
    });

    room.on(lk.RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.isLocal) {
        setCall((cur) => cur ? { ...cur, connectionQuality: quality } : cur);
      }
    });

    try {
      await room.connect(tokenData.url, tokenData.token);
    } catch (err) {
      toastRef.current?.("Could not connect to call server");
      teardown();
      return;
    }

    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      await room.localParticipant.publishTrack(audioTrack, {
        source: lk.Track.Source.Microphone,
      });
    }
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      await room.localParticipant.publishTrack(videoTrack, {
        source: lk.Track.Source.Camera,
        simulcast: true,
      });
    }

    const existingParticipants = {};
    room.remoteParticipants.forEach((p) => {
      existingParticipants[p.identity] = {
        name: p.name || p.identity,
        avatar: (p.name || "?")[0],
        color: "#6366f1",
        stream: null,
        user_id: p.identity,
      };
    });

    sendRef.current({ type: "group_call_start", chat_id: chatId, call_kind: callKind });

    setCall({
      phase: "active",
      chatId,
      callKind,
      muted: false,
      cameraOff: callKind !== "video",
      sfuMode: true,
      localStream,
      participants: existingParticipants,
      hostId: null,
      permissions: { screen_share: "everyone", whiteboard: "everyone" },
      screenSharerId: null,
      spotlightUserId: null,
      raisedHands: {},
      reactions: [],
      captions: [],
      connectionQuality: null,
    });
  }, [teardown]);

  const leave = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_leave", chat_id: current.chatId });
    teardown();
    setCall(null);
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setCall((cur) => {
      if (!cur) return cur;
      const next = !cur.muted;
      room.localParticipant.setMicrophoneEnabled(!next);
      return { ...cur, muted: next };
    });
  }, []);

  const toggleCamera = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    setCall((cur) => {
      if (!cur) return cur;
      const next = !cur.cameraOff;
      room.localParticipant.setCameraEnabled(!next);
      return { ...cur, cameraOff: next };
    });
  }, []);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const current = callRef.current;
    if (!current) return;

    if (current.screenSharerId) {
      await room.localParticipant.setScreenShareEnabled(false);
      setCall((cur) => cur ? { ...cur, screenSharerId: null } : cur);
    } else {
      try {
        await room.localParticipant.setScreenShareEnabled(true);
        setCall((cur) => cur ? { ...cur, screenSharerId: "__self__" } : cur);
      } catch {
        toastRef.current?.("Screen share cancelled");
      }
    }
  }, []);

  const sendReaction = useCallback((emoji) => {
    const current = callRef.current;
    if (!current) return;
    sendRef.current({ type: "group_call_reaction", chat_id: current.chatId, emoji });
    setCall((cur) => cur ? {
      ...cur,
      reactions: [...cur.reactions.slice(-9), { key: ++reactionKeyCounter, emoji, self: true }],
    } : cur);
  }, []);

  useEffect(() => {
    if (!events?.length) return;
    for (const event of events) {
      const t = event.type;
      if (t === "group_call_invite" && !callRef.current) {
        setCall({
          phase: "incoming",
          chatId: event.chat_id,
          callKind: event.call_kind || "audio",
          muted: false,
          cameraOff: true,
          sfuMode: true,
          inviterName: event.inviter_name,
          inviterAvatar: event.inviter_avatar,
          inviterColor: event.inviter_color,
          localStream: null,
          participants: {},
          hostId: null,
          permissions: {},
          screenSharerId: null,
          spotlightUserId: null,
          raisedHands: {},
          reactions: [],
          captions: [],
        });
      } else if (t === "group_call_host_changed") {
        setCall((cur) => cur?.chatId === event.chat_id ? { ...cur, hostId: event.host_id } : cur);
      } else if (t === "group_call_ended") {
        if (callRef.current?.chatId === event.chat_id) {
          teardown();
          setCall(null);
          toastRef.current?.("Call ended");
        }
      } else if (t === "group_call_kicked") {
        if (callRef.current?.chatId === event.chat_id) {
          teardown();
          setCall(null);
          toastRef.current?.("You were removed from the call");
        }
      } else if (t === "group_call_reaction") {
        setCall((cur) => cur?.chatId === event.chat_id ? {
          ...cur,
          reactions: [...cur.reactions.slice(-9), {
            key: ++reactionKeyCounter, emoji: event.emoji, userId: event.user_id,
          }],
        } : cur);
      } else if (t === "group_call_caption") {
        setCall((cur) => cur?.chatId === event.chat_id ? {
          ...cur,
          captions: [...cur.captions.slice(-(MAX_CAPTION_LINES - 1)), {
            userId: event.user_id, name: event.name, text: event.text,
          }],
        } : cur);
      } else if (t === "group_call_spotlight_changed") {
        setCall((cur) => cur?.chatId === event.chat_id
          ? { ...cur, spotlightUserId: event.user_id } : cur);
      } else if (t === "group_call_raise_hand") {
        setCall((cur) => cur?.chatId === event.chat_id
          ? { ...cur, raisedHands: { ...cur.raisedHands, [event.user_id]: true } } : cur);
      } else if (t === "group_call_lower_hand") {
        setCall((cur) => {
          if (!cur || cur.chatId !== event.chat_id) return cur;
          const next = { ...cur.raisedHands };
          delete next[event.user_id];
          return { ...cur, raisedHands: next };
        });
      } else if (t === "whiteboard_open") {
        setCall((cur) => cur?.chatId === event.chat_id ? { ...cur, whiteboardOpen: true } : cur);
      } else if (t === "whiteboard_close") {
        setCall((cur) => cur?.chatId === event.chat_id ? { ...cur, whiteboardOpen: false } : cur);
      } else if (t === "group_call_permissions_changed") {
        setCall((cur) => cur?.chatId === event.chat_id
          ? { ...cur, permissions: { ...cur.permissions, [event.feature]: event.policy } } : cur);
      } else if (t === "group_call_action_denied") {
        toastRef.current?.(event.reason || "Action not allowed");
        if (event.action === "whiteboard_open") {
          setCall((cur) => cur?.chatId === event.chat_id ? { ...cur, whiteboardOpen: false } : cur);
        }
      } else if (t === "group_call_force_muted" || t === "group_call_muted_by_host") {
        const room = roomRef.current;
        if (room) room.localParticipant.setMicrophoneEnabled(false);
        setCall((cur) => cur?.chatId === event.chat_id ? { ...cur, muted: true } : cur);
        toastRef.current?.("You were muted by the host");
      } else if (t === "breakout_rooms_created") {
        setCall((cur) => cur?.chatId === event.chat_id ? { ...cur, breakoutRooms: event.rooms } : cur);
      } else if (t === "breakout_rooms_closed") {
        setCall((cur) => cur?.chatId === event.chat_id
          ? { ...cur, breakoutRooms: null, breakoutParentChatId: null } : cur);
      }
    }
  }, [events, teardown]);

  const toggleRaiseHand = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    const next = !current.handRaised;
    setCall((c) => (c ? { ...c, handRaised: next } : c));
    sendRef.current({ type: next ? "group_call_raise_hand" : "group_call_lower_hand", chat_id: current.chatId });
  }, []);

  const sendCaption = useCallback((text) => {
    const current = callRef.current;
    if (!current || !text.trim()) return;
    setCall((c) => (c ? {
      ...c, captions: [...(c.captions || []), { from: "me", text, key: `${Date.now()}-me` }].slice(-MAX_CAPTION_LINES),
    } : c));
    sendRef.current({ type: "group_call_caption", chat_id: current.chatId, text });
  }, []);

  const switchCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const pub = room.localParticipant.getTrackPublication("camera");
    if (!pub?.track) return;
    try {
      const current = pub.track.mediaStreamTrack;
      const settings = current.getSettings();
      const nextFacing = settings.facingMode === "user" ? "environment" : "user";
      await pub.track.restartTrack({ ...CAMERA_CONSTRAINTS, facingMode: nextFacing });
    } catch { /* camera switch unavailable on this device */ }
  }, []);

  const declineIncoming = useCallback(() => setCall(null), []);

  const forceMuteAll = useCallback(() => {
    const c = callRef.current;
    if (c) sendRef.current({ type: "group_call_force_mute_all", chat_id: c.chatId });
  }, []);

  const muteParticipant = useCallback((userId) => {
    const c = callRef.current;
    if (c) sendRef.current({ type: "group_call_mute_participant", chat_id: c.chatId, target: userId });
  }, []);

  const kickParticipant = useCallback((userId) => {
    const c = callRef.current;
    if (c) sendRef.current({ type: "group_call_kick", chat_id: c.chatId, target: userId });
  }, []);

  const addPeople = useCallback((userIds) => {
    const c = callRef.current;
    if (c && userIds.length) sendRef.current({ type: "group_call_add_people", chat_id: c.chatId, call_kind: c.callKind, targets: userIds });
  }, []);

  const toggleWhiteboard = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    const next = !c.whiteboardOpen;
    setCall((cur) => cur ? { ...cur, whiteboardOpen: next } : cur);
    sendRef.current({ type: next ? "whiteboard_open" : "whiteboard_close", chat_id: c.chatId });
  }, []);

  const toggleCaptions = useCallback(() => {
    setCall((c) => c ? { ...c, captionsOn: !c.captionsOn, captions: c.captionsOn ? c.captions : [] } : c);
  }, []);

  const spotlight = useCallback((userId) => {
    const c = callRef.current;
    if (c) sendRef.current({ type: "group_call_spotlight", chat_id: c.chatId, target: userId });
  }, []);

  const transferHost = useCallback((userId) => {
    const c = callRef.current;
    if (c) sendRef.current({ type: "group_call_transfer_host", chat_id: c.chatId, target: userId });
  }, []);

  const setPermission = useCallback((feature, policy) => {
    const c = callRef.current;
    if (c) sendRef.current({ type: "group_call_set_permission", chat_id: c.chatId, feature, policy });
  }, []);

  const admitParticipant = useCallback((userId) => {
    const c = callRef.current;
    if (!c) return;
    sendRef.current({ type: "group_call_admit", chat_id: c.chatId, target: userId });
    setCall((cur) => cur ? { ...cur, joinRequests: (cur.joinRequests || []).filter((r) => r.user_id !== userId) } : cur);
  }, []);

  const denyParticipant = useCallback((userId) => {
    const c = callRef.current;
    if (!c) return;
    sendRef.current({ type: "group_call_deny", chat_id: c.chatId, target: userId });
    setCall((cur) => cur ? { ...cur, joinRequests: (cur.joinRequests || []).filter((r) => r.user_id !== userId) } : cur);
  }, []);

  const setScreenOptimization = useCallback(() => {}, []);

  const joinBreakoutRoom = useCallback(() => {}, []);
  const returnToMainCall = useCallback(() => {}, []);

  return {
    call,
    join,
    declineIncoming,
    leave,
    toggleMute,
    toggleCamera,
    shareScreen: toggleScreenShare,
    setScreenOptimization,
    switchCamera,
    forceMuteAll,
    kickParticipant,
    addPeople,
    toggleWhiteboard,
    sendReaction,
    toggleRaiseHand,
    toggleCaptions,
    sendCaption,
    joinBreakoutRoom,
    returnToMainCall,
    admitParticipant,
    denyParticipant,
    muteParticipant,
    spotlight,
    transferHost,
    setPermission,
    raiseHand: toggleRaiseHand,
  };
}
