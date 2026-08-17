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
        audio: true,
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
      }
    }
  }, [events, teardown]);

  return {
    call,
    join,
    leave,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    sendReaction,
    switchCamera: useCallback(() => {}, []),
    raiseHand: useCallback(() => {}, []),
    sendCaption: useCallback(() => {}, []),
  };
}
