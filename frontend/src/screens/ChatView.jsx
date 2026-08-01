import { useCallback, useEffect, useRef, useState } from "react";
import {
  Actions, Chats, Contacts, Me, Meetings, Messages, Pins, Scheduled, Search, Uploads, Users,
  sendReliably, sendFileReliably, newClientMessageId,
} from "../api.js";
import * as offlineDb from "../offlineDb.js";
import {
  Av, Button, EMOJIS, EMOJI_GROUPS, Field, G, I, SRow, Spinner, Toggle, clockTime, countdown,
  durationLabel, localInputToUnix, whenLabel,
} from "../ui.jsx";
import { useVoiceRecorder } from "../useVoiceRecorder.js";
import { canvasToPdfBlob } from "../imageToPdf.js";
import { STICKERS, STICKERS_BY_ID } from "../stickers.jsx";
import { shouldAutoDownload } from "../mediaPrefs.js";
import CameraCapture from "../CameraCapture.jsx";
import { COUNTRY_CODES, flagFor, splitPhone } from "../countryCodes.js";

const SLOW_MODE_CHOICES = [
  { label: "Off", seconds: 0 },
  { label: "10s", seconds: 10 },
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
];

const DISAPPEAR_CHOICES = [
  { label: "Off", seconds: null },
  { label: "5 min", seconds: 300 },
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
  { label: "90 days", seconds: 7776000 },
];

/**
 * One conversation.
 *
 * Sending is optimistic: the message is drawn immediately with a temporary id
 * and reconciled when the server answers. That is only safe because every send
 * carries a client_msg_id the server de-duplicates on — if the request is
 * retried, the same message comes back rather than a second copy.
 */
export default function ChatView({ chat, me, events, typingBy, reconnectedAt, onBack, onChanged,
                                   onOpenChat, onChatLocked, onStartCall, onStartGroupCall, toast }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState(chat.draft || "");
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [forwarding, setForwarding] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState(new Set());
  const [pins, setPins] = useState([]);
  const [starredIds, setStarredIds] = useState(() => new Set());
  const [showPins, setShowPins] = useState(false);
  const [readState, setReadState] = useState([]);
  const [sheet, setSheet] = useState(null);       // 'schedule' | 'meeting' | 'timer' | 'poll' | 'info' | 'attach' | 'contact' | 'scanEdit' | 'mediaPreview'
  const [scanFile, setScanFile] = useState(null); // the raw photo waiting in the scan-edit sheet
  const [mediaPreview, setMediaPreview] = useState(null); // {files, kindOverride} waiting in the caption sheet
  const [meetingUpdates, setMeetingUpdates] = useState({});
  const [members, setMembers] = useState([]); // for @mention autocomplete — group-like chats only
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [chatSearchResults, setChatSearchResults] = useState([]);
  const inputRef = useRef(chat.draft || "");
  const bottom = useRef(null);
  const typingSentAt = useRef(0);
  const lastApplied = useRef(0);
  const lastPinEvent = useRef(0);
  const lastReadEvent = useRef(0);

  const highestSeq = messages.reduce((top, message) => Math.max(top, message.seq || 0), 0);

  // Keep ref in sync so the unmount cleanup can read it without depending on state.
  useEffect(() => { inputRef.current = input; }, [input]);

  // Save draft on unmount (leaving the chat).
  useEffect(() => {
    return () => {
      const text = inputRef.current || "";
      Chats.settings(chat.id, { draft: text }).catch(() => {});
    };
  }, [chat.id]);

  // ── Loading and live updates ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Messages.list(chat.id, 50)
      .then((page) => {
        if (cancelled) return;
        setMessages(page);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [chat.id]);

  // Mark read whenever the newest message changes while the chat is open.
  useEffect(() => {
    if (!highestSeq) return;
    Actions.markRead(chat.id, highestSeq).then(onChanged).catch(() => {});
  }, [chat.id, highestSeq]);

  // @mentions only make sense where there's more than one other person to
  // name — skipped entirely for a DM. Reuses the same endpoint ChatInfoSheet
  // calls for its member list, rather than adding a second one.
  useEffect(() => {
    if (!MANAGED_TYPES.includes(chat.type)) { setMembers([]); return; }
    Chats.get(chat.id).then((full) => setMembers(full.members || [])).catch(() => {});
  }, [chat.id, chat.type]);

  const reloadPins = useCallback(() => {
    Pins.list(chat.id).then(setPins).catch(() => {});
  }, [chat.id]);

  useEffect(reloadPins, [reloadPins]);

  // Stars are personal and cross-chat, so /me/starred returns every chat's —
  // filtered down to this one here, rather than adding a chat-scoped star
  // endpoint just to avoid one client-side filter.
  useEffect(() => {
    Me.starred()
      .then((list) => setStarredIds(new Set(
        list.filter((m) => m.chat_id === chat.id).map((m) => m.id))))
      .catch(() => {});
  }, [chat.id]);

  // Read state: the lowest last_read_seq among everyone else determines what
  // "read" means for a message. In a DM that is simply the peer's marker; in a
  // group it is "has everyone seen this" — the same rule WhatsApp groups use.
  const reloadReadState = useCallback(() => {
    Chats.readState(chat.id).then(setReadState).catch(() => {});
  }, [chat.id]);

  useEffect(reloadReadState, [reloadReadState]);

  useEffect(() => {
    if (events.some((event) => event._n > lastReadEvent.current && event.chat_id === chat.id
                               && event.type === "read")) {
      lastReadEvent.current = events[events.length - 1]._n;
      reloadReadState();
    }
  }, [events, chat.id, reloadReadState]);

  const readUpToSeq = readState.length
    ? Math.min(...readState.map((row) => row.last_read_seq))
    : null;

  // A pin from anyone in the chat has to update everyone's view of the pinned
  // list, not just the person who pinned it.
  useEffect(() => {
    if (events.some((event) => event._n > lastPinEvent.current && event.chat_id === chat.id
                               && event.type === "pins_changed")) {
      lastPinEvent.current = events[events.length - 1]._n;
      reloadPins();
    }
  }, [events, chat.id, reloadPins]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Apply every event pushed over the socket that we have not seen yet.
  //
  // Tracking the last applied number matters twice over: a burst of events
  // arriving between renders is applied in full rather than only the newest,
  // and React's development double-invocation of effects cannot apply the same
  // event a second time.
  useEffect(() => {
    const fresh = events.filter((event) => event._n > lastApplied.current);
    if (!fresh.length) return;
    lastApplied.current = fresh[fresh.length - 1]._n;

    const forThisChat = fresh.filter((event) =>
      (event.message ? event.message.chat_id : event.chat_id) === chat.id);
    if (!forThisChat.length) return;

    setMessages((current) => forThisChat.reduce(applyEvent, current));

    // Meetings live in their own table, not in the message list, so their
    // events are collected separately and handed to the cards. Without this a
    // card showed whatever it fetched when it mounted and never moved, so
    // someone else's RSVP or the meeting starting went unnoticed.
    const meetingEvents = forThisChat.filter((event) =>
      event.type?.startsWith("meeting_"));
    if (meetingEvents.length) {
      setMeetingUpdates((current) => {
        const next = { ...current };
        for (const event of meetingEvents) {
          const id = event.meeting?.id || event.meeting_id;
          if (!id) continue;
          next[id] = event.meeting || { ...(next[id] || {}), _stale: Date.now() };
        }
        return next;
      });
    }
  }, [events, chat.id]);

  // After a reconnect, ask for exactly what was missed rather than refetching.
  const catchUp = useCallback(async () => {
    if (!highestSeq) return;
    try {
      const missed = await Messages.after(chat.id, highestSeq);
      if (missed.length) setMessages((current) => mergeBySeq(current, missed));
    } catch { /* the next event or reopen will fix it */ }
  }, [chat.id, highestSeq]);

  useEffect(() => {
    window.addEventListener("online", catchUp);
    return () => window.removeEventListener("online", catchUp);
  }, [catchUp]);

  // And whenever the socket itself comes back. This is the case that actually
  // matters: the browser never reports going offline when a socket drops on a
  // flaky connection or because the server restarted, so without this the gap
  // was never filled and those messages simply never appeared.
  useEffect(() => {
    if (reconnectedAt) catchUp();
  }, [reconnectedAt, catchUp]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function send() {
    const text = input.trim();
    if (!text) return;

    if (editing) {
      const editingId = editing.id;
      try {
        const updated = await Actions.edit(editingId, text);
        setMessages((current) => current.map((m) => (m.id === editingId
          // null means queued — no server copy to apply yet, so show the
          // edit locally with the same "still syncing" mark a queued send
          // gets, rather than pretending nothing happened.
          ? (updated || { ...m, text, edited_at: Date.now() / 1000, queued: true })
          : m)));
      } catch (problem) {
        toast(problem.message || "Could not edit");
      }
      setEditing(null);
      setInput("");
      return;
    }

    // Draw it straight away. `pending` marks it so the bubble can show a clock
    // instead of a tick until the server confirms.
    //
    // The client_msg_id is generated here rather than inside sendReliably,
    // because it is what ties this on-screen copy to the one that will arrive
    // back over the socket. Without it the two look like different messages and
    // the send appears twice.
    const clientMsgId = newClientMessageId();
    const temporary = {
      id: "pending_" + clientMsgId,
      client_msg_id: clientMsgId,
      chat_id: chat.id, sender_id: me.id, text, kind: "text",
      created_at: Date.now() / 1000, seq: highestSeq + 1,
      reactions: [], pending: true,
      reply_to_id: replyTo?.id || null,
    };
    setMessages((current) => [...current, temporary]);
    setInput("");
    setReplyTo(null);

    try {
      const stored = await sendReliably({
        chatId: chat.id, text, replyToId: temporary.reply_to_id, clientMsgId,
      });
      setMessages((current) =>
        stored
          // upsert handles both orders: whether the socket echo beat this
          // response or not, the result is exactly one copy.
          ? upsertMessage(current, stored)
          // null means it went to the outbox: keep showing it, still pending.
          : current.map((m) => (m.id === temporary.id ? { ...m, queued: true } : m)));
      onChanged();
    } catch (problem) {
      setMessages((current) => current.filter((m) => m.id !== temporary.id));
      toast(problem.message || "Could not send");
    }
  }

  function onType(value) {
    setInput(value);
    // Throttled: one typing signal every two seconds, not one per keystroke.
    const now = Date.now();
    if (now - typingSentAt.current > 2000) {
      typingSentAt.current = now;
      window.dispatchEvent(new CustomEvent("ht:typing", { detail: chat.id }));
    }
  }

  async function react(message, emoji) {
    const mine = message.reactions?.find((r) => r.emoji === emoji && r.mine);
    try {
      const updated = mine
        ? await Actions.unreact(message.id, emoji)
        : await Actions.react(message.id, emoji);
      setMessages((current) => current.map((m) => {
        if (m.id !== message.id) return m;
        if (updated) return { ...m, reactions: updated };
        // Queued — toggle it locally so the tap visibly did something. The
        // server's real tally replaces this the moment the queued action
        // actually lands and a fresh copy of the message arrives.
        const without = (m.reactions || []).filter((r) => r.emoji !== emoji);
        const existing = (m.reactions || []).find((r) => r.emoji === emoji);
        const nextCount = mine ? (existing?.count || 1) - 1 : (existing?.count || 0) + 1;
        const next = nextCount > 0 ? [...without, { emoji, count: nextCount, mine: !mine }] : without;
        return { ...m, reactions: next };
      }));
    } catch (problem) {
      toast(problem.message || "Could not react");
    }
    setMenuFor(null);
  }

  async function unsend(message) {
    // No optimistic tombstone here on purpose — unsend has no visible trace
    // at all. The server broadcasts message_unsent, which is what actually
    // removes it from every other open client; here, the same removal is
    // applied locally right away whether it went through immediately or was
    // queued for later — both eventually reach the same end state.
    try {
      await Actions.unsend(message.id);
      setMessages((current) => current.filter((m) => m.id !== message.id));
    } catch (problem) {
      toast(problem.message || "Could not unsend");
    }
    setMenuFor(null);
  }

  async function removeForEveryone(message) {
    // Delete for everyone — the server broadcasts this once it actually
    // runs, so every other open client updates too. Unlike unsend, this
    // leaves a "This message was deleted" tombstone behind, applied locally
    // now regardless of whether the call went through or got queued.
    try {
      await Actions.deleteForEveryone(message.id);
      setMessages((current) => current.map((m) =>
        m.id === message.id ? { ...m, deleted_at: Date.now() / 1000, text: "" } : m));
    } catch (problem) {
      toast(problem.message || "Could not delete");
    }
    setMenuFor(null);
  }

  async function hideForMe(message) {
    // Delete for me — nothing is broadcast, so the local removal here IS the
    // whole effect regardless of whether the call landed immediately or was
    // queued. Drop the row entirely rather than showing a tombstone: unlike
    // a real delete, nobody else needs to see that this ever existed.
    try {
      await Actions.hide(message.id);
      setMessages((current) => current.filter((m) => m.id !== message.id));
    } catch (problem) {
      toast(problem.message || "Could not delete");
    }
    setMenuFor(null);
  }

  async function vote(message, optionIndex) {
    try {
      const updated = await Actions.vote(message.id, optionIndex);
      if (updated) {
        setMessages((current) => current.map((m) => (m.id === updated.id ? updated : m)));
      } else {
        toast("Vote queued — counts once you're back online");
      }
    } catch (problem) {
      toast(problem.message || "Could not vote");
    }
  }

  async function togglePin(message) {
    const isPinned = pins.some((p) => p.id === message.id);
    try {
      const result = isPinned ? await Actions.unpin(message.id) : await Actions.pin(message.id);
      if (result === null) {
        // Queued — a real reload can't reach the server to confirm this
        // right now, so reflect the change locally until it can.
        setPins((current) => isPinned
          ? current.filter((p) => p.id !== message.id)
          : [...current, message]);
      } else {
        reloadPins();
      }
    } catch (problem) {
      toast(problem.message || "Could not update pin");
    }
    setMenuFor(null);
  }

  async function toggleStar(message) {
    try {
      if (starredIds.has(message.id)) {
        await Actions.unstar(message.id);
        setStarredIds((current) => {
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
      } else {
        await Actions.star(message.id);
        setStarredIds((current) => new Set(current).add(message.id));
      }
    } catch (problem) {
      toast(problem.message || "Could not update star");
    }
    setMenuFor(null);
  }

  async function forwardTo(message, toChatIds) {
    await Messages.forward(message.id, toChatIds);
    toast(toChatIds.length === 1 ? "Forwarded" : `Forwarded to ${toChatIds.length} chats`);
    setForwarding(null);
  }

  const [uploading, setUploading] = useState(false);

  function sendVoiceNote(blob) {
    // MediaRecorder produces a Blob, not a File — Uploads.create needs
    // something with a filename, so wrap it. The extension is cosmetic; the
    // server trusts the declared content type, not the name, for playback.
    const extension = blob.type.includes("mp4") ? "m4a" : "webm";
    const file = new File([blob], `voice-note.${extension}`, { type: blob.type });
    sendFile(file, "voice");
  }

  async function sendFile(file, kindOverride, text = "", viewOnce = false) {
    // Anything that came from an <input accept="image/*,video/*"> is a photo
    // or a video; anything else is a document. A recorded voice note, or a
    // file picked explicitly via the "Document" attach option, passes its
    // kind directly instead of relying on this guess.
    const kind = kindOverride
      || (file.type.startsWith("image/") ? "photo"
        : file.type.startsWith("video/") ? "video"
        : "document");

    const clientMsgId = newClientMessageId();
    // Drawn immediately from the file itself — same reason the text send
    // draws optimistically: the network round-trip (here, two of them —
    // upload, then send) must never be what decides whether something
    // appears on screen. Voice/photo/video get a real preview; a document
    // just shows its name, same as the eventual server-backed row will.
    const localUrl = (kind === "photo" || kind === "video" || kind === "voice")
      ? URL.createObjectURL(file) : null;
    const temporary = {
      id: "pending_" + clientMsgId, client_msg_id: clientMsgId,
      chat_id: chat.id, sender_id: me.id, text, kind,
      created_at: Date.now() / 1000, seq: highestSeq + 1,
      reactions: [], pending: true, view_once: viewOnce,
      payload: { file_name: file.name, size_bytes: file.size, _localUrl: localUrl },
    };
    setMessages((current) => [...current, temporary]);

    setUploading(true);
    try {
      const stored = await sendFileReliably({ chatId: chat.id, file, kind, text, viewOnce, clientMsgId });
      setMessages((current) =>
        stored
          ? upsertMessage(current, stored)
          // null means it went to the pending-uploads queue: keep showing
          // the local preview, marked queued instead of pending.
          : current.map((m) => (m.id === temporary.id ? { ...m, queued: true } : m)));
      if (stored) onChanged();
    } catch (problem) {
      setMessages((current) => current.filter((m) => m.id !== temporary.id));
      if (localUrl) URL.revokeObjectURL(localUrl);
      toast(problem.message || "Could not send file");
    } finally {
      setUploading(false);
    }
  }

  // A queued photo/video/voice/document that finished sending — flushed
  // from App.jsx's top-level listener, not necessarily from this component,
  // so the two sides talk through a window event the same way "ht:typing"
  // already does elsewhere in this file.
  useEffect(() => {
    function onQueuedSent(event) {
      const stored = event.detail;
      if (stored.chat_id !== chat.id) return;
      setMessages((current) => {
        const match = current.find((m) => m.client_msg_id === stored.client_msg_id);
        if (match?.payload?._localUrl) URL.revokeObjectURL(match.payload._localUrl);
        return upsertMessage(current, stored);
      });
    }
    function onQueuedFailed(event) {
      if (event.detail.chatId !== chat.id) return;
      setMessages((current) => {
        const match = current.find((m) => m.client_msg_id === event.detail.clientMsgId);
        if (match?.payload?._localUrl) URL.revokeObjectURL(match.payload._localUrl);
        return current.filter((m) => m.client_msg_id !== event.detail.clientMsgId);
      });
      toast("A queued file could not be sent");
    }
    window.addEventListener("ht:queued-sent", onQueuedSent);
    window.addEventListener("ht:queued-failed", onQueuedFailed);
    return () => {
      window.removeEventListener("ht:queued-sent", onQueuedSent);
      window.removeEventListener("ht:queued-failed", onQueuedFailed);
    };
  }, [chat.id]);

  // Anything already queued from a previous visit to this chat (the tab was
  // closed and reopened before it ever got a connection back) — merged in
  // once on mount so a queued photo doesn't just vanish across a reload.
  useEffect(() => {
    let cancelled = false;
    offlineDb.getPendingUploads(chat.id).then((pending) => {
      if (cancelled || pending.length === 0) return;
      setMessages((current) => {
        const known = new Set(current.map((m) => m.client_msg_id));
        const synthetic = pending
          .filter((item) => !known.has(item.client_msg_id))
          .map((item) => ({
            id: "pending_" + item.client_msg_id, client_msg_id: item.client_msg_id,
            chat_id: item.chat_id, sender_id: me.id, text: item.text, kind: item.kind,
            created_at: item.created_at / 1000, seq: highestSeq + 1,
            reactions: [], pending: true, queued: true, view_once: item.view_once,
            payload: {
              file_name: item.file_name, size_bytes: item.file.size,
              _localUrl: ["photo", "video", "voice"].includes(item.kind)
                ? URL.createObjectURL(item.file) : null,
            },
          }));
        return synthetic.length ? [...current, ...synthetic] : current;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  // Sent one at a time rather than in parallel, so a burst of picked photos
  // lands in the chat in the same order they were picked, and one failure
  // partway through doesn't leave the upload endpoint fighting itself.
  async function sendFiles(files, kindOverride, text = "", viewOnce = false) {
    for (const file of files) {
      await sendFile(file, kindOverride, text, viewOnce);
    }
  }

  // Only one live share can be running from this tab at a time. A ref, not
  // state — nothing here needs to trigger a re-render, and a ref survives
  // the setTimeout closure below without going stale.
  const liveLocationRef = useRef(null); // { watchId, messageId }

  const stopLiveLocation = useCallback(() => {
    if (liveLocationRef.current?.watchId != null) {
      navigator.geolocation.clearWatch(liveLocationRef.current.watchId);
    }
    liveLocationRef.current = null;
  }, []);

  useEffect(() => stopLiveLocation, [stopLiveLocation]);

  function startLiveTracking(messageId, liveSeconds) {
    stopLiveLocation();
    let lastSentAt = 0;
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        // watchPosition can fire every second or two on a moving device —
        // pushing every tick would hammer the server for no visible benefit.
        const now = Date.now();
        if (now - lastSentAt < 12000) return;
        lastSentAt = now;
        Messages.updateLocation(messageId, position.coords.latitude, position.coords.longitude)
          .then((updated) => setMessages((current) => upsertMessage(current, updated)))
          .catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true },
    );
    liveLocationRef.current = { watchId, messageId };
    setTimeout(() => {
      // Only stop if nothing newer has started in the meantime — a stale
      // timeout from a share that already ended must not clear a fresh one.
      if (liveLocationRef.current?.messageId === messageId) stopLiveLocation();
    }, liveSeconds * 1000);
  }

  function sendLocation(liveSeconds) {
    if (!navigator.geolocation) {
      toast("Location isn't available in this browser");
      return;
    }
    setSheet(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const payload = { lat: position.coords.latitude, lng: position.coords.longitude };
          if (liveSeconds) payload.live_until = Date.now() / 1000 + liveSeconds;
          const stored = await Messages.send({
            chat_id: chat.id, kind: "location", text: "",
            payload, client_msg_id: newClientMessageId(),
          });
          setMessages((current) => upsertMessage(current, stored));
          onChanged();
          if (liveSeconds) startLiveTracking(stored.id, liveSeconds);
        } catch (problem) {
          toast(problem.message || "Could not send location");
        }
      },
      () => toast("Location permission denied"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function sendContact(name, phone) {
    try {
      const stored = await Messages.send({
        chat_id: chat.id, kind: "contact", text: "",
        payload: { name, phone },
        client_msg_id: newClientMessageId(),
      });
      setMessages((current) => upsertMessage(current, stored));
      onChanged();
      setSheet(null);
    } catch (problem) {
      toast(problem.message || "Could not send contact");
    }
  }

  async function sendSticker(stickerId) {
    try {
      const stored = await Messages.send({
        chat_id: chat.id, kind: "sticker", text: "",
        payload: { sticker_id: stickerId },
        client_msg_id: newClientMessageId(),
      });
      setMessages((current) => upsertMessage(current, stored));
      onChanged();
      setSheet(null);
    } catch (problem) {
      toast(problem.message || "Could not send sticker");
    }
  }

  async function sendScanPdf(pdfBlob) {
    const pdfFile = new File([pdfBlob], "scan.pdf", { type: "application/pdf" });
    await sendFile(pdfFile, "document");
    setSheet(null);
    setScanFile(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const typingNames = Object.values(typingBy[chat.id] || {});

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Header chat={chat} typing={typingNames} onBack={onBack}
              onTimer={() => setSheet("timer")}
              onMeeting={() => setSheet("meeting")}
              onInfo={() => setSheet("info")}
              onVoiceCall={() => (chat.type === "dm" ? onStartCall("voice") : onStartGroupCall("voice"))}
              onVideoCall={() => (chat.type === "dm" ? onStartCall("video") : onStartGroupCall("video"))}
              pinCount={pins.length}
              onTogglePins={() => setShowPins((v) => !v)}
              onSearch={() => { setChatSearchOpen((v) => !v); setChatSearchQuery(""); setChatSearchResults([]); }}/>

      {chatSearchOpen && (
        <ChatSearchBar chatId={chat.id} query={chatSearchQuery}
                       onChange={setChatSearchQuery} results={chatSearchResults}
                       setResults={setChatSearchResults}
                       onClose={() => { setChatSearchOpen(false); setChatSearchQuery(""); setChatSearchResults([]); }}
                       onJump={(id) => {
                         document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                       }}/>
      )}

      {showPins && pins.length > 0 && (
        <PinnedBar pins={pins} onJump={(id) => {
          document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}/>
      )}

      {selectMode && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "8px 14px",
          borderBottom: `1px solid ${G.border}`, background: G.card2,
        }}>
          <div onClick={() => { setSelectMode(false); setSelectedMsgIds(new Set()); }}
               style={{ cursor: "pointer" }}>{I.back()}</div>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
            {selectedMsgIds.size} selected
          </div>
          <div onClick={() => {
            if (!selectedMsgIds.size) return;
            setForwarding({ ids: [...selectedMsgIds] });
            setSelectMode(false);
            setSelectedMsgIds(new Set());
          }} style={{ cursor: selectedMsgIds.size ? "pointer" : "default", opacity: selectedMsgIds.size ? 1 : 0.4 }}
               title="Forward selected">
            {I.send(G.accent, 18)}
          </div>
          <div onClick={async () => {
            if (!selectedMsgIds.size) return;
            await Promise.all([...selectedMsgIds].map((id) => Messages.hide(id)));
            setMessages((c) => c.filter((m) => !selectedMsgIds.has(m.id)));
            toast(`${selectedMsgIds.size} deleted`);
            setSelectMode(false);
            setSelectedMsgIds(new Set());
          }} style={{ cursor: selectedMsgIds.size ? "pointer" : "default", opacity: selectedMsgIds.size ? 1 : 0.4 }}
               title="Delete for me">
            {I.trash(G.red, 18)}
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
        {loading ? <Spinner/> : messages.map((message) => (
          <div key={message.id} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            {selectMode && (
              <div onClick={() => setSelectedMsgIds((prev) => {
                const next = new Set(prev);
                if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
                return next;
              })} style={{
                marginTop: 10, width: 20, height: 20, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                border: `2px solid ${selectedMsgIds.has(message.id) ? G.accent : G.border}`,
                background: selectedMsgIds.has(message.id) ? G.accent : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {selectedMsgIds.has(message.id) && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>✓</span>}
              </div>
            )}
            <div style={{ flex: 1 }}>
              <Bubble message={message} me={me}
                      replyTarget={messages.find((m) => m.id === message.reply_to_id)}
                      meetingUpdates={meetingUpdates}
                      isPinned={pins.some((p) => p.id === message.id)}
                      isRead={readUpToSeq !== null && message.seq <= readUpToSeq}
                      onLongPress={() => {
                        // Nothing sitting in the send queue has a real
                        // server id yet ("pending_..." is a local stand-in)
                        // — reacting, editing, pinning or selecting it would
                        // just fail against an id the server has never seen.
                        if (message.pending || message.queued) return;
                        if (selectMode) {
                          setSelectedMsgIds((prev) => {
                            const n = new Set(prev);
                            if (n.has(message.id)) n.delete(message.id); else n.add(message.id);
                            return n;
                          });
                        } else {
                          setMenuFor(message);
                        }
                      }}
                      onVote={(index) => vote(message, index)}
                      onCallAgain={(kind) => onStartCall(kind)} toast={toast}/>
            </div>
          </div>
        ))}
        <div ref={bottom}/>
      </div>

      {replyTo && (
        <Banner label={`Replying to: ${replyTo.text?.slice(0, 60) || "message"}`}
                onClear={() => setReplyTo(null)}/>
      )}
      {editing && (
        <Banner label={`Editing: ${editing.text?.slice(0, 60)}`}
                onClear={() => { setEditing(null); setInput(""); }}/>
      )}

      <Composer
        value={input}
        onChange={onType}
        onSend={send}
        onSchedule={() => setSheet("schedule")}
        onAttach={() => setSheet("attach")}
        onVoice={sendVoiceNote}
        uploading={uploading}
        disappearSecs={chat.disappear_secs}
        editing={Boolean(editing)}
        members={members}
        toast={toast}/>

      {menuFor && (
        <MessageMenu
          message={menuFor} me={me}
          isModerator={chat.role === "owner" || chat.role === "admin"}
          isPinned={pins.some((p) => p.id === menuFor.id)}
          isStarred={starredIds.has(menuFor.id)}
          onClose={() => setMenuFor(null)}
          onReact={(emoji) => react(menuFor, emoji)}
          onReply={() => { setReplyTo(menuFor); setMenuFor(null); }}
          onEdit={() => { setEditing(menuFor); setInput(menuFor.text); setMenuFor(null); }}
          onUnsend={() => unsend(menuFor)}
          onDeleteForEveryone={() => removeForEveryone(menuFor)}
          onHide={() => hideForMe(menuFor)}
          onPin={() => togglePin(menuFor)}
          onStar={() => toggleStar(menuFor)}
          onForward={() => { setForwarding(menuFor); setMenuFor(null); }}
          onCopy={() => {
            navigator.clipboard?.writeText(menuFor.text || "");
            toast("Copied");
            setMenuFor(null);
          }}
          onSelect={() => {
            setSelectMode(true);
            setSelectedMsgIds(new Set([menuFor.id]));
            setMenuFor(null);
          }}/>
      )}

      {forwarding && (
        <ForwardSheet message={forwarding} onClose={() => setForwarding(null)}
                      onForward={(toChatIds) => forwardTo(forwarding, toChatIds)}/>
      )}

      {sheet === "timer" && (
        <TimerSheet chat={chat} onClose={() => setSheet(null)}
                    onPicked={async (seconds) => {
                      await Chats.setDisappearing(chat.id, seconds);
                      toast(seconds ? `Messages vanish after ${durationLabel(seconds)}` : "Timer off");
                      setSheet(null);
                      onChanged();
                    }}/>
      )}

      {sheet === "schedule" && (
        <ScheduleSheet chat={chat} onClose={() => setSheet(null)} toast={toast}/>
      )}

      {sheet === "meeting" && (
        <MeetingSheet chat={chat} onClose={() => setSheet(null)} toast={toast}/>
      )}

      {sheet === "poll" && (
        <PollSheet chat={chat} onClose={() => setSheet(null)} toast={toast}
                   onCreated={(message) => setMessages((c) => [...c, message])}/>
      )}

      {sheet === "attach" && (
        <AttachSheet onClose={() => setSheet(null)} onFile={sendFile}
                     onLocation={() => setSheet("location")} onContact={() => setSheet("contact")}
                     onPoll={() => setSheet("poll")} onSticker={() => setSheet("sticker")}
                     onScanCaptured={(file) => { setScanFile(file); setSheet("scanEdit"); }}
                     onFilesPicked={(files, kindOverride) => {
                       setMediaPreview({ files, kindOverride });
                       setSheet("mediaPreview");
                     }}/>
      )}

      {sheet === "sticker" && (
        <StickerPickerSheet onClose={() => setSheet(null)} onPick={sendSticker}/>
      )}

      {sheet === "location" && (
        <LiveLocationSheet onClose={() => setSheet(null)} onPicked={sendLocation}/>
      )}

      {sheet === "contact" && (
        <ContactSheet onClose={() => setSheet(null)} onSave={sendContact} toast={toast}/>
      )}

      {sheet === "scanEdit" && scanFile && (
        <ScanEditSheet file={scanFile} toast={toast}
                       onClose={() => { setSheet(null); setScanFile(null); }}
                       onSend={sendScanPdf}/>
      )}

      {sheet === "mediaPreview" && mediaPreview && (
        <MediaPreviewSheet files={mediaPreview.files} kindOverride={mediaPreview.kindOverride}
                           onClose={() => { setSheet(null); setMediaPreview(null); }}
                           onSend={sendFiles}/>
      )}

      {sheet === "info" && (
        <ChatInfoSheet chat={chat} me={me} events={events} onClose={() => setSheet(null)} toast={toast}
                       onChanged={onChanged} onOpenChat={onOpenChat} onChatLocked={onChatLocked}
                       onLeft={() => { setSheet(null); onBack(); }}/>
      )}
    </div>
  );
}

// ── Event handling ───────────────────────────────────────────────────────────

function applyEvent(messages, event) {
  switch (event.type) {
    case "message":
      return upsertMessage(messages, event.message);

    case "message_edited":
    case "poll_updated":
      return messages.map((m) => (m.id === event.message.id ? event.message : m));

    case "message_deleted":
      return messages.map((m) =>
        m.id === event.message_id ? { ...m, deleted_at: Date.now() / 1000, text: "" } : m);

    case "message_unsent":
      // No tombstone — an unsent message is removed outright, for every
      // viewer including the sender, same as it never having been sent.
      return messages.filter((m) => m.id !== event.message_id);

    case "message_expired":
      return messages.map((m) =>
        m.id === event.message_id ? { ...m, text: "", expired: true } : m);

    case "reaction":
      return messages.map((m) =>
        m.id === event.message_id ? { ...m, reactions: event.reactions } : m);

    default:
      return messages;
  }
}

/**
 * Insert or replace one message.
 *
 * The same stored message can reach this list by two routes at once: the reply
 * to our own POST, and the echo the server pushes over the socket. Whichever
 * arrives first wins, and the second is absorbed rather than added again.
 *
 * Matching is by id, then by client_msg_id — the optimistic copy on screen has
 * a temporary id, so client_msg_id is the only thing tying it to the stored
 * message. Doing this in one place is what keeps the two routes from fighting:
 * an earlier version filtered by id in one path and mapped by id in the other,
 * and a message could end up duplicated or deleted depending on which raced in.
 */
function upsertMessage(messages, incoming) {
  const index = messages.findIndex((m) =>
    m.id === incoming.id ||
    (incoming.client_msg_id && m.client_msg_id === incoming.client_msg_id));

  if (index === -1) return [...messages, incoming];

  const next = [...messages];
  next[index] = incoming;
  return next;
}

/** Merge a catch-up page in without duplicating what we already hold. */
function mergeBySeq(current, incoming) {
  return incoming.reduce(upsertMessage, current).sort((a, b) => a.seq - b.seq);
}

// ── Pieces ───────────────────────────────────────────────────────────────────

// A DM never needs to name the one other person who could possibly be
// typing — a group does, or "typing…" is ambiguous about who.
function typingLabel(names, isGroup) {
  if (names.length === 0) return "";
  if (!isGroup) return "typing…";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} others are typing…`;
}

function Header({ chat, typing, onBack, onTimer, onMeeting, onInfo, onVoiceCall, onVideoCall,
                   pinCount, onTogglePins, onSearch }) {
  const isGroup = chat.type !== "dm";
  const label = typingLabel(typing, isGroup);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
      borderBottom: `1px solid ${G.border}`, background: G.surface,
      position: "sticky", top: 0, zIndex: 5, flexShrink: 0,
    }}>
      <div onClick={onBack} style={{ cursor: "pointer" }}>{I.back()}</div>
      <div onClick={onInfo} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, cursor: "pointer" }}>
        <Av av={chat.avatar_letter} color={chat.color} size={38} photoId={chat.avatar_attachment_id}
            online={chat.peer_online}/>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {chat.name || "Direct message"}
          </div>
          <div style={{
            fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            color: label ? G.accentText : chat.peer_online ? G.green : G.muted,
          }}>
            {label
              ? label
              : chat.type === "dm" ? (chat.peer_online ? "online" : "offline")
              : chat.description ? chat.description
              : chat.type}
          </div>
        </div>
      </div>
      <div onClick={onSearch} style={{ cursor: "pointer" }} title="Search in chat">
        {I.search(G.sub, 18)}
      </div>
      {pinCount > 0 && (
        <div onClick={onTogglePins} style={{ cursor: "pointer", position: "relative" }}
             title={`${pinCount} pinned`}>
          {I.pin(G.accentText, 18)}
        </div>
      )}
      {(chat.type === "dm" || chat.type === "group") && (
        <>
          <div onClick={onVoiceCall} style={{ cursor: "pointer" }} title="Voice call">
            {I.phone(G.sub, 19)}
          </div>
          <div onClick={onVideoCall} style={{ cursor: "pointer" }} title="Video call">
            {I.video(G.sub, 20)}
          </div>
        </>
      )}
      <div onClick={onMeeting} style={{ cursor: "pointer" }} title="Schedule a meeting">
        {I.calendar(G.sub, 20)}
      </div>
      <div onClick={onTimer} style={{ cursor: "pointer" }} title="Disappearing messages">
        {I.timer(chat.disappear_secs ? G.yellow : G.sub, 20)}
      </div>
    </div>
  );
}

function EmojiPicker({ onPick, onClose }) {
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? EMOJI_GROUPS.flatMap((g) => g.items).filter(([, name]) => name.includes(query.trim().toLowerCase()))
    : EMOJI_GROUPS[tab].items;

  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", bottom: "100%", left: 12, right: 12, marginBottom: 4,
      background: G.surface, border: `1px solid ${G.border}`, borderRadius: 14,
      boxShadow: `0 4px 16px ${G.border}`, overflow: "hidden", height: 280, display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: `1px solid ${G.border}` }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Search emoji…" style={{
                 flex: 1, border: "none", outline: "none", background: G.dim,
                 borderRadius: 8, padding: "6px 10px", fontSize: 12.5, color: G.text,
               }}/>
        <div onClick={onClose} style={{ cursor: "pointer", fontSize: 16, color: G.muted }}>×</div>
      </div>

      {!query.trim() && (
        <div style={{ display: "flex", overflowX: "auto", borderBottom: `1px solid ${G.border}` }}>
          {EMOJI_GROUPS.map((g, i) => (
            <div key={g.label} onClick={() => setTab(i)} style={{
              padding: "6px 10px", fontSize: 16, cursor: "pointer", flexShrink: 0,
              background: tab === i ? G.accentSoft : "transparent",
              borderBottom: tab === i ? `2px solid ${G.accent}` : "2px solid transparent",
            }}>{g.icon}</div>
          ))}
        </div>
      )}

      <div style={{
        flex: 1, overflowY: "auto", padding: 8, display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)", gap: 2,
      }}>
        {filtered.map(([emoji, name]) => (
          <div key={emoji} onClick={() => onPick(emoji)} title={name} style={{
            fontSize: 22, textAlign: "center", padding: "4px 0", cursor: "pointer", borderRadius: 8,
          }}>{emoji}</div>
        ))}
        {filtered.length === 0 && (
          <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: G.muted, textAlign: "center", padding: 16 }}>
            No emoji found
          </div>
        )}
      </div>
    </div>
  );
}

function ChatSearchBar({ chatId, query, onChange, results, setResults, onClose, onJump }) {
  const timerRef = useRef(null);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!query || query.trim().length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(() => {
      Search.query(query, chatId).then(setResults).catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query, chatId]);

  return (
    <div style={{ borderBottom: `1px solid ${G.border}`, background: G.card2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
        {I.search(G.muted, 16)}
        <input value={query} onChange={(e) => onChange(e.target.value)}
               placeholder="Search in chat…" autoFocus
               style={{
                 flex: 1, border: "none", outline: "none", background: "transparent",
                 fontSize: 13.5, color: G.text,
               }}/>
        {results.length > 0 && (
          <span style={{ fontSize: 11, color: G.muted, whiteSpace: "nowrap" }}>
            {results.length} found
          </span>
        )}
        <div onClick={onClose} style={{ cursor: "pointer", fontSize: 18, color: G.muted }}>×</div>
      </div>
      {results.length > 0 && (
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          {results.map((r) => (
            <div key={r.id} onClick={() => onJump(r.id)} style={{
              padding: "6px 14px", fontSize: 12.5, color: G.text, cursor: "pointer",
              borderTop: `1px solid ${G.border}`, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            }}>
              <span style={{ color: G.muted, marginRight: 6 }}>{whenLabel(r.created_at)}</span>
              {r.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PinnedBar({ pins, onJump }) {
  return (
    <div style={{
      display: "flex", gap: 8, overflowX: "auto", padding: "8px 14px",
      background: G.card2, borderBottom: `1px solid ${G.border}`,
    }}>
      {pins.map((pin) => (
        <div key={pin.id} onClick={() => onJump(pin.id)} style={{
          flexShrink: 0, maxWidth: 220, padding: "6px 10px", borderRadius: 10,
          background: G.dim, border: `1px solid ${G.border}`, cursor: "pointer",
          fontSize: 12, color: G.text, whiteSpace: "nowrap", overflow: "hidden",
          textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 6,
        }}>
          {I.pin(G.accentText, 12)}
          {pin.text || `[${pin.kind}]`}
        </div>
      ))}
    </div>
  );
}

// Splits "@word" tokens out of message text and highlights them. Any
// @-token is styled, not just ones matching a real member — the same
// distinction Telegram's renderer draws, since validating requires the
// full member list and this runs on every bubble, not just the composer
// where that list is already loaded for autocomplete.
// WhatsApp/Telegram-style inline markdown: *bold*, _italic_, ~strike~,
// `code`. Applied on top of mention splitting rather than instead of it —
// a segment is either an @mention (never re-parsed for markdown, since a
// username can legitimately contain underscores) or plain text that gets a
// second pass for the four markers below.
function renderFormatting(text, mine, keyPrefix) {
  const tokenPattern = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
  const parts = text.split(tokenPattern);
  if (parts.length === 1) return text;
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.length >= 2 && part[0] === "*" && part[part.length - 1] === "*") {
      return <strong key={key}>{part.slice(1, -1)}</strong>;
    }
    if (part.length >= 2 && part[0] === "_" && part[part.length - 1] === "_") {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.length >= 2 && part[0] === "~" && part[part.length - 1] === "~") {
      return <span key={key} style={{ textDecoration: "line-through" }}>{part.slice(1, -1)}</span>;
    }
    if (part.length >= 2 && part[0] === "`" && part[part.length - 1] === "`") {
      return (
        <code key={key} style={{
          fontFamily: "monospace", fontSize: "0.92em", padding: "1px 5px", borderRadius: 4,
          background: mine ? "#ffffff26" : G.dim,
        }}>{part.slice(1, -1)}</code>
      );
    }
    return part;
  });
}

function renderWithMentions(text, mine) {
  const parts = text.split(/(@\w+)/g);
  if (parts.length === 1) return renderFormatting(text, mine, "f");
  return parts.map((part, index) => (
    part.startsWith("@")
      ? <span key={index} style={{ fontWeight: 700, color: mine ? "#fff" : G.accentText }}>{part}</span>
      : renderFormatting(part, mine, `f${index}`)
  ));
}

function Bubble({ message, me, replyTarget, meetingUpdates, isPinned, isRead,
                  onLongPress, onVote, onCallAgain, toast }) {
  const mine = message.sender_id === me.id;
  const gone = message.deleted_at || message.expired;

  if (message.kind === "meeting") {
    return <MeetingCard message={message} mine={mine}
                        update={meetingUpdates?.[message.payload?.meeting_id]}/>;
  }

  // Stickers render borderless, without the chat-bubble background — same
  // convention WhatsApp/Telegram use, since a sticker is already a complete
  // little illustration and a bubble around it just adds a frame nobody wants.
  if (message.kind === "sticker" && !gone) {
    return (
      <div id={`msg-${message.id}`} onContextMenu={(event) => { event.preventDefault(); onLongPress(); }}
           onClick={onLongPress} style={{
             display: "flex", flexDirection: "column",
             alignItems: mine ? "flex-end" : "flex-start", marginBottom: 8, cursor: "pointer",
           }}>
        <StickerMessage message={message}/>
        <span style={{ fontSize: 10.5, color: G.muted, marginTop: 2 }}>{clockTime(message.created_at)}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${message.id}`}
         style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 8 }}>
      <div
        onContextMenu={(event) => { event.preventDefault(); onLongPress(); }}
        onClick={onLongPress}
        style={{
          position: "relative", maxWidth: "78%", padding: "9px 13px", borderRadius: 16,
          borderBottomRightRadius: mine ? 4 : 16,
          borderBottomLeftRadius: mine ? 16 : 4,
          background: mine ? G.accent : G.card,
          border: mine ? "none" : `1px solid ${G.border}`,
          cursor: "pointer",
        }}>

        {message.forwarded_from && (
          <div style={{ fontSize: 11, color: mine ? "#ffffffaa" : G.muted, marginBottom: 3 }}>
            Forwarded from {message.forwarded_from}
          </div>
        )}

        {message.payload?.via_broadcast && (
          <div style={{ fontSize: 11, color: mine ? "#ffffffaa" : G.muted, marginBottom: 3 }}>
            📢 Broadcast: {message.payload.via_broadcast}
          </div>
        )}

        {replyTarget && (
          <div style={{
            borderLeft: `2px solid ${mine ? "#ffffff88" : G.accent}`,
            paddingLeft: 8, marginBottom: 5, fontSize: 12,
            color: mine ? "#ffffffcc" : G.sub, opacity: 0.9,
          }}>{replyTarget.text?.slice(0, 80) || "message"}</div>
        )}

        {gone ? (
          <div style={{
            fontSize: 14, fontStyle: "italic",
            color: mine ? "#ffffff99" : G.muted,
          }}>
            {message.expired ? "This message disappeared" : "This message was deleted"}
          </div>
        ) : message.kind === "poll" ? (
          <Poll message={message} mine={mine} onVote={onVote}/>
        ) : ["photo", "video", "voice", "document"].includes(message.kind) ? (
          <>
            {message.view_once && !message.payload?._localUrl
              // A still-queued view-once send has no server-side single-use
              // gate to defer to yet — it's just your own file, about to go
              // out, same as any other pending attachment until it actually
              // reaches the server.
              ? <ViewOnceAttachment message={message} mine={mine}/>
              : <Attachment message={message} mine={mine}/>}
            {message.text && (
              <div style={{ fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap", marginTop: 6 }}>
                {renderWithMentions(message.text, mine)}
              </div>
            )}
          </>
        ) : message.kind === "location" ? (
          <LocationMessage message={message} mine={mine} toast={toast}/>
        ) : message.kind === "contact" ? (
          <ContactMessage message={message} mine={mine}/>
        ) : message.kind === "call" ? (
          <CallCard message={message} mine={mine} onCallAgain={onCallAgain}/>
        ) : (
          <div style={{ fontSize: 14.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
            {renderWithMentions(message.text, mine)}
          </div>
        )}

        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 5, marginTop: 3,
        }}>
          {message.edited_at && (
            <span style={{ fontSize: 10, color: mine ? "#ffffff99" : G.muted }}>edited</span>
          )}
          {isPinned && I.pin(mine ? "#ffffff99" : G.accentText, 11)}
          {message.expires_at && !gone && I.timer(mine ? "#ffffff99" : G.muted, 11)}
          <span style={{ fontSize: 10.5, color: mine ? "#ffffffaa" : G.muted }}>
            {clockTime(message.created_at)}
          </span>
          {mine && (
            message.pending || message.queued
              ? I.clock("#ffffff99", 11)                    // still going out
              : isRead
                ? I.checkDouble("#38bdf8", 13)                // seen — bright, stands out from plain white
                : I.checkDouble("#ffffffaa", 13)              // delivered, not yet seen
          )}
        </div>

        {message.reactions?.length > 0 && (
          <ReactionPills reactions={message.reactions} messageId={message.id}/>
        )}
      </div>
    </div>
  );
}

function ReactionPills({ reactions, messageId }) {
  const [detail, setDetail] = useState(null);

  function showDetail() {
    Messages.reactionDetails(messageId)
      .then((list) => setDetail(list))
      .catch(() => {});
  }

  return (
    <>
      <div style={{ display: "flex", gap: 4, marginTop: 5, flexWrap: "wrap" }}>
        {reactions.map((reaction) => (
          <div key={reaction.emoji} onClick={(e) => { e.stopPropagation(); showDetail(); }} style={{
            padding: "2px 7px", borderRadius: 12, fontSize: 11, cursor: "pointer",
            background: reaction.mine ? G.accentSoft : G.dim,
            border: `1px solid ${reaction.mine ? G.accent : G.border}`,
            color: G.text,
          }}>{reaction.emoji} {reaction.count}</div>
        ))}
      </div>
      {detail && (
        <div onClick={(e) => e.stopPropagation()} style={{
          position: "absolute", bottom: "100%", right: 0, marginBottom: 4, zIndex: 10,
          background: G.surface, border: `1px solid ${G.border}`, borderRadius: 12,
          boxShadow: `0 4px 16px ${G.border}`, minWidth: 160, maxHeight: 200, overflowY: "auto",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderBottom: `1px solid ${G.border}` }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Reactions</span>
            <span onClick={() => setDetail(null)} style={{ cursor: "pointer", color: G.muted }}>×</span>
          </div>
          {detail.map((entry, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", fontSize: 12.5 }}>
              <span style={{ fontSize: 16 }}>{entry.emoji}</span>
              <span style={{ flex: 1 }}>{entry.name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Poll({ message, mine, onVote }) {
  const options = message.payload?.options || [];
  const total = options.reduce((sum, option) => sum + option.votes, 0);

  return (
    <div style={{ minWidth: 200 }}>
      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 8 }}>{message.text}</div>
      {options.map((option, index) => {
        const share = total ? Math.round((option.votes / total) * 100) : 0;
        return (
          <div key={index} onClick={(event) => { event.stopPropagation(); onVote(index); }}
            style={{
              marginBottom: 6, padding: "7px 10px", borderRadius: 10,
              background: mine ? "#ffffff22" : G.dim,
              border: `1px solid ${mine ? "#ffffff33" : G.border}`,
              cursor: "pointer", position: "relative", overflow: "hidden",
            }}>
            <div style={{
              position: "absolute", inset: 0, width: `${share}%`,
              background: mine ? "#ffffff22" : G.accentSoft,
            }}/>
            <div style={{
              position: "relative", display: "flex", justifyContent: "space-between",
              fontSize: 13,
            }}>
              <span>{option.text}</span>
              <span style={{ opacity: 0.8 }}>{share}%</span>
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
        {total} vote{total === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function LocationMessage({ message, mine, toast }) {
  const { lat, lng, live_until: liveUntil } = message.payload || {};
  const [stopping, setStopping] = useState(false);
  if (typeof lat !== "number" || typeof lng !== "number") {
    return <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.7 }}>Location unavailable</div>;
  }
  const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const isLive = liveUntil && liveUntil > Date.now() / 1000;

  async function stopSharing(event) {
    event.preventDefault();
    event.stopPropagation();
    setStopping(true);
    try {
      await Messages.stopLiveLocation(message.id);
    } catch (problem) {
      toast?.(problem.message || "Could not stop sharing");
    } finally {
      setStopping(false);
    }
  }

  return (
    <a href={mapUrl} target="_blank" rel="noopener noreferrer"
       onClick={(event) => event.stopPropagation()}
       style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180, textDecoration: "none", color: "inherit" }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10, flexShrink: 0, position: "relative",
        background: mine ? "#ffffff26" : G.accentSoft,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {I.mapPin(mine ? "#fff" : G.accentText, 20)}
        {isLive && (
          <div style={{
            position: "absolute", top: -3, right: -3, width: 10, height: 10,
            borderRadius: "50%", background: G.red, border: `2px solid ${mine ? G.accent : G.card}`,
          }}/>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {isLive ? "Live location" : "Location"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {isLive
            ? `Updating · until ${clockTime(liveUntil)}`
            : `${lat.toFixed(5)}, ${lng.toFixed(5)}`}
        </div>
      </div>
      {isLive && mine && (
        <div onClick={stopSharing} style={{
          fontSize: 11.5, fontWeight: 600, padding: "5px 9px", borderRadius: 8,
          background: "#ffffff33", color: "#fff", cursor: stopping ? "default" : "pointer",
          opacity: stopping ? 0.6 : 1, flexShrink: 0,
        }}>Stop</div>
      )}
    </a>
  );
}

function ContactMessage({ message, mine }) {
  const { name, phone } = message.payload || {};
  if (!name) {
    return <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.7 }}>Contact unavailable</div>;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180 }}>
      <Av av={name[0]?.toUpperCase() || "?"} color="#64748b" size={38}/>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
        {phone && (
          <a href={`tel:${phone}`} onClick={(event) => event.stopPropagation()}
             style={{ fontSize: 12, color: mine ? "#ffffffcc" : G.accentText, textDecoration: "none" }}>
            {phone}
          </a>
        )}
      </div>
    </div>
  );
}

const CALL_STATUS_LABEL = {
  completed: "Call ended",
  declined: "Declined",
  unanswered: "No answer",
  busy: "Line busy",
};

function CallCard({ message, mine, onCallAgain }) {
  const { call_kind: callKind, status, duration_secs: durationSecs } = message.payload || {};
  const icon = callKind === "video" ? I.video : I.phone;
  const missed = status !== "completed";
  const label = CALL_STATUS_LABEL[status] || "Call";
  const detail = status === "completed" && durationSecs
    ? `${Math.floor(durationSecs / 60)}:${String(durationSecs % 60).padStart(2, "0")}`
    : label;

  return (
    <div onClick={(event) => { event.stopPropagation(); onCallAgain(callKind); }}
         style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180, cursor: "pointer" }}>
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: mine ? "#ffffff26" : (missed ? `${G.red}22` : G.accentSoft),
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>
        {icon(mine ? "#fff" : (missed ? G.red : G.accentText), 17)}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {callKind === "video" ? "Video call" : "Voice call"}
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>{detail}</div>
      </div>
    </div>
  );
}

function StickerMessage({ message }) {
  const sticker = STICKERS_BY_ID[message.payload?.sticker_id];
  if (!sticker) {
    return <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.7 }}>Sticker unavailable</div>;
  }
  return <div>{sticker.render()}</div>;
}

/**
 * A photo/video sent with the view-once flag. GET /uploads/{id} is the
 * server-side reveal — the very first successful fetch stamps
 * view_once_opened_at, and every read after that (including a second fetch
 * of the exact same attachment) gets refused. So "tap to view" here doesn't
 * ask a separate permission endpoint first; the fetch itself IS spending the
 * one view, which is why it only happens on an explicit tap, never eagerly.
 */
function ViewOnceAttachment({ message, mine }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [revealing, setRevealing] = useState(false);
  const [gone, setGone] = useState(false);
  const attachmentId = message.payload?.attachment_id;
  const alreadyOpened = !attachmentId; // server already stripped it — opened by someone, or by us if mine

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  if (mine) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", opacity: 0.85 }}>
        {I.eye ? I.eye(mine ? "#fff" : G.muted, 16) : null}
        <span style={{ fontSize: 13, fontStyle: "italic" }}>
          {alreadyOpened ? `${message.kind === "video" ? "Video" : "Photo"} · opened`
                         : `${message.kind === "video" ? "Video" : "Photo"} · view once`}
        </span>
      </div>
    );
  }

  if (blobUrl) {
    return message.kind === "video"
      ? <video autoPlay controls src={blobUrl} style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10 }}/>
      : <img src={blobUrl} alt="" style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10, display: "block" }}/>;
  }

  if (gone || alreadyOpened) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", opacity: 0.7 }}>
        {I.eye ? I.eye(mine ? "#fff" : G.muted, 16) : null}
        <span style={{ fontSize: 13, fontStyle: "italic" }}>
          {message.kind === "video" ? "Video" : "Photo"} · already opened
        </span>
      </div>
    );
  }

  async function reveal() {
    if (revealing) return;
    setRevealing(true);
    try {
      const url = await Uploads.fetchBlobUrl(attachmentId);
      setBlobUrl(url);
    } catch {
      setGone(true);
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div onClick={reveal} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "6px 2px",
      cursor: revealing ? "default" : "pointer",
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700,
        background: mine ? "#ffffff26" : G.accentSoft, color: mine ? "#fff" : G.accentText,
      }}>{revealing ? <Spinner small/> : "1"}</div>
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>
        {revealing ? "Opening…" : `Tap to view ${message.kind === "video" ? "video" : "photo"} · once`}
      </div>
    </div>
  );
}

/**
 * Renders a photo, video, voice note or document.
 *
 * The bytes are fetched as a blob rather than pointed at with a plain <img
 * src>, because downloading requires the bearer token — a tag's src attribute
 * cannot carry an Authorization header, only cookies, which this app does not
 * use for auth.
 */
function Attachment({ message, mine }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(false);
  // Starts closed when the setting says not to fetch automatically; tapping
  // the placeholder below flips this to fetch on demand, same one-time
  // manual download WhatsApp offers when auto-download is off.
  const [wantsDownload, setWantsDownload] = useState(shouldAutoDownload);
  const attachmentId = message.payload?.attachment_id;
  // Set only on a message still sitting in the local send queue (pending or
  // queued-while-offline) — the file itself, held client-side, with no
  // server attachment id yet. Nothing to fetch in that case; the local blob
  // URL already made from that same file IS the thing to render.
  const localUrl = message.payload?._localUrl;
  const fileName = message.payload?.file_name || "file";
  const sizeBytes = message.payload?.size_bytes || 0;

  useEffect(() => {
    if (localUrl || !attachmentId || !wantsDownload) return;
    let cancelled = false;
    let objectUrl = null;

    Uploads.fetchBlobUrl(attachmentId, { cache: true })
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch(() => !cancelled && setError(true));

    return () => {
      cancelled = true;
      // Blob URLs are not garbage collected on their own — holding one per
      // attachment for the life of the tab would leak memory in a long chat.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, wantsDownload, localUrl]);

  const effectiveUrl = localUrl || blobUrl;

  if (!attachmentId && !localUrl) {
    return <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.7 }}>Attachment unavailable</div>;
  }

  if (error) {
    return <div style={{ fontSize: 13, color: mine ? "#ffffffcc" : G.red }}>Could not load file</div>;
  }

  if (!localUrl && !wantsDownload) {
    return (
      <div onClick={() => setWantsDownload(true)} style={{
        display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer",
      }}>
        {I.image ? I.image(mine ? "#fff" : G.accent, 18) : null}
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Tap to download</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{fileName} · {formatBytes(sizeBytes)}</div>
        </div>
      </div>
    );
  }

  if (!effectiveUrl) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
        <Spinner small/>
        <span style={{ fontSize: 13, opacity: 0.8 }}>{fileName}</span>
      </div>
    );
  }

  if (message.kind === "photo") {
    return (
      <img src={effectiveUrl} alt={fileName}
           style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10, display: "block" }}/>
    );
  }

  if (message.kind === "video") {
    return (
      <video controls src={effectiveUrl}
             style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10, display: "block" }}/>
    );
  }

  if (message.kind === "voice") {
    return <VoicePlayer src={effectiveUrl}/>;
  }

  // document, and anything else that lands here as a fallback.
  return (
    <a href={effectiveUrl} download={fileName} style={{
      display: "flex", alignItems: "center", gap: 10, textDecoration: "none",
      color: mine ? "#fff" : G.text, padding: "6px 2px",
    }}>
      {I.doc ? I.doc(mine ? "#fff" : G.accent, 26) : "📄"}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
          {fileName}
        </div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>{formatBytes(sizeBytes)}</div>
      </div>
    </a>
  );
}

const PLAYBACK_SPEEDS = [1, 1.5, 2];

function VoicePlayer({ src }) {
  const audioRef = useRef(null);
  const [speed, setSpeed] = useState(1);

  function cycleSpeed() {
    const next = PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(speed) + 1) % PLAYBACK_SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <audio ref={audioRef} controls src={src} style={{ maxWidth: 200 }}
             onPlay={() => { if (audioRef.current) audioRef.current.playbackRate = speed; }}/>
      <div onClick={cycleSpeed} style={{
        minWidth: 36, height: 24, borderRadius: 12, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        background: `${G.accent}22`, color: G.accent, fontSize: 11, fontWeight: 700,
        userSelect: "none",
      }}>{speed}x</div>
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MeetingCard({ message, mine, update }) {
  const [meeting, setMeeting] = useState(null);
  const meetingId = message.payload?.meeting_id;

  useEffect(() => {
    if (meetingId) Meetings.get(meetingId).then(setMeeting).catch(() => {});
  }, [meetingId]);

  // A meeting event either carries the whole updated meeting (an RSVP or an
  // edit) or only says something changed (started, ended, cancelled). Take the
  // full object when it is there, otherwise re-fetch.
  useEffect(() => {
    if (!update) return;
    if (update.id) setMeeting(update);
    else if (meetingId) Meetings.get(meetingId).then(setMeeting).catch(() => {});
  }, [update, meetingId]);

  async function answer(response) {
    const updated = await Meetings.rsvp(meetingId, response);
    setMeeting(updated);
  }

  const startsAt = meeting?.starts_at || message.payload?.starts_at;

  return (
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
      <div style={{
        width: "90%", padding: 14, borderRadius: 16,
        background: G.card2, border: `1px solid ${G.accent}44`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          {I.calendar(G.accent, 18)}
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {meeting?.title || message.text.replace("📅 ", "")}
          </div>
        </div>

        <div style={{ fontSize: 12.5, color: G.sub, marginBottom: 2 }}>
          {whenLabel(startsAt)} · {countdown(startsAt)}
          {meeting ? ` · ${meeting.duration_min} min` : ""}
        </div>

        {meeting?.agenda && (
          <div style={{ fontSize: 12.5, color: G.muted, marginTop: 6 }}>{meeting.agenda}</div>
        )}

        {meeting && (
          <>
            <div style={{ fontSize: 12, color: G.accentText, margin: "8px 0" }}>
              {meeting.going_count} going · status {meeting.status}
            </div>

            {meeting.status === "scheduled" && (
              <div style={{ display: "flex", gap: 6 }}>
                {["going", "maybe", "declined"].map((option) => (
                  <button key={option} onClick={() => answer(option)}
                    style={{
                      flex: 1, padding: "7px", borderRadius: 10, fontSize: 12,
                      cursor: "pointer",
                      border: `1px solid ${meeting.my_response === option ? G.accent : G.border}`,
                      background: meeting.my_response === option ? G.accentSoft : "transparent",
                      color: meeting.my_response === option ? G.accentText : G.sub,
                    }}>
                    {option === "going" ? "Going" : option === "maybe" ? "Maybe" : "Can't"}
                  </button>
                ))}
              </div>
            )}

            {meeting.join_url && meeting.status === "live" && (
              <a href={meeting.join_url} target="_blank" rel="noreferrer"
                 style={{
                   display: "block", marginTop: 8, padding: "9px", borderRadius: 10,
                   background: G.green, color: "#fff", textAlign: "center",
                   fontSize: 13, fontWeight: 600, textDecoration: "none",
                 }}>Join now</a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Banner({ label, onClear }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
      background: G.card, borderTop: `1px solid ${G.border}`,
    }}>
      <div style={{ flex: 1, fontSize: 12.5, color: G.sub }}>{label}</div>
      <div onClick={onClear} style={{ cursor: "pointer", color: G.muted, fontSize: 18 }}>×</div>
    </div>
  );
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function Composer({ value, onChange, onSend, onSchedule, onAttach, onVoice, uploading,
                    disappearSecs, editing, members, toast }) {
  const voice = useVoiceRecorder((blob) => onVoice(blob));
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [cannedReplies, setCannedReplies] = useState([]);

  useEffect(() => {
    Me.cannedReplies().then(setCannedReplies).catch(() => {});
  }, []);

  useEffect(() => {
    if (voice.state === "error" && voice.error) toast(voice.error);
  }, [voice.state, voice.error, toast]);

  // A mention only autocompletes when the @ is at the END of what's typed so
  // far — this composer is a plain single-line input, not a rich editor
  // that tracks cursor position, so "wherever the user is currently typing"
  // and "the end of the string" are the same place in the common case.
  const mentionMatch = /@(\w*)$/.exec(value);
  const mentionQuery = mentionMatch ? mentionMatch[1].toLowerCase() : null;
  const mentionCandidates = mentionQuery === null || members.length === 0
    ? []
    : members.filter((m) => m.username.toLowerCase().startsWith(mentionQuery)).slice(0, 5);

  function pickMention(member) {
    onChange(value.slice(0, value.length - mentionMatch[0].length) + `@${member.username} `);
  }

  if (voice.state === "recording") {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
        borderTop: `1px solid ${G.border}`, background: G.surface,
      }}>
        <div onClick={voice.cancel} style={{ cursor: "pointer" }} title="Cancel">
          {I.trash(G.red, 20)}
        </div>
        <div style={{
          width: 10, height: 10, borderRadius: "50%", background: G.red,
          animation: "pulse 1s ease-in-out infinite",
        }}/>
        <div style={{ flex: 1, fontSize: 14, color: G.text, fontVariantNumeric: "tabular-nums" }}>
          {String(Math.floor(voice.seconds / 60)).padStart(2, "0")}:
          {String(voice.seconds % 60).padStart(2, "0")}
        </div>
        <button onClick={voice.stop} style={{
          width: 42, height: 42, borderRadius: "50%", border: "none", cursor: "pointer",
          background: `linear-gradient(135deg,${G.accent},${G.accentD})`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{I.send()}</button>
        <style>{"@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}"}</style>
      </div>
    );
  }

  return (
    <div style={{
      position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
      borderTop: `1px solid ${G.border}`, background: G.surface,
    }}>
      {mentionCandidates.length > 0 && (
        <div style={{
          position: "absolute", bottom: "100%", left: 12, right: 12, marginBottom: 4,
          background: G.surface, border: `1px solid ${G.border}`, borderRadius: 12,
          boxShadow: `0 4px 16px ${G.border}`, overflow: "hidden",
        }}>
          {mentionCandidates.map((member) => (
            <div key={member.id} onClick={() => pickMention(member)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", cursor: "pointer",
            }}>
              <Av av={member.avatar_letter} color={member.color} size={26} photoId={member.avatar_attachment_id}/>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{member.name}</div>
                <div style={{ fontSize: 11.5, color: G.muted }}>@{member.username}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {emojiOpen && (
        <EmojiPicker onPick={(emoji) => onChange(value + emoji)} onClose={() => setEmojiOpen(false)}/>
      )}

      {quickReplyOpen && (
        <div style={{
          position: "absolute", bottom: "100%", left: 12, right: 12, marginBottom: 4,
          background: G.surface, border: `1px solid ${G.border}`, borderRadius: 12,
          boxShadow: `0 4px 16px ${G.border}`, overflow: "hidden", maxHeight: 240, overflowY: "auto",
        }}>
          {cannedReplies.map((reply) => (
            <div key={reply.id}
                 onClick={() => { onChange(value + reply.text); setQuickReplyOpen(false); }}
                 style={{ padding: "10px 12px", cursor: "pointer", borderBottom: `1px solid ${G.border}` }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: G.accentText }}>{reply.label}</div>
              <div style={{ fontSize: 13, color: G.sub, marginTop: 2 }}>{reply.text}</div>
            </div>
          ))}
        </div>
      )}

      {cannedReplies.length > 0 && (
        <div onClick={() => setQuickReplyOpen((v) => !v)} style={{ cursor: "pointer" }} title="Quick replies">
          {I.checkDouble(G.sub, 18)}
        </div>
      )}

      <div onClick={() => !uploading && onAttach()}
           style={{ cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.5 : 1 }}
           title="Attach">
        {uploading ? <Spinner small/> : I.paperclip(G.sub, 20)}
      </div>
      <div onClick={onSchedule} style={{ cursor: "pointer" }} title="Schedule this message">
        {I.clock(G.sub, 20)}
      </div>
      <div onClick={() => setEmojiOpen((v) => !v)} style={{ cursor: "pointer", fontSize: 19 }} title="Emoji">
        🙂
      </div>

      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && onSend()}
        placeholder={disappearSecs
          ? `Disappears after ${durationLabel(disappearSecs)}…`
          : editing ? "Edit message…" : "Message"}
        style={{
          flex: 1, padding: "11px 14px", borderRadius: 22, background: G.dim,
          border: `1px solid ${G.border}`, color: G.text, fontSize: 14.5,
          outline: "none",
        }}/>

      {value.trim() ? (
        <button onClick={onSend} style={{
          width: 42, height: 42, borderRadius: "50%", border: "none", cursor: "pointer",
          background: `linear-gradient(135deg,${G.accent},${G.accentD})`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{I.send()}</button>
      ) : (
        <div onClick={voice.start} style={{
          width: 42, height: 42, borderRadius: "50%", cursor: "pointer",
          background: G.dim, border: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }} title="Record a voice note">
          {I.mic(G.sub, 19)}
        </div>
      )}
    </div>
  );
}

function Sheet({ title, children, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 50,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        border: `1px solid ${G.border}`, maxHeight: "80vh", overflowY: "auto",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function MessageMenu({ message, me, isModerator, isPinned, isStarred, onClose, onReact, onReply,
                      onEdit, onUnsend, onDeleteForEveryone, onHide, onPin, onStar, onForward, onCopy, onSelect }) {
  const mine = message.sender_id === me.id;
  // Two genuinely different removals, not two labels on one action:
  //   Unsend — only the sender, on their own message, no trace left at all.
  //   Delete for everyone — sender OR a moderator; always leaves a visible
  //     tombstone. It's the ONLY removal option a moderator has on someone
  //     else's message — a moderator silently erasing what someone else
  //     wrote, with no trace, is not something this app does.
  const canUnsend = !message.deleted_at && mine;
  const canDeleteForEveryone = !message.deleted_at && (mine || isModerator);
  return (
    <Sheet title="Message" onClose={onClose}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {EMOJIS.map((emoji) => (
          <button key={emoji} onClick={() => onReact(emoji)} style={{
            fontSize: 22, padding: "6px 10px", borderRadius: 12, cursor: "pointer",
            background: G.dim, border: `1px solid ${G.border}`,
          }}>{emoji}</button>
        ))}
      </div>

      <Button variant="ghost" onClick={onReply} style={{ width: "100%", marginBottom: 8 }}>
        Reply
      </Button>
      <Button variant="ghost" onClick={onForward} style={{ width: "100%", marginBottom: 8 }}>
        Forward
      </Button>
      {!message.deleted_at && (
        <Button variant="ghost" onClick={onPin} style={{ width: "100%", marginBottom: 8 }}>
          {isPinned ? "Unpin" : "Pin"}
        </Button>
      )}
      {!message.deleted_at && (
        <Button variant="ghost" onClick={onStar} style={{ width: "100%", marginBottom: 8 }}>
          {isStarred ? "Unstar" : "Star"}
        </Button>
      )}
      <Button variant="ghost" onClick={onSelect} style={{ width: "100%", marginBottom: 8 }}>
        Select
      </Button>
      {message.text && (
        <Button variant="ghost" onClick={onCopy} style={{ width: "100%", marginBottom: 8 }}>
          Copy text
        </Button>
      )}
      {mine && !message.deleted_at && (
        <Button variant="ghost" onClick={onEdit} style={{ width: "100%", marginBottom: 8 }}>
          Edit
        </Button>
      )}
      {!message.deleted_at && (
        <Button variant="ghost" onClick={onHide} style={{ width: "100%", marginBottom: 8 }}>
          Delete for me
        </Button>
      )}
      {canUnsend && (
        <Button variant="danger" onClick={onUnsend} style={{ width: "100%", marginBottom: 8 }}>
          Unsend
        </Button>
      )}
      {canDeleteForEveryone && (
        <Button variant="danger" onClick={onDeleteForEveryone} style={{ width: "100%" }}>
          Delete for everyone
        </Button>
      )}
    </Sheet>
  );
}

function TimerSheet({ chat, onClose, onPicked }) {
  return (
    <Sheet title="Disappearing messages" onClose={onClose}>
      <div style={{ fontSize: 13, color: G.muted, marginBottom: 14 }}>
        Applies to messages sent from now on. Messages already in this chat keep
        whatever timer they were sent with.
      </div>
      {DISAPPEAR_CHOICES.map((choice) => (
        <div key={choice.label} onClick={() => onPicked(choice.seconds)}
          style={{
            padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
            background: chat.disappear_secs === choice.seconds ? G.accentSoft : G.dim,
            border: `1px solid ${chat.disappear_secs === choice.seconds ? G.accent : G.border}`,
            fontSize: 14,
          }}>{choice.label}</div>
      ))}
    </Sheet>
  );
}

function kindForFile(file) {
  if (file.type.startsWith("image/")) return "photo";
  if (file.type.startsWith("video/")) return "video";
  return "document";
}

function ScheduleSheet({ chat, onClose, toast }) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  // { attachmentId, kind, fileName, sizeBytes } — null until a file is picked.
  const [attachment, setAttachment] = useState(null);

  async function onFilePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const uploaded = await Uploads.create(file);
      setAttachment({
        attachmentId: uploaded.attachment_id, kind: kindForFile(file),
        fileName: uploaded.file_name, sizeBytes: uploaded.size_bytes,
      });
    } catch (problem) {
      toast(problem.message || "Could not upload file");
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!text.trim() && !attachment) return;
    if (!when) return;
    const sendAt = localInputToUnix(when);
    if (sendAt <= Date.now() / 1000) {
      toast("Pick a time in the future");
      return;
    }
    setBusy(true);
    try {
      await Scheduled.create({
        chatId: chat.id, text: text.trim(), sendAt,
        kind: attachment?.kind || "text",
        payload: attachment ? { attachment_id: attachment.attachmentId } : null,
      });
      toast("Scheduled");
      onClose();
    } catch (problem) {
      toast(problem.message || "Could not schedule");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Schedule a message" onClose={onClose}>
      <Field label={attachment ? "Caption (optional)" : "Message"} value={text}
             onChange={(e) => setText(e.target.value)}
             placeholder="Good morning team"/>

      {attachment ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
          borderRadius: 10, background: G.dim, border: `1px solid ${G.border}`, marginBottom: 14,
        }}>
          {attachment.kind === "photo" ? I.image(G.accent, 20)
            : attachment.kind === "video" ? I.video(G.accent, 20)
            : I.doc(G.accent, 20)}
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {attachment.fileName}
          </div>
          <div onClick={() => setAttachment(null)} style={{ cursor: "pointer" }}>{I.trash()}</div>
        </div>
      ) : (
        <label style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: "12px", borderRadius: 10, marginBottom: 14, cursor: "pointer",
          border: `1.5px dashed ${G.border}`, background: G.dim, fontSize: 13, color: G.muted,
        }}>
          {uploading ? <Spinner small/> : (
            <>{I.paperclip(G.sub, 16)} Attach a photo, video or document (optional)</>
          )}
          <input type="file" hidden disabled={uploading} onChange={onFilePicked}/>
        </label>
      )}

      <Field label="Send at" type="datetime-local" value={when}
             onChange={(e) => setWhen(e.target.value)}/>
      <Button onClick={save} disabled={busy || uploading} style={{ width: "100%" }}>
        {busy ? "Saving…" : "Schedule"}
      </Button>
      <div style={{ fontSize: 12, color: G.muted, marginTop: 10 }}>
        It will be sent even if you are offline. You can cancel it any time before then.
      </div>
    </Sheet>
  );
}

function MeetingSheet({ chat, onClose, toast }) {
  const [form, setForm] = useState({
    title: "", agenda: "", when: "", duration: 30, reminder: 10, joinUrl: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function save() {
    if (!form.title.trim() || !form.when) return;
    const startsAt = localInputToUnix(form.when);
    if (startsAt <= Date.now() / 1000) {
      toast("Pick a time in the future");
      return;
    }
    setBusy(true);
    try {
      await Meetings.create({
        chatId: chat.id,
        title: form.title.trim(),
        agenda: form.agenda.trim(),
        startsAt,
        durationMin: Number(form.duration) || 30,
        reminderMin: Number(form.reminder) || 0,
        joinUrl: form.joinUrl.trim(),
      });
      toast("Meeting scheduled");
      onClose();
    } catch (problem) {
      toast(problem.message || "Could not create meeting");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Schedule a meeting" onClose={onClose}>
      <Field label="Title" value={form.title} onChange={set("title")}
             placeholder="Sprint planning"/>
      <Field label="Agenda (optional)" value={form.agenda} onChange={set("agenda")}
             placeholder="What ships this week"/>
      <Field label="Starts at" type="datetime-local" value={form.when} onChange={set("when")}/>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <Field label="Minutes" type="number" value={form.duration} onChange={set("duration")}/>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Remind before" type="number" value={form.reminder} onChange={set("reminder")}/>
        </div>
      </div>
      <Field label="Join link (optional)" value={form.joinUrl} onChange={set("joinUrl")}
             placeholder="https://meet.example.com/abc"/>
      <Button onClick={save} disabled={busy} style={{ width: "100%" }}>
        {busy ? "Saving…" : "Schedule meeting"}
      </Button>
      <div style={{ fontSize: 12, color: G.muted, marginTop: 10 }}>
        Everyone in this chat is invited and reminded before it starts.
      </div>
    </Sheet>
  );
}

function PollSheet({ chat, onClose, toast, onCreated }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);

  async function save() {
    const filled = options.map((option) => option.trim()).filter(Boolean);
    if (!question.trim() || filled.length < 2) {
      toast("A poll needs a question and two options");
      return;
    }
    try {
      const message = await Messages.send({
        chat_id: chat.id, text: question.trim(), kind: "poll",
        poll_options: filled, client_msg_id: newClientMessageId(),
      });
      onCreated(message);
      onClose();
    } catch (problem) {
      toast(problem.message || "Could not create poll");
    }
  }

  return (
    <Sheet title="New poll" onClose={onClose}>
      <Field label="Question" value={question} onChange={(e) => setQuestion(e.target.value)}
             placeholder="Where should we meet?"/>
      {options.map((option, index) => (
        <Field key={index} label={`Option ${index + 1}`} value={option}
               onChange={(event) => {
                 const next = [...options];
                 next[index] = event.target.value;
                 setOptions(next);
               }}/>
      ))}
      {options.length < 12 && (
        <Button variant="ghost" onClick={() => setOptions([...options, ""])}
                style={{ width: "100%", marginBottom: 10 }}>Add option</Button>
      )}
      <Button onClick={save} style={{ width: "100%" }}>Create poll</Button>
    </Sheet>
  );
}

function AttachSheet({ onClose, onFile, onLocation, onContact, onPoll, onSticker,
                        onScanCaptured, onFilesPicked }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const galleryInput = useRef(null);
  const docInput = useRef(null);
  const scanInput = useRef(null);
  const audioInput = useRef(null);

  function tooBig(file) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      alert(`Files must be under ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
      return true;
    }
    return false;
  }

  // Camera/Gallery/Document all route through the caption sheet instead of
  // sending immediately — kindOverride is left null for Camera/Gallery so
  // each file's own mime type decides photo vs video, since a multi-select
  // from Gallery can freely mix both in one batch.
  function pickToPreview(kindOverride) {
    return (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";               // lets the same file(s) be picked twice in a row
      if (files.length === 0 || files.some(tooBig)) return;
      // Not followed by onClose() — onFilesPicked already moves ChatView's
      // `sheet` state to "mediaPreview", and both are the same state, set in
      // the same event handler tick. Calling onClose() after it would set
      // `sheet` back to null immediately, since React applies both updates
      // in order and the later one wins — the caption sheet would never show.
      onFilesPicked(files, kindOverride);
    };
  }

  function pickAudio(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || tooBig(file)) return;
    onFile(file, "voice");
    onClose();
  }

  function pickToScan(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || tooBig(file)) return;
    onScanCaptured(file);
  }

  function onCameraCaptured(file) {
    setCameraOpen(false);
    onFilesPicked([file], null);
  }

  const options = [
    { label: "Camera", icon: I.camera, action: () => setCameraOpen(true) },
    { label: "Gallery", icon: I.image, action: () => galleryInput.current?.click() },
    { label: "Document", icon: I.doc, action: () => docInput.current?.click() },
    { label: "Scan PDF", icon: I.scan, action: () => scanInput.current?.click() },
    { label: "Location", icon: I.mapPin, action: onLocation },
    { label: "Contact", icon: I.contactCard, action: onContact },
    { label: "Audio", icon: I.musicNote, action: () => audioInput.current?.click() },
    { label: "Poll", icon: I.poll, action: onPoll },
    { label: "Sticker", icon: I.sticker, action: onSticker },
  ];

  if (cameraOpen) {
    return <CameraCapture onCapture={onCameraCaptured} onClose={() => setCameraOpen(false)}/>;
  }

  return (
    <Sheet title="Attach" onClose={onClose}>
      <input ref={galleryInput} type="file" accept="image/*,video/*" multiple
             onChange={pickToPreview(null)} style={{ display: "none" }}/>
      <input ref={docInput} type="file" multiple
             onChange={pickToPreview("document")} style={{ display: "none" }}/>
      <input ref={scanInput} type="file" accept="image/*" capture="environment"
             onChange={pickToScan} style={{ display: "none" }}/>
      <input ref={audioInput} type="file" accept="audio/*" onChange={pickAudio} style={{ display: "none" }}/>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, padding: "4px 2px 8px" }}>
        {options.map((option) => (
          <div key={option.label} onClick={option.action}
               style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <div style={{
              width: 52, height: 52, borderRadius: "50%", background: G.dim,
              border: `1px solid ${G.border}`, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {option.icon(G.accentText, 22)}
            </div>
            <div style={{ fontSize: 12, color: G.sub }}>{option.label}</div>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * The step between "files picked" and "files actually sent" — a caption
 * field plus a preview, so a photo doesn't leave the device the instant it's
 * tapped. The same caption text goes on every file in the batch; splitting
 * one caption across N different messages isn't a distinction WhatsApp's own
 * UI makes either.
 */
function MediaPreviewSheet({ files, kindOverride, onClose, onSend }) {
  const [caption, setCaption] = useState("");
  const [sending, setSending] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [viewOnce, setViewOnce] = useState(false);

  const firstFile = files[0];
  const isImage = firstFile?.type.startsWith("image/");
  const isVideo = firstFile?.type.startsWith("video/");
  const canViewOnce = files.length === 1 && (isImage || isVideo);

  useEffect(() => {
    if (!isImage && !isVideo) return;
    const url = URL.createObjectURL(firstFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstFile]);

  async function send() {
    setSending(true);
    try {
      await onSend(files, kindOverride, caption.trim(), viewOnce);
      onClose();
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet title={files.length > 1 ? `${files.length} files` : (firstFile?.name || "Send file")}
           onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14, position: "relative" }}>
        {isImage && previewUrl ? (
          <img src={previewUrl} alt="" style={{
            maxWidth: "100%", maxHeight: 220, borderRadius: 10,
            filter: viewOnce ? "blur(14px)" : "none",
          }}/>
        ) : isVideo && previewUrl ? (
          <video src={previewUrl} controls style={{
            maxWidth: "100%", maxHeight: 220, borderRadius: 10,
            filter: viewOnce ? "blur(14px)" : "none",
          }}/>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
            {I.doc(G.accent, 28)}
            <div style={{ fontSize: 13.5 }}>
              {files.length > 1 ? `${files.length} files selected` : firstFile?.name}
            </div>
          </div>
        )}
        {canViewOnce && viewOnce && (
          <div style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            fontSize: 28, color: "#fff",
          }}>1</div>
        )}
      </div>

      {canViewOnce && (
        <div onClick={() => setViewOnce((v) => !v)} style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer",
          padding: "8px 10px", borderRadius: 10, background: viewOnce ? G.accentSoft : G.dim,
          border: `1px solid ${viewOnce ? G.accent : G.border}`,
        }}>
          <div style={{
            width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700,
            background: viewOnce ? G.accent : "transparent", color: viewOnce ? "#fff" : G.muted,
            border: `2px solid ${viewOnce ? G.accent : G.border}`,
          }}>1</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: G.text }}>
            View once — disappears after opening
          </div>
        </div>
      )}

      <Field label="Caption (optional)" value={caption}
             onChange={(event) => setCaption(event.target.value)}
             placeholder="Add a caption…"/>

      <Button onClick={send} disabled={sending} style={{ width: "100%" }}>
        {sending ? "Sending…" : files.length > 1 ? `Send ${files.length}` : "Send"}
      </Button>
    </Sheet>
  );
}

const COMPRESSION_LEVELS = [
  { label: "Low", quality: 0.4 },
  { label: "Medium", quality: 0.7 },
  { label: "High", quality: 0.92 },
];

/**
 * Preview screen between "photo captured" and "PDF sent": rotate and pick a
 * compression level before the bytes actually leave the device. The canvas
 * here is the single source of truth for what gets wrapped into the PDF —
 * imageToPdf.js only ever wraps whatever is already drawn on it.
 */
function ScanEditSheet({ file, onClose, onSend, toast }) {
  const canvasRef = useRef(null);
  const bitmapRef = useRef(null);
  const [rotation, setRotation] = useState(0);
  const [quality, setQuality] = useState(COMPRESSION_LEVELS[1].quality);
  const [previewBytes, setPreviewBytes] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createImageBitmap(file).then((bitmap) => {
      if (cancelled) return;
      bitmapRef.current = bitmap;
      redraw();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => { redraw(); }, [rotation, quality]); // eslint-disable-line react-hooks/exhaustive-deps

  function redraw() {
    const bitmap = bitmapRef.current;
    const canvas = canvasRef.current;
    if (!bitmap || !canvas) return;

    const swapped = rotation === 90 || rotation === 270;
    canvas.width = swapped ? bitmap.height : bitmap.width;
    canvas.height = swapped ? bitmap.width : bitmap.height;

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();

    canvas.toBlob((blob) => setPreviewBytes(blob.size), "image/jpeg", quality);
  }

  async function send() {
    setSending(true);
    try {
      const pdfBlob = await canvasToPdfBlob(canvasRef.current, quality);
      await onSend(pdfBlob);
    } catch {
      toast("Could not create the PDF from that photo");
      setSending(false);
    }
  }

  return (
    <Sheet title="Edit scan" onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
        <canvas ref={canvasRef} style={{
          maxWidth: "100%", maxHeight: 260, borderRadius: 10,
          border: `1px solid ${G.border}`, background: G.dim,
        }}/>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 16 }}>
        <div onClick={() => setRotation((r) => (r + 270) % 360)}
             style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer" }}>
          {I.rotateLeft(G.sub, 22)}
          <span style={{ fontSize: 11, color: G.muted }}>Rotate left</span>
        </div>
        <div onClick={() => setRotation((r) => (r + 90) % 360)}
             style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer" }}>
          {I.rotateRight(G.sub, 22)}
          <span style={{ fontSize: 11, color: G.muted }}>Rotate right</span>
        </div>
      </div>

      <div style={{ fontSize: 12, color: G.sub, marginBottom: 8 }}>Compression</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {COMPRESSION_LEVELS.map((level) => (
          <div key={level.label} onClick={() => setQuality(level.quality)}
               style={{
                 flex: 1, textAlign: "center", padding: "8px 0", borderRadius: 10, cursor: "pointer",
                 background: quality === level.quality ? G.accentSoft : G.dim,
                 border: `1px solid ${quality === level.quality ? G.accent : G.border}`,
                 fontSize: 13, fontWeight: quality === level.quality ? 600 : 400,
               }}>
            {level.label}
          </div>
        ))}
      </div>

      {previewBytes != null && (
        <div style={{ fontSize: 12, color: G.muted, marginBottom: 14 }}>
          Estimated size: {formatBytes(previewBytes)}
        </div>
      )}

      <Button onClick={send} disabled={sending} style={{ width: "100%" }}>
        {sending ? "Preparing…" : "Send as PDF"}
      </Button>
    </Sheet>
  );
}

function ContactSheet({ onClose, onSave, toast }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  function save() {
    if (!name.trim() || !phone.trim()) {
      toast("A contact needs a name and phone number");
      return;
    }
    onSave(name.trim(), phone.trim());
  }

  return (
    <Sheet title="Share a contact" onClose={onClose}>
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)}
             placeholder="Full name"/>
      <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)}
             placeholder="+91 98765 43210"/>
      <Button onClick={save} style={{ width: "100%" }}>Send contact</Button>
    </Sheet>
  );
}

function StickerPickerSheet({ onClose, onPick }) {
  return (
    <Sheet title="Stickers" onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, padding: "4px 2px 8px" }}>
        {STICKERS.map((sticker) => (
          <div key={sticker.id} onClick={() => onPick(sticker.id)}
               title={sticker.label}
               style={{ display: "flex", justifyContent: "center", cursor: "pointer" }}>
            {sticker.render()}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const LIVE_LOCATION_CHOICES = [
  { label: "Share current location", seconds: null },
  { label: "Live for 15 minutes", seconds: 15 * 60 },
  { label: "Live for 1 hour", seconds: 3600 },
  { label: "Live for 8 hours", seconds: 8 * 3600 },
];

function LiveLocationSheet({ onClose, onPicked }) {
  return (
    <Sheet title="Share location" onClose={onClose}>
      {LIVE_LOCATION_CHOICES.map((choice) => (
        <div key={choice.label} onClick={() => onPicked(choice.seconds)}
          style={{
            padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
            background: G.dim, border: `1px solid ${G.border}`, fontSize: 14,
          }}>{choice.label}</div>
      ))}
    </Sheet>
  );
}

function ForwardSheet({ message, onClose, onForward }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    Chats.list().then(setChats).catch(() => {}).finally(() => setLoading(false));
  }, []);

  function toggle(chatId) {
    setSelected((current) =>
      current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId]);
  }

  async function send() {
    if (!selected.length) return;
    setSending(true);
    try {
      await onForward(selected);
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet title="Forward to…" onClose={onClose}>
      {loading ? <Spinner small/> : (
        <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 14 }}>
          {chats.map((target) => (
            <label key={target.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "9px 4px",
              cursor: "pointer", borderBottom: `1px solid ${G.border}`,
            }}>
              <input type="checkbox" checked={selected.includes(target.id)}
                     onChange={() => toggle(target.id)}/>
              <Av av={target.avatar_letter} color={target.color} size={32} photoId={target.avatar_attachment_id}/>
              <div style={{ fontSize: 14 }}>{target.name || "Direct message"}</div>
            </label>
          ))}
        </div>
      )}
      <Button onClick={send} disabled={!selected.length || sending} style={{ width: "100%" }}>
        {sending ? "Forwarding…" : `Forward${selected.length ? ` (${selected.length})` : ""}`}
      </Button>
    </Sheet>
  );
}

const FOLDER_CHOICES = ["", "Work", "Family", "Friends"];

const MANAGED_TYPES = ["group", "channel", "community", "community_channel"];

function ChatInfoSheet({ chat, me, events, onClose, toast, onChanged, onLeft, onOpenChat,
                        onChatLocked }) {
  const [folder, setFolder] = useState(chat.folder || "");
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(null);          // members + my_role, fetched separately
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [subChannels, setSubChannels] = useState(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const [locked, setLocked] = useState(Boolean(chat.is_locked));
  const [lockSheet, setLockSheet] = useState(null);   // 'set' | 'remove'
  const [archived, setArchived] = useState(Boolean(chat.archived));
  const [muteSheet, setMuteSheet] = useState(false);
  const [mediaSheet, setMediaSheet] = useState(false);
  const [inviteSheet, setInviteSheet] = useState(false);
  const [mutedUntil, setMutedUntil] = useState(chat.muted_until || 0);
  const [memberQuery, setMemberQuery] = useState("");
  const [slowModeSecs, setSlowModeSecs] = useState(chat.slow_mode_secs || 0);
  const lastMemberEvent = useRef(0);

  // DM-only: the other person's profile plus whether they're already a
  // saved contact — folded into this same sheet rather than a separate one,
  // so a DM's info screen is a strict superset of a group's (contact
  // management on top of mute/archive/lock/etc.), never a replacement.
  const isDm = chat.type === "dm";
  const [peerProfile, setPeerProfile] = useState(null);
  const [contact, setContact] = useState(null);
  const [editingContact, setEditingContact] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", phone: "" });
  const [contactCountry, setContactCountry] = useState(COUNTRY_CODES[0]);
  const contactFullPhone = contactCountry.dial + contactForm.phone;
  const contactPhoneValid = contactForm.phone.length === contactCountry.len;

  useEffect(() => {
    if (!isDm || !chat.peer_id) return;
    Promise.all([Users.get(chat.peer_id), Contacts.list()]).then(([user, contacts]) => {
      setPeerProfile(user);
      setContact(contacts.find((entry) => entry.user?.id === chat.peer_id) || null);
    }).catch(() => {});
  }, [isDm, chat.peer_id]);

  function startEditContact() {
    const existingPhone = contact ? contact.phone : (peerProfile?.phone || "");
    const { country, local } = splitPhone(existingPhone);
    setContactCountry(country);
    setContactForm({ name: contact ? contact.name : (peerProfile?.name || chat.name || ""), phone: local });
    setEditingContact(true);
  }

  async function saveContact() {
    if (!contactForm.name.trim() || !contactPhoneValid) {
      toast("Name and a valid phone number are required");
      return;
    }
    try {
      const saved = contact
        ? await Contacts.update(contact.id, contactForm.name.trim(), contactFullPhone)
        : await Contacts.add(contactForm.name.trim(), contactFullPhone);
      setContact(saved);
      setEditingContact(false);
      toast(contact ? "Contact updated" : "Contact added");
    } catch (problem) {
      toast(problem.message || "Could not save contact");
    }
  }

  async function deleteContact() {
    if (!confirm(`Delete ${contact.name} from your contacts?`)) return;
    try {
      await Contacts.remove(contact.id);
      setContact(null);
      toast("Contact deleted");
    } catch (problem) {
      toast(problem.message || "Could not delete contact");
    }
  }

  async function clearChat() {
    if (!confirm("Clear this chat? This only clears your own copy.")) return;
    await Chats.clear(chat.id);
    toast("Chat cleared");
    onChanged();
    onLeft();
  }

  async function deleteChat() {
    if (!confirm("Delete this chat? It will disappear from your chat list.")) return;
    await Chats.clear(chat.id);
    await Chats.settings(chat.id, { archived: true });
    toast("Chat deleted");
    onChanged();
    onLeft();
  }

  const managed = MANAGED_TYPES.includes(chat.type);

  const reloadFull = useCallback(() => {
    if (!managed) return;
    Chats.get(chat.id).then(setFull).catch(() => {});
  }, [chat.id, managed]);

  useEffect(reloadFull, [reloadFull]);

  useEffect(() => {
    if (chat.type !== "community") return;
    Chats.channels(chat.id).then(setSubChannels).catch(() => {});
  }, [chat.id, chat.type]);

  // Anyone's add/remove/promote shows up for everyone with the sheet open.
  useEffect(() => {
    if (events.some((event) => event._n > lastMemberEvent.current && event.chat_id === chat.id
                               && event.type === "members_changed")) {
      lastMemberEvent.current = events[events.length - 1]._n;
      reloadFull();
    }
  }, [events, chat.id, reloadFull]);

  const myRole = full?.my_role;
  const canManage = myRole === "owner" || myRole === "admin";

  async function removeMember(userId) {
    try {
      await Chats.removeMember(chat.id, userId);
      reloadFull();
    } catch (problem) {
      toast(problem.message || "Could not remove member");
    }
  }

  async function setRole(userId, role) {
    try {
      await Chats.setMemberRole(chat.id, userId, role);
      reloadFull();
    } catch (problem) {
      toast(problem.message || "Could not change role");
    }
  }

  async function setMuteUntil(muted_until) {
    setMutedUntil(muted_until);
    setMuteSheet(false);
    await Chats.settings(chat.id, { muted_until });
    onChanged();
  }

  async function toggleArchive(next) {
    setArchived(next);
    await Chats.settings(chat.id, { archived: next });
    onChanged();
  }

  async function changeFolder(next) {
    setFolder(next);
    await Chats.settings(chat.id, { folder: next });
    onChanged();
  }

  async function leave() {
    if (!confirm(`Leave ${chat.name || "this chat"}?`)) return;
    setBusy(true);
    try {
      await Chats.leave(chat.id);
      toast("Left the chat");
      onLeft();
    } catch (problem) {
      toast(problem.message || "Could not leave");
      setBusy(false);
    }
  }

  return (
    <Sheet title={chat.name || "Chat info"} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <Av av={chat.avatar_letter} color={chat.color} size={52} photoId={chat.avatar_attachment_id}/>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{chat.name || "Direct message"}</div>
          {isDm && peerProfile?.phone
            ? <div style={{ fontSize: 12.5, color: G.muted }}>{peerProfile.phone}</div>
            : <div style={{ fontSize: 12.5, color: G.muted, textTransform: "capitalize" }}>{chat.type}</div>}
        </div>
      </div>

      {isDm && (
        editingContact ? (
          <div style={{ marginBottom: 8 }}>
            <Field label="Name" value={contactForm.name}
                   onChange={(event) => setContactForm({ ...contactForm, name: event.target.value })}/>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>Phone</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={contactCountry.iso}
                        onChange={(event) => {
                          setContactCountry(COUNTRY_CODES.find((c) => c.iso === event.target.value));
                          setContactForm({ ...contactForm, phone: "" });
                        }}
                        style={{
                          padding: "12px 8px", borderRadius: 12, background: G.dim,
                          border: `1px solid ${G.border}`, color: G.text, fontSize: 15,
                          outline: "none", flexShrink: 0,
                        }}>
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.iso} value={c.iso}>{flagFor(c.iso)} {c.dial}</option>
                  ))}
                </select>
                <input value={contactForm.phone} inputMode="tel"
                       onChange={(event) => setContactForm({
                         ...contactForm,
                         phone: event.target.value.replace(/\D/g, "").slice(0, contactCountry.len),
                       })}
                       placeholder={"98765" + "4".repeat(Math.max(contactCountry.len - 5, 0))}
                       style={{
                         flex: 1, width: "100%", padding: "12px 14px", borderRadius: 12,
                         background: G.dim, border: `1px solid ${G.border}`, color: G.text,
                         fontSize: 15, outline: "none", boxSizing: "border-box",
                       }}/>
              </div>
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <Button onClick={saveContact}
                      disabled={!contactForm.name.trim() || !contactPhoneValid}
                      style={{ flex: 1 }}>Save</Button>
              <Button variant="ghost" onClick={() => setEditingContact(false)} style={{ flex: 1 }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <SRow icon={I.user(G.accent, 18)} label={contact ? "Edit contact" : "Add to contacts"}
                  sub={contact ? contact.phone : "Save this person to your address book"}
                  onClick={startEditContact}/>
            {contact && (
              <SRow icon={I.trash(G.red, 18)} label="Delete contact" onClick={deleteContact} danger/>
            )}
          </>
        )
      )}

      <SRow icon={I.bellOff(G.accent, 18)} label="Mute notifications"
            sub={mutedUntil > Date.now() / 1000 ? muteLabel(mutedUntil) : "Off"}
            onClick={() => setMuteSheet(true)}
            right={<span style={{ fontSize: 13, color: G.sub }}>
              {mutedUntil > Date.now() / 1000 ? "On" : "Off"}
            </span>}/>

      <SRow icon={I.archive(G.accent, 18)} label="Archive chat"
            sub="Off the main list until a new message arrives"
            right={<Toggle on={archived} onChange={toggleArchive}/>}/>

      <SRow icon={I.image(G.accent, 18)} label="Shared media" onClick={() => setMediaSheet(true)}/>

      {["group", "channel", "community"].includes(chat.type) && canManage && (
        <SRow icon={I.link(G.accent, 18)} label="Invite link"
              sub="Share a code that lets anyone join"
              onClick={() => setInviteSheet(true)}/>
      )}

      <SRow icon={I.lock(locked ? G.accent : G.sub, 18)} label="Chat lock"
            sub={locked ? "PIN required to open this chat" : "Set a PIN to lock this chat"}
            onClick={() => setLockSheet(locked ? "remove" : "set")}
            right={<span style={{ fontSize: 13, color: G.sub }}>{locked ? "On" : "Off"}</span>}/>

      <SRow icon={I.broom(G.accent, 18)} label="Clear chat" sub="Clears your own copy only" onClick={clearChat}/>
      <SRow icon={I.trash(G.red, 18)} label="Delete chat" onClick={deleteChat} danger/>

      <div style={{ padding: "12px 4px" }}>
        <div style={{ fontSize: 12, color: G.sub, marginBottom: 8 }}>Folder</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {FOLDER_CHOICES.map((option) => (
            <button key={option || "none"} onClick={() => changeFolder(option)}
              style={{
                padding: "6px 14px", borderRadius: 20, cursor: "pointer",
                border: `1px solid ${folder === option ? G.accent : G.border}`,
                background: folder === option ? G.accentSoft : "transparent",
                color: folder === option ? G.accentText : G.sub, fontSize: 13,
              }}>{option || "None"}</button>
          ))}
        </div>
      </div>

      {chat.type === "community" && (
        <div style={{ padding: "12px 4px" }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 8,
          }}>
            <div style={{ fontSize: 12, color: G.sub }}>Channels</div>
            {canManage && (
              <div onClick={() => setAddingChannel(true)} style={{ cursor: "pointer" }} title="Add a channel">
                {I.plus(G.accentText, 16)}
              </div>
            )}
          </div>
          {(subChannels || []).map((sub) => (
            <div key={sub.id} onClick={() => onOpenChat(sub)} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 4px",
              cursor: "pointer", borderBottom: `1px solid ${G.border}`,
            }}>
              <Av av={sub.avatar_letter} color={sub.color} size={28}/>
              <div style={{ fontSize: 13.5 }}>{sub.name}</div>
            </div>
          ))}
          {subChannels?.length === 0 && (
            <div style={{ fontSize: 12.5, color: G.muted, padding: "6px 4px" }}>No channels yet</div>
          )}
        </div>
      )}

      {chat.type === "group" && canManage && (
        <div style={{ padding: "12px 4px", borderTop: `1px solid ${G.border}` }}>
          <div style={{ fontSize: 12, color: G.sub, marginBottom: 8 }}>Slow mode</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {SLOW_MODE_CHOICES.map((choice) => (
              <div key={choice.seconds} onClick={async () => {
                try {
                  await Chats.setSlowMode(chat.id, choice.seconds);
                  setSlowModeSecs(choice.seconds);
                  toast(choice.seconds ? `Slow mode: ${choice.label}` : "Slow mode off");
                } catch (problem) {
                  toast(problem.message || "Could not set slow mode");
                }
              }} style={{
                padding: "6px 11px", borderRadius: 16, fontSize: 12, cursor: "pointer",
                background: slowModeSecs === choice.seconds ? G.accentSoft : G.dim,
                border: `1px solid ${slowModeSecs === choice.seconds ? G.accent : G.border}`,
                color: slowModeSecs === choice.seconds ? G.accentText : G.text,
              }}>{choice.label}</div>
            ))}
          </div>
        </div>
      )}

      {managed && (
        <div style={{ padding: "12px 4px" }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 8,
          }}>
            <div style={{ fontSize: 12, color: G.sub }}>
              Members {full ? `(${full.members.length})` : ""}
            </div>
            {canManage && (
              <div onClick={() => setShowAddMembers(true)} style={{ cursor: "pointer" }} title="Add members">
                {I.plus(G.accentText, 16)}
              </div>
            )}
          </div>

          {full && full.members.length > 6 && (
            <input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)}
                   placeholder="Search members…" style={{
                     width: "100%", padding: "7px 10px", borderRadius: 10, marginBottom: 8,
                     background: G.dim, border: `1px solid ${G.border}`, color: G.text, fontSize: 12.5,
                   }}/>
          )}

          {!full && <Spinner small/>}
          {full?.members.filter((m) => m.name.toLowerCase().includes(memberQuery.toLowerCase())).map((member) => (
            <div key={member.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "7px 4px",
              borderBottom: `1px solid ${G.border}`,
            }}>
              <Av av={member.avatar_letter} color={member.color} size={30} photoId={member.avatar_attachment_id}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5 }}>
                  {member.name}{member.id === me.id ? " (you)" : ""}
                </div>
                <div style={{ fontSize: 11, color: G.muted, textTransform: "capitalize" }}>
                  {member.role}
                </div>
              </div>

              {/* Only the owner grants/revokes admin. Nobody manages the owner
                  from here — that only changes by them leaving. */}
              {myRole === "owner" && member.role === "member" && (
                <Button variant="ghost" style={{ padding: "5px 10px", fontSize: 11 }}
                        onClick={() => setRole(member.id, "admin")}>Make admin</Button>
              )}
              {myRole === "owner" && member.role === "admin" && (
                <Button variant="ghost" style={{ padding: "5px 10px", fontSize: 11 }}
                        onClick={() => setRole(member.id, "member")}>Remove admin</Button>
              )}
              {canManage && member.role !== "owner" && member.id !== me.id &&
               (myRole === "owner" || member.role !== "admin") && (
                <Button variant="danger" style={{ padding: "5px 10px", fontSize: 11 }}
                        onClick={() => removeMember(member.id)}>Remove</Button>
              )}
            </div>
          ))}
        </div>
      )}

      {chat.type !== "saved" && chat.type !== "dm" && (
        <Button variant="danger" onClick={leave} disabled={busy}
                style={{ width: "100%", marginTop: 18 }}>
          Leave {chat.type === "channel" ? "channel" : chat.type === "community" ? "community" : "group"}
        </Button>
      )}

      {showAddMembers && (
        <AddMembersSheet chatId={chat.id} existingIds={(full?.members || []).map((m) => m.id)}
                         onClose={() => setShowAddMembers(false)}
                         onAdded={() => { setShowAddMembers(false); reloadFull(); }}/>
      )}

      {addingChannel && (
        <NewSubChannelSheet communityId={chat.id}
                           onClose={() => setAddingChannel(false)}
                           onCreated={(sub) => {
                             setAddingChannel(false);
                             setSubChannels((current) => [...(current || []), sub]);
                             onOpenChat(sub);
                           }}/>
      )}

      {lockSheet && (
        <LockSheet chatId={chat.id} mode={lockSheet} onClose={() => setLockSheet(null)}
                  toast={toast}
                  onDone={(nowLocked) => {
                    setLocked(nowLocked);
                    setLockSheet(null);
                    onChanged();
                    // A chat just locked from inside itself must not stay
                    // "unlocked for this session" — otherwise leaving and
                    // reopening it skips the PIN prompt you just set.
                    if (nowLocked) onChatLocked?.(chat.id);
                  }}/>
      )}

      {muteSheet && (
        <MuteSheet mutedUntil={mutedUntil} onClose={() => setMuteSheet(false)} onPicked={setMuteUntil}/>
      )}

      {mediaSheet && (
        <MediaGallerySheet chatId={chat.id} onClose={() => setMediaSheet(false)}/>
      )}

      {inviteSheet && (
        <InviteLinkSheet chat={chat} toast={toast} onClose={() => setInviteSheet(false)}/>
      )}
    </Sheet>
  );
}

const MUTE_CHOICES = [
  { label: "8 hours", seconds: 8 * 3600 },
  { label: "1 week", seconds: 7 * 24 * 3600 },
  { label: "Always", seconds: 100 * 365 * 24 * 3600 },
];

function muteLabel(mutedUntil) {
  const secondsLeft = mutedUntil - Date.now() / 1000;
  if (secondsLeft > 50 * 365 * 24 * 3600) return "Muted";
  if (secondsLeft > 24 * 3600) return `Muted for ${Math.round(secondsLeft / (24 * 3600))}d`;
  return `Muted for ${Math.round(secondsLeft / 3600)}h`;
}

function MuteSheet({ mutedUntil, onClose, onPicked }) {
  const isMuted = mutedUntil > Date.now() / 1000;
  return (
    <Sheet title="Mute notifications" onClose={onClose}>
      {isMuted && (
        <div onClick={() => onPicked(0)} style={{
          padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
          background: G.dim, border: `1px solid ${G.border}`, fontSize: 14, color: G.red,
        }}>Unmute</div>
      )}
      {MUTE_CHOICES.map((choice) => (
        <div key={choice.label} onClick={() => onPicked(Date.now() / 1000 + choice.seconds)}
          style={{
            padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
            background: G.dim, border: `1px solid ${G.border}`, fontSize: 14,
          }}>{choice.label}</div>
      ))}
    </Sheet>
  );
}

function MediaGallerySheet({ chatId, onClose }) {
  const [media, setMedia] = useState(null);
  const [openIndex, setOpenIndex] = useState(null);

  useEffect(() => {
    Chats.media(chatId).then(setMedia).catch(() => setMedia([]));
  }, [chatId]);

  const viewable = (media || []).filter((m) => m.kind === "photo" || m.kind === "video");

  return (
    <>
      <Sheet title="Shared media" onClose={onClose}>
        {!media ? <Spinner small/> : media.length === 0 ? (
          <div style={{ fontSize: 13, color: G.muted, padding: "10px 0" }}>Nothing shared yet</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {media.map((item) => (
              <MediaThumb key={item.id} message={item}
                          onOpen={item.kind === "photo" || item.kind === "video"
                            ? () => setOpenIndex(viewable.findIndex((v) => v.id === item.id))
                            : null}/>
            ))}
          </div>
        )}
      </Sheet>
      {openIndex !== null && viewable[openIndex] && (
        <MediaLightbox items={viewable} index={openIndex}
                       onIndexChange={setOpenIndex} onClose={() => setOpenIndex(null)}/>
      )}
    </>
  );
}

function MediaThumb({ message, onOpen }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const attachmentId = message.payload?.attachment_id;

  useEffect(() => {
    if (!attachmentId) return;
    let cancelled = false;
    let objectUrl = null;
    Uploads.fetchBlobUrl(attachmentId, { cache: true })
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  const boxStyle = { width: "100%", aspectRatio: "1", borderRadius: 8, background: G.dim, objectFit: "cover" };

  if (!blobUrl) return <div style={boxStyle}/>;
  if (message.kind === "photo") {
    return <img src={blobUrl} alt="" onClick={onOpen} style={{ ...boxStyle, cursor: onOpen ? "pointer" : "default" }}/>;
  }
  if (message.kind === "video") {
    return (
      <div onClick={onOpen} style={{ position: "relative", cursor: onOpen ? "pointer" : "default" }}>
        <video src={blobUrl} style={boxStyle} muted/>
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%", background: "#00000066",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{I.play ? I.play("#fff", 14) : null}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      ...boxStyle, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: 6, objectFit: undefined,
    }}>
      {I.doc(G.accent, 22)}
      <div style={{
        fontSize: 9.5, marginTop: 4, textAlign: "center", overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%",
      }}>{message.payload?.file_name}</div>
    </div>
  );
}

/**
 * Full-screen swipe-through viewer for a chat's shared photos/videos —
 * opened from the grid in MediaGallerySheet. Each slide fetches its own
 * blob lazily (only the current, previous and next indices), same
 * bearer-token reasoning as every other attachment render in this file.
 */
function MediaLightbox({ items, index, onIndexChange, onClose }) {
  const current = items[index];
  const [blobUrl, setBlobUrl] = useState(null);
  const attachmentId = current?.payload?.attachment_id;

  useEffect(() => {
    if (!attachmentId) return;
    let cancelled = false;
    let objectUrl = null;
    Uploads.fetchBlobUrl(attachmentId, { cache: true })
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (event.key === "ArrowRight" && index < items.length - 1) onIndexChange(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndexChange, onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000e6", zIndex: 70,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{ fontSize: 13, color: "#fff", position: "absolute", top: 16, left: 16 }}>
        {index + 1} / {items.length}
      </div>
      <div onClick={onClose} style={{
        position: "absolute", top: 12, right: 16, cursor: "pointer", color: "#fff", fontSize: 26,
      }}>×</div>

      {index > 0 && (
        <div onClick={(e) => { e.stopPropagation(); onIndexChange(index - 1); }} style={{
          position: "absolute", left: 12, cursor: "pointer", color: "#fff", fontSize: 30, userSelect: "none",
        }}>‹</div>
      )}
      {index < items.length - 1 && (
        <div onClick={(e) => { e.stopPropagation(); onIndexChange(index + 1); }} style={{
          position: "absolute", right: 12, cursor: "pointer", color: "#fff", fontSize: 30, userSelect: "none",
        }}>›</div>
      )}

      {!blobUrl ? (
        <Spinner/>
      ) : current.kind === "video" ? (
        <video src={blobUrl} controls autoPlay onClick={(e) => e.stopPropagation()}
               style={{ maxWidth: "92vw", maxHeight: "88vh" }}/>
      ) : (
        <img src={blobUrl} alt="" onClick={(e) => e.stopPropagation()}
             style={{ maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain" }}/>
      )}
    </div>
  );
}

function InviteLinkSheet({ chat, onClose, toast }) {
  const [code, setCode] = useState(chat.invite_code || null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const result = await Chats.createInvite(chat.id);
      setCode(result.invite_code);
    } catch (problem) {
      toast(problem.message || "Could not create invite link");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await Chats.revokeInvite(chat.id);
      setCode(null);
      toast("Invite link revoked");
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    navigator.clipboard?.writeText(code);
    toast("Copied");
  }

  return (
    <Sheet title="Invite link" onClose={onClose}>
      {code ? (
        <>
          <div style={{
            padding: "12px 14px", borderRadius: 12, background: G.dim,
            border: `1px solid ${G.border}`, fontFamily: "monospace", fontSize: 13,
            wordBreak: "break-all", marginBottom: 14,
          }}>{code}</div>
          <div style={{ fontSize: 12, color: G.muted, marginBottom: 14 }}>
            Anyone with this code can join from + → Join via code — no
            invitation needed.
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <Button variant="ghost" onClick={copy} style={{ flex: 1 }}>Copy code</Button>
            <Button onClick={generate} disabled={busy} style={{ flex: 1 }}>Rotate</Button>
          </div>
          <Button variant="danger" onClick={revoke} disabled={busy} style={{ width: "100%" }}>
            Revoke link
          </Button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
            Generate a code that lets anyone join this chat directly, without
            being added by a member.
          </div>
          <Button onClick={generate} disabled={busy} style={{ width: "100%" }}>
            {busy ? "Generating…" : "Generate invite link"}
          </Button>
        </>
      )}
    </Sheet>
  );
}

function LockSheet({ chatId, mode, onClose, onDone, toast }) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (mode === "set") {
      if (pin.length < 4) { toast("PIN must be at least 4 digits"); return; }
      if (pin !== confirmPin) { toast("PINs don't match"); return; }
    } else if (!pin) {
      return;
    }

    setBusy(true);
    try {
      if (mode === "set") {
        await Chats.lock(chatId, pin);
        toast("Chat locked");
        onDone(true);
      } else {
        await Chats.removeLock(chatId, pin);
        toast("Lock removed");
        onDone(false);
      }
    } catch (problem) {
      toast(problem.message || "Wrong PIN");
      setPin("");
      setConfirmPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={mode === "set" ? "Set a PIN" : "Remove chat lock"} onClose={onClose}>
      {mode === "set" ? (
        <>
          <Field type="password" inputMode="numeric" label="New PIN" value={pin}
                 placeholder="At least 4 digits"
                 onChange={(event) => setPin(event.target.value)}/>
          <Field type="password" inputMode="numeric" label="Confirm PIN" value={confirmPin}
                 onChange={(event) => setConfirmPin(event.target.value)}
                 onKeyDown={(event) => event.key === "Enter" && save()}/>
        </>
      ) : (
        <Field type="password" inputMode="numeric" label="Current PIN" value={pin}
               placeholder="Enter the PIN to remove the lock"
               onChange={(event) => setPin(event.target.value)}
               onKeyDown={(event) => event.key === "Enter" && save()}/>
      )}
      <Button variant={mode === "remove" ? "danger" : "solid"} onClick={save}
              disabled={busy || !pin} style={{ width: "100%" }}>
        {busy ? "Please wait…" : mode === "set" ? "Lock this chat" : "Remove lock"}
      </Button>
    </Sheet>
  );
}

function AddMembersSheet({ chatId, existingIds, onClose, onAdded }) {
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Users.list().then(setPeople).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const candidates = people.filter((person) => !existingIds.includes(person.id));

  function toggle(userId) {
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  async function save() {
    if (!selected.length) return;
    setBusy(true);
    try {
      await Chats.addMembers(chatId, selected);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add members" onClose={onClose}>
      {loading ? <Spinner small/> : (
        <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 14 }}>
          {candidates.length === 0 && (
            <div style={{ fontSize: 13, color: G.muted }}>Everyone found is already in this chat.</div>
          )}
          {candidates.map((person) => (
            <label key={person.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 4px",
              cursor: "pointer", borderBottom: `1px solid ${G.border}`,
            }}>
              <input type="checkbox" checked={selected.includes(person.id)}
                     onChange={() => toggle(person.id)}/>
              <Av av={person.avatar_letter} color={person.color} size={30} photoId={person.avatar_attachment_id}/>
              <div style={{ fontSize: 13.5 }}>{person.name}</div>
            </label>
          ))}
        </div>
      )}
      <Button onClick={save} disabled={!selected.length || busy} style={{ width: "100%" }}>
        {busy ? "Adding…" : `Add${selected.length ? ` (${selected.length})` : ""}`}
      </Button>
    </Sheet>
  );
}

function NewSubChannelSheet({ communityId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const sub = await Chats.createSubChannel(communityId, { name: name.trim() });
      onCreated(sub);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="New channel" onClose={onClose}>
      <Field label="Channel name" value={name} onChange={(event) => setName(event.target.value)}
             placeholder="help"/>
      <Button onClick={save} disabled={busy || !name.trim()} style={{ width: "100%" }}>
        {busy ? "Creating…" : "Create channel"}
      </Button>
    </Sheet>
  );
}
