import React, { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Actions, Chats, Contacts, Me, Meetings, Messages, Pins, Products, Report, Scheduled, Search, Translate,
  Uploads, Users,
  sendReliably, sendFileReliably, newClientMessageId, meetingLink,
} from "../api.js";
import * as offlineDb from "../offlineDb.js";
import { playNotifyTone, TONE_OPTIONS } from "../notifyTone.js";
import {
  Av, Button, ChatBackdrop, ContextMenu, CoverImage, EMOJIS, EMOJI_GROUPS, Field, G, I, SRow, SocialLinks,
  Spinner, Toggle,
  clockTime, countdown, dateSeparatorLabel, durationLabel, lastSeenLabel, localInputToUnix, toDate, whenLabel, useEnterToSend,
  useIsDesktop, usePrompt,
} from "../ui.jsx";
import { useVoiceRecorder } from "../useVoiceRecorder.js";
import { canvasesToPdfBlob } from "../imageToPdf.js";
import ErrorBoundary from "../ErrorBoundary.jsx";
import { STICKER_PACKS, STICKERS_BY_ID, getEnabledPacks, setEnabledPacks } from "../stickers.jsx";
import { checkSpam, getSpamSettings, setSpamSettings } from "../spamFilter.js";
import { shouldAutoDownload } from "../mediaPrefs.js";
import { logAdminAction, getAdminLog, clearAdminLog } from "../adminLog.js";
import CameraCapture from "../CameraCapture.jsx";
import GifPicker from "../GifPicker.jsx";
import { contactsAvailable, pickContacts } from "../nativeContacts.js";
import { COUNTRY_CODES, flagFor, samplePlaceholder, splitPhone } from "../countryCodes.js";

const LocationMap = lazy(() => import("../LocationMap.jsx"));
const PhotoEditor = lazy(() => import("../PhotoEditor.jsx"));
const VideoTrimmer = lazy(() => import("../VideoTrimmer.jsx"));
const QrView = lazy(() => import("../QrView.jsx"));
const PdfDoc = lazy(() => import("../PdfDoc.jsx"));

// Granular admin rights, matching chatstore.ADMIN_PERMISSIONS on the backend.
const ADMIN_PERMISSIONS = ["post", "edit", "delete", "pin", "invite"];
const PERMISSION_LABELS = {
  post: "Post messages", edit: "Edit others' messages", delete: "Delete messages",
  pin: "Pin messages", invite: "Add members",
};

const CHAT_ACCENT_KEY = "talkex_chat_accents";
const CHAT_ACCENT_COLORS = [
  { hex: null, label: "Default" },
  { hex: "#0ea5e9", label: "Sky" },
  { hex: "#7c3aed", label: "Violet" },
  { hex: "#059669", label: "Emerald" },
  { hex: "#e11d48", label: "Rose" },
  { hex: "#d97706", label: "Amber" },
  { hex: "#0d9488", label: "Teal" },
  { hex: "#3b82f6", label: "Blue" },
  { hex: "#db2777", label: "Pink" },
  { hex: "#ef4444", label: "Red" },
  { hex: "#8b5cf6", label: "Purple" },
  { hex: "#f97316", label: "Orange" },
];
function getChatAccents() {
  try { return JSON.parse(localStorage.getItem(CHAT_ACCENT_KEY) || "{}"); } catch { return {}; }
}
function setChatAccent(chatId, hex) {
  const accents = getChatAccents();
  if (hex) accents[chatId] = hex; else delete accents[chatId];
  localStorage.setItem(CHAT_ACCENT_KEY, JSON.stringify(accents));
  window.dispatchEvent(new CustomEvent("chat-accent-change"));
}

const REMINDERS_KEY = "talkex_reminders";
function getReminders() {
  try { return JSON.parse(localStorage.getItem(REMINDERS_KEY) || "[]"); } catch { return []; }
}
function addReminder(chatId, messageId, messageText, remindAt) {
  const reminders = getReminders();
  reminders.push({ chatId, messageId, text: (messageText || "").slice(0, 100), remindAt, createdAt: Date.now() });
  localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
}
function removeReminder(messageId) {
  const reminders = getReminders().filter((r) => r.messageId !== messageId);
  localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
}

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
  const [promptFn, promptModal] = usePrompt();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState(chat.draft || "");
  // Text's view-once equivalent of a view-once photo — armed per-message via
  // the composer's eye-toggle, cleared again the moment a send actually
  // goes out so it never silently stays on for the next message.
  const [viewOnceText, setViewOnceText] = useState(false);
  const [silentSend, setSilentSend] = useState(false);
  const [chatAccent, setChatAccentState] = useState(() => getChatAccents()[chat.id] || null);
  useEffect(() => {
    setChatAccentState(getChatAccents()[chat.id] || null);
    const handler = () => setChatAccentState(getChatAccents()[chat.id] || null);
    window.addEventListener("storage", handler);
    window.addEventListener("chat-accent-change", handler);
    return () => { window.removeEventListener("storage", handler); window.removeEventListener("chat-accent-change", handler); };
  }, [chat.id]);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [infoFor, setInfoFor] = useState(null); // message currently showing the "Message info" sheet
  const [bgMenu, setBgMenu] = useState(null); // { x, y } for right-click/long-press on empty chat background
  const [forwarding, setForwarding] = useState(null);
  const [remindFor, setRemindFor] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null); // index into mediaMessages, or null
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState(new Set());
  const [pins, setPins] = useState([]);
  // Translated text keyed by message id — kept local to this screen (never
  // written back to the message itself, never synced), so it's naturally
  // gone the moment the chat is reopened rather than something that has to
  // be explicitly cleared.
  const [translations, setTranslations] = useState({});
  // Topics (see topics table / /chats/{id}/topics): "all" is today's
  // ordinary unfiltered view, so a chat that never turns Topics on behaves
  // exactly as it always has — this only changes anything once the user
  // explicitly picks a specific thread from the strip below.
  const [topics, setTopics] = useState([]);
  const [activeTopicId, setActiveTopicId] = useState("all");
  useEffect(() => {
    if (!chat.topics_enabled) { setTopics([]); setActiveTopicId("all"); return; }
    Chats.topics(chat.id).then(setTopics).catch(() => {});
  }, [chat.id, chat.topics_enabled]);
  const visibleMessages = useMemo(() => {
    if (activeTopicId === "all") return messages;
    if (activeTopicId === "general") return messages.filter((m) => !m.topic_id);
    return messages.filter((m) => m.topic_id === activeTopicId);
  }, [messages, activeTopicId]);
  // messages.find()/pins.some() inside the per-message render loop below
  // turned an O(n) list render into O(n * (n + pins.length)) — for a chat
  // with a few hundred messages that's on the order of 250k comparisons on
  // every re-render (every incoming message, reaction, edit...). Building
  // these once per messages/pins change and doing O(1) lookups per row
  // fixes the complexity without changing what's rendered.
  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // All the chat's photos/videos, in order — the lightbox pages through this
  // whole list (WhatsApp-style) rather than the single tapped image.
  const mediaMessages = useMemo(
    () => messages.filter((m) => (m.kind === "photo" || m.kind === "video")
      && !m.deleted_at && m.payload?.attachment_id && !m.view_once),
    [messages]
  );
  const openMedia = useCallback((message) => {
    const idx = mediaMessages.findIndex((m) => m.id === message.id);
    setLightboxIndex(idx >= 0 ? idx : 0);
  }, [mediaMessages]);
  const mediaGroupMap = useMemo(() => {
    const map = new Map();
    let cur = null;
    for (let i = 0; i < visibleMessages.length; i++) {
      const m = visibleMessages[i];
      const isMedia = (m.kind === "photo" || m.kind === "video") && !m.deleted_at && !m.unsent_at && !m.view_once && !m.text;
      if (isMedia && cur) {
        const first = cur[0];
        if (m.sender_id === first.sender_id && Math.abs(m.created_at - first.created_at) < 60) {
          cur.push(m);
          continue;
        }
      }
      if (cur && cur.length > 1) {
        const gid = cur[0].id;
        cur.forEach((msg, idx) => map.set(msg.id, { groupId: gid, members: cur, index: idx }));
      }
      cur = isMedia ? [m] : null;
    }
    if (cur && cur.length > 1) {
      const gid = cur[0].id;
      cur.forEach((msg, idx) => map.set(msg.id, { groupId: gid, members: cur, index: idx }));
    }
    return map;
  }, [visibleMessages]);
  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.id)), [pins]);
  const [starredIds, setStarredIds] = useState(() => new Set());
  const [showPins, setShowPins] = useState(false);
  const [readState, setReadState] = useState([]);
  const [sheet, setSheet] = useState(null);       // 'schedule' | 'meeting' | 'timer' | 'poll' | 'info' | 'attach' | 'contact' | 'scanEdit' | 'mediaPreview'
  const [commentsFor, setCommentsFor] = useState(null); // the channel post whose discussion thread is open
  const [scanFile, setScanFile] = useState(null); // the raw photo waiting in the scan-edit sheet
  const [mediaPreview, setMediaPreview] = useState(null); // {files, kindOverride} waiting in the caption sheet
  const [meetingUpdates, setMeetingUpdates] = useState({});
  const [members, setMembers] = useState([]); // for @mention autocomplete — group-like chats only
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [chatSearchResults, setChatSearchResults] = useState([]);
  const [headerMenu, setHeaderMenu] = useState(null); // { x, y } for the header's ⋮ menu
  const [muteSheetTop, setMuteSheetTop] = useState(false);
  const [mutedUntilTop, setMutedUntilTop] = useState(chat.muted_until || 0);
  const [lockSheetTop, setLockSheetTop] = useState(null); // 'set' | 'remove'
  const [lockedTop, setLockedTop] = useState(Boolean(chat.is_locked));
  const [favoriteTop, setFavoriteTop] = useState(Boolean(chat.is_favorite));
  const [folderSheetOpen, setFolderSheetOpen] = useState(false);
  const [reportSheetOpen, setReportSheetOpen] = useState(false);
  const inputRef = useRef(chat.draft || "");
  const bottom = useRef(null);
  const scrollContainerRef = useRef(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const bgLongPressTimer = useRef(null);
  const bgLongPressFired = useRef(false);
  const bgPressStart = useRef({ x: 0, y: 0 });
  const typingSentAt = useRef(0);
  const lastApplied = useRef(0);
  const lastPinEvent = useRef(0);
  const lastReadEvent = useRef(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const highestSeq = messages.reduce((top, message) => Math.max(top, message.seq || 0), 0);
  const highestSeqRef = useRef(0);
  highestSeqRef.current = highestSeq;
  // A locked or vanish-mode chat is one you've marked as sensitive — forwarding
  // its contents elsewhere defeats the point of either setting, so every
  // forward entry point (bubble button, long-press menu, multi-select,
  // lightbox) is gated on this rather than just hidden in one of them.
  const canForwardHere = !chat.is_locked && !chat.vanish_mode;

  // Keep ref in sync so the unmount cleanup can read it without depending on state.
  useEffect(() => { inputRef.current = input; }, [input]);

  // Save draft on unmount (leaving the chat).
  useEffect(() => {
    return () => {
      const text = inputRef.current || "";
      Chats.settings(chat.id, { draft: text }).catch(() => {});
    };
  }, [chat.id]);

  // Vanish mode's actual effect: a no-op unless this member turned it on
  // for this chat (see Settings sheet's Toggle above) — fires on the same
  // "switched to a different chat, or left the screen entirely" moment the
  // draft save above does.
  useEffect(() => {
    return () => { Chats.leaveView(chat.id).catch(() => {}); };
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
    Actions.markRead(chat.id, highestSeq).then(() => onChangedRef.current()).catch(() => {});
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

  useEffect(() => {
    let active = true;
    let timerId;
    function checkReminders() {
      if (!active) return;
      const now = Date.now();
      const due = getReminders().filter((r) => r.chatId === chat.id && r.remindAt <= now);
      due.forEach((r) => {
        toast(`Reminder: ${r.text || "message"}`);
        removeReminder(r.messageId);
      });
      timerId = setTimeout(checkReminders, 30000);
    }
    timerId = setTimeout(checkReminders, 5000);
    return () => { active = false; clearTimeout(timerId); };
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
                               && (event.type === "read" || event.type === "delivered"))) {
      lastReadEvent.current = events[events.length - 1]._n;
      reloadReadState();
    }
  }, [events, chat.id, reloadReadState]);

  // Read watermark: the lowest last_read_seq among members who actually report
  // it (receipt-off members come through with last_read_seq === null and are
  // skipped, so they never hold back — or grant — a blue tick).
  const readRows = readState.filter((row) => row.last_read_seq != null);
  const readUpToSeq = readRows.length
    ? Math.min(...readRows.map((row) => row.last_read_seq))
    : null;
  // Delivery watermark: the lowest last_delivered_seq across ALL other members
  // (delivery is never withheld). A message at or below this shows two ticks.
  const deliveredUpToSeq = readState.length
    ? Math.min(...readState.map((row) => row.last_delivered_seq ?? 0))
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

  // Opening a chat (or switching to a different one) should land at the very
  // bottom immediately, the way every WhatsApp-style app opens — not
  // animate a visible scroll through the history. A single scrollIntoView
  // right on mount was also too easy to leave "stuck in the middle": a
  // photo/video bubble that finishes loading its image AFTER this first
  // fires grows the content's height and pushes the real bottom further
  // down, with nothing re-triggering a scroll to compensate — which is
  // exactly what a long chat with media showed. Re-firing a few times over
  // the first second catches that late layout shift without having to
  // instrument every attachment's own load event individually.
  useEffect(() => {
    const delays = [0, 60, 200, 500, 1000];
    const timers = delays.map((delay) =>
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "auto" }), delay));
    return () => timers.forEach(clearTimeout);
  }, [chat.id]);

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
    if (!highestSeqRef.current) return;
    try {
      const missed = await Messages.after(chat.id, highestSeqRef.current);
      if (missed.length) setMessages((current) => mergeBySeq(current, missed));
    } catch { /* the next event or reopen will fix it */ }
  }, [chat.id]);

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
    const sendingViewOnce = viewOnceText;
    const temporary = {
      id: "pending_" + clientMsgId,
      client_msg_id: clientMsgId,
      chat_id: chat.id, sender_id: me.id, text, kind: "text",
      created_at: Date.now() / 1000, seq: highestSeq + 1,
      reactions: [], pending: true, view_once: sendingViewOnce,
      reply_to_id: replyTo?.id || null,
    };
    setMessages((current) => [...current, temporary]);
    setInput("");
    setReplyTo(null);
    setViewOnceText(false);

    try {
      const stored = await sendReliably({
        chatId: chat.id, text, replyToId: temporary.reply_to_id, clientMsgId,
        viewOnce: sendingViewOnce, silent: silentSend,
        topicId: activeTopicId === "all" || activeTopicId === "general" ? null : activeTopicId,
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
      if (problem?.name === "AbortError") {
        setMessages((current) => current.filter((m) => m.id !== temporary.id));
      } else {
        setMessages((current) => current.map((m) =>
          m.id === temporary.id ? { ...m, pending: false, failed: true } : m));
        toast(problem.message || "Could not send");
      }
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
    try {
      await Messages.forward(message.id, toChatIds);
      toast(toChatIds.length === 1 ? "Forwarded" : `Forwarded to ${toChatIds.length} chats`);
    } catch (problem) {
      toast(problem.message || "Could not forward");
    }
    setForwarding(null);
  }

  // The OS-level share sheet, not in-app forwarding — lets a photo/document
  // land in whatever other app the user actually wants (Instagram, Mail,
  // WhatsApp itself), which Forward alone can never reach since that only
  // moves a message to another chat inside TalkEx.
  async function shareMessage(message) {
    try {
      const attachmentId = message.payload?.attachment_id;
      if (attachmentId) {
        const blobUrl = message.payload?._localUrl || await Uploads.fetchBlobUrl(attachmentId, { cache: true });
        const blob = await fetch(blobUrl).then((r) => r.blob());
        const file = new File([blob], message.payload?.file_name || "file", { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text: message.text || undefined });
          return;
        }
      }
      if (message.text) await navigator.share({ text: message.text });
    } catch (problem) {
      if (problem?.name !== "AbortError") toast("Could not share");
    }
  }

  async function downloadMessageFile(message) {
    const attachmentId = message.payload?.attachment_id;
    if (!attachmentId) return;
    try {
      const blobUrl = message.payload?._localUrl || await Uploads.fetchBlobUrl(attachmentId, { cache: true });
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = message.payload?.file_name || "file";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      toast("Could not download");
    }
  }

  async function clearThisChat() {
    if (!confirm("Clear this chat? This only clears your own copy.")) return;
    try {
      await Chats.clear(chat.id);
      setMessages([]);
      toast("Chat cleared");
      onChanged();
    } catch (problem) {
      toast(problem.message || "Could not clear chat");
    }
  }

  // Right-click (desktop) or long-press/tap (mobile, mirroring the
  // per-message menu's onClick+onContextMenu pattern) on empty space in the
  // message list — same full action set as the header's ⋮ button
  // (headerMenuItems, defined below), just reached a second way. Kept as
  // one shared list rather than two so they can't quietly drift apart.
  function bgMenuItems() {
    return headerMenuItems();
  }

  async function toggleArchiveTop() {
    const next = !chat.archived;
    await Chats.settings(chat.id, { archived: next });
    toast(next ? "Chat archived" : "Chat unarchived");
    onChanged();
  }

  // Moves a still-scheduled meeting to 'live' if it isn't already (a no-op
  // otherwise), then joins the in-app call for this chat — meetings have no
  // room of their own; a meeting IS the call happening in the chat it was
  // created in, whoever joins it first is starting it.
  async function joinMeeting(meeting) {
    let password;
    if (meeting.has_password) {
      password = await promptFn("Meeting password:");
      if (password === null) return;
    }
    try {
      await Meetings.start(meeting.id);
      if (chat.type === "dm") onStartCall("video"); else onStartGroupCall("video", password);
    } catch (problem) {
      toast(problem.message || "Could not join the meeting");
    }
  }

  async function toggleFavoriteTop() {
    const next = !favoriteTop;
    setFavoriteTop(next);
    await Chats.settings(chat.id, { is_favorite: next });
    toast(next ? "Added to favourites" : "Removed from favourites");
    onChanged();
  }

  async function sendCallLink() {
    try {
      let code = chat.invite_code;
      if (!code) {
        const result = await Chats.createInvite(chat.id);
        code = result.invite_code;
      }
      const url = `https://web.talkex.in/?invite=${code}`;
      if (navigator.share) {
        await navigator.share({ url, text: `Join ${chat.name || "the chat"} on TalkEx` });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Call link copied");
      }
    } catch (problem) {
      if (problem?.name !== "AbortError") toast(problem.message || "Could not create a call link");
    }
  }

  async function blockPeer() {
    if (!chat.peer_id) return;
    if (!confirm(`Block ${chat.name || "this person"}? They won't be able to message or call you.`)) return;
    try {
      await Users.block(chat.peer_id);
      toast("Blocked");
    } catch (problem) {
      toast(problem.message || "Could not block");
    }
  }

  async function deleteThisChat() {
    if (!confirm("Delete this chat? It will disappear from your chat list.")) return;
    try {
      await Chats.clear(chat.id);
      await Chats.settings(chat.id, { archived: true });
      toast("Chat deleted");
      onChanged();
      onBack();
    } catch (problem) {
      toast(problem.message || "Could not delete chat");
    }
  }

  // The header's ⋮ button — a visible, always-discoverable way to reach
  // everything the background right-click/long-press menu above also
  // offers, plus the chat-level actions that otherwise only live one level
  // deeper inside the full Chat info sheet.
  function headerMenuItems() {
    const isMutedTop = mutedUntilTop > Date.now() / 1000;
    const canManageTop = chat.role === "owner" || chat.role === "admin";
    return [
      { label: "Chat info", icon: I.user(G.sub, 16), onClick: () => setSheet("info") },
      {
        label: "Select messages",
        icon: I.check(G.sub, 16),
        onClick: () => { setSelectMode(true); setSelectedMsgIds(new Set()); },
      },
      {
        label: "Search in chat",
        icon: I.search(G.sub, 16),
        onClick: () => { setChatSearchOpen(true); setChatSearchQuery(""); setChatSearchResults([]); },
      },
      {
        label: isMutedTop ? muteLabel(mutedUntilTop) : "Mute notifications",
        icon: I.bellOff(G.sub, 16),
        onClick: () => setMuteSheetTop(true),
      },
      { label: "Disappearing messages", icon: I.timer(G.sub, 16), onClick: () => setSheet("timer") },
      {
        label: lockedTop ? "Remove chat lock" : "Chat lock",
        icon: I.lock(lockedTop ? G.accent : G.sub, 16),
        onClick: () => setLockSheetTop(lockedTop ? "remove" : "set"),
      },
      {
        label: favoriteTop ? "Remove from favourites" : "Add to favourites",
        icon: <span style={{ fontSize: 15, color: favoriteTop ? G.accent : G.sub, width: 16, textAlign: "center", lineHeight: 1 }}>★</span>,
        onClick: toggleFavoriteTop,
      },
      { label: "Add to list", icon: I.archive(G.sub, 16), onClick: () => setFolderSheetOpen(true) },
      ...(["group", "channel", "community"].includes(chat.type)
        ? [{ label: "Schedule a meeting", icon: I.calendar(G.sub, 16), onClick: () => setSheet("meeting") }]
        : []),
      { divider: true },
      ...(chat.type === "dm" || chat.type === "group"
        ? [
            {
              label: "Voice call", icon: I.phone(G.sub, 16),
              onClick: () => (chat.type === "dm" ? onStartCall("voice") : onStartGroupCall("voice")),
            },
            {
              label: "Video call", icon: I.video(G.sub, 16),
              onClick: () => (chat.type === "dm" ? onStartCall("video") : onStartGroupCall("video")),
            },
          ]
        : []),
      ...(["group", "channel", "community"].includes(chat.type) && canManageTop
        ? [{ label: "Send call link", icon: I.link(G.sub, 16), onClick: sendCallLink }]
        : []),
      { label: "Close chat", icon: I.back(G.sub, 16), onClick: onBack },
      { label: chat.archived ? "Unarchive chat" : "Archive chat", icon: I.archive(G.sub, 16), onClick: toggleArchiveTop },
      ...(chat.type === "dm" && chat.peer_id
        ? [{ label: "Block", icon: I.ban(G.red, 16), danger: true, onClick: blockPeer }]
        : []),
      { label: "Report", icon: I.ban(G.sub, 16), onClick: () => setReportSheetOpen(true) },
      { label: "Clear chat", icon: I.broom(G.sub, 16), onClick: clearThisChat },
      { label: "Delete chat", icon: I.trash(G.red, 16), danger: true, onClick: deleteThisChat },
    ];
  }

  // Was a single boolean that disabled the attach button until the ONE
  // in-flight upload finished — which meant picking a second file mid-
  // upload was simply impossible, unlike WhatsApp where every attachment
  // uploads independently and you can keep composing/attaching in the
  // meantime. A Map keyed by clientMsgId (rather than a count) is what
  // lets a specific upload be found again for cancelUpload below.
  const uploadControllers = useRef(new Map()); // clientMsgId -> AbortController
  const [uploadingIds, setUploadingIds] = useState(() => new Set());
  const [uploadProgress, setUploadProgress] = useState(() => new Map());
  const failedFilesRef = useRef(new Map()); // clientMsgId -> { file, kind, text, viewOnce }

  function cancelUpload(clientMsgId) {
    uploadControllers.current.get(clientMsgId)?.abort();
  }

  async function retryMessage(msg) {
    const cmid = msg.client_msg_id;
    const saved = failedFilesRef.current.get(cmid);
    if (saved) {
      failedFilesRef.current.delete(cmid);
      setMessages((current) => current.filter((m) => m.client_msg_id !== cmid));
      if (msg.payload?._localUrl) URL.revokeObjectURL(msg.payload._localUrl);
      sendFile(saved.file, saved.kind, saved.text || "", saved.viewOnce);
    } else if (msg.kind === "text") {
      setMessages((current) => current.map((m) =>
        m.client_msg_id === cmid ? { ...m, failed: false, pending: true } : m));
      try {
        const stored = await sendReliably({
          chatId: chat.id, text: msg.text, clientMsgId: cmid,
          replyToId: msg.reply_to_id || null,
        });
        setMessages((current) =>
          stored ? upsertMessage(current, stored)
            : current.map((m) => m.client_msg_id === cmid ? { ...m, queued: true } : m));
        if (stored) onChanged();
      } catch {
        setMessages((current) => current.map((m) =>
          m.client_msg_id === cmid ? { ...m, pending: false, failed: true } : m));
      }
    }
  }

  function removeFailedMessage(msg) {
    const cmid = msg.client_msg_id;
    setMessages((current) => current.filter((m) => m.client_msg_id !== cmid));
    failedFilesRef.current.delete(cmid);
    if (msg.payload?._localUrl) URL.revokeObjectURL(msg.payload._localUrl);
  }

  function sendVoiceNote(blob, transcript) {
    // MediaRecorder produces a Blob, not a File — Uploads.create needs
    // something with a filename, so wrap it. The extension is cosmetic; the
    // server trusts the declared content type, not the name, for playback.
    const extension = blob.type.includes("mp4") ? "m4a" : "webm";
    const file = new File([blob], `voice-note.${extension}`, { type: blob.type });
    // The transcript rides in as the message's ordinary text/caption field —
    // Attachment already renders message.text under a voice note, so this
    // needs no new rendering path, just a label so it doesn't read as
    // something the sender deliberately typed.
    sendFile(file, "voice", transcript ? `📝 ${transcript}` : "");
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

    const controller = new AbortController();
    uploadControllers.current.set(clientMsgId, controller);
    setUploadingIds((current) => new Set(current).add(clientMsgId));
    try {
      const stored = await sendFileReliably({
        chatId: chat.id, file, kind, text, viewOnce, clientMsgId, signal: controller.signal,
        onProgress: (pct) => setUploadProgress((prev) => new Map(prev).set(clientMsgId, pct)),
      });
      setMessages((current) =>
        stored
          ? upsertMessage(current, stored)
          // null means it went to the pending-uploads queue: keep showing
          // the local preview, marked queued instead of pending.
          : current.map((m) => (m.id === temporary.id ? { ...m, queued: true } : m)));
      if (stored) onChanged();
    } catch (problem) {
      if (problem?.name === "AbortError") {
        setMessages((current) => current.filter((m) => m.id !== temporary.id));
        if (localUrl) URL.revokeObjectURL(localUrl);
      } else {
        failedFilesRef.current.set(clientMsgId, { file, kind, text, viewOnce });
        setMessages((current) => current.map((m) =>
          m.id === temporary.id ? { ...m, pending: false, failed: true } : m));
        toast(problem.message || "Could not send file");
      }
    } finally {
      uploadControllers.current.delete(clientMsgId);
      setUploadingIds((current) => {
        const next = new Set(current);
        next.delete(clientMsgId);
        return next;
      });
      setUploadProgress((prev) => { const next = new Map(prev); next.delete(clientMsgId); return next; });
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
      setMessages((current) =>
        current.map((m) => m.client_msg_id === event.detail.clientMsgId
          ? { ...m, pending: false, queued: false, failed: true } : m));
      toast("A queued file could not be sent — tap to retry");
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
    for (let i = 0; i < files.length; i++) {
      await sendFile(files[i], kindOverride, i === files.length - 1 ? text : "", viewOnce);
    }
  }

  // Only one live share can be running from this tab at a time. A ref, not
  // state — nothing here needs to trigger a re-render, and a ref survives
  // the setTimeout closure below without going stale.
  const liveLocationRef = useRef(null); // { watchId, messageId, timerId }

  const stopLiveLocation = useCallback(() => {
    if (liveLocationRef.current?.watchId != null) {
      navigator.geolocation.clearWatch(liveLocationRef.current.watchId);
    }
    if (liveLocationRef.current?.timerId != null) {
      clearTimeout(liveLocationRef.current.timerId);
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
    const timerId = setTimeout(() => {
      if (liveLocationRef.current?.messageId === messageId) stopLiveLocation();
    }, liveSeconds * 1000);
    liveLocationRef.current = { watchId, messageId, timerId };
  }

  // Takes an already-confirmed lat/lng (the picker sheet shows the map and
  // lets the pin be dragged/tapped before this is ever called) rather than
  // grabbing the device's raw current position and sending it sight
  // unseen the way this used to.
  async function sendLocation(lat, lng, liveSeconds) {
    try {
      const payload = { lat, lng };
      if (liveSeconds) payload.live_until = Date.now() / 1000 + liveSeconds;
      const stored = await Messages.send({
        chat_id: chat.id, kind: "location", text: "",
        payload, client_msg_id: newClientMessageId(),
      });
      setMessages((current) => upsertMessage(current, stored));
      onChanged();
      setSheet(null);
      if (liveSeconds) startLiveTracking(stored.id, liveSeconds);
    } catch (problem) {
      toast(problem.message || "Could not send location");
      throw problem;
    }
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

  async function translateMessage(message) {
    if (!message?.text) return;
    const target = (navigator.language || "en").split("-")[0];
    try {
      const result = await Translate.text(message.text, target);
      setTranslations((current) => ({ ...current, [message.id]: result.translated_text }));
    } catch (problem) {
      toast(problem.status === 503
        ? "Translation isn't set up on this server yet"
        : (problem.message || "Could not translate"));
    }
  }

  async function sendProduct(product) {
    try {
      const stored = await Messages.send({
        chat_id: chat.id, kind: "product", text: "",
        payload: { product_id: product.id },
        client_msg_id: newClientMessageId(),
      });
      setMessages((current) => upsertMessage(current, stored));
      onChanged();
      setSheet(null);
    } catch (problem) {
      toast(problem.message || "Could not share product");
    }
  }

  async function sendGif(gif) {
    try {
      const stored = await Messages.send({
        chat_id: chat.id, kind: "gif", text: "",
        payload: {
          gif_url: gif.gif_url, preview_url: gif.preview_url,
          width: gif.width, height: gif.height,
        },
        client_msg_id: newClientMessageId(),
      });
      setMessages((current) => upsertMessage(current, stored));
      onChanged();
      setSheet(null);
    } catch (problem) {
      toast(problem.message || "Could not send GIF");
    }
  }

  function sendScanPdf(pdfBlob) {
    // Not awaited — sendFile already shows its own optimistic bubble and
    // uploads in the background (with its own progress/cancel UI); waiting
    // for that here would hold the scan sheet open with a spinner for as
    // long as the actual upload took, on top of however long building the
    // PDF itself already took.
    const pdfFile = new File([pdfBlob], "scan.pdf", { type: "application/pdf" });
    sendFile(pdfFile, "document");
    setSheet(null);
    setScanFile(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const typingNames = Object.values(typingBy[chat.id] || {});

  // WhatsApp Web-style drag-and-drop file support. Attached to the whole
  // ChatView (not just the composer) so a file can be dropped anywhere in
  // the conversation area, same as WhatsApp Web. onDragOver's
  // preventDefault is the actual switch that tells the browser "yes, this
  // is a drop target" — without it Chrome opens the file in a new tab
  // instead of firing our onDrop.
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragEnterCount = useRef(0);

  return (
    // --app-height (kept live by useViewportHeightVar) is the height ABOVE the
    // on-screen keyboard on mobile; 100vh is the fallback. Using a plain 100vh
    // here was the typing bug: the container stayed full-height when the iOS
    // keyboard opened, so the composer sat underneath it and Safari scrolled
    // the whole view to try to reveal it, breaking the layout.
    <div style={{ display: "flex", flexDirection: "column", height: "var(--app-height, 100vh)", position: "relative" }}
      onDragEnter={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        // dragenter fires for every child element the cursor crosses, not
        // just the outer div — counter approach is the standard trick to
        // avoid flicker as it re-enters children while the drag is still
        // over the drop zone as a whole.
        dragEnterCount.current += 1;
        setIsDraggingFile(true);
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        dragEnterCount.current -= 1;
        if (dragEnterCount.current <= 0) {
          dragEnterCount.current = 0;
          setIsDraggingFile(false);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.files?.length) return;
        event.preventDefault();
        dragEnterCount.current = 0;
        setIsDraggingFile(false);
        // Kind auto-picked from mime type per file — matches how the
        // Attach sheet's file picker works (photos go as photo, videos as
        // video, everything else as document).
        const files = Array.from(event.dataTransfer.files);
        for (const file of files) {
          const kind = file.type.startsWith("image/") ? "photo"
            : file.type.startsWith("video/") ? "video"
            : file.type.startsWith("audio/") ? "voice"
            : "document";
          sendFile(file, kind);
        }
      }}>
      {isDraggingFile && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 45, pointerEvents: "none",
          background: `${G.accent}22`, border: `3px dashed ${G.accent}`, borderRadius: 8,
          display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
        }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>📎</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: G.accent }}>Drop files to send</div>
        </div>
      )}
      <Header chat={chat} typing={typingNames} onBack={onBack}
              onTimer={() => setSheet("timer")}
              onMeeting={() => setSheet("meeting")}
              onInfo={() => setSheet("info")}
              onVoiceCall={() => (chat.type === "dm" ? onStartCall("voice") : onStartGroupCall("voice"))}
              onVideoCall={() => (chat.type === "dm" ? onStartCall("video") : onStartGroupCall("video"))}
              pinCount={pins.length}
              onTogglePins={() => setShowPins((v) => !v)}
              onSearch={() => { setChatSearchOpen((v) => !v); setChatSearchQuery(""); setChatSearchResults([]); }}
              onMenu={(event) => setHeaderMenu({ x: event.clientX, y: event.clientY })}/>

      {headerMenu && (
        <ContextMenu x={headerMenu.x} y={headerMenu.y} items={headerMenuItems()} onClose={() => setHeaderMenu(null)}/>
      )}
      {muteSheetTop && (
        <MuteSheet mutedUntil={mutedUntilTop} onClose={() => setMuteSheetTop(false)}
                   onPicked={async (muted_until) => {
                     setMutedUntilTop(muted_until);
                     setMuteSheetTop(false);
                     await Chats.settings(chat.id, { muted_until });
                     onChanged();
                   }}/>
      )}
      {lockSheetTop && (
        <LockSheet chatId={chat.id} mode={lockSheetTop} toast={toast}
                   onClose={() => setLockSheetTop(null)}
                   onDone={(nowLocked) => {
                     setLockedTop(nowLocked);
                     setLockSheetTop(null);
                     onChanged();
                     if (nowLocked) onChatLocked?.(chat.id);
                   }}/>
      )}
      {folderSheetOpen && (
        <FolderSheet current={chat.folder || ""} onClose={() => setFolderSheetOpen(false)}
                     onPicked={async (folder) => {
                       setFolderSheetOpen(false);
                       await Chats.settings(chat.id, { folder });
                       toast(folder ? `Added to "${folder}"` : "Removed from list");
                       onChanged();
                     }}/>
      )}
      {reportSheetOpen && (
        <ReportSheet onClose={() => setReportSheetOpen(false)}
                     onSubmit={async (reason) => {
                       setReportSheetOpen(false);
                       try {
                         await Report.submit(
                           chat.type === "dm" ? "user" : "chat",
                           chat.type === "dm" ? chat.peer_id : chat.id,
                           reason,
                         );
                         toast("Reported — thanks for letting us know");
                       } catch (problem) {
                         toast(problem.message || "Could not send the report");
                       }
                     }}/>
      )}

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
          {canForwardHere && (
            <div onClick={() => {
              if (!selectedMsgIds.size) return;
              setForwarding({ ids: [...selectedMsgIds] });
              setSelectMode(false);
              setSelectedMsgIds(new Set());
            }} style={{ cursor: selectedMsgIds.size ? "pointer" : "default", opacity: selectedMsgIds.size ? 1 : 0.4 }}
                 title="Forward selected">
              {I.send(G.accent, 18)}
            </div>
          )}
          <div onClick={async () => {
            if (!selectedMsgIds.size) return;
            try {
              await Promise.all([...selectedMsgIds].map((id) => Messages.hide(id)));
              setMessages((c) => c.filter((m) => !selectedMsgIds.has(m.id)));
              toast(`${selectedMsgIds.size} deleted`);
            } catch (problem) {
              toast(problem.message || "Could not delete messages");
            }
            setSelectMode(false);
            setSelectedMsgIds(new Set());
          }} style={{ cursor: selectedMsgIds.size ? "pointer" : "default", opacity: selectedMsgIds.size ? 1 : 0.4 }}
               title="Delete for me">
            {I.trash(G.red, 18)}
          </div>
        </div>
      )}

      {!!chat.topics_enabled && (
        <TopicStrip topics={topics} activeTopicId={activeTopicId} onSelect={setActiveTopicId}
                    onCreated={(topic) => setTopics((current) => [...current, topic])}
                    chatId={chat.id} toast={toast}/>
      )}

      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <ChatBackdrop/>
        <div
          ref={scrollContainerRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
          }}
          onContextMenu={(event) => {
            if (selectMode || event.target !== event.currentTarget) return;
            event.preventDefault();
            setBgMenu({ x: event.clientX, y: event.clientY });
          }}
          onPointerDown={(event) => {
            // Empty-space long-press, on touch only — the same trigger a
            // right-click is for a mouse. A message itself has its own
            // press handling (see Bubble) and isn't the container itself,
            // so this only ever fires for a press on genuine empty space.
            if (selectMode || event.pointerType !== "touch" || event.target !== event.currentTarget) return;
            bgLongPressFired.current = false;
            bgPressStart.current = { x: event.clientX, y: event.clientY };
            const x = event.clientX, y = event.clientY;
            bgLongPressTimer.current = setTimeout(() => {
              bgLongPressFired.current = true;
              setBgMenu({ x, y: y - 50 });
            }, 500);
          }}
          onPointerMove={(event) => {
            if (!bgLongPressTimer.current) return;
            if (Math.abs(event.clientX - bgPressStart.current.x) > 8
                || Math.abs(event.clientY - bgPressStart.current.y) > 8) {
              clearTimeout(bgLongPressTimer.current);
              bgLongPressTimer.current = null;
            }
          }}
          onPointerUp={() => {
            if (bgLongPressTimer.current) { clearTimeout(bgLongPressTimer.current); bgLongPressTimer.current = null; }
          }}
          onPointerCancel={() => {
            if (bgLongPressTimer.current) { clearTimeout(bgLongPressTimer.current); bgLongPressTimer.current = null; }
          }}
          style={{
          position: "relative", zIndex: 1, height: "100%", overflowY: "auto", padding: "12px 14px",
        }}>
        {/* E2EE system banner at top of messages */}
        {!loading && (
          <div style={{
            textAlign: "center", padding: "10px 24px", marginBottom: 8,
          }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px",
              borderRadius: 10, background: `${G.accent}0c`, fontSize: 11.5, color: G.muted,
            }}>
              <span style={{ fontSize: 12 }}>🔒</span>
              Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.
            </div>
          </div>
        )}
        {loading ? <Spinner/> : visibleMessages.map((message, idx) => {
          const prevMsg = idx > 0 ? visibleMessages[idx - 1] : null;
          const curDay = toDate(message.created_at).toDateString();
          const prevDay = prevMsg ? toDate(prevMsg.created_at).toDateString() : null;
          const showDatePill = !prevMsg || curDay !== prevDay;
          const datePill = showDatePill ? (
            <div key={`date_${curDay}`} style={{ textAlign: "center", margin: "10px 0 6px" }}>
              <span style={{
                display: "inline-block", padding: "4px 12px", borderRadius: 8,
                background: G.card, color: G.sub, fontSize: 12, fontWeight: 500,
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
              }}>{dateSeparatorLabel(message.created_at)}</span>
            </div>
          ) : null;
          const albumInfo = mediaGroupMap.get(message.id);
          if (albumInfo && albumInfo.index > 0) return datePill;
          if (albumInfo && albumInfo.index === 0) {
            const mine = message.sender_id === me?.id;
            const last = albumInfo.members[albumInfo.members.length - 1];
            return (<React.Fragment key={message.id}>
              {datePill}
              <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 8 }}>
                <div style={{ maxWidth: "min(78%, 300px)", borderRadius: 16, overflow: "hidden",
                  borderBottomRightRadius: mine ? 4 : 16, borderBottomLeftRadius: mine ? 16 : 4,
                  background: mine ? (chatAccent || G.accent) : G.card, border: mine ? "none" : `1px solid ${G.border}`, padding: 3,
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: albumInfo.members.length === 1 ? "1fr" : "1fr 1fr", gap: 2, borderRadius: 13, overflow: "hidden" }}>
                    {albumInfo.members.slice(0, 4).map((m, idx) => (
                      <div key={m.id} onClick={() => openMedia(m)} style={{
                        position: "relative", cursor: "pointer", aspectRatio: albumInfo.members.length === 3 && idx === 2 ? "2/1" : "1/1",
                        gridColumn: albumInfo.members.length === 3 && idx === 2 ? "1 / -1" : undefined,
                        overflow: "hidden",
                      }}>
                        <AlbumThumb message={m}/>
                        {idx === 3 && albumInfo.members.length > 4 && (
                          <div style={{ position: "absolute", inset: 0, background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 28, fontWeight: 700, color: "#fff" }}>+{albumInfo.members.length - 4}</div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5, padding: "2px 8px 4px" }}>
                    <span style={{ fontSize: 10.5, color: mine ? "#ffffffaa" : G.muted }}>{clockTime(last.created_at)}</span>
                    {mine && (
                      <span style={{ display: "inline-flex" }}>
                        {last.pending || last.queued ? I.clock("#ffffff99", 11) : I.checkDouble(readUpToSeq !== null && last.seq <= readUpToSeq ? "#53bdeb" : "#ffffffaa", 12)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </React.Fragment>);
          }
          return message.kind === "system" ? (
            <React.Fragment key={message.id}>
              {datePill}
              <div style={{ textAlign: "center", margin: "8px 0" }}>
                <span style={{
                  display: "inline-block", padding: "5px 12px", borderRadius: 10,
                  background: `${G.accent}12`, color: G.muted, fontSize: 12, lineHeight: 1.4,
                  maxWidth: "80%",
                }}>{message.text}</span>
              </div>
            </React.Fragment>
          ) : (
          <React.Fragment key={message.id}>
          {datePill}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
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
              {/* key={message.id} so a crashed boundary resets when React
                  swaps in a different message at this slot, instead of one
                  bad message's caught-error state bleeding into whatever
                  renders here next. This is the actual containment for
                  "some chats crash the whole screen" — one malformed
                  message (an old/legacy payload shape a renderer doesn't
                  guard against, say) now degrades to a single inline
                  notice instead of taking every other message in the
                  conversation down with it. */}
              <ErrorBoundary key={message.id} compact>
              <Bubble message={message} me={me}
                      chatAccent={chatAccent}
                      onCancelUpload={cancelUpload}
                      onRetry={() => retryMessage(message)}
                      onRemoveFailed={() => removeFailedMessage(message)}
                      uploadPct={uploadProgress.get(message.client_msg_id)}
                      translatedText={translations[message.id]}
                      replyTarget={messagesById.get(message.reply_to_id)}
                      meetingUpdates={meetingUpdates}
                      isPinned={pinnedIds.has(message.id)}
                      isRead={readUpToSeq !== null && message.seq <= readUpToSeq}
                      isDelivered={deliveredUpToSeq !== null && message.seq <= deliveredUpToSeq}
                      onDoubleTap={() => {
                        if (message.pending || message.queued || message.failed || message.deleted_at || message.expired) return;
                        react(message, "❤️");
                      }}
                      onLongPress={() => {
                        if (message.pending || message.queued || message.failed) return;
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
                      onSwipeReply={() => {
                        if (message.pending || message.queued || message.failed) return;
                        setReplyTo(message);
                      }}
                      onSwipeInfo={() => {
                        if (message.pending || message.queued || message.failed) return;
                        setInfoFor(message);
                      }}
                      onVote={(index) => vote(message, index)}
                      onForward={canForwardHere ? () => setForwarding(message) : undefined}
                      onOpenMedia={openMedia}
                      signature={chat.signature_enabled && chat.type === "channel"
                        ? (members.find((m) => m.id === message.sender_id)?.name || "")
                        : ""}
                      commentsOn={["channel", "community", "community_channel"].includes(chat.type)
                        && chat.comments_enabled !== 0 && !message.deleted_at && !message.expired}
                      onComments={() => setCommentsFor(message)}
                      onCallAgain={(kind) => onStartCall(kind)} onJoinMeeting={joinMeeting} toast={toast}/>
              </ErrorBoundary>
            </div>
          </div>
          </React.Fragment>
          );
        })}
        <div ref={bottom}/>
        </div>

        {showScrollDown && (
          <button
            onClick={() => bottom.current?.scrollIntoView({ behavior: "smooth" })}
            style={{
              position: "absolute", bottom: 16, right: 16, zIndex: 5,
              width: 40, height: 40, borderRadius: "50%",
              background: G.bg, border: `1px solid ${G.border}`,
              boxShadow: `0 2px 8px ${G.shadow || "rgba(0,0,0,.15)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", color: G.text,
            }}
            aria-label="Scroll to bottom"
          >
            {/* `I` is TalkEx's icon OBJECT (I.send, I.chevronDown, ...) — a
                plain object of icon-generator functions, not itself a
                component. `<I name="..." sz={24}/>` used the object as a
                JSX element type directly, which is React error #130
                ("Element type is invalid... got: object") the instant this
                button actually renders. It only renders once a chat has
                enough messages to scroll away from the bottom — which is
                exactly why this only ever crashed on long chats and never
                on short ones. */}
            {I.chevronDown(G.text, 24)}
          </button>
        )}
      </div>

      {viewOnceText && !editing && (
        <Banner label="View once — disappears the moment it's read"
                icon={I.eye("#a855f7", 16)} accent="#a855f7"
                onClear={() => setViewOnceText(false)}/>
      )}
      {replyTo && (
        <Banner label={`Replying to: ${replyTo.text?.slice(0, 60) || "message"}`}
                icon={I.reply(G.accent, 16)} accent={G.accent}
                onClear={() => setReplyTo(null)}/>
      )}
      {editing && (
        <Banner label={`Editing: ${editing.text?.slice(0, 60) || "message"}`}
                icon={I.edit("#f59e0b", 16)} accent="#f59e0b"
                onClear={() => { setEditing(null); setInput(""); }}/>
      )}

      <Composer
        value={input}
        onChange={onType}
        onSend={send}
        onSchedule={() => setSheet("schedule")}
        onVoice={sendVoiceNote}
        uploading={uploadingIds.size > 0}
        disappearSecs={chat.disappear_secs}
        editing={Boolean(editing)}
        onCancelEdit={() => { setEditing(null); setInput(""); }}
        members={members}
        toast={toast}
        viewOnce={viewOnceText}
        onToggleViewOnce={() => setViewOnceText((v) => !v)}
        canSilent
        silent={silentSend}
        onToggleSilent={() => setSilentSend((v) => !v)}
        onFile={sendFile}
        onLocation={() => setSheet("location")}
        onContact={() => setSheet("contact")}
        onPoll={() => setSheet("poll")}
        onSticker={() => setSheet("sticker")}
        onGif={() => setSheet("gif")}
        onProduct={() => setSheet("product")}
        onScanCaptured={(file) => { setScanFile(file); setSheet("scanEdit"); }}
        onFilesPicked={(files, kindOverride) => {
          setMediaPreview({ files, kindOverride });
          setSheet("mediaPreview");
        }}/>

      {menuFor && (
        <MessageMenu
          message={menuFor} me={me}
          isModerator={chat.role === "owner" || chat.role === "admin"}
          reactionsEnabled={chat.reactions_enabled !== 0}
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
          onForward={canForwardHere ? () => { setForwarding(menuFor); setMenuFor(null); } : undefined}
          onShare={canForwardHere ? () => { shareMessage(menuFor); setMenuFor(null); } : undefined}
          onTranslate={() => { translateMessage(menuFor); setMenuFor(null); }}
          onCopy={() => {
            navigator.clipboard?.writeText(menuFor.text || "");
            toast("Copied");
            setMenuFor(null);
          }}
          onSelect={() => {
            setSelectMode(true);
            setSelectedMsgIds(new Set([menuFor.id]));
            setMenuFor(null);
          }}
          onDownload={() => downloadMessageFile(menuFor)}
          onRemind={() => { setRemindFor(menuFor); setMenuFor(null); }}
          onInfo={() => { setInfoFor(menuFor); setMenuFor(null); }}/>
      )}
      {infoFor && (
        <MessageInfoSheet message={infoFor} chat={chat} members={members} readState={readState}
                          me={me} onClose={() => setInfoFor(null)}/>
      )}

      {forwarding && (
        <ForwardSheet message={forwarding} onClose={() => setForwarding(null)}
                      onForward={(toChatIds) => forwardTo(forwarding, toChatIds)}/>
      )}

      {remindFor && (
        <ReminderSheet message={remindFor} chatId={chat.id}
                       onClose={() => setRemindFor(null)}
                       onSet={(label) => { toast(`Reminder set: ${label}`); setRemindFor(null); }}/>
      )}

      {lightboxIndex != null && mediaMessages[lightboxIndex] && (
        <ChatMediaLightbox items={mediaMessages} index={lightboxIndex}
                           onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)}
                           me={me} members={members}
                           onForward={canForwardHere ? (m) => { setLightboxIndex(null); setForwarding(m); } : undefined}
                           toast={toast}/>
      )}

      {bgMenu && (
        <ContextMenu x={bgMenu.x} y={bgMenu.y} items={bgMenuItems()} onClose={() => setBgMenu(null)}/>
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
        <MeetingSheet chat={chat} onClose={() => setSheet(null)} toast={toast}
                     onCreated={() => {
                       if (["group", "channel", "community"].includes(chat.type) && confirm("Share this meeting's link now?")) {
                         sendCallLink();
                       }
                     }}/>
      )}

      {sheet === "poll" && (
        <PollSheet chat={chat} onClose={() => setSheet(null)} toast={toast}
                   onCreated={(message) => setMessages((c) => [...c, message])}/>
      )}

      {sheet === "sticker" && (
        <StickerPickerSheet onClose={() => setSheet(null)} onPick={sendSticker}/>
      )}

      {sheet === "gif" && (
        <GifPicker onClose={() => setSheet(null)} onSelect={sendGif}/>
      )}

      {sheet === "product" && (
        <ProductPickerSheet onClose={() => setSheet(null)} onPick={sendProduct}/>
      )}

      {sheet === "location" && (
        <LiveLocationSheet onClose={() => setSheet(null)} onSend={sendLocation}/>
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
                       onVoiceCall={() => (chat.type === "dm" ? onStartCall("voice") : onStartGroupCall("voice"))}
                       onVideoCall={() => (chat.type === "dm" ? onStartCall("video") : onStartGroupCall("video"))}
                       onSearch={() => { setSheet(null); setChatSearchOpen(true); setChatSearchQuery(""); setChatSearchResults([]); }}
                       onLeft={() => { setSheet(null); onBack(); }}/>
      )}

      {commentsFor && (
        <CommentsSheet post={commentsFor} chat={chat} me={me} events={events}
                       onClose={() => setCommentsFor(null)} toast={toast}/>
      )}
      {promptModal}
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

    case "comment_added":
    case "comment_deleted":
      // Keep the post's "💬 N" badge in sync live — the thread sheet handles
      // the comment list itself.
      return messages.map((m) =>
        m.id === event.post_message_id ? { ...m, comment_count: event.comment_count } : m);

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
                   pinCount, onTogglePins, onSearch, onMenu }) {
  const isGroup = chat.type !== "dm";
  const label = typingLabel(typing, isGroup);
  const [callMenu, setCallMenu] = useState(null); // {x,y} for the voice/video dropdown
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "12px 14px", paddingBottom: 18, paddingTop: "max(12px, env(safe-area-inset-top, 0px))",
      borderBottom: `1px solid ${G.border}`, background: G.surface,
      position: "sticky", top: 0, zIndex: 5, flexShrink: 0,
    }}>
      <div onClick={onBack} style={{ cursor: "pointer" }}>{I.back()}</div>
      <div onClick={onInfo} style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, cursor: "pointer" }}>
        <Av av={chat.avatar_letter} color={chat.color} size={38} photoId={chat.avatar_attachment_id}
            online={chat.peer_online}/>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 15, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden",
            textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4,
          }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{chat.name || "Direct message"}</span>
            {chat.peer_blue_tick ? <span style={{ flexShrink: 0 }}>{I.blueTick(14)}</span> : null}
          </div>
          <div style={{
            fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            color: label ? G.accentText : chat.peer_online ? G.green : G.muted,
          }}>
            {label
              ? label
              : chat.type === "dm"
              ? (chat.peer_online ? "online" : (lastSeenLabel(chat.peer_last_seen) || "offline"))
              : chat.description ? chat.description
              : chat.type}
          </div>
        </div>
      </div>
      {/* E2EE label — always visible like WhatsApp */}
      <div style={{
        position: "absolute", bottom: 2, left: 0, right: 0, textAlign: "center",
        fontSize: 9, color: G.muted, letterSpacing: 0.3, pointerEvents: "none",
      }}>🔒 End-to-end encrypted</div>
      {/* WhatsApp-style trimmed header: only ONE primary call action sits up
          front — a voice-call icon for a one-to-one chat, a video-call icon
          for a group — and everything else (search, the other call type,
          schedule a meeting, disappearing messages, mute, lock, …) lives in
          the ⋮ menu. Keeps the header uncluttered on a phone. The pinned-
          messages shortcut only appears when there actually are pins. */}
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
        <div onClick={(event) => setCallMenu({ x: event.clientX, y: event.clientY })}
             style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 1 }}
             title="Call">
          {chat.type === "dm" ? I.phone(G.sub, 20) : I.video(G.sub, 21)}
          {I.chevronDown(G.sub, 14)}
        </div>
      )}
      {callMenu && (
        <ContextMenu x={callMenu.x} y={callMenu.y} onClose={() => setCallMenu(null)} items={[
          { label: "Voice call", icon: I.phone(G.sub, 16), onClick: onVoiceCall },
          { label: "Video call", icon: I.video(G.sub, 16), onClick: onVideoCall },
        ]}/>
      )}
      <div onClick={onMenu} style={{ cursor: "pointer" }} title="More options">
        {I.moreVertical(G.sub, 20)}
      </div>
    </div>
  );
}

function getCustomEmoji() {
  try { return JSON.parse(localStorage.getItem("talkex_custom_emoji") || "[]"); } catch { return []; }
}
function saveCustomEmoji(list) { localStorage.setItem("talkex_custom_emoji", JSON.stringify(list)); }

function EmojiPicker({ onPick, onClose }) {
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState(getCustomEmoji);
  const customTab = EMOJI_GROUPS.length;
  const fileRef = useRef(null);

  const filtered = query.trim()
    ? EMOJI_GROUPS.flatMap((g) => g.items).filter(([, name]) => name.includes(query.trim().toLowerCase()))
    : tab === customTab ? [] : EMOJI_GROUPS[tab].items;

  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) { alert("Emoji must be under 256 KB"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const name = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
      const entry = { id: `custom_${Date.now()}`, name, dataUrl: reader.result };
      const next = [...customEmoji, entry];
      setCustomEmoji(next);
      saveCustomEmoji(next);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function removeCustom(id) {
    const next = customEmoji.filter((ce) => ce.id !== id);
    setCustomEmoji(next);
    saveCustomEmoji(next);
  }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: "absolute", bottom: "100%", left: 0, right: 0,
      background: G.surface, borderTop: `1px solid ${G.border}`,
      borderTopLeftRadius: 16, borderTopRightRadius: 16,
      boxShadow: `0 -4px 16px ${G.border}`, overflow: "hidden",
      height: "min(320px, 50vh)", display: "flex", flexDirection: "column", zIndex: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: `1px solid ${G.border}` }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Search emoji…" style={{
                 flex: 1, border: "none", outline: "none", background: G.dim,
                 borderRadius: 8, padding: "6px 10px", fontSize: 12.5, color: G.text,
               }}/>
        <button type="button" onClick={onClose} style={{
          cursor: "pointer", fontSize: 18, color: G.muted, background: "none", border: "none",
          padding: 4, lineHeight: 1,
        }}>×</button>
      </div>

      {!query.trim() && (
        <div style={{ display: "flex", overflowX: "auto", borderBottom: `1px solid ${G.border}` }}>
          {EMOJI_GROUPS.map((g, i) => (
            <button key={g.label} type="button" onClick={() => setTab(i)} style={{
              padding: "6px 10px", fontSize: 16, cursor: "pointer", flexShrink: 0,
              background: tab === i ? G.accentSoft : "transparent", border: "none",
              borderBottom: tab === i ? `2px solid ${G.accent}` : "2px solid transparent",
            }}>{g.icon}</button>
          ))}
          <button type="button" onClick={() => setTab(customTab)} style={{
            padding: "6px 10px", fontSize: 16, cursor: "pointer", flexShrink: 0,
            background: tab === customTab ? G.accentSoft : "transparent", border: "none",
            borderBottom: tab === customTab ? `2px solid ${G.accent}` : "2px solid transparent",
          }}>⭐</button>
        </div>
      )}

      <div style={{
        flex: 1, overflowY: "auto", overscrollBehavior: "contain", padding: 8, display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)", gap: 6,
      }}>
        {tab === customTab && !query.trim() ? (
          <>
            <button type="button" onClick={() => fileRef.current?.click()} style={{
              fontSize: 22, textAlign: "center", padding: "6px 0", cursor: "pointer", borderRadius: 8,
              background: G.dim, border: `1px dashed ${G.border}`, lineHeight: 1.3, color: G.muted,
            }} title="Upload custom emoji">+</button>
            <input ref={fileRef} type="file" accept="image/*" onChange={handleUpload}
                   style={{ display: "none" }}/>
            {customEmoji.map((ce) => (
              <button key={ce.id} type="button"
                      onClick={() => onPick(`:${ce.name}:`)}
                      onContextMenu={(e) => { e.preventDefault(); removeCustom(ce.id); }}
                      title={`:${ce.name}: (right-click to remove)`} style={{
                fontSize: 22, textAlign: "center", padding: "2px", cursor: "pointer", borderRadius: 8,
                background: "none", border: "none", lineHeight: 1.3,
              }}>
                <img src={ce.dataUrl} alt={ce.name} style={{ width: 28, height: 28, objectFit: "contain" }}/>
              </button>
            ))}
            {customEmoji.length === 0 && (
              <div style={{ gridColumn: "1 / -1", fontSize: 12, color: G.muted, textAlign: "center", padding: 12 }}>
                Tap + to upload custom emoji
              </div>
            )}
          </>
        ) : (
          <>
            {filtered.map(([emoji, name]) => (
              <button key={emoji} type="button" onClick={() => onPick(emoji)} title={name} style={{
                fontSize: 22, textAlign: "center", padding: "6px 0", cursor: "pointer", borderRadius: 8,
                background: "none", border: "none", lineHeight: 1.3,
              }}>{emoji}</button>
            ))}
            {filtered.length === 0 && (
              <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: G.muted, textAlign: "center", padding: 16 }}>
                No emoji found
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const SEARCH_FILTERS = [
  { key: "all", label: "All" },
  { key: "photo", label: "Photos" },
  { key: "video", label: "Videos" },
  { key: "document", label: "Files" },
  { key: "links", label: "Links" },
  { key: "voice", label: "Voice" },
];

function ChatSearchBar({ chatId, query, onChange, results, setResults, onClose, onJump }) {
  const timerRef = useRef(null);
  const [filter, setFilter] = useState("all");
  const [allResults, setAllResults] = useState([]);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!query || query.trim().length < 2) { setAllResults([]); setResults([]); return; }
    timerRef.current = setTimeout(() => {
      Search.query(query, chatId).then((res) => {
        setAllResults(res);
        setResults(res);
      }).catch(() => { setAllResults([]); setResults([]); });
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query, chatId]);

  useEffect(() => {
    if (filter === "all") { setResults(allResults); return; }
    if (filter === "links") {
      setResults(allResults.filter((r) => r.text && /https?:\/\/\S+/i.test(r.text)));
    } else {
      setResults(allResults.filter((r) => r.kind === filter));
    }
  }, [filter, allResults]);

  const filtered = results;

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
        {filtered.length > 0 && (
          <span style={{ fontSize: 11, color: G.muted, whiteSpace: "nowrap" }}>
            {filtered.length} found
          </span>
        )}
        <div onClick={onClose} style={{ cursor: "pointer", fontSize: 18, color: G.muted }}>×</div>
      </div>
      <div style={{ display: "flex", gap: 4, padding: "4px 14px 6px", overflowX: "auto" }}>
        {SEARCH_FILTERS.map((f) => (
          <div key={f.key} onClick={() => setFilter(f.key)} style={{
            padding: "3px 10px", borderRadius: 14, cursor: "pointer", fontSize: 11.5,
            whiteSpace: "nowrap",
            background: filter === f.key ? G.accent : G.dim,
            color: filter === f.key ? "#fff" : G.sub,
            border: `1px solid ${filter === f.key ? G.accent : G.border}`,
          }}>{f.label}</div>
        ))}
      </div>
      {filtered.length > 0 && (
        <div style={{ maxHeight: 180, overflowY: "auto" }}>
          {filtered.map((r) => (
            <div key={r.id} onClick={() => onJump(r.id)} style={{
              padding: "6px 14px", fontSize: 12.5, color: G.text, cursor: "pointer",
              borderTop: `1px solid ${G.border}`, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            }}>
              <span style={{ color: G.muted, marginRight: 6 }}>{whenLabel(r.created_at)}</span>
              {r.sender_name && <span style={{ fontWeight: 600, marginRight: 4 }}>{r.sender_name}:</span>}
              {r.text || `[${r.kind}]`}
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
// http(s):// or bare www. links, up to the next whitespace. Split-capture so
// the URLs themselves come back as their own array entries between the plain
// text around them.
const URL_PATTERN = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;

// A trailing . , ) ! ? etc. is almost always sentence punctuation, not part
// of the address ("visit https://x.com." → the dot isn't in the URL).
function trimUrlPunctuation(url) {
  const match = url.match(/[.,;:!?)\]]+$/);
  return match ? url.slice(0, -match[0].length) : url;
}

function renderFormatting(text, mine, keyPrefix) {
  const parts = text.split(URL_PATTERN);
  if (parts.length === 1) return renderMarkdown(text, mine, keyPrefix);
  return parts.map((part, index) => {
    if (!part) return null;
    if (/^(https?:\/\/|www\.)/i.test(part)) {
      const clean = trimUrlPunctuation(part);
      const trailing = part.slice(clean.length);
      const href = clean.startsWith("www.") ? `https://${clean}` : clean;
      return (
        <span key={`${keyPrefix}-u${index}`}>
          <a href={href} target="_blank" rel="noopener noreferrer"
             onClick={(event) => event.stopPropagation()}
             style={{ color: mine ? "#fff" : G.accentText, textDecoration: "underline", wordBreak: "break-all" }}>
            {clean}
          </a>
          {trailing}
        </span>
      );
    }
    return <span key={`${keyPrefix}-t${index}`}>{renderMarkdown(part, mine, `${keyPrefix}-${index}`)}</span>;
  });
}

// The *bold* / _italic_ / ~strike~ / `code` markdown pass, split out from
// renderFormatting so the URL linkifier above can run first and hand each
// non-URL span through here.
function renderMarkdown(text, mine, keyPrefix) {
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
  const parts = text.split(/(:[a-zA-Z0-9_]+:|@\w+)/g);
  if (parts.length === 1) return renderFormatting(text, mine, "f");
  const customs = getCustomEmoji();
  return parts.map((part, index) => {
    if (part.startsWith("@")) {
      return <span key={index} style={{ fontWeight: 700, color: mine ? "#fff" : G.accentText }}>{part}</span>;
    }
    if (part.startsWith(":") && part.endsWith(":") && part.length > 2) {
      const name = part.slice(1, -1);
      const found = customs.find((ce) => ce.name === name);
      if (found) {
        return <img key={index} src={found.dataUrl} alt={part} title={part}
                    style={{ width: 22, height: 22, verticalAlign: "middle", objectFit: "contain" }}/>;
      }
    }
    return renderFormatting(part, mine, `f${index}`);
  });
}

function firstUrl(text) {
  const match = (text || "").match(URL_PATTERN);
  if (!match) return null;
  const clean = trimUrlPunctuation(match[0]);
  return clean.startsWith("www.") ? `https://${clean}` : clean;
}

/**
 * The little title/description/thumbnail card WhatsApp shows under a message
 * that contains a link. The server does the actual page fetch and OpenGraph
 * parse (a browser can't read another origin's HTML) via GET /link-preview,
 * caching it briefly — see _fetch_link_preview in main.py. Renders nothing at
 * all until (and unless) that returns something worth showing, so a plain
 * message with a bare link is never pushed around by an empty box.
 */
const LinkPreview = memo(function LinkPreview({ text, mine }) {
  const url = firstUrl(text);
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!url) { setData(null); return; }
    let cancelled = false;
    Chats.linkPreview(url)
      .then((preview) => { if (!cancelled) setData(preview); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [url]);

  if (!url || !data || (!data.title && !data.description && !data.image)) return null;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
       onClick={(event) => event.stopPropagation()}
       style={{
         display: "block", marginTop: 6, borderRadius: 10, overflow: "hidden",
         textDecoration: "none", color: "inherit",
         background: mine ? "#ffffff1f" : G.dim,
         border: `1px solid ${mine ? "#ffffff33" : G.border}`,
       }}>
      {data.image && (
        <img src={data.image} alt="" loading="lazy"
             style={{ width: "100%", maxHeight: 160, objectFit: "cover", display: "block" }}/>
      )}
      <div style={{ padding: "7px 10px" }}>
        {data.site_name && (
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, opacity: 0.7, marginBottom: 2 }}>
            {data.site_name}
          </div>
        )}
        {data.title && (
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{data.title}</div>
        )}
        {data.description && (
          <div style={{
            fontSize: 11.5, opacity: 0.85, marginTop: 2, lineHeight: 1.35,
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
          }}>{data.description}</div>
        )}
      </div>
    </a>
  );
});

function ComposerLinkPreview({ text }) {
  const url = firstUrl(text);
  const [data, setData] = useState(null);
  const prevUrl = useRef(null);

  useEffect(() => {
    if (!url) { setData(null); prevUrl.current = null; return; }
    if (url === prevUrl.current) return;
    prevUrl.current = url;
    let cancelled = false;
    const timer = setTimeout(() => {
      Chats.linkPreview(url)
        .then((preview) => { if (!cancelled) setData(preview); })
        .catch(() => { if (!cancelled) setData(null); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [url]);

  if (!url || !data || (!data.title && !data.description && !data.image)) return null;

  return (
    <div style={{
      position: "absolute", bottom: "100%", left: 12, right: 12, marginBottom: 4,
      background: G.surface, border: `1px solid ${G.border}`, borderRadius: 12,
      boxShadow: `0 4px 16px ${G.border}`, overflow: "hidden",
      display: "flex", alignItems: "center", gap: 10,
    }}>
      {data.image && (
        <img src={data.image} alt="" loading="lazy"
             style={{ width: 56, height: 56, objectFit: "cover", flexShrink: 0 }}/>
      )}
      <div style={{ padding: "8px 10px", minWidth: 0, flex: 1 }}>
        {data.site_name && (
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.3, color: G.muted, marginBottom: 1 }}>
            {data.site_name}
          </div>
        )}
        {data.title && (
          <div style={{
            fontSize: 12.5, fontWeight: 600, color: G.text, lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{data.title}</div>
        )}
        {data.description && (
          <div style={{
            fontSize: 11, color: G.sub, marginTop: 1, lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{data.description}</div>
        )}
      </div>
    </div>
  );
}

const SWIPE_REPLY_TRIGGER = 56;
const SWIPE_REPLY_MAX = 74;
const SWIPE_INFO_TRIGGER = -56;
const SWIPE_INFO_MAX = -74;

const Bubble = memo(function Bubble({ message, me, chatAccent, translatedText, replyTarget, meetingUpdates, isPinned, isRead, isDelivered, signature,
                  commentsOn, onComments, onDoubleTap, onLongPress, onSwipeReply, onSwipeInfo, onVote, onForward, onOpenMedia, onCallAgain, onJoinMeeting, onCancelUpload, onRetry, onRemoveFailed, uploadPct, toast }) {
  const mine = message.sender_id === me.id;
  const gone = message.deleted_at || message.expired;
  const spamSettings = getSpamSettings();
  const spamResult = !mine && spamSettings.enabled && !gone ? checkSpam(message, message.sender_id) : null;
  const [spamHidden, setSpamHidden] = useState(!!spamResult);
  // A photo/video shows nearly edge-to-edge like WhatsApp — the bubble shrinks
  // to a hairline frame instead of the usual roomy text padding. Only when
  // there are no header decorations (reply/forward/signature/broadcast), which
  // still want the normal inset.
  const mediaFlush = ["photo", "video"].includes(message.kind) && !gone
    && !message.view_once
    && !replyTarget && !message.forwarded_from && !signature && !message.payload?.via_broadcast;

  // Desktop opens the message menu on a plain click OR a right-click; touch
  // has neither, so a real press-and-hold stands in — a bare tap is left
  // free (native media controls, the download link) rather than eating every
  // touch on the bubble the instant it lands.
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
  const pressStart = useRef({ x: 0, y: 0 });
  const lastTapTime = useRef(0);
  // Swipe-to-reply (WhatsApp-style): dragging a bubble rightward with a
  // touch pointer reveals a reply arrow and, past SWIPE_REPLY_TRIGGER,
  // releasing sets this message as the reply target directly — no menu.
  // swipeAxis stays null until the gesture clearly commits to horizontal
  // (vs. the list's normal vertical scroll), so a touch-scroll is never
  // hijacked; only once committed do we capture the pointer and cancel the
  // long-press timer, mirroring ChatList's ChatRow swipe-to-pin gesture.
  const swipeAxis = useRef(null);
  const [dragX, setDragX] = useState(0);
  const canSwipeRight = Boolean(onSwipeReply) && !message.pending && !message.queued && !message.failed && !gone;
  const canSwipeLeft = Boolean(onSwipeInfo) && !message.pending && !message.queued && !message.failed && !gone;
  const canSwipe = canSwipeRight || canSwipeLeft;

  function handlePointerDown(event) {
    if (event.pointerType !== "touch") return;
    longPressFired.current = false;
    pressStart.current = { x: event.clientX, y: event.clientY };
    swipeAxis.current = null;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      onLongPress();
    }, 500);
  }
  function handlePointerMove(event) {
    if (event.pointerType !== "touch") return;
    const dx = event.clientX - pressStart.current.x;
    const dy = event.clientY - pressStart.current.y;
    if (longPressTimer.current && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (!canSwipe) return;
    if (swipeAxis.current === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        swipeAxis.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (swipeAxis.current === "x") event.currentTarget.setPointerCapture?.(event.pointerId);
      }
    }
    if (swipeAxis.current === "x") {
      const clamped = dx > 0
        ? (canSwipeRight ? Math.min(SWIPE_REPLY_MAX, dx) : 0)
        : (canSwipeLeft ? Math.max(SWIPE_INFO_MAX, dx) : 0);
      setDragX(clamped);
    }
  }
  function clearPressTimer() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }
  function handlePointerUp(event) {
    clearPressTimer();
    if (event.pointerType === "touch" && !longPressFired.current && !gone) {
      const now = Date.now();
      if (now - lastTapTime.current < 300) {
        lastTapTime.current = 0;
        onDoubleTap?.();
        swipeAxis.current = null;
        setDragX(0);
        return;
      }
      lastTapTime.current = now;
    }
    if (event.pointerType !== "touch" && !longPressFired.current
        && !event.target.closest?.("[data-media]")) {
      onLongPress();
    }
    longPressFired.current = false;
    if (swipeAxis.current === "x") {
      if (dragX >= SWIPE_REPLY_TRIGGER) onSwipeReply?.();
      else if (dragX <= SWIPE_INFO_TRIGGER) onSwipeInfo?.();
    }
    swipeAxis.current = null;
    setDragX(0);
  }
  function handlePointerCancel() {
    clearPressTimer();
    swipeAxis.current = null;
    setDragX(0);
  }
  const pressHandlers = {
    onPointerDown: handlePointerDown, onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp, onPointerCancel: handlePointerCancel,
    onContextMenu: (event) => { event.preventDefault(); onLongPress(); },
    onDoubleClick: (event) => { if (!gone && !event.target.closest?.("[data-media]")) onDoubleTap?.(); },
  };
  const swipeStyle = dragX ? {
    transform: `translateX(${dragX}px)`,
    transition: swipeAxis.current === "x" ? "none" : "transform 0.18s ease",
  } : undefined;
  const swipeReplyIcon = dragX > 0 && (
    <div style={{
      position: "absolute", left: -34, top: "50%", transform: "translateY(-50%)",
      opacity: Math.min(1, dragX / SWIPE_REPLY_TRIGGER),
      width: 26, height: 26, borderRadius: "50%", background: G.card,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>{I.reply(G.muted, 14)}</div>
  );
  const swipeInfoIcon = dragX < 0 && (
    <div style={{
      position: "absolute", right: -34, top: "50%", transform: "translateY(-50%)",
      opacity: Math.min(1, Math.abs(dragX) / Math.abs(SWIPE_INFO_TRIGGER)),
      width: 26, height: 26, borderRadius: "50%", background: G.card,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>{I.info(G.muted, 14)}</div>
  );

  // The little "⌄" WhatsApp Web shows at a bubble's corner on hover — a
  // direct-click alternative to right-click/long-press, desktop-only by
  // nature since there's no such thing as "hovering" on touch. A ref rather
  // than component state: touching opacity on mouse in/out shouldn't cost a
  // re-render of the message it's sitting on.
  const chevronRef = useRef(null);
  const showChevron = () => { if (chevronRef.current) chevronRef.current.style.opacity = "1"; };
  const hideChevron = () => { if (chevronRef.current) chevronRef.current.style.opacity = "0"; };

  if (message.kind === "meeting") {
    return <MeetingCard message={message} mine={mine}
                        update={meetingUpdates?.[message.payload?.meeting_id]}
                        onJoin={onJoinMeeting} toast={toast}/>;
  }

  // Stickers render borderless, without the chat-bubble background — same
  // convention WhatsApp/Telegram use, since a sticker is already a complete
  // little illustration and a bubble around it just adds a frame nobody wants.
  if (message.kind === "sticker" && !gone) {
    return (
      <div id={`msg-${message.id}`} {...pressHandlers} style={{
             position: "relative", display: "flex", flexDirection: "column",
             alignItems: mine ? "flex-end" : "flex-start", marginBottom: 8, cursor: "pointer",
             ...swipeStyle,
           }}>
        {swipeReplyIcon}
        {swipeInfoIcon}
        <StickerMessage message={message}/>
        <span style={{ fontSize: 10.5, color: G.muted, marginTop: 2 }}>{clockTime(message.created_at)}</span>
      </div>
    );
  }

  return (
    <div id={`msg-${message.id}`}
         style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 8 }}>
      <div
        {...pressHandlers}
        onMouseEnter={showChevron} onMouseLeave={hideChevron}
        style={{
          position: "relative", maxWidth: mediaFlush ? "min(78%, 300px)" : "78%",
          padding: mediaFlush ? 3 : "9px 13px", borderRadius: 16,
          borderBottomRightRadius: mine ? 4 : 16,
          borderBottomLeftRadius: mine ? 16 : 4,
          background: mine ? (chatAccent || G.accent) : G.card,
          border: mine ? "none" : `1px solid ${G.border}`,
          cursor: "pointer",
          touchAction: "pan-y",
          ...swipeStyle,
        }}>
        {swipeReplyIcon}
        {swipeInfoIcon}

        {spamResult && spamHidden && (
          <div onClick={(e) => { e.stopPropagation(); setSpamHidden(false); }} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
            marginBottom: 4, borderRadius: 8, cursor: "pointer",
            background: "#f59e0b22", border: "1px solid #f59e0b55",
            fontSize: 12, color: "#f59e0b",
          }}>
            ⚠ {spamResult.label} — tap to show
          </div>
        )}
        {spamResult && !spamHidden && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
            marginBottom: 4, borderRadius: 8,
            background: "#f59e0b15", fontSize: 11, color: "#f59e0b",
          }}>
            ⚠ Flagged: {spamResult.label}
          </div>
        )}

        <div ref={chevronRef} onClick={(event) => { event.stopPropagation(); onLongPress(); }} style={{
          position: "absolute", top: 2, right: mine ? 2 : "auto", left: mine ? "auto" : 2,
          opacity: 0, transition: "opacity 0.15s", cursor: "pointer",
          width: 20, height: 20, borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: mine ? "#ffffff26" : G.dim,
        }}>{I.chevronDown(mine ? "#fff" : G.sub, 12)}</div>

        {message.forwarded_from && (
          <div style={{ fontSize: 11, color: mine ? "#ffffffaa" : G.muted, marginBottom: 3 }}>
            Forwarded from {message.forwarded_from}
          </div>
        )}
        {signature && !message.deleted_at && (
          <div style={{ fontSize: 11.5, fontWeight: 600, color: mine ? "#fff" : G.accentText, marginBottom: 3 }}>
            {signature}
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
        ) : message.kind === "gif" ? (
          <img src={message.payload?.gif_url} alt="GIF" style={{
            maxWidth: "100%", maxHeight: 280, borderRadius: 10, display: "block",
          }}/>
        ) : message.kind === "product" ? (
          <ProductCard message={message} mine={mine}/>
        ) : ["photo", "video", "voice", "document"].includes(message.kind) ? (
          <>
            {message.view_once && !message.payload?._localUrl
              // A still-queued view-once send has no server-side single-use
              // gate to defer to yet — it's just your own file, about to go
              // out, same as any other pending attachment until it actually
              // reaches the server.
              ? <ViewOnceAttachment message={message} mine={mine}/>
              : <Attachment message={message} mine={mine} onForward={onForward} onOpenMedia={onOpenMedia}
                             onCancelUpload={onCancelUpload} onRetry={onRetry} uploadPct={uploadPct} toast={toast}/>}
            {message.text && (
              <div style={{
                fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap", marginTop: 6,
                // The bubble lost its padding to make the media flush; the
                // caption gets its own inset back so it isn't jammed to the edge.
                padding: mediaFlush ? "0 8px 4px" : 0,
              }}>
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
        ) : message.kind === "text" && message.view_once ? (
          <ViewOnceText message={message} mine={mine}/>
        ) : (
          <>
            <div style={{ fontSize: 14.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
              {renderWithMentions(message.text, mine)}
            </div>
            {translatedText && (
              <div style={{
                marginTop: 6, paddingTop: 6, borderTop: `1px solid ${mine ? "#ffffff26" : G.border}`,
              }}>
                <div style={{
                  fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4,
                  color: mine ? "#ffffff99" : G.muted, marginBottom: 2,
                }}>Translated</div>
                <div style={{ fontSize: 14.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
                  {renderWithMentions(translatedText, mine)}
                </div>
              </div>
            )}
            <LinkPreview text={message.text} mine={mine}/>
          </>
        )}

        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 5, marginTop: 3,
          // Inset the time/ticks off the hairline edge when the bubble went flush
          // for media (unless a caption already re-added its own padding).
          padding: mediaFlush && !message.text ? "0 8px 4px" : 0,
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
            message.failed
              ? <span title="Not sent" style={{ color: "#ef4444", fontSize: 12, fontWeight: 700 }}>!</span>
              : message.pending || message.queued
              ? I.clock("#ffffff99", 11)
              : <span style={{
                  display: "inline-flex", transition: "transform 0.3s ease",
                  transform: isRead ? "scale(1.15)" : "scale(1)",
                }}
                onTransitionEnd={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                >
                  {isRead
                    ? I.checkDouble("#38bdf8", 13)
                    : isDelivered
                      ? I.checkDouble("#ffffffaa", 13)
                      : I.check("#ffffffaa", 13)}
                </span>
          )}
        </div>

        {message.failed && mine && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <button onClick={(e) => { e.stopPropagation(); onRetry?.(); }} style={{
              display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px",
              borderRadius: 12, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600,
              background: "#ef444420", color: "#ef4444",
            }}>↻ Retry</button>
            <button onClick={(e) => { e.stopPropagation(); onRemoveFailed?.(); }} style={{
              display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px",
              borderRadius: 12, border: "none", cursor: "pointer", fontSize: 11,
              background: "transparent", color: mine ? "#ffffff99" : G.muted,
            }}>✕</button>
          </div>
        )}

        {message.reactions?.length > 0 && (
          <ReactionPills reactions={message.reactions} messageId={message.id}/>
        )}

        {/* Discussion comments button under a channel/community post. */}
        {commentsOn && (
          <div onClick={(e) => { e.stopPropagation(); onComments(); }} style={{
            display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6,
            padding: "5px 12px", borderRadius: 16, cursor: "pointer",
            background: G.dim, border: `1px solid ${G.border}`, color: G.accent,
            fontSize: 12, fontWeight: 600,
          }}>
            {I.chat(G.accent, 14)}
            {message.comment_count > 0
              ? `${message.comment_count} comment${message.comment_count === 1 ? "" : "s"}`
              : "Comment"}
          </div>
        )}
      </div>
    </div>
  );
});

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
  // Array.isArray guard, not just `|| []` — a truthy non-array payload
  // (e.g. a malformed/legacy row) would otherwise reach .reduce/.map below
  // and throw, taking the whole chat screen down with it instead of just
  // this one bubble degrading.
  const options = Array.isArray(message.payload?.options) ? message.payload.options : [];
  const total = options.reduce((sum, option) => sum + (option?.votes || 0), 0);

  return (
    <div style={{ minWidth: 200 }}>
      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 8 }}>{message.text}</div>
      {options.map((option, index) => {
        const share = total ? Math.round(((option?.votes || 0) / total) * 100) : 0;
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
              <span>{option?.text || "Option"}</span>
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
       style={{ display: "block", minWidth: 220, maxWidth: 260, textDecoration: "none", color: "inherit" }}>
      {/* A live-updating message keeps rebuilding this block (upsertMessage
          on every watchPosition tick), so the preview intentionally isn't
          draggable/clickable itself — only the surrounding <a> is, opening
          the full OpenStreetMap page for anything more than a glance. */}
      <div style={{ pointerEvents: "none" }}>
        <Suspense fallback={<div style={{height:120,background:G.card,borderRadius:12}}/>}>
          <LocationMap lat={lat} lng={lng} height={120}/>
        </Suspense>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, flexShrink: 0, position: "relative",
          background: mine ? "#ffffff26" : G.accentSoft,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {I.mapPin(mine ? "#fff" : G.accentText, 17)}
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
      </div>
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

function ProductCard({ message, mine }) {
  const { name, description, price_cents: priceCents, currency, image_attachment_id: imageId } =
    message.payload || {};
  const [blobUrl, setBlobUrl] = useState(null);

  // Downloading requires the bearer token, which a plain <img src> can't
  // carry — same reason Attachment fetches its file as a blob instead of
  // pointing an <img> straight at /uploads/{id}.
  useEffect(() => {
    if (!imageId) return undefined;
    let cancelled = false;
    Uploads.fetchBlobUrl(imageId).then((url) => { if (!cancelled) setBlobUrl(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [imageId]);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  if (!name) {
    return <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.7 }}>Product unavailable</div>;
  }
  return (
    <div style={{ minWidth: 200, maxWidth: 240 }}>
      {blobUrl && (
        <img src={blobUrl} alt={name} style={{
          width: "100%", height: 140, objectFit: "cover", borderRadius: 8, marginBottom: 8, display: "block",
        }}/>
      )}
      <div style={{ fontSize: 14.5, fontWeight: 700 }}>{name}</div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: mine ? "#ffffffcc" : G.accentText, marginTop: 2 }}>
        {currency === "INR" ? "₹" : (currency || "") + " "}{((priceCents || 0) / 100).toFixed(2)}
      </div>
      {description && (
        <div style={{ fontSize: 12.5, color: mine ? "#ffffffaa" : G.muted, marginTop: 4 }}>
          {description}
        </div>
      )}
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
      : <img src={blobUrl} alt={message.text || "Photo"} style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 10, display: "block" }}/>;
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
 * A view-once TEXT message. Mirrors ViewOnceAttachment's tap-to-reveal gate:
 * the recipient's tap is what spends the one view (POST .../view-once-open),
 * not merely the chat's read watermark passing it — that used to be the
 * trigger (mark_read) and could blank the text before the recipient had even
 * scrolled to it. The sender's own copy never needed a view to spend, so it
 * keeps rendering plainly like it always has, until the recipient opens it.
 */
function ViewOnceText({ message, mine }) {
  const [revealedText, setRevealedText] = useState(null);
  const [revealing, setRevealing] = useState(false);
  const [gone, setGone] = useState(false);

  // Checked first so the realtime "message_edited" broadcast that follows a
  // successful reveal (which blanks message.text and flips
  // view_once_consumed for everyone) doesn't hide the text we just fetched.
  if (revealedText != null) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, fontSize: 11, fontWeight: 600, color: G.accentText }}>
          {I.eye(G.accentText, 13)}
          <span>View once</span>
        </div>
        <div style={{ fontSize: 14.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
          {renderWithMentions(revealedText, mine)}
        </div>
      </div>
    );
  }

  if (mine) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4, fontSize: 11, fontWeight: 600, color: "#ffffffcc" }}>
          {I.eye("#ffffffcc", 13)}
          <span>View once</span>
        </div>
        <div style={{ fontSize: 14.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
          {renderWithMentions(message.text, mine)}
        </div>
      </div>
    );
  }

  if (gone || message.view_once_consumed) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontStyle: "italic", color: G.muted }}>
        {I.eye(G.muted, 14)}
        <span>Opened</span>
      </div>
    );
  }

  async function reveal() {
    if (revealing) return;
    setRevealing(true);
    try {
      const { text } = await Messages.openViewOnce(message.id);
      setRevealedText(text);
    } catch {
      setGone(true);
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div onClick={reveal} style={{
      display: "flex", alignItems: "center", gap: 8, padding: "4px 2px",
      cursor: revealing ? "default" : "pointer",
    }}>
      {revealing ? <Spinner small/> : I.eye(G.accentText, 16)}
      <span style={{ fontSize: 13.5, fontWeight: 600, color: G.accentText }}>
        {revealing ? "Opening…" : "Tap to view · once"}
      </span>
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
function AlbumThumb({ message }) {
  const [url, setUrl] = useState(message.payload?._localUrl || null);
  const attachmentId = message.payload?.attachment_id;
  useEffect(() => {
    if (url || !attachmentId) return;
    let cancelled = false;
    Uploads.fetchBlobUrl(attachmentId, { cache: true })
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [attachmentId, url]);
  if (!url) return <div style={{ width: "100%", height: "100%", background: "#00000022" }}/>;
  if (message.kind === "video") {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <video src={url} muted style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>
        <div style={{ position: "absolute", bottom: 4, left: 4, display: "flex", alignItems: "center", gap: 3,
          padding: "1px 6px", borderRadius: 6, background: "#00000088", fontSize: 10, color: "#fff" }}>
          {I.video("#fff", 10)} Video
        </div>
      </div>
    );
  }
  return <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}/>;
}

const Attachment = memo(function Attachment({ message, mine, onForward, onOpenMedia, onCancelUpload, onRetry, uploadPct, toast }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(false);
  // Tapping a photo/video opens it full-screen, the way WhatsApp does —
  // reusing the blob URL already loaded below, so there's nothing to refetch.
  const [fullscreen, setFullscreen] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState(false);
  const [editFile, setEditFile] = useState(null);
  const [viewingPdf, setViewingPdf] = useState(false);
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

  // Still going up (message.pending) or sitting in the offline retry queue
  // (message.queued) — either way not yet a real server attachment. A
  // document never gets a localUrl at all (see sendFile in ChatView), so
  // before this branch existed a document in either state fell straight
  // into the "Attachment unavailable" case below and read as a permanent
  // failure the whole time it was simply still going up or waiting for a
  // connection. Cancel is only offered for `pending` — a `queued` item's
  // AbortController is long gone (the attempt that failed already tore it
  // down before queuing), cancelling that one is a "remove from the retry
  // queue" action this doesn't wire up.
  if (message.failed) {
    return (
      <div style={{ minWidth: 180, padding: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
            background: "#ef444420", display: "flex", alignItems: "center",
            justifyContent: "center", color: "#ef4444", fontSize: 16, fontWeight: 700,
          }}>!</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#ef4444" }}>
              Failed to send
            </div>
            <div style={{ fontSize: 11, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fileName}
            </div>
          </div>
          {onRetry && (
            <button onClick={(event) => { event.stopPropagation(); onRetry(); }}
                    title="Retry" style={{
                      padding: "4px 10px", borderRadius: 12, flexShrink: 0, cursor: "pointer",
                      border: "none", background: "#ef444420", color: "#ef4444",
                      fontSize: 12, fontWeight: 600,
                    }}>↻ Retry</button>
          )}
        </div>
      </div>
    );
  }

  if (message.pending || message.queued) {
    const pct = uploadPct != null ? Math.round(uploadPct * 100) : null;
    return (
      <div style={{ minWidth: 180, padding: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner small/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {message.queued ? "Waiting to send…" : pct != null ? `Uploading… ${pct}%` : "Uploading…"}
            </div>
            <div style={{ fontSize: 11, opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fileName}
            </div>
          </div>
          {onCancelUpload && !message.queued && (
            <button onClick={(event) => { event.stopPropagation(); onCancelUpload(message.client_msg_id); }}
                    title="Cancel upload" style={{
                      width: 26, height: 26, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                      border: "none", background: mine ? "#ffffff33" : G.dim,
                      color: mine ? "#fff" : G.text, fontSize: 15, lineHeight: 1,
                    }}>×</button>
          )}
        </div>
        {pct != null && (
          <div style={{ marginTop: 6, height: 3, borderRadius: 2, background: mine ? "#ffffff22" : G.dim, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: mine ? "#ffffffaa" : G.accent, borderRadius: 2, transition: "width 0.2s ease" }}/>
          </div>
        )}
      </div>
    );
  }

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
    if (message.kind === "photo" || message.kind === "video") {
      return (
        <div style={{
          width: "100%", maxWidth: 260, aspectRatio: "4/3", borderRadius: 13,
          background: mine ? "#ffffff12" : G.dim,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Spinner small/>
        </div>
      );
    }
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
        <Spinner small/>
        <span style={{ fontSize: 13, opacity: 0.8 }}>{fileName}</span>
      </div>
    );
  }

  const isPdf = /\.pdf$/i.test(fileName) || message.payload?.mime === "application/pdf";

  // Blob URLs download fine through a synthesised <a download>; doing it in JS
  // (rather than a static link) lets the same handler back every download
  // button below and the in-app PDF viewer's own download control.
  function downloadFile() {
    if (!effectiveUrl) return;
    const link = document.createElement("a");
    link.href = effectiveUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Editing works on a File rebuilt from the already-loaded blob — no refetch.
  async function openPhotoEditor() {
    try {
      const blob = await (await fetch(effectiveUrl)).blob();
      setEditFile(new File([blob], fileName || "photo.jpg", { type: blob.type || "image/jpeg" }));
      setEditingPhoto(true);
    } catch {
      toast && toast("Could not open the editor");
    }
  }

  function saveEditedPhoto(edited) {
    setEditingPhoto(false);
    const url = URL.createObjectURL(edited);
    const link = document.createElement("a");
    link.href = url;
    link.download = edited.name || "edited.jpg";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast && toast("Saved edited photo");
  }

  if (message.kind === "photo") {
    return (
      <>
        <img src={effectiveUrl} alt={fileName} data-media="1"
             onClick={(event) => { event.stopPropagation(); onOpenMedia ? onOpenMedia(message) : setFullscreen(true); }}
             style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 13, display: "block", cursor: "pointer" }}/>
        {fullscreen && (
          <FullscreenMedia kind="photo" src={effectiveUrl} alt={fileName}
                           onEdit={() => { setFullscreen(false); openPhotoEditor(); }}
                           onClose={() => setFullscreen(false)}/>
        )}
        {editingPhoto && editFile && (
          <Suspense fallback={null}>
            <PhotoEditor file={editFile} onCancel={() => setEditingPhoto(false)} onDone={saveEditedPhoto}/>
          </Suspense>
        )}
      </>
    );
  }

  if (message.kind === "video") {
    return (
      <div>
        <div style={{ position: "relative" }} data-media="1">
          <video controls src={effectiveUrl}
                 style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 13, display: "block" }}/>
          {/* An explicit expand button — tapping the video body itself is
              reserved for play/pause via the native controls, so the way into
              full-screen is this corner control rather than a tap anywhere. */}
          <div onClick={(event) => { event.stopPropagation(); onOpenMedia ? onOpenMedia(message) : setFullscreen(true); }}
               title="Full screen" data-media="1" style={{
                 position: "absolute", top: 6, right: 6, width: 30, height: 30, borderRadius: "50%",
                 background: "#00000099", display: "flex", alignItems: "center", justifyContent: "center",
                 cursor: "pointer",
               }}>
            {I.expand ? I.expand("#fff", 15) : "⛶"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <AttachmentAction label="Download" icon={I.download} mine={mine} onClick={downloadFile}/>
          {onForward && <AttachmentAction label="Forward" icon={I.fwd} mine={mine} onClick={onForward}/>}
        </div>
        {fullscreen && (
          <FullscreenMedia kind="video" src={effectiveUrl} alt={fileName}
                           onClose={() => setFullscreen(false)}/>
        )}
      </div>
    );
  }

  if (message.kind === "voice") {
    return <VoicePlayer src={effectiveUrl}/>;
  }

  // document (and anything else that falls through) — a WhatsApp-style file
  // card with an inline action row underneath: View (PDF only) / Download /
  // Forward, instead of the whole bubble being one bare download link.
  return (
    <div style={{ minWidth: 210 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {I.doc ? I.doc(mine ? "#fff" : G.accent, 26) : "📄"}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fileName}
          </div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>
            {isPdf ? "PDF · " : ""}{formatBytes(sizeBytes)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {isPdf && <AttachmentAction label="View" icon={I.eye} mine={mine} onClick={() => setViewingPdf(true)}/>}
        <AttachmentAction label="Download" icon={I.download} mine={mine} onClick={downloadFile}/>
        {onForward && <AttachmentAction label="Forward" icon={I.fwd} mine={mine} onClick={onForward}/>}
      </div>
      {viewingPdf && (
        <Suspense fallback={
          <div style={{
            position: "fixed", inset: 0, background: "#1e1e1e", zIndex: 1300,
            display: "flex", alignItems: "center", justifyContent: "center", color: "#fff",
          }}>Loading…</div>
        }>
          <PdfDoc src={effectiveUrl} name={fileName} toast={toast}
                  onClose={() => setViewingPdf(false)} onDownloadOriginal={downloadFile}/>
        </Suspense>
      )}
    </div>
  );
});

/** A small pill button used under a file/video bubble. Adapts its colours to
 *  whether it sits inside the sender's (coloured) bubble or a received one. */
function AttachmentAction({ label, icon, mine, onClick }) {
  const fg = mine ? "#fff" : G.accentText;
  return (
    <button data-media="1" onClick={(e) => { e.stopPropagation(); onClick(); }} style={{
      display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 16,
      cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: fg,
      background: mine ? "#ffffff26" : G.accentSoft, border: "none",
    }}>
      {icon ? icon(fg, 15) : null}
      <span>{label}</span>
    </button>
  );
}


/**
 * Full-screen viewer for a single tapped photo/video in a chat bubble. Kept
 * separate from MediaLightbox (which swipes through a whole gallery and
 * refetches each slide by attachment id) because here the blob URL is already
 * in hand — nothing to fetch, no neighbours to page through.
 */
function FullscreenMedia({ kind, src, alt, onEdit, onClose }) {
  useEffect(() => {
    function onKey(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000ee", zIndex: 1200,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        position: "absolute", top: 10, right: 12, zIndex: 1, display: "flex", gap: 8, alignItems: "center",
      }}>
        {kind === "photo" && onEdit && (
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit" style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 18,
            cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#fff",
            background: "#ffffff2e", border: "none",
          }}>
            {I.edit ? I.edit("#fff", 15) : null}<span>Edit</span>
          </button>
        )}
        <div onClick={onClose} style={{ cursor: "pointer", color: "#fff", fontSize: 30, lineHeight: 1 }}>×</div>
      </div>
      {kind === "video" ? (
        <video src={src} controls autoPlay onClick={(e) => e.stopPropagation()}
               style={{ maxWidth: "96vw", maxHeight: "92vh" }}/>
      ) : (
        <img src={src} alt={alt || "Photo"} onClick={(e) => e.stopPropagation()}
             style={{ maxWidth: "96vw", maxHeight: "92vh", objectFit: "contain" }}/>
      )}
    </div>
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

function MeetingCard({ message, mine, update, onJoin, toast }) {
  const [meeting, setMeeting] = useState(null);
  const meetingId = message.payload?.meeting_id;

  async function shareLink() {
    const url = meetingLink(meetingId);
    try {
      if (navigator.share) {
        await navigator.share({ url, text: `Join "${meeting?.title || "this meeting"}" on TalkEx` });
      } else {
        await navigator.clipboard.writeText(url);
        toast?.("Meeting link copied");
      }
    } catch (problem) {
      if (problem?.name !== "AbortError") toast?.("Could not share the link");
    }
  }

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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0" }}>
              <div style={{ fontSize: 12, color: G.accentText }}>
                {meeting.going_count} going · status {meeting.status}
              </div>
              {meeting.status !== "cancelled" && meeting.status !== "ended" && (
                <div onClick={shareLink} title="Copy/share meeting link"
                     style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: G.accentText }}>
                  {I.link(G.accentText, 14)}
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>Link</span>
                </div>
              )}
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

            {(meeting.status === "scheduled" || meeting.status === "live") && (
              // The server rejects anything but http(s) on write (see
              // _validate_join_url in main.py), but this renders straight
              // into an href — checking again here means a value that
              // somehow predates that check (or arrives from anywhere else
              // that skips it) can't run as a `javascript:` navigation.
              meeting.join_url && /^https?:\/\//i.test(meeting.join_url) ? (
                <a href={meeting.join_url} target="_blank" rel="noreferrer"
                   style={{
                     display: "block", marginTop: 8, padding: "9px", borderRadius: 10,
                     background: G.green, color: "#fff", textAlign: "center",
                     fontSize: 13, fontWeight: 600, textDecoration: "none",
                   }}>Join now</a>
              ) : (
                // No external link was set — join means the in-app call for
                // this chat, starting it for everyone if it hasn't already.
                <button onClick={() => onJoin?.(meeting)}
                   style={{
                     display: "block", width: "100%", marginTop: 8, padding: "9px", borderRadius: 10,
                     background: G.green, color: "#fff", textAlign: "center", border: "none",
                     fontSize: 13, fontWeight: 600, cursor: "pointer",
                   }}>{meeting.status === "live" ? "Join now — live" : "Join now"}</button>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}

// `icon`/`accent` are optional so a caller with nothing more specific than
// "a dismissible strip" can still just pass `label` — but reply/edit/
// view-once each pass their own now, since three composer-context banners
// that all looked identical (same grey bar, same generic × button) gave no
// visual cue for which mode you were actually in beyond reading the text.
// The left accent bar + icon match the color/glyph iOS Messages' own
// per-context compose bar uses this same pattern for.
function Banner({ label, onClear, icon, accent }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "9px 14px",
      background: G.card, borderTop: `1px solid ${G.border}`,
      borderLeft: accent ? `3px solid ${accent}` : "none",
      animation: "txBannerSlideUp 0.18s ease-out",
    }}>
      {icon && <div style={{ flexShrink: 0, display: "flex" }}>{icon}</div>}
      <div style={{ flex: 1, fontSize: 12.5, color: G.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div onClick={onClear} style={{
        cursor: "pointer", color: G.muted, fontSize: 15, flexShrink: 0,
        width: 22, height: 22, borderRadius: "50%", background: G.dim,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>×</div>
      <style>{"@keyframes txBannerSlideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}"}</style>
    </div>
  );
}

const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

function Composer({ value, onChange, onSend, onSchedule, onVoice, uploading,
                    disappearSecs, editing, onCancelEdit, members, toast, viewOnce, onToggleViewOnce,
                    canSilent, silent, onToggleSilent,
                    onFile, onLocation, onContact, onPoll, onSticker, onGif, onProduct,
                    onScanCaptured, onFilesPicked }) {
  const voice = useVoiceRecorder((blob, transcript) => onVoice(blob, transcript));
  const enterToSend = useEnterToSend();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [cannedReplies, setCannedReplies] = useState([]);
  const inputRef = useRef(null);

  // Dropping into edit mode selects the pre-filled text instead of just
  // parking the cursor at the end — the iOS/desktop-app convention for
  // "you're now editing this," where retyping the whole thing (the common
  // case: fixing a typo means most people select-all and redo it) is one
  // keystroke instead of a manual select-all first.
  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  // Enter behaviour depends on the per-device "Press Enter to send" setting.
  // ON  → Enter sends, Shift+Enter makes a newline.
  // OFF → Enter makes a newline, only the send button sends.
  function onInputKeyDown(event) {
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      onCancelEdit?.();
      return;
    }
    if (event.key !== "Enter") return;
    if (enterToSend && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
    // else: let the newline through (textarea default).
  }

  // The attach button and the emoji button each double as a keyboard switch,
  // WhatsApp-style: opening a panel blurs the field (so the on-screen keyboard
  // drops and the panel has room); tapping the button again — now showing a
  // keyboard glyph — refocuses the field to bring the keyboard back.
  function toggleAttach() {
    if (attachOpen) {
      setAttachOpen(false);
      inputRef.current?.focus();
    } else {
      setEmojiOpen(false);
      setQuickReplyOpen(false);
      setAttachOpen(true);
      inputRef.current?.blur();
    }
  }

  function toggleEmoji() {
    if (emojiOpen) {
      setEmojiOpen(false);
      inputRef.current?.focus();
    } else {
      setAttachOpen(false);
      setQuickReplyOpen(false);
      setEmojiOpen(true);
      inputRef.current?.blur();
    }
  }

  useEffect(() => {
    Me.cannedReplies().then(setCannedReplies).catch(() => {});
  }, []);

  // Auto-grow the textarea to fit its content (up to the CSS max-height, after
  // which it scrolls). Runs on every value change, including after a send
  // clears it back to a single row.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

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
    : (() => {
        // @all / @everyone pings the whole group — offered first whenever the
        // typed prefix could be leading toward it (including an empty "@").
        const all = ("all".startsWith(mentionQuery) || "everyone".startsWith(mentionQuery))
          ? [{ id: "all", name: "Everyone", username: "all", avatar_letter: "@", color: G.accent }]
          : [];
        const people = members.filter((m) => m.username.toLowerCase().startsWith(mentionQuery));
        return [...all, ...people].slice(0, 5);
      })();

  function pickMention(member) {
    onChange(value.slice(0, value.length - mentionMatch[0].length) + `@${member.username} `);
  }

  if (voice.state === "recording") {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        paddingTop: 10, paddingLeft: 16, paddingRight: 16,
        paddingBottom: "max(10px, env(safe-area-inset-bottom))",
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

  const panelOpen = emojiOpen || quickReplyOpen || attachOpen;

  return (
    <div style={{
      position: "relative", display: "flex", alignItems: "center", gap: 8,
      paddingTop: 10, paddingLeft: 12, paddingRight: 12,
      // Reserve the device's own bottom inset (gesture bar / home indicator)
      // so the composer never sits underneath it — a plain 10px was enough
      // on some phones but got covered by the OS nav bar on others.
      paddingBottom: "max(10px, env(safe-area-inset-bottom))",
      borderTop: `1px solid ${G.border}`, background: G.surface,
      // Lift the composer (and the emoji/attach/quick-reply panel it hosts)
      // above the tap-catcher below while a panel is open, so the input and its
      // buttons stay interactive — only taps OUTSIDE the composer hit the catcher.
      zIndex: panelOpen ? 30 : "auto",
    }}>
      {/* Tap-anywhere-to-dismiss: while a panel is up, a tap on the chat (or
          anywhere off the composer) closes it, the way WhatsApp dismisses its
          emoji/attach keyboard. Tapping the button again still toggles it shut
          via that button's own handler. */}
      {panelOpen && (
        <div onClick={() => { setEmojiOpen(false); setQuickReplyOpen(false); setAttachOpen(false); }}
             style={{ position: "fixed", inset: 0, zIndex: 20 }}/>
      )}

      {attachOpen && (
        <AttachPanel onClose={() => setAttachOpen(false)}
                     onFile={onFile} onLocation={onLocation} onContact={onContact}
                     onPoll={onPoll} onSticker={onSticker} onGif={onGif} onProduct={onProduct}
                     onScanCaptured={onScanCaptured} onFilesPicked={onFilesPicked}/>
      )}

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

      <ComposerLinkPreview text={value}/>

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
        <IconButton onClick={() => setQuickReplyOpen((v) => !v)} label="Quick replies">
          {I.checkDouble(G.sub, 18)}
        </IconButton>
      )}

      {/* Never disabled by `uploading` — WhatsApp lets you keep attaching
          more files while one is still going up, and blocking on a single
          in-flight upload (the old behavior here) was exactly the bug: pick
          one file, and the attach button stayed dead until that upload
          finished. `uploading` now only drives a small badge, not the
          button's own clickability. */}
      <IconButton onClick={toggleAttach} label={attachOpen ? "Keyboard" : "Attach"} style={{ position: "relative" }}>
        {attachOpen ? I.keyboard(G.sub, 20) : I.paperclip(G.sub, 20)}
        {uploading && (
          <div style={{
            position: "absolute", top: -2, right: -2, width: 9, height: 9, borderRadius: "50%",
            background: G.accent, border: `1.5px solid ${G.surface}`,
          }}/>
        )}
      </IconButton>
      <IconButton onClick={onSchedule} label="Schedule this message">
        {I.clock(G.sub, 20)}
      </IconButton>
      <IconButton onClick={toggleEmoji} label={emojiOpen ? "Keyboard" : "Emoji"} style={{ fontSize: 19 }}>
        {emojiOpen ? I.keyboard(G.sub, 20) : "🙂"}
      </IconButton>

      <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center" }}>
        <textarea
          ref={inputRef}
          value={value}
          rows={1}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onFocus={() => {
            const kill = () => {
              window.scrollTo(0, 0);
              document.documentElement.scrollTop = 0;
              document.body.scrollTop = 0;
            };
            kill();
            const t1 = setTimeout(kill, 50);
            const t2 = setTimeout(kill, 150);
            const t3 = setTimeout(kill, 300);
            const onScroll = () => kill();
            window.addEventListener("scroll", onScroll);
            setTimeout(() => {
              window.removeEventListener("scroll", onScroll);
              clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
            }, 500);
          }}
          placeholder={disappearSecs
            ? `Disappears after ${durationLabel(disappearSecs)}…`
            : editing ? "Edit message…" : "Message"}
          style={{
            width: "100%", padding: !editing && value.trim() ? "11px 38px 11px 14px" : "11px 14px",
            borderRadius: 22, background: G.dim,
            border: `1px solid ${G.border}`, color: G.text, fontSize: 14.5,
            outline: "none", resize: "none", fontFamily: "inherit", lineHeight: 1.35,
            maxHeight: 120, overflowY: "auto",
          }}/>
        {!editing && value.trim() && (
          <div onClick={onToggleViewOnce}
               style={{
                 position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                 cursor: "pointer", padding: 2, borderRadius: "50%",
                 background: viewOnce ? G.accentSoft : "transparent",
               }}
               title={viewOnce ? "View once is on" : "Send as view once"}>
            {I.eye(viewOnce ? G.accent : G.sub, 18)}
          </div>
        )}
      </div>
      {value.trim() ? (
        <button onClick={onSend} style={{
          width: 42, height: 42, borderRadius: "50%", border: "none", cursor: "pointer",
          background: `linear-gradient(135deg,${G.accent},${G.accentD})`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{I.send()}</button>
      ) : (
        <IconButton onClick={voice.start} label="Record a voice note" style={{
          width: 42, height: 42, borderRadius: "50%",
          background: G.dim, border: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {I.mic(G.sub, 19)}
        </IconButton>
      )}
    </div>
  );
}

// A `title` attribute alone is a hover tooltip — not reliably exposed to
// screen readers, and never reachable by keyboard without a tabIndex. Every
// icon-only composer action (quick replies, attach, schedule, emoji, voice
// note) was a bare `<div onClick>` with just a title, so none of them could
// be operated without a mouse. This wraps that same visual shape with the
// role/focus/keyboard handling all five were missing.
function IconButton({ onClick, label, disabled, children, style }) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      role="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onClick?.(event);
        }
      }}
      title={label}
      style={{ cursor: disabled ? "default" : "pointer", ...style }}>
      {children}
    </div>
  );
}

function Sheet({ title, children, onClose, side = "bottom" }) {
  const panelRef = useRef(null);
  const isDesktop = useIsDesktop();
  // A right-side panel (WhatsApp-Web-style contact/chat info) only makes sense
  // where there's horizontal room to spare — on a phone it stays the same
  // bottom sheet every other sheet uses, so the behaviour is desktop-only.
  const asRightPanel = side === "right" && isDesktop;

  // A modal that only closes on a backdrop click traps a keyboard user
  // inside it — Escape is the standard way out of any native dialog, and
  // moving focus into the panel on open means Tab starts somewhere sane
  // instead of leaving focus behind on whatever opened this.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#00000066", zIndex: 50,
      display: "flex",
      alignItems: asRightPanel ? "stretch" : "flex-end",
      justifyContent: asRightPanel ? "flex-end" : "center",
      animation: "talkexFadeIn .18s ease",
    }}>
      <style>{`@keyframes talkexSlideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
@keyframes talkexSlideUp{from{transform:translateY(100%);opacity:.8}to{transform:translateY(0);opacity:1}}
@keyframes talkexFadeIn{from{opacity:0}to{opacity:1}}`}</style>
      <div ref={panelRef} onClick={(event) => event.stopPropagation()}
           role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}
           tabIndex={-1}
           style={asRightPanel ? {
        width: 400, maxWidth: "90vw", height: "100%", background: G.surface, padding: 20,
        borderLeft: `1px solid ${G.border}`, overflowY: "auto", outline: "none",
        animation: "talkexSlideInRight .22s ease",
      } : {
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        border: `1px solid ${G.border}`, maxHeight: "80vh", overflowY: "auto",
        outline: "none",
        animation: "talkexSlideUp .22s cubic-bezier(.32,.72,.37,1.12)",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

/** One tappable row in the message popover: an icon + a label, tight and
 *  left-aligned, WhatsApp-style. */
function MenuRow({ icon, label, danger, onClick }) {
  const color = danger ? G.red : G.text;
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 14, width: "100%",
      padding: "11px 16px", background: "transparent", border: "none", cursor: "pointer",
      color, fontSize: 14.5, textAlign: "left", lineHeight: 1.1,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = G.dim; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
      <span style={{ display: "flex", width: 18, justifyContent: "center", flexShrink: 0 }}>
        {icon ? icon(danger ? G.red : G.sub, 18) : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

/**
 * The message action menu, WhatsApp-style: a horizontal reaction bar floating
 * above a compact icon-list popover — NOT the old full-width bottom sheet that
 * stacked every action as a giant button and overflowed the screen. Tapping
 * the "+" on the reaction bar expands it to the full emoji set.
 */
function MessageMenu({ message, me, isModerator, reactionsEnabled = true, isPinned, isStarred, onClose, onReact, onReply,
                      onEdit, onUnsend, onDeleteForEveryone, onHide, onPin, onStar, onForward, onShare,
                      onCopy, onSelect, onDownload, onInfo, onTranslate, onRemind }) {
  const mine = message.sender_id === me.id;
  const hasAttachment = Boolean(message.payload?.attachment_id);
  const canShare = typeof navigator !== "undefined" && navigator.share && !message.deleted_at;
  // Two genuinely different removals, not two labels on one action:
  //   Unsend — only the sender, on their own message, no trace left at all.
  //   Delete for everyone — sender OR a moderator; always leaves a visible
  //     tombstone. It's the ONLY removal option a moderator has on someone
  //     else's message — a moderator silently erasing what someone else
  //     wrote, with no trace, is not something this app does.
  const canUnsend = !message.deleted_at && mine;
  const canDeleteForEveryone = !message.deleted_at && (mine || isModerator);
  const [showAllEmojis, setShowAllEmojis] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => { const id = setTimeout(() => setArmed(true), 300); return () => clearTimeout(id); }, []);

  // The six most-reached-for reactions sit inline; "+" reveals the rest.
  const quickEmojis = EMOJIS.slice(0, 6);

  const actionRows = [
    mine && !message.deleted_at && { key: "info", label: "Message info", icon: I.info, onClick: onInfo },
    { key: "reply", label: "Reply", icon: I.reply, onClick: onReply },
    message.text && { key: "copy", label: "Copy", icon: I.copy, onClick: onCopy },
    !mine && message.text && !message.deleted_at
      && { key: "translate", label: "Translate", icon: I.globe, onClick: onTranslate },
    onForward && { key: "forward", label: "Forward", icon: I.fwd, onClick: onForward },
    hasAttachment && !message.deleted_at && { key: "download", label: "Download", icon: I.download, onClick: onDownload },
    canShare && onShare && { key: "share", label: "Share", icon: I.share, onClick: onShare },
    !message.deleted_at && { key: "pin", label: isPinned ? "Unpin" : "Pin", icon: I.pin, onClick: onPin },
    !message.deleted_at && { key: "star", label: isStarred ? "Unstar" : "Star", icon: isStarred ? I.starFill : I.star, onClick: onStar },
    !message.deleted_at && { key: "remind", label: "Remind me", icon: I.timer || I.clock, onClick: onRemind },
    { key: "select", label: "Select", icon: I.select, onClick: onSelect },
    mine && !message.deleted_at && { key: "edit", label: "Edit", icon: I.edit, onClick: onEdit },
  ].filter(Boolean);

  const dangerRows = [
    !message.deleted_at && { key: "hide", label: "Delete for me", icon: I.trash, onClick: onHide },
    canUnsend && { key: "unsend", label: "Unsend", icon: I.trash, onClick: onUnsend },
    canDeleteForEveryone && { key: "dfe", label: "Delete for everyone", icon: I.trash, onClick: onDeleteForEveryone },
  ].filter(Boolean);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1200, background: "#00000066",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300,
        pointerEvents: armed ? "auto" : "none",
      }}>
        {/* Reaction bar — hidden entirely when an admin has turned reactions
            off for this channel/group. */}
        {reactionsEnabled && !message.deleted_at && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            flexWrap: showAllEmojis ? "wrap" : "nowrap",
            background: G.surface, border: `1px solid ${G.border}`,
            borderRadius: 26, padding: showAllEmojis ? "10px 12px" : "7px 10px",
            maxHeight: showAllEmojis ? "40vh" : "none", overflowY: showAllEmojis ? "auto" : "visible",
          }}>
            {(showAllEmojis ? EMOJIS : quickEmojis).map((emoji) => (
              <button key={emoji} onClick={() => onReact(emoji)} style={{
                fontSize: 25, lineHeight: 1, padding: 4, borderRadius: "50%", cursor: "pointer",
                background: "transparent", border: "none",
              }}>{emoji}</button>
            ))}
            {!showAllEmojis && (
              <button onClick={() => setShowAllEmojis(true)} title="More" style={{
                width: 34, height: 34, borderRadius: "50%", cursor: "pointer", flexShrink: 0,
                background: G.dim, border: "none", display: "flex", alignItems: "center", justifyContent: "center",
              }}>{I.plus(G.sub, 18)}</button>
            )}
          </div>
        )}

        {/* Action list */}
        <div style={{
          background: G.surface, border: `1px solid ${G.border}`, borderRadius: 14,
          overflow: "hidden", maxHeight: "56vh", overflowY: "auto",
        }}>
          {actionRows.map((row) => (
            <MenuRow key={row.key} icon={row.icon} label={row.label} onClick={row.onClick}/>
          ))}
          {dangerRows.length > 0 && <div style={{ height: 1, background: G.border, margin: "4px 0" }}/>}
          {dangerRows.map((row) => (
            <MenuRow key={row.key} icon={row.icon} label={row.label} danger onClick={row.onClick}/>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Who has (and hasn't yet) read a message you sent. There's no per-message
 * read TIMESTAMP anywhere in this app — only each member's current
 * last_read_seq watermark — so this can only say read/not-read, not "read
 * at 3:42pm" the way WhatsApp's own Message Info does.
 */
function MessageInfoSheet({ message, chat, members, readState, me, onClose }) {
  const mine = message.sender_id === me?.id;
  const isDm = chat.type === "dm";
  const others = isDm
    ? (chat.peer_id ? [{ id: chat.peer_id, name: chat.name, avatar_letter: chat.avatar_letter, color: chat.color }] : [])
    : members.filter((m) => m.id !== message.sender_id);

  const rowFor = (userId) => readState.find((r) => r.user_id === userId);
  const statusFor = (userId) => {
    const row = rowFor(userId);
    if (!row) return null;
    if (row.last_read_seq != null && row.last_read_seq >= message.seq) return "read";
    if ((row.last_delivered_seq ?? 0) >= message.seq) return "delivered";
    return "sent";
  };

  const read = mine ? others.filter((person) => statusFor(person.id) === "read") : [];
  const delivered = mine ? others.filter((person) => statusFor(person.id) === "delivered") : [];

  const sentDate = message.created_at ? toDate(message.created_at) : null;
  const senderName = mine ? "You" : (members.find((m) => m.id === message.sender_id)?.name || chat.name || "Unknown");

  const fmtTs = (unixSec) => {
    if (!unixSec) return null;
    const d = new Date(unixSec * 1000);
    return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const deliveredAt = mine && isDm && others[0] ? rowFor(others[0].id)?.last_delivered_at : null;
  const readAt = mine && isDm && others[0] ? rowFor(others[0].id)?.last_read_at : null;

  return (
    <Sheet title="Message info" onClose={onClose}>
      <div style={{ padding: "6px 0 10px", borderBottom: `1px solid ${G.border}`, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
          <span style={{ color: G.muted }}>From</span>
          <span>{senderName}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
          <span style={{ color: G.muted }}>Sent</span>
          <span>{sentDate ? sentDate.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</span>
        </div>
        {mine && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: G.muted }}>Delivered</span>
            <span>{fmtTs(deliveredAt) || "—"}</span>
          </div>
        )}
        {mine && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: G.muted }}>Read</span>
            <span style={{ color: readAt ? G.accent : undefined }}>{fmtTs(readAt) || "—"}</span>
          </div>
        )}
      </div>

      {mine && !isDm && (read.length > 0 || delivered.length > 0) && (
        <div style={{ borderBottom: `1px solid ${G.border}`, paddingBottom: 10, marginBottom: 10 }}>
          {read.length > 0 && (
            <>
              <div style={{ fontSize: 12, color: G.muted, marginBottom: 6, marginTop: 4 }}>
                {I.checkDouble(G.accent, 12)} Read by
              </div>
              {read.map((person) => {
                const row = rowFor(person.id);
                return (
                  <div key={person.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                    <Av av={person.avatar_letter} color={person.color} size={30}/>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13.5 }}>{person.name}</div>
                      {row?.last_read_at && <div style={{ fontSize: 11, color: G.muted }}>{fmtTs(row.last_read_at)}</div>}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {delivered.length > 0 && (
            <>
              <div style={{ fontSize: 12, color: G.muted, marginBottom: 6, marginTop: read.length > 0 ? 14 : 4 }}>
                {I.checkDouble(G.muted, 12)} Delivered to
              </div>
              {delivered.map((person) => {
                const row = rowFor(person.id);
                return (
                  <div key={person.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                    <Av av={person.avatar_letter} color={person.color} size={30}/>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13.5 }}>{person.name}</div>
                      {row?.last_delivered_at && <div style={{ fontSize: 11, color: G.muted }}>{fmtTs(row.last_delivered_at)}</div>}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {mine && read.length === 0 && delivered.length === 0 && (
        <div style={{ fontSize: 13, color: G.muted, padding: "10px 0" }}>
          No read-receipt info available for this message.
        </div>
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

export function MeetingSheet({ chat, onClose, toast, onCreated }) {
  const [form, setForm] = useState({
    title: "", agenda: "", when: "", duration: 30, reminder: 10, joinUrl: "",
    waitingRoom: false, password: "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      const meeting = await Meetings.create({
        chatId: chat.id,
        title: form.title.trim(),
        agenda: form.agenda.trim(),
        startsAt,
        durationMin: Number(form.duration) || 30,
        reminderMin: Number(form.reminder) || 0,
        joinUrl: form.joinUrl.trim(),
        waitingRoom: form.waitingRoom,
        password: form.password.trim(),
      });
      toast("Meeting scheduled");
      onCreated?.(meeting);
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

      <div onClick={() => setShowAdvanced((v) => !v)} style={{
        display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
        fontSize: 12.5, color: G.accentText, margin: "4px 0 12px",
      }}>{showAdvanced ? "Hide" : "Show"} security options {I.chevronDown(G.accentText, 12)}</div>

      {showAdvanced && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <Toggle on={form.waitingRoom} onChange={(value) => setForm({ ...form, waitingRoom: value })}/>
            <div>
              <div style={{ fontSize: 13.5 }}>Waiting room</div>
              <div style={{ fontSize: 11.5, color: G.muted }}>
                You approve everyone who isn't already the host before they join
              </div>
            </div>
          </div>
          <Field label="Password (optional)" value={form.password} onChange={set("password")}
                 placeholder="Leave blank for none"/>
        </>
      )}

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

// The attach picker as an INLINE bottom panel (not a modal sheet), so it sits
// flush above the input bar the way WhatsApp's does — the input row and its
// attach/keyboard switcher button stay visible and interactive on top. Each
// action closes the panel; the ones that open a follow-up sheet (location,
// contact, poll, sticker, caption preview, scan) do so through the parent's
// handlers, which move ChatView's own `sheet` state.
function AttachPanel({ onClose, onFile, onLocation, onContact, onPoll, onSticker, onGif, onProduct,
                       onScanCaptured, onFilesPicked }) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const galleryInput = useRef(null);
  const docInput = useRef(null);
  const scanInput = useRef(null);
  const audioInput = useRef(null);

  function tooBig(file) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`Files must be under ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
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
      onFilesPicked(files, kindOverride);
      onClose();
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
    onClose();
  }

  function onCameraCaptured(file) {
    setCameraOpen(false);
    onFilesPicked([file], null);
    onClose();
  }

  // Each tile gets its own accent colour, WhatsApp-style — the icon takes the
  // colour and the circle behind it a soft tint of the same, so the grid reads
  // as a set of distinct actions rather than one wall of identical buttons.
  const options = [
    { label: "Gallery", icon: I.image, color: "#7c5cff", action: () => galleryInput.current?.click() },
    { label: "Camera", icon: I.camera, color: "#e0245e", action: () => setCameraOpen(true) },
    { label: "Location", icon: I.mapPin, color: "#22c55e", action: () => { onLocation(); onClose(); } },
    { label: "Contact", icon: I.contactCard, color: "#3b82f6", action: () => { onContact(); onClose(); } },
    { label: "Document", icon: I.doc, color: "#5b6ef5", action: () => docInput.current?.click() },
    { label: "Scan PDF", icon: I.scan, color: "#0fb5a6", action: () => scanInput.current?.click() },
    { label: "Audio", icon: I.musicNote, color: "#f59e0b", action: () => audioInput.current?.click() },
    { label: "Poll", icon: I.poll, color: "#f97316", action: () => { onPoll(); onClose(); } },
    { label: "Sticker", icon: I.sticker, color: "#a855f7", action: () => { onSticker(); onClose(); } },
    { label: "GIF", icon: I.image, color: "#0ea5e9", action: () => { onGif(); onClose(); } },
    { label: "Catalog", icon: I.tag, color: "#22c55e", action: () => { onProduct(); onClose(); } },
  ];

  if (cameraOpen) {
    return <CameraCapture onCapture={onCameraCaptured} onClose={() => setCameraOpen(false)}/>;
  }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      // Same edge-to-edge bottom-panel chrome as the emoji picker.
      position: "absolute", bottom: "100%", left: 0, right: 0,
      background: G.surface, borderTop: `1px solid ${G.border}`,
      borderTopLeftRadius: 16, borderTopRightRadius: 16,
      boxShadow: `0 -4px 16px ${G.border}`, overflow: "hidden",
      maxHeight: "min(340px, 55vh)", overflowY: "auto", zIndex: 20,
    }}>
      <input ref={galleryInput} type="file" accept="image/*,video/*" multiple
             onChange={pickToPreview(null)} style={{ display: "none" }}/>
      <input ref={docInput} type="file" multiple
             onChange={pickToPreview("document")} style={{ display: "none" }}/>
      <input ref={scanInput} type="file" accept="image/*" capture="environment"
             onChange={pickToScan} style={{ display: "none" }}/>
      <input ref={audioInput} type="file" accept="audio/*" onChange={pickAudio} style={{ display: "none" }}/>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, padding: 16 }}>
        {options.map((option) => (
          <div key={option.label} onClick={option.action}
               style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <div style={{
              width: 58, height: 58, borderRadius: "50%", background: `${option.color}22`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {option.icon(option.color, 24)}
            </div>
            <div style={{ fontSize: 12, color: G.sub }}>{option.label}</div>
          </div>
        ))}
      </div>
    </div>
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
  const [previewUrl, setPreviewUrl] = useState(null);
  const [viewOnce, setViewOnce] = useState(false);
  const [editing, setEditing] = useState(false);
  const [trimming, setTrimming] = useState(false);
  // Editing replaces this sheet's own working copy of the file(s) — the
  // caller's original array is left alone, so cancelling an edit can't
  // ever lose or mutate what was actually picked.
  const [workingFiles, setWorkingFiles] = useState(files);

  const firstFile = workingFiles[0];
  const isImage = firstFile?.type.startsWith("image/");
  const isVideo = firstFile?.type.startsWith("video/");
  const canViewOnce = workingFiles.length === 1 && (isImage || isVideo);
  // Editing a whole multi-photo batch at once isn't offered — one photo at
  // a time keeps the crop/filter tool's scope to what it can actually do
  // well, rather than a half-built "apply to all" mode.
  const canEdit = workingFiles.length === 1 && isImage;
  const canTrim = workingFiles.length === 1 && isVideo;

  useEffect(() => {
    if (!isImage && !isVideo) return;
    const url = URL.createObjectURL(firstFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstFile]);

  function send() {
    // Fire-and-forget, not awaited: onSend (ChatView's sendFile/sendFiles)
    // already does the actual WhatsApp thing on its own — an optimistic
    // local-preview bubble appears in the chat immediately, then the real
    // upload runs in the background with its own progress/cancel UI (see
    // Attachment's pending branch). Awaiting the whole upload here before
    // closing was the freeze this replaces: "Sending…" sat on screen,
    // blocking the composer, for as long as the upload took, instead of
    // landing straight back in the conversation — which is where WhatsApp
    // actually puts you the instant you tap send.
    onSend(workingFiles, kindOverride, caption.trim(), viewOnce);
    onClose();
  }

  if (editing) {
    return (
      <Suspense fallback={null}>
        <PhotoEditor file={firstFile} onCancel={() => setEditing(false)}
                     onDone={(edited) => { setWorkingFiles([edited]); setEditing(false); }}/>
      </Suspense>
    );
  }

  if (trimming) {
    return (
      <Suspense fallback={null}>
        <VideoTrimmer file={firstFile} onCancel={() => setTrimming(false)}
                      onDone={(trimmed) => { setWorkingFiles([trimmed]); setTrimming(false); }}/>
      </Suspense>
    );
  }

  return (
    <Sheet title={workingFiles.length > 1 ? `${workingFiles.length} files` : (firstFile?.name || "Send file")}
           onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14, position: "relative" }}>
        {isImage && previewUrl ? (
          <>
            <img src={previewUrl} alt={firstFile?.name ? `Preview of ${firstFile.name}` : "Selected photo preview"} style={{
              maxWidth: "100%", maxHeight: 220, borderRadius: 10,
              filter: viewOnce ? "blur(14px)" : "none",
            }}/>
            {canEdit && (
              <div onClick={() => setEditing(true)} title="Edit photo" style={{
                position: "absolute", top: 6, right: 6, width: 32, height: 32, borderRadius: "50%",
                background: "#00000099", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}>{I.edit("#fff", 16)}</div>
            )}
          </>
        ) : isVideo && previewUrl ? (
          <>
            <video src={previewUrl} controls style={{
              maxWidth: "100%", maxHeight: 220, borderRadius: 10,
              filter: viewOnce ? "blur(14px)" : "none",
            }}/>
            {canTrim && (
              <div onClick={() => setTrimming(true)} title="Trim video" style={{
                position: "absolute", top: 6, right: 6, width: 32, height: 32, borderRadius: "50%",
                background: "#00000099", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}>{I.edit("#fff", 16)}</div>
            )}
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
            {I.doc(G.accent, 28)}
            <div style={{ fontSize: 13.5 }}>
              {workingFiles.length > 1 ? `${workingFiles.length} files selected` : firstFile?.name}
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

      <Button onClick={send} style={{ width: "100%" }}>
        {workingFiles.length > 1 ? `Send ${workingFiles.length}` : "Send"}
      </Button>
    </Sheet>
  );
}

const COMPRESSION_LEVELS = [
  { label: "Low", quality: 0.4 },
  { label: "Medium", quality: 0.7 },
  { label: "High", quality: 0.92 },
];

// Document-scan cleanup filters, applied per pixel over a rendered page.
const SCAN_FILTERS = [
  { key: "original", label: "Original" },
  { key: "magic", label: "Magic" },     // whiten paper, deepen ink, keep colour
  { key: "whiten", label: "Whiten" },   // grey + strong contrast, clean B/W-ish
  { key: "bw", label: "B&W" },          // hard threshold — crisp text
  { key: "grayscale", label: "Gray" },
];

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * In-place pixel cleanup for a scanned page. "Magic"/"Whiten" push the paper
 * background toward white and the ink toward black (a contrast+brightness
 * stretch) the way CamScanner/WhatsApp's document mode does; "B&W" is a hard
 * threshold for the crispest text; "Gray" just desaturates. "original" is a
 * no-op so the un-filtered scan costs nothing.
 */
function applyScanFilter(ctx, width, height, filterName) {
  if (!filterName || filterName === "original") return;
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    if (filterName === "grayscale") {
      d[i] = d[i + 1] = d[i + 2] = gray;
    } else if (filterName === "bw") {
      const v = gray > 140 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    } else if (filterName === "whiten") {
      const v = clamp255((gray - 128) * 1.9 + 128 + 26);
      d[i] = d[i + 1] = d[i + 2] = v;
    } else if (filterName === "magic") {
      d[i] = clamp255((r - 128) * 1.55 + 128 + 20);
      d[i + 1] = clamp255((g - 128) * 1.55 + 128 + 20);
      d[i + 2] = clamp255((b - 128) * 1.55 + 128 + 20);
    }
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Preview screen between "photo captured" and "PDF sent". Supports a
 * MULTI-PAGE scan: the first captured photo is page 1, and "Add page" snaps
 * more pages onto the same document (a real scanner flow, not one-photo-one-
 * PDF). Each page keeps its own rotation; a single compression level applies
 * to the whole document. On send, every page is drawn to its own canvas and
 * the lot is wrapped into one multi-page PDF (see canvasesToPdfBlob).
 */
function ScanEditSheet({ file, onClose, onSend, toast }) {
  const canvasRef = useRef(null);
  const bitmapRef = useRef(null);
  const addInputRef = useRef(null);
  // Each entry is { file, rotation, filter } — all per-page.
  const [pages, setPages] = useState([{ file, rotation: 0, filter: "original" }]);
  const [current, setCurrent] = useState(0);
  const [quality, setQuality] = useState(COMPRESSION_LEVELS[1].quality);
  const [previewBytes, setPreviewBytes] = useState(null);
  const [sending, setSending] = useState(false);

  const currentFile = pages[current]?.file;
  const rotation = pages[current]?.rotation || 0;
  const filter = pages[current]?.filter || "original";

  // Load the bitmap for whichever page is being previewed. Keyed on the file
  // reference (not the pages array) so a rotate — which only changes the
  // rotation field, not the file — doesn't needlessly re-decode the image.
  useEffect(() => {
    let cancelled = false;
    if (!currentFile) return;
    createImageBitmap(currentFile).then((bitmap) => {
      if (cancelled) return;
      bitmapRef.current = bitmap;
      redraw(bitmap, rotation, filter);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile]);

  useEffect(() => { redraw(bitmapRef.current, rotation, filter); }, [rotation, quality, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawTo(canvas, bitmap, deg, filterName) {
    const swapped = deg === 90 || deg === 270;
    canvas.width = swapped ? bitmap.height : bitmap.width;
    canvas.height = swapped ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();
    applyScanFilter(ctx, canvas.width, canvas.height, filterName);
  }

  function redraw(bitmap, deg, filterName) {
    const canvas = canvasRef.current;
    if (!bitmap || !canvas) return;
    drawTo(canvas, bitmap, deg, filterName);
    canvas.toBlob((blob) => blob && setPreviewBytes(blob.size), "image/jpeg", quality);
  }

  function rotatePage(delta) {
    setPages((prev) => prev.map((page, i) =>
      i === current ? { ...page, rotation: (page.rotation + delta + 360) % 360 } : page));
  }

  function setPageFilter(filterName) {
    setPages((prev) => prev.map((page, i) => (i === current ? { ...page, filter: filterName } : page)));
  }

  function onAddPage(event) {
    const picked = event.target.files?.[0];
    event.target.value = ""; // let the same file be picked again later
    if (!picked) return;
    setPages((prev) => [...prev, { file: picked, rotation: 0, filter: "original" }]);
    setCurrent(pages.length); // the new page's index is the old length
  }

  function removePage(index) {
    if (pages.length === 1) return; // a document needs at least one page
    setPages((prev) => prev.filter((_, i) => i !== index));
    setCurrent((prev) => (prev > index ? prev - 1 : Math.min(prev, pages.length - 2)));
  }

  async function send() {
    setSending(true);
    try {
      const canvases = [];
      for (const page of pages) {
        const bitmap = await createImageBitmap(page.file);
        const offscreen = document.createElement("canvas");
        drawTo(offscreen, bitmap, page.rotation, page.filter || "original");
        canvases.push(offscreen);
      }
      const pdfBlob = await canvasesToPdfBlob(canvases, quality);
      await onSend(pdfBlob);
    } catch {
      toast("Could not create the PDF");
      setSending(false);
    }
  }

  return (
    <Sheet title={pages.length > 1 ? `Edit scan · ${pages.length} pages` : "Edit scan"} onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <canvas ref={canvasRef} style={{
          maxWidth: "100%", maxHeight: 240, borderRadius: 10,
          border: `1px solid ${G.border}`, background: G.dim,
        }}/>
      </div>

      {/* Page strip: thumbnails of every page, the current one highlighted,
          each removable, with an "add another page" tile at the end. */}
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6, marginBottom: 12 }}>
        {pages.map((page, index) => (
          <div key={index} onClick={() => setCurrent(index)} style={{
            position: "relative", flexShrink: 0, width: 54, height: 54, borderRadius: 8, cursor: "pointer",
            border: `2px solid ${index === current ? G.accent : G.border}`,
            background: G.dim, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 700, color: index === current ? G.accentText : G.muted,
          }}>
            {index + 1}
            {pages.length > 1 && (
              <div onClick={(e) => { e.stopPropagation(); removePage(index); }} title="Remove page" style={{
                position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%",
                background: G.red, color: "#fff", fontSize: 12, lineHeight: "16px", textAlign: "center",
              }}>×</div>
            )}
          </div>
        ))}
        <div onClick={() => addInputRef.current?.click()} title="Add page" style={{
          flexShrink: 0, width: 54, height: 54, borderRadius: 8, cursor: "pointer",
          border: `2px dashed ${G.border}`, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", color: G.accent,
        }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
          <span style={{ fontSize: 8.5, color: G.muted }}>Page</span>
        </div>
      </div>
      <input ref={addInputRef} type="file" accept="image/*" capture="environment"
             onChange={onAddPage} style={{ display: "none" }}/>

      {/* Scan cleanup filters — applied to the current page. */}
      <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>Filter</div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, marginBottom: 14 }}>
        {SCAN_FILTERS.map((f) => (
          <div key={f.key} onClick={() => setPageFilter(f.key)} style={{
            flexShrink: 0, padding: "7px 14px", borderRadius: 16, cursor: "pointer", fontSize: 12.5,
            fontWeight: filter === f.key ? 600 : 400,
            background: filter === f.key ? G.accentSoft : G.dim,
            border: `1px solid ${filter === f.key ? G.accent : G.border}`,
            color: filter === f.key ? G.accentText : G.text,
          }}>
            {f.label}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 24, marginBottom: 16 }}>
        <div onClick={() => rotatePage(-90)}
             style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer" }}>
          {I.rotateLeft(G.sub, 22)}
          <span style={{ fontSize: 11, color: G.muted }}>Rotate left</span>
        </div>
        <div onClick={() => rotatePage(90)}
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
          Current page: {formatBytes(previewBytes)}{pages.length > 1 ? ` · ${pages.length} pages total` : ""}
        </div>
      )}

      <Button onClick={send} disabled={sending} style={{ width: "100%" }}>
        {sending ? "Preparing…" : pages.length > 1 ? `Send ${pages.length}-page PDF` : "Send as PDF"}
      </Button>
    </Sheet>
  );
}

// pickContacts() is a one-shot, user-gesture-triggered picker with no
// background "sync" (an app never gets standing address-book access) —
// native Android uses a real plugin+permission, everywhere else falls back
// to the browser's own Contact Picker API. Same helper Discover.jsx's
// importFromDevice uses — see nativeContacts.js.
const canPickDeviceContacts = contactsAvailable();

/**
 * Picking a contact to share into a chat, WhatsApp-style: a searchable list
 * of the app's own saved contacts (Contacts.list(), the same address book
 * Discover.jsx manages) rather than the old bare name+phone text form —
 * that form is still here, just demoted to "add a new one" for a person
 * who isn't saved yet, plus an explicit "Import from phone" action for
 * browsers that can hand over real device contacts.
 */
function ContactSheet({ onClose, onSave, toast }) {
  const [contacts, setContacts] = useState(null);
  const [query, setQuery] = useState("");
  const [addingNew, setAddingNew] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    Contacts.list().then(setContacts).catch(() => setContacts([]));
  }, []);

  useEffect(() => {
    if (canPickDeviceContacts) importFromDevice();
  }, []);

  const filtered = (contacts || []).filter((contact) =>
    !query.trim()
    || contact.name.toLowerCase().includes(query.trim().toLowerCase())
    || contact.phone.includes(query.trim()));

  function saveNew() {
    if (!name.trim() || !phone.trim()) {
      toast("A contact needs a name and phone number");
      return;
    }
    onSave(name.trim(), phone.trim());
  }

  async function importFromDevice() {
    try {
      const picked = await pickContacts();
      let imported = 0;
      for (const person of picked) {
        const personName = person.name?.[0]?.trim();
        const personPhone = person.tel?.[0]?.trim();
        if (!personName || !personPhone) continue;
        try {
          await Contacts.add(personName, personPhone);
          imported++;
        } catch {
          // Already saved, or didn't validate — skip rather than abort the batch.
        }
      }
      if (imported > 0) {
        toast(`Imported ${imported} contact${imported === 1 ? "" : "s"}`);
        Contacts.list().then(setContacts).catch(() => {});
      } else {
        toast("No new contacts to import");
      }
    } catch (problem) {
      if (problem.name !== "AbortError") toast("Could not import contacts");
    }
  }

  if (addingNew) {
    return (
      <Sheet title="New contact" onClose={() => setAddingNew(false)}>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Full name"/>
        <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)}
               placeholder="+91 98765 43210"/>
        <Button onClick={saveNew} style={{ width: "100%" }}>Send contact</Button>
      </Sheet>
    );
  }

  return (
    <Sheet title={
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Share a contact</span>
        <div onClick={() => setAddingNew(true)} style={{
          cursor: "pointer", padding: 4, borderRadius: "50%", display: "flex",
          alignItems: "center", justifyContent: "center",
        }} title="New contact">
          {I.plus(G.accent, 22)}
        </div>
      </div>
    } onClose={onClose}>
      <Field value={query} onChange={(e) => setQuery(e.target.value)}
             placeholder="Search your contacts" style={{ marginBottom: 10 }}/>
      {contacts === null ? (
        <div style={{ fontSize: 13, color: G.sub, textAlign: "center", padding: 20 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: G.sub, textAlign: "center", padding: 20 }}>
          {contacts.length === 0 ? "No saved contacts yet — add one above." : "No matches."}
        </div>
      ) : (
        <div style={{ maxHeight: 340, overflowY: "auto" }}>
          {filtered.map((contact) => (
            <div key={contact.id} onClick={() => onSave(contact.name, contact.phone)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", cursor: "pointer",
            }}>
              <Av av={contact.name[0]?.toUpperCase() || "?"} color={G.accent} size={38}/>
              <div>
                <div style={{ fontSize: 14 }}>{contact.name}</div>
                <div style={{ fontSize: 12, color: G.sub }}>{contact.phone}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function StickerPickerSheet({ onClose, onPick }) {
  const [enabledIds, setEnabledIds] = useState(getEnabledPacks);
  const [activePack, setActivePack] = useState(STICKER_PACKS[0].id);
  const [managing, setManaging] = useState(false);
  const visiblePacks = STICKER_PACKS.filter((p) => enabledIds.includes(p.id));
  const pack = STICKER_PACKS.find((p) => p.id === activePack) || visiblePacks[0];

  function togglePack(id) {
    setEnabledIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      setEnabledPacks(next);
      return next;
    });
  }

  return (
    <Sheet title="Stickers" onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 0, borderBottom: `1px solid ${G.border}`, marginBottom: 8 }}>
        <div style={{ display: "flex", flex: 1, gap: 0, overflowX: "auto" }}>
          {visiblePacks.map((p) => (
            <div key={p.id} onClick={() => { setActivePack(p.id); setManaging(false); }}
                 style={{
                   padding: "8px 12px", cursor: "pointer", fontSize: 16, whiteSpace: "nowrap",
                   borderBottom: activePack === p.id && !managing ? "2px solid #2563eb" : "2px solid transparent",
                   opacity: activePack === p.id && !managing ? 1 : 0.5,
                 }}
                 title={p.name}>
              {p.icon}
            </div>
          ))}
        </div>
        <div onClick={() => setManaging(!managing)}
             style={{ padding: "8px 10px", cursor: "pointer", fontSize: 14, opacity: managing ? 1 : 0.5 }}
             title="Manage packs">
          {I.settings(managing ? G.accentText : G.sub, 16)}
        </div>
      </div>

      {managing ? (
        <div style={{ padding: "4px 0 8px" }}>
          <div style={{ fontSize: 12, color: G.muted, marginBottom: 8 }}>Enable or disable sticker packs</div>
          {STICKER_PACKS.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px", borderBottom: `1px solid ${G.border}` }}>
              <span style={{ fontSize: 20 }}>{p.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: G.muted }}>{p.stickers.length} stickers</div>
              </div>
              <Toggle value={enabledIds.includes(p.id)} onToggle={() => togglePack(p.id)}/>
            </div>
          ))}
        </div>
      ) : pack ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, padding: "4px 2px 8px" }}>
          {pack.stickers.map((sticker) => (
            <div key={sticker.id} onClick={() => onPick(sticker.id)}
                 title={sticker.label}
                 style={{ display: "flex", justifyContent: "center", cursor: "pointer" }}>
              {sticker.render()}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: 20, textAlign: "center", fontSize: 13, color: G.muted }}>
          No packs enabled. Tap the gear icon to add packs.
        </div>
      )}
    </Sheet>
  );
}

const LIVE_LOCATION_CHOICES = [
  { label: "Share current location", seconds: null },
  { label: "Live for 15 minutes", seconds: 15 * 60 },
  { label: "Live for 1 hour", seconds: 3600 },
  { label: "Live for 8 hours", seconds: 8 * 3600 },
];

function LiveLocationSheet({ onClose, onSend }) {
  // undefined = still choosing a duration; once picked, this step fetches
  // the device position and shows it on an actual map to confirm/adjust
  // before anything is sent — the old flow sent the raw GPS fix the moment
  // you picked a duration, with no chance to see or correct it first.
  const [seconds, setSeconds] = useState(undefined);
  const [position, setPosition] = useState(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  function pick(chosenSeconds) {
    setSeconds(chosenSeconds);
    setError("");
    if (!navigator.geolocation) {
      setError("Location isn't available in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => { setError("Location permission denied"); setLocating(false); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function confirm() {
    if (!position || sending) return;
    setSending(true);
    try {
      await onSend(position.lat, position.lng, seconds);
    } catch {
      setSending(false); // onSend already toasted; let them retry without re-picking
    }
  }

  if (seconds === undefined) {
    return (
      <Sheet title="Share location" onClose={onClose}>
        {LIVE_LOCATION_CHOICES.map((choice) => (
          <div key={choice.label} onClick={() => pick(choice.seconds)}
            style={{
              padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
              background: G.dim, border: `1px solid ${G.border}`, fontSize: 14,
            }}>{choice.label}</div>
        ))}
      </Sheet>
    );
  }

  return (
    <Sheet title="Confirm location" onClose={onClose}>
      {locating && (
        <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}><Spinner/></div>
      )}
      {error && (
        <div style={{ fontSize: 13, color: G.red, padding: "10px 0", textAlign: "center" }}>{error}</div>
      )}
      {position && (
        <>
          <Suspense fallback={<div style={{height:220,background:G.card,borderRadius:12}}/>}>
            <LocationMap lat={position.lat} lng={position.lng} height={220} interactive
                         onPick={(lat, lng) => setPosition({ lat, lng })}/>
          </Suspense>
          <div style={{ fontSize: 12, color: G.muted, margin: "10px 0 14px" }}>
            Drag the pin or tap the map to adjust · {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
          </div>
          <Button onClick={confirm} disabled={sending} style={{ width: "100%" }}>
            {sending ? "Sending…" : "Send location"}
          </Button>
        </>
      )}
    </Sheet>
  );
}

const REMIND_CHOICES = [
  { label: "In 30 minutes", ms: 30 * 60 * 1000 },
  { label: "In 1 hour", ms: 60 * 60 * 1000 },
  { label: "In 3 hours", ms: 3 * 60 * 60 * 1000 },
  { label: "In 8 hours", ms: 8 * 60 * 60 * 1000 },
  { label: "Tomorrow morning", ms: null },
  { label: "In 1 week", ms: 7 * 24 * 60 * 60 * 1000 },
];

function ReminderSheet({ message, chatId, onClose, onSet }) {
  function pick(choice) {
    let remindAt;
    if (choice.ms) {
      remindAt = Date.now() + choice.ms;
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      remindAt = tomorrow.getTime();
    }
    addReminder(chatId, message.id, message.text, remindAt);
    onSet(choice.label);
  }

  return (
    <Sheet title="Remind me" onClose={onClose}>
      <div style={{ fontSize: 13, color: G.sub, marginBottom: 10 }}>
        {(message.text || "").slice(0, 80) || "This message"}
      </div>
      {REMIND_CHOICES.map((choice) => (
        <div key={choice.label} onClick={() => pick(choice)} style={{
          padding: "12px 6px", cursor: "pointer", fontSize: 14,
          borderBottom: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          {(I.timer || I.clock)(G.accent, 16)}
          {choice.label}
        </div>
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

/**
 * The discussion thread under a single channel/community post (Telegram-style
 * comments). Loads the post's comments, listens for comment_added/
 * comment_deleted over the shared realtime `events` stream so it updates live
 * while open, and lets anyone in the channel add a comment or remove their own
 * (admins with the delete right can remove any).
 */
function CommentsSheet({ post, chat, me, events, onClose, toast }) {
  const [comments, setComments] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const lastEvent = useRef(0);
  const listBottom = useRef(null);
  const canModerate = (chat.my_permissions || []).includes("delete") || chat.my_role === "owner";

  useEffect(() => {
    Chats.comments(post.id).then(setComments).catch(() => setComments([]));
  }, [post.id]);

  // Live updates for this post's thread from the shared event stream.
  useEffect(() => {
    const fresh = events.filter((event) => event._n > lastEvent.current
      && event.post_message_id === post.id
      && (event.type === "comment_added" || event.type === "comment_deleted"));
    if (fresh.length === 0) return;
    lastEvent.current = events[events.length - 1]._n;
    setComments((current) => {
      let next = current ? [...current] : [];
      for (const event of fresh) {
        if (event.type === "comment_added") {
          if (!next.some((c) => c.id === event.comment.id)) next.push(event.comment);
        } else {
          next = next.filter((c) => c.id !== event.comment_id);
        }
      }
      return next;
    });
  }, [events, post.id]);

  async function send() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const created = await Chats.addComment(post.id, body);
      setText("");
      // Optimistically add if the realtime event hasn't landed yet.
      setComments((current) => (current || []).some((c) => c.id === created.id)
        ? current : [...(current || []), created]);
      setTimeout(() => listBottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (problem) {
      toast(problem.message || "Could not post comment");
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment) {
    try {
      await Chats.deleteComment(comment.id);
      setComments((current) => (current || []).filter((c) => c.id !== comment.id));
    } catch (problem) {
      toast(problem.message || "Could not delete comment");
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 55,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        display: "flex", flexDirection: "column", height: "80vh",
      }}>
        <div style={{
          padding: "16px 20px 12px", borderBottom: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            Comments{comments ? ` (${comments.length})` : ""}
          </div>
          <div onClick={onClose} style={{ cursor: "pointer", color: G.muted, fontSize: 20 }}>✕</div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          {comments === null && <Spinner small/>}
          {comments?.length === 0 && (
            <div style={{ fontSize: 13, color: G.muted, textAlign: "center", padding: 24 }}>
              No comments yet. Be the first to comment.
            </div>
          )}
          {comments?.map((comment) => (
            <div key={comment.id} style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <Av av={comment.user_avatar_letter} color={comment.user_color} size={32}
                  photoId={comment.user_avatar_attachment_id}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{comment.user_name}</span>
                  <span style={{ fontSize: 10.5, color: G.muted }}>{whenLabel(comment.created_at)}</span>
                </div>
                <div style={{ fontSize: 13.5, color: G.text, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                  {comment.text}
                </div>
              </div>
              {(comment.user_id === me.id || canModerate) && (
                <div onClick={() => remove(comment)} style={{ cursor: "pointer", flexShrink: 0, padding: 2 }}
                     title="Delete comment">{I.trash(G.muted, 15)}</div>
              )}
            </div>
          ))}
          <div ref={listBottom}/>
        </div>

        <div style={{
          display: "flex", gap: 8, padding: "10px 14px",
          borderTop: `1px solid ${G.border}`, alignItems: "flex-end",
        }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder="Write a comment…" rows={1} style={{
            flex: 1, padding: "9px 12px", borderRadius: 18, resize: "none", maxHeight: 100,
            background: G.dim, border: `1px solid ${G.border}`, color: G.text,
            fontSize: 14, outline: "none", fontFamily: "inherit",
          }}/>
          <Button onClick={send} disabled={busy || !text.trim()} style={{ padding: "9px 16px" }}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One rounded quick-action tile (Voice/Video/Search) in the contact info header. */
function InfoAction({ icon, label, onClick }) {
  return (
    <div onClick={onClick} style={{
      flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
      padding: "12px 6px", borderRadius: 12, cursor: "pointer",
      background: `${G.accent}0c`, border: `1px solid ${G.accent}1f`,
    }}>
      {icon}
      <span style={{ fontSize: 12, color: G.accent, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function ChatInfoSheet({ chat, me, events, onClose, toast, onChanged, onLeft, onOpenChat,
                        onChatLocked, onVoiceCall, onVideoCall, onSearch }) {
  const [folder, setFolder] = useState(chat.folder || "");
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(null);          // members + my_role, fetched separately
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [subChannels, setSubChannels] = useState(null);
  const [addingChannel, setAddingChannel] = useState(false);
  const [locked, setLocked] = useState(Boolean(chat.is_locked));
  const [lockSheet, setLockSheet] = useState(null);   // 'set' | 'remove'
  const [archived, setArchived] = useState(Boolean(chat.archived));
  const [callsEnabled, setCallsEnabled] = useState(Boolean(chat.calls_enabled));
  const [vanishMode, setVanishMode] = useState(Boolean(chat.vanish_mode));
  // Vanish mode is chat-wide now — the OTHER member flipping it shows up
  // here as a fresh `chat` prop (App.jsx refetches the open chat on its
  // own chat_updated event), not just when this device is the one that
  // toggled it. useState's initial value alone would miss that.
  useEffect(() => { setVanishMode(Boolean(chat.vanish_mode)); }, [chat.vanish_mode]);
  const [muteSheet, setMuteSheet] = useState(false);
  const [toneSheet, setToneSheet] = useState(false);
  const [notifyTone, setNotifyTone] = useState(chat.notify_tone || "default");
  const [labelSheet, setLabelSheet] = useState(false);
  const [chatLabels, setChatLabels] = useState(chat.labels || []);
  const [mediaSheet, setMediaSheet] = useState(false);
  const [inviteSheet, setInviteSheet] = useState(false);
  const [mutedUntil, setMutedUntil] = useState(chat.muted_until || 0);
  const [memberQuery, setMemberQuery] = useState("");
  const [membersShown, setMembersShown] = useState(50); // grows on "Show more" for huge groups
  const [slowModeSecs, setSlowModeSecs] = useState(chat.slow_mode_secs || 0);
  const [reactionsOn, setReactionsOn] = useState(chat.reactions_enabled !== 0);
  const [commentsOn, setCommentsOn] = useState(chat.comments_enabled !== 0);
  const [adminsOnlySend, setAdminsOnlySend] = useState(chat.send_policy === "admins");
  const [topicsOn, setTopicsOn] = useState(Boolean(chat.topics_enabled));
  const [editingInfo, setEditingInfo] = useState(false);
  const [infoForm, setInfoForm] = useState({ name: chat.name || "", description: chat.description || "" });
  const [handle, setHandle] = useState(chat.public_username || "");
  const [handleSaving, setHandleSaving] = useState(false);
  const [approvalOn, setApprovalOn] = useState(Boolean(chat.require_approval));
  const [signatureOn, setSignatureOn] = useState(Boolean(chat.signature_enabled));
  const [pendingReqs, setPendingReqs] = useState([]);
  const [permEditFor, setPermEditFor] = useState(null);   // member id whose granular admin rights are being edited
  const [permDraft, setPermDraft] = useState([]);          // the rights selected in that editor
  const [showPermMatrix, setShowPermMatrix] = useState(false);
  const [channelStats, setChannelStats] = useState(null);
  const [broadcastRecipients, setBroadcastRecipients] = useState(null);
  const [showAddBroadcast, setShowAddBroadcast] = useState(false);
  const lastMemberEvent = useRef(0);

  useEffect(() => {
    if (chat.type === "broadcast") {
      Chats.broadcastRecipients(chat.id).then(setBroadcastRecipients).catch(() => setBroadcastRecipients([]));
    }
  }, [chat.id, chat.type]);

  useEffect(() => {
    if (chat.type !== "channel") return;
    Messages.list(chat.id, 100).then((msgs) => {
      const now = Date.now();
      const day = 86400000;
      const week = 7 * day;
      const total = msgs.length;
      const withMedia = msgs.filter((m) => ["photo", "video", "voice", "document"].includes(m.kind)).length;
      const withReactions = msgs.filter((m) => m.reactions?.length > 0).length;
      const totalReactions = msgs.reduce((sum, m) => sum + (m.reactions?.length || 0), 0);
      const last24h = msgs.filter((m) => now - new Date(m.created_at).getTime() < day).length;
      const lastWeek = msgs.filter((m) => now - new Date(m.created_at).getTime() < week).length;
      const topPosters = {};
      msgs.forEach((m) => { topPosters[m.sender_name || m.sender_id] = (topPosters[m.sender_name || m.sender_id] || 0) + 1; });
      const sorted = Object.entries(topPosters).sort((a, b) => b[1] - a[1]).slice(0, 3);
      setChannelStats({ total, withMedia, withReactions, totalReactions, last24h, lastWeek, topPosters: sorted });
    }).catch(() => {});
  }, [chat.id, chat.type]);

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

  const [commonGroups, setCommonGroups] = useState([]);
  const [viewingAvatar, setViewingAvatar] = useState(false);

  useEffect(() => {
    if (!isDm || !chat.peer_id) return;
    Promise.all([Users.get(chat.peer_id), Contacts.list()]).then(([user, contacts]) => {
      setPeerProfile(user);
      setContact(contacts.find((entry) => entry.user?.id === chat.peer_id) || null);
    }).catch(() => {});
    Chats.commonGroups(chat.peer_id).then(setCommonGroups).catch(() => setCommonGroups([]));
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

  const [exportBusy, setExportBusy] = useState(false);

  // A plain-text transcript, same shape WhatsApp's own "export chat without
  // media" produces — the honest scope for a client-only export with no new
  // backend storage: message content is what "will I lose everything
  // switching phones" is actually about, not the attachment bytes
  // themselves (those would need a zip of every file, a much bigger and
  // slower operation this button doesn't attempt).
  async function exportChat() {
    if (exportBusy) return;
    setExportBusy(true);
    try {
      const all = [];
      let page = await Messages.list(chat.id, 200);
      all.unshift(...page);
      // Messages.list returns newest-last; page backward via the oldest
      // seq on hand until the server has nothing older left to give.
      while (page.length > 0 && all.length < 20000) {
        const oldestSeq = page[0].seq;
        page = await Messages.before(chat.id, oldestSeq, 200);
        if (page.length === 0) break;
        all.unshift(...page);
      }

      // Messages carry only sender_id — names come from the member list
      // (fetched for groups/channels/communities as `full`) or, for a DM,
      // the peer's name is just the chat's own name.
      const nameFor = (id) => {
        if (id === me.id) return "You";
        return full?.members?.find((mem) => mem.id === id)?.name || chat.name || "Them";
      };
      const lines = all.map((m) => {
        const when = new Date((m.created_at || 0) * 1000).toLocaleString();
        const who = nameFor(m.sender_id);
        const body = m.deleted_at ? "[deleted]"
          : m.kind === "text" ? (m.text || "")
          : `[${m.kind}]${m.text ? " " + m.text : ""}`;
        return `[${when}] ${who}: ${body}`;
      });
      const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `talkex-${(chat.name || "chat").replace(/[^\w-]+/g, "_")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`Exported ${all.length} messages`);
    } catch {
      toast("Could not export this chat");
    } finally {
      setExportBusy(false);
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

  // Admins load pending join requests (and refresh them when one arrives).
  const reloadRequests = useCallback(() => {
    if (!canManage || !["group", "channel", "community"].includes(chat.type)) return;
    Chats.joinRequests(chat.id).then(setPendingReqs).catch(() => {});
  }, [canManage, chat.id, chat.type]);
  useEffect(reloadRequests, [reloadRequests]);
  useEffect(() => {
    if (events.some((e) => e.type === "join_request" && e.chat_id === chat.id)) reloadRequests();
  }, [events, chat.id, reloadRequests]);

  async function removeMember(userId) {
    try {
      await Chats.removeMember(chat.id, userId);
      const target = full?.members?.find((m) => m.id === userId);
      logAdminAction(chat.id, me.name, "remove_member", target?.name || userId);
      reloadFull();
    } catch (problem) {
      toast(problem.message || "Could not remove member");
    }
  }

  async function setRole(userId, role, permissions) {
    try {
      await Chats.setMemberRole(chat.id, userId, role, permissions);
      const target = full?.members?.find((m) => m.id === userId);
      logAdminAction(chat.id, me.name, role === "admin" ? "promote_admin" : "demote_admin", target?.name || userId);
      setPermEditFor(null);
      reloadFull();
    } catch (problem) {
      toast(problem.message || "Could not change role");
    }
  }

  async function makeOwner(member) {
    if (!confirm(`Make ${member.name} the group owner? You will become an admin.`)) return;
    try {
      await Chats.makeOwner(chat.id, member.id);
      logAdminAction(chat.id, me.name, "transfer_ownership", member.name);
      reloadFull();
      onChanged();
      toast(`${member.name} is now the owner`);
    } catch (problem) {
      toast(problem.message || "Could not transfer ownership");
    }
  }

  function openPermEditor(member) {
    // Pre-fill with the admin's current rights, or all of them when first
    // promoting a plain member (the sensible "full admin" default).
    setPermDraft(member.role === "admin" && member.permissions ? [...member.permissions] : [...ADMIN_PERMISSIONS]);
    setPermEditFor(member.id);
  }

  function togglePerm(perm) {
    setPermDraft((current) =>
      current.includes(perm) ? current.filter((p) => p !== perm) : [...current, perm]);
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

  async function toggleCallsEnabled(next) {
    setCallsEnabled(next);
    await Chats.settings(chat.id, { calls_enabled: next });
    onChanged();
  }

  async function toggleVanishMode(next) {
    setVanishMode(next);
    await Chats.setVanishMode(chat.id, next);
  }

  async function changeFolder(next) {
    setFolder(next);
    await Chats.settings(chat.id, { folder: next });
    onChanged();
  }

  const avatarInputRef = useRef(null);
  async function changeAvatar(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await Chats.setAvatar(chat.id, file);
      reloadFull();
      onChanged();
      toast("Photo updated");
    } catch (problem) {
      toast(problem.message || "Could not update photo");
    }
  }
  async function removeAvatar() {
    try {
      await Chats.removeAvatar(chat.id);
      reloadFull();
      onChanged();
      toast("Photo removed");
    } catch (problem) {
      toast(problem.message || "Could not remove photo");
    }
  }

  async function saveInfo() {
    if (!infoForm.name.trim()) { toast("Name cannot be empty"); return; }
    try {
      await Chats.updateInfo(chat.id, {
        name: infoForm.name.trim(), description: infoForm.description.trim(),
      });
      setEditingInfo(false);
      reloadFull();
      onChanged();
      toast("Group info updated");
    } catch (problem) {
      toast(problem.message || "Could not update info");
    }
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
    <Sheet title={chat.name || "Chat info"} onClose={onClose} side="right">
      {isDm && peerProfile?.cover_attachment_id && (
        <div style={{ margin: "-4px 0 14px", borderRadius: 12, overflow: "hidden" }}>
          <CoverImage coverId={peerProfile.cover_attachment_id} height={120}/>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        {MANAGED_TYPES.includes(chat.type) && canManage ? (
          <div style={{ position: "relative", cursor: "pointer" }}
               onClick={() => avatarInputRef.current?.click()}
               title="Change photo">
            <Av av={chat.avatar_letter} color={chat.color} size={52} photoId={chat.avatar_attachment_id}/>
            <div style={{
              position: "absolute", bottom: -2, right: -2, width: 22, height: 22, borderRadius: "50%",
              background: G.accent, border: `2px solid ${G.surface}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{I.camera("#fff", 12)}</div>
            <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: "none" }}
                   onChange={changeAvatar}/>
          </div>
        ) : (
          <div onClick={() => chat.avatar_attachment_id && setViewingAvatar(true)}
               style={{ cursor: chat.avatar_attachment_id ? "zoom-in" : "default" }}
               title={chat.avatar_attachment_id ? "View photo" : undefined}>
            <Av av={chat.avatar_letter} color={chat.color} size={52} photoId={chat.avatar_attachment_id}/>
          </div>
        )}
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
            {chat.name || "Direct message"} {chat.peer_blue_tick ? I.blueTick(14) : null}
          </div>
          {isDm && peerProfile?.phone
            ? <div style={{ fontSize: 12.5, color: G.muted }}>{peerProfile.phone}</div>
            : <div style={{ fontSize: 12.5, color: G.muted, textTransform: "capitalize" }}>{chat.type}</div>}
          {isDm && peerProfile?.business_category && (
            <div style={{ fontSize: 12, color: G.sub, marginTop: 2, fontWeight: 600 }}>
              {peerProfile.business_category}
            </div>
          )}
        </div>
      </div>

      {viewingAvatar && chat.avatar_attachment_id && (
        <div onClick={() => setViewingAvatar(false)} style={{
          position: "fixed", inset: 0, zIndex: 90, background: "#000000e6",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div onClick={(e) => e.stopPropagation()}>
            <Av av={chat.avatar_letter} color={chat.color} size={300} photoId={chat.avatar_attachment_id}/>
          </div>
          <div onClick={() => setViewingAvatar(false)} style={{
            position: "absolute", top: 18, right: 20, color: "#fff", fontSize: 26, cursor: "pointer",
          }}>✕</div>
        </div>
      )}

      {/* WhatsApp-style quick actions right under the header. */}
      {isDm && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <InfoAction icon={I.phone(G.accent, 20)} label="Voice" onClick={onVoiceCall}/>
          <InfoAction icon={I.video(G.accent, 20)} label="Video" onClick={onVideoCall}/>
          <InfoAction icon={I.search(G.accent, 20)} label="Search" onClick={onSearch}/>
        </div>
      )}

      {isDm && peerProfile?.bio && (
        <div style={{ fontSize: 13.5, color: G.text, marginBottom: 12, lineHeight: 1.4 }}>
          {peerProfile.bio}
        </div>
      )}

      {/* The peer's social links, same brand chips their own profile shows. */}
      {isDm && <SocialLinks profile={peerProfile} style={{ marginBottom: 14 }}/>}

      {/* Groups you and this person are both in. */}
      {isDm && commonGroups.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>
            {commonGroups.length} group{commonGroups.length > 1 ? "s" : ""} in common
          </div>
          {commonGroups.map((group) => (
            <div key={group.id} onClick={() => onOpenChat?.(group)} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "7px 4px",
              cursor: onOpenChat ? "pointer" : "default",
            }}>
              <Av av={group.avatar_letter} color={group.color} size={30}
                  photoId={group.avatar_attachment_id}/>
              <div style={{ fontSize: 13.5 }}>{group.name}</div>
            </div>
          ))}
        </div>
      )}

      {/* E2EE badge in info sheet */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", marginBottom: 12,
        borderRadius: 12, background: `${G.accent}0a`, border: `1px solid ${G.accent}18`,
      }}>
        <span style={{ fontSize: 16 }}>🔒</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: G.text }}>End-to-end encrypted</div>
          <div style={{ fontSize: 11, color: G.muted, marginTop: 1 }}>
            Messages and calls are secured with end-to-end encryption. Only you and the participants can read or listen to them.
          </div>
        </div>
      </div>

      {/* Group/channel/community name + description, editable by admins. */}
      {MANAGED_TYPES.includes(chat.type) && (
        editingInfo ? (
          <div style={{ marginBottom: 14 }}>
            <Field label="Name" value={infoForm.name}
                   onChange={(e) => setInfoForm({ ...infoForm, name: e.target.value })}/>
            <div style={{ fontSize: 12.5, color: G.sub, margin: "6px 0 4px" }}>Description</div>
            <textarea value={infoForm.description} rows={3}
                      onChange={(e) => setInfoForm({ ...infoForm, description: e.target.value })}
                      placeholder="What's this group about?" style={{
              width: "100%", padding: "9px 12px", borderRadius: 12, resize: "vertical",
              background: G.dim, border: `1px solid ${G.border}`, color: G.text,
              fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit",
            }}/>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button onClick={saveInfo} style={{ flex: 1 }}>Save</Button>
              <Button variant="ghost" onClick={() => setEditingInfo(false)} style={{ flex: 1 }}>Cancel</Button>
            </div>
            {chat.avatar_attachment_id ? (
              <Button variant="ghost" onClick={removeAvatar}
                      style={{ width: "100%", marginTop: 8, color: G.red }}>Remove photo</Button>
            ) : null}
          </div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            {chat.description && (
              <div style={{ fontSize: 13.5, color: G.text, marginBottom: 8, lineHeight: 1.45 }}>
                {chat.description}
              </div>
            )}
            {canManage && (
              <SRow icon={I.edit(G.accent, 18)} label="Edit group info" sub="Name and description"
                    onClick={() => { setInfoForm({ name: chat.name || "", description: chat.description || "" }); setEditingInfo(true); }}/>
            )}
          </div>
        )
      )}

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
                       placeholder={samplePlaceholder(contactCountry.len)}
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

      <SRow icon={I.bell(G.accent, 18)} label="Notification sound"
            sub="For this chat, while the app is open"
            onClick={() => setToneSheet(true)}
            right={<span style={{ fontSize: 13, color: G.sub, textTransform: "capitalize" }}>
              {notifyTone}
            </span>}/>

      <SRow icon={I.archive(G.accent, 18)} label="Archive chat"
            sub="Off the main list until a new message arrives"
            right={<Toggle on={archived} onChange={toggleArchive}/>}/>

      <SRow icon={I.phone(G.accent, 18)} label="Calls"
            sub="When off, nobody can call you in this chat — even if Calling is on overall"
            right={<Toggle on={callsEnabled} onChange={toggleCallsEnabled}/>}/>

      <SRow icon={I.image(G.accent, 18)} label="Shared media" onClick={() => setMediaSheet(true)}/>

      <SRow icon={I.download(G.accent, 18)} label={exportBusy ? "Exporting…" : "Export chat"}
            sub="Downloads a text transcript to this device — no media files"
            onClick={exportChat}/>

      <SRow icon={I.tag(G.accent, 18)} label="Labels"
            sub="Personal tags — only you see these, like a CRM"
            onClick={() => setLabelSheet(true)}
            right={chatLabels.length > 0 && (
              <div style={{ display: "flex", gap: 4 }}>
                {chatLabels.slice(0, 3).map((l) => (
                  <span key={l.id} style={{
                    width: 10, height: 10, borderRadius: "50%", background: l.color,
                  }}/>
                ))}
              </div>
            )}/>

      {["group", "channel", "community"].includes(chat.type) && canManage && (
        <SRow icon={I.link(G.accent, 18)} label="Invite link"
              sub="Share a code that lets anyone join"
              onClick={() => setInviteSheet(true)}/>
      )}

      <SRow icon={I.lock(locked ? G.accent : G.sub, 18)} label="Chat lock"
            sub={locked ? "PIN required to open this chat" : "Set a PIN to lock this chat"}
            onClick={() => setLockSheet(locked ? "remove" : "set")}
            right={<span style={{ fontSize: 13, color: G.sub }}>{locked ? "On" : "Off"}</span>}/>

      <SRow icon={I.eye(vanishMode ? G.accent : G.sub, 18)} label="Vanish mode"
            sub="Messages sent while on will disappear when you leave the chat"
            right={<Toggle on={vanishMode} onChange={toggleVanishMode}/>}/>

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

      <div style={{ padding: "12px 4px" }}>
        <div style={{ fontSize: 12, color: G.sub, marginBottom: 8 }}>Chat accent color</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CHAT_ACCENT_COLORS.map((c) => (
            <div key={c.hex || "default"} onClick={() => {
              setChatAccent(chat.id, c.hex);
              toast(c.hex ? `Accent: ${c.label}` : "Reset to default");
              onChanged?.();
            }} title={c.label} style={{
              width: 28, height: 28, borderRadius: "50%", cursor: "pointer",
              background: c.hex || G.accent,
              border: (getChatAccents()[chat.id] || null) === c.hex
                ? `3px solid ${G.text}` : `2px solid ${G.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {!c.hex && <span style={{ fontSize: 10, color: "#fff", fontWeight: 700 }}>A</span>}
            </div>
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
                  logAdminAction(chat.id, me.name, "set_slow_mode", choice.label);
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

      {["group", "channel", "community"].includes(chat.type) && canManage && (
        <div style={{
          padding: "14px 4px", borderTop: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13.5 }}>Reactions</div>
            <div style={{ fontSize: 11.5, color: G.muted }}>
              Let members react to messages with emoji
            </div>
          </div>
          <Toggle on={reactionsOn} onChange={async (value) => {
            setReactionsOn(value);
            try {
              await Chats.setReactionsPolicy(chat.id, value);
              logAdminAction(chat.id, me.name, "toggle_reactions", value ? "enabled" : "disabled");
              onChanged?.();
            } catch (problem) {
              setReactionsOn(!value);
              toast(problem.message || "Could not update reactions");
            }
          }}/>
        </div>
      )}

      {chat.type === "group" && canManage && (
        <div style={{
          padding: "14px 4px", borderTop: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13.5 }}>Only admins can send messages</div>
            <div style={{ fontSize: 11.5, color: G.muted }}>
              Members can read but not post
            </div>
          </div>
          <Toggle on={adminsOnlySend} onChange={async (value) => {
            setAdminsOnlySend(value);
            try {
              await Chats.setSendPolicy(chat.id, value);
              logAdminAction(chat.id, me.name, "toggle_admins_only_send", value ? "enabled" : "disabled");
              onChanged?.();
            } catch (problem) {
              setAdminsOnlySend(!value);
              toast(problem.message || "Could not update send policy");
            }
          }}/>
        </div>
      )}

      {chat.type === "group" && canManage && (
        <div style={{
          padding: "14px 4px", borderTop: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13.5 }}>Topics</div>
            <div style={{ fontSize: 11.5, color: G.muted }}>
              Split this group into named threads, Telegram-style
            </div>
          </div>
          <Toggle on={topicsOn} onChange={async (value) => {
            setTopicsOn(value);
            try {
              await Chats.setTopicsPolicy(chat.id, value);
              logAdminAction(chat.id, me.name, "toggle_topics", value ? "enabled" : "disabled");
              onChanged?.();
            } catch (problem) {
              setTopicsOn(!value);
              toast(problem.message || "Could not update Topics");
            }
          }}/>
        </div>
      )}

      {["group", "channel", "community"].includes(chat.type) && canManage && (
        <div style={{
          padding: "14px 4px", borderTop: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13.5 }}>Anti-spam filter</div>
            <div style={{ fontSize: 11.5, color: G.muted }}>
              Flag floods, repeated messages, and link spam
            </div>
          </div>
          <Toggle on={getSpamSettings().enabled} onChange={(value) => {
            setSpamSettings({ ...getSpamSettings(), enabled: value });
            logAdminAction(chat.id, me.name, "toggle_spam_filter", value ? "enabled" : "disabled");
            toast(value ? "Spam filter enabled" : "Spam filter disabled");
          }}/>
        </div>
      )}

      {["channel", "community"].includes(chat.type) && canManage && (
        <div style={{
          padding: "14px 4px", borderTop: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13.5 }}>Discussion (comments)</div>
            <div style={{ fontSize: 11.5, color: G.muted }}>
              Let people comment on your posts
            </div>
          </div>
          <Toggle on={commentsOn} onChange={async (value) => {
            setCommentsOn(value);
            try {
              await Chats.setCommentsPolicy(chat.id, value);
              logAdminAction(chat.id, me.name, "toggle_comments", value ? "enabled" : "disabled");
              onChanged?.();
            } catch (problem) {
              setCommentsOn(!value);
              toast(problem.message || "Could not update comments");
            }
          }}/>
        </div>
      )}

      {chat.type === "channel" && canManage && (
        <div style={{ padding: "14px 4px", borderTop: `1px solid ${G.border}` }}>
          <div style={{ fontSize: 13.5, marginBottom: 4 }}>Public link</div>
          <div style={{ fontSize: 11.5, color: G.muted, marginBottom: 8 }}>
            Give the channel a @username so anyone can find and join it.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{
              display: "flex", alignItems: "center", flex: 1, background: G.dim,
              border: `1px solid ${G.border}`, borderRadius: 10, padding: "0 10px",
            }}>
              <span style={{ color: G.muted, fontSize: 14 }}>@</span>
              <input value={handle}
                     onChange={(e) => setHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase())}
                     placeholder="channelname" maxLength={32}
                     style={{ flex: 1, border: "none", outline: "none", background: "transparent",
                              color: G.text, fontSize: 14, padding: "9px 6px" }}/>
            </div>
            <Button disabled={handleSaving} onClick={async () => {
              setHandleSaving(true);
              try {
                const res = await Chats.setChannelUsername(chat.id, handle);
                setHandle(res.public_username || "");
                toast(res.public_username ? "Public link updated" : "Public link removed");
                onChanged?.();
              } catch (problem) {
                toast(problem.message || "Could not update the username");
              } finally { setHandleSaving(false); }
            }} style={{ padding: "9px 16px" }}>Save</Button>
          </div>
          {chat.public_username && (
            <div onClick={() => { navigator.clipboard?.writeText(`@${chat.public_username}`); toast("Copied"); }}
                 style={{ fontSize: 12, color: G.accentText, marginTop: 8, cursor: "pointer" }}>
              Share: @{chat.public_username} (tap to copy)
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16 }}>
            <div>
              <div style={{ fontSize: 13.5 }}>Sign posts</div>
              <div style={{ fontSize: 11.5, color: G.muted }}>Show the admin's name on each post</div>
            </div>
            <Toggle on={signatureOn} onChange={async (value) => {
              setSignatureOn(value);
              try { await Chats.setChannelSignature(chat.id, value); logAdminAction(chat.id, me.name, "toggle_signature", value ? "enabled" : "disabled"); onChanged?.(); }
              catch (problem) { setSignatureOn(!value); toast(problem.message || "Could not update"); }
            }}/>
          </div>
        </div>
      )}

      {["group", "channel", "community"].includes(chat.type) && canManage && (
        <div style={{ padding: "14px 4px", borderTop: `1px solid ${G.border}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13.5 }}>Approve new members</div>
              <div style={{ fontSize: 11.5, color: G.muted }}>
                People must be approved before they can join
              </div>
            </div>
            <Toggle on={approvalOn} onChange={async (value) => {
              setApprovalOn(value);
              try { await Chats.setJoinApproval(chat.id, value); logAdminAction(chat.id, me.name, "toggle_approval", value ? "enabled" : "disabled"); onChanged?.(); }
              catch (problem) { setApprovalOn(!value); toast(problem.message || "Could not update"); }
            }}/>
          </div>

          {pendingReqs.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>
                Requests ({pendingReqs.length})
              </div>
              {pendingReqs.map((person) => (
                <div key={person.id} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "7px 4px",
                  borderBottom: `1px solid ${G.border}`,
                }}>
                  <Av av={person.avatar_letter} color={person.color} size={30}
                      photoId={person.avatar_attachment_id}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5 }}>{person.name}</div>
                    <div style={{ fontSize: 11, color: G.muted }}>@{person.username}</div>
                  </div>
                  <Button style={{ padding: "5px 12px", fontSize: 11 }} onClick={async () => {
                    try {
                      await Chats.approveJoinRequest(chat.id, person.id);
                      setPendingReqs((cur) => cur.filter((r) => r.id !== person.id));
                      reloadFull();
                    } catch (problem) { toast(problem.message || "Could not approve"); }
                  }}>Approve</Button>
                  <Button variant="ghost" style={{ padding: "5px 10px", fontSize: 11 }} onClick={async () => {
                    try {
                      await Chats.denyJoinRequest(chat.id, person.id);
                      setPendingReqs((cur) => cur.filter((r) => r.id !== person.id));
                    } catch (problem) { toast(problem.message || "Could not deny"); }
                  }}>Deny</Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {chat.type === "channel" && canManage && channelStats && (
          <div style={{ padding: "14px 4px", borderTop: `1px solid ${G.border}` }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>Channel analytics</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              {[
                { label: "Posts (loaded)", value: channelStats.total },
                { label: "Last 24h", value: channelStats.last24h },
                { label: "Last 7 days", value: channelStats.lastWeek },
                { label: "With media", value: channelStats.withMedia },
                { label: "With reactions", value: channelStats.withReactions },
                { label: "Total reactions", value: channelStats.totalReactions },
              ].map((s, i) => (
                <div key={i} style={{
                  padding: "8px 10px", borderRadius: 10, background: G.dim,
                  border: `1px solid ${G.border}`,
                }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: G.accentText }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: G.muted }}>{s.label}</div>
                </div>
              ))}
            </div>
            {channelStats.topPosters.length > 0 && (
              <div>
                <div style={{ fontSize: 12, color: G.sub, marginBottom: 4 }}>Top contributors</div>
                {channelStats.topPosters.map(([name, count], i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
                    <span>{name}</span>
                    <span style={{ color: G.muted }}>{count} posts</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 10.5, color: G.muted, marginTop: 6 }}>
              Based on the last {channelStats.total} loaded messages
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
              {chat.type === "channel" ? "Subscribers" : "Members"} {full ? `(${full.members.length})` : ""}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {myRole === "owner" && full && full.members.some((m) => m.role === "admin") && (
                <div onClick={() => setShowPermMatrix(true)} style={{ cursor: "pointer", fontSize: 11, fontWeight: 600, color: G.accentText }}>
                  Permissions
                </div>
              )}
              {canManage && (
                <div onClick={() => setShowAddMembers(true)} style={{ cursor: "pointer" }} title="Add members">
                  {I.plus(G.accentText, 16)}
                </div>
              )}
            </div>
          </div>

          {full && full.members.length > 6 && (
            <input value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)}
                   placeholder="Search members…" style={{
                     width: "100%", padding: "7px 10px", borderRadius: 10, marginBottom: 8,
                     background: G.dim, border: `1px solid ${G.border}`, color: G.text, fontSize: 12.5,
                   }}/>
          )}

          {!full && <Spinner small/>}
          {(() => {
            const matched = (full?.members || [])
              .filter((m) => m.name.toLowerCase().includes(memberQuery.toLowerCase()));
            const visible = matched.slice(0, membersShown);
            return <>{visible.map((member) => (
            <div key={member.id} style={{ borderBottom: `1px solid ${G.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 4px" }}>
                <Av av={member.avatar_letter} color={member.color} size={30} photoId={member.avatar_attachment_id}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>
                    {member.name}{member.id === me.id ? " (you)" : ""}
                  </div>
                  <div style={{ fontSize: 11, color: G.muted, textTransform: "capitalize" }}>
                    {member.role}
                    {member.role === "admin" && member.permissions
                      && member.permissions.length < ADMIN_PERMISSIONS.length
                      && ` · ${member.permissions.length} rights`}
                  </div>
                </div>

                {/* Only the owner grants/revokes admin. Nobody manages the owner
                    from here — that only changes by them leaving. */}
                {myRole === "owner" && member.role === "member" && member.id !== me.id && (
                  <Button variant="ghost" style={{ padding: "5px 10px", fontSize: 11 }}
                          onClick={() => openPermEditor(member)}>Make admin</Button>
                )}
                {myRole === "owner" && member.role === "admin" && (
                  <>
                    <Button variant="ghost" style={{ padding: "5px 8px", fontSize: 11 }}
                            onClick={() => openPermEditor(member)}>Rights</Button>
                    <Button variant="ghost" style={{ padding: "5px 8px", fontSize: 11 }}
                            onClick={() => setRole(member.id, "member")}>Remove admin</Button>
                  </>
                )}
                {myRole === "owner" && member.role !== "owner" && member.id !== me.id
                  && ["group", "community"].includes(chat.type) && (
                  <Button variant="ghost" style={{ padding: "5px 8px", fontSize: 11 }}
                          onClick={() => makeOwner(member)}>Make owner</Button>
                )}
                {canManage && member.role !== "owner" && member.id !== me.id &&
                 (myRole === "owner" || member.role !== "admin") && (
                  <Button variant="danger" style={{ padding: "5px 8px", fontSize: 11 }}
                          onClick={() => removeMember(member.id)}>Remove</Button>
                )}
              </div>

              {/* Granular admin-rights editor — owner picks exactly what this
                  admin may do (post / edit / delete / pin / add members). */}
              {permEditFor === member.id && (
                <div style={{ padding: "4px 4px 12px" }}>
                  {ADMIN_PERMISSIONS.map((perm) => (
                    <label key={perm} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "5px 2px",
                      fontSize: 12.5, cursor: "pointer",
                    }}>
                      <input type="checkbox" checked={permDraft.includes(perm)}
                             onChange={() => togglePerm(perm)}/>
                      {PERMISSION_LABELS[perm]}
                    </label>
                  ))}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Button style={{ flex: 1, padding: "6px", fontSize: 12 }}
                            onClick={() => setRole(member.id, "admin", permDraft)}>
                      Save rights
                    </Button>
                    <Button variant="ghost" style={{ flex: 1, padding: "6px", fontSize: 12 }}
                            onClick={() => setPermEditFor(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {matched.length > visible.length && (
            <div onClick={() => setMembersShown((n) => n + 100)} style={{
              textAlign: "center", padding: "10px 4px", fontSize: 12.5, fontWeight: 600,
              color: G.accentText, cursor: "pointer",
            }}>
              Show more ({matched.length - visible.length})
            </div>
          )}</>;
          })()}
        </div>
      )}

      {chat.type === "broadcast" && (
        <div style={{ padding: "12px 4px" }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: 8,
          }}>
            <div style={{ fontSize: 12, color: G.sub }}>
              Recipients {broadcastRecipients ? `(${broadcastRecipients.length})` : ""}
            </div>
            <div onClick={() => setShowAddBroadcast(true)} style={{ cursor: "pointer" }} title="Add recipients">
              {I.plus(G.accentText, 16)}
            </div>
          </div>
          {!broadcastRecipients && <Spinner small/>}
          {(broadcastRecipients || []).map((person) => (
            <div key={person.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "7px 4px",
              borderBottom: `1px solid ${G.border}`,
            }}>
              <Av av={person.avatar_letter} color={person.color} size={30} photoId={person.avatar_attachment_id}/>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>{person.name}</div>
              <Button variant="danger" style={{ padding: "5px 8px", fontSize: 11 }}
                      onClick={async () => {
                        try {
                          await Chats.removeBroadcastRecipient(chat.id, person.id);
                          setBroadcastRecipients((cur) => cur.filter((r) => r.id !== person.id));
                          toast("Recipient removed");
                        } catch (problem) {
                          toast(problem.message || "Could not remove recipient");
                        }
                      }}>Remove</Button>
            </div>
          ))}
          {broadcastRecipients?.length === 0 && (
            <div style={{ fontSize: 12.5, color: G.muted, padding: "6px 4px" }}>No recipients yet</div>
          )}
        </div>
      )}

      {showAddBroadcast && (
        <AddBroadcastRecipientsSheet chatId={chat.id}
          existingIds={(broadcastRecipients || []).map((r) => r.id)}
          onClose={() => setShowAddBroadcast(false)}
          onAdded={() => {
            setShowAddBroadcast(false);
            Chats.broadcastRecipients(chat.id).then(setBroadcastRecipients).catch(() => {});
          }}/>
      )}

      {["group", "channel", "community"].includes(chat.type) && canManage && (() => {
        const log = getAdminLog(chat.id);
        if (log.length === 0) return null;
        const ACTION_LABELS = {
          remove_member: "Removed member",
          promote_admin: "Promoted to admin",
          demote_admin: "Removed admin",
          transfer_ownership: "Transferred ownership to",
          toggle_reactions: "Reactions",
          toggle_admins_only_send: "Admin-only send",
          toggle_topics: "Topics",
          toggle_comments: "Comments",
          toggle_signature: "Sign posts",
          toggle_approval: "Join approval",
          toggle_spam_filter: "Spam filter",
          set_slow_mode: "Slow mode set to",
        };
        return (
          <div style={{ padding: "14px 4px", borderTop: `1px solid ${G.border}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Admin activity log</div>
              <span onClick={() => { clearAdminLog(chat.id); toast("Log cleared"); }}
                    style={{ fontSize: 11, color: G.muted, cursor: "pointer" }}>Clear</span>
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {log.slice(0, 50).map((entry, i) => (
                <div key={i} style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: `1px solid ${G.dim}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}>
                      <span style={{ fontWeight: 600 }}>{entry.actor}</span>{" "}
                      {ACTION_LABELS[entry.action] || entry.action}
                      {entry.detail ? ` ${entry.detail}` : ""}
                    </div>
                    <div style={{ fontSize: 10.5, color: G.muted }}>
                      {new Date(entry.ts).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {chat.type !== "saved" && chat.type !== "dm" && chat.type !== "broadcast" && (
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

      {toneSheet && (
        <ToneSheet current={notifyTone} onClose={() => setToneSheet(false)}
                   onPicked={async (tone) => {
                     setNotifyTone(tone);
                     setToneSheet(false);
                     await Chats.settings(chat.id, { notify_tone: tone });
                   }}/>
      )}

      {labelSheet && (
        <LabelSheet chatId={chat.id} applied={chatLabels} toast={toast}
                    onClose={() => setLabelSheet(false)}
                    onSaved={(labels) => { setChatLabels(labels); setLabelSheet(false); onChanged?.(); }}/>
      )}

      {mediaSheet && (
        <MediaGallerySheet chatId={chat.id} onClose={() => setMediaSheet(false)}/>
      )}

      {inviteSheet && (
        <InviteLinkSheet chat={chat} toast={toast} onClose={() => setInviteSheet(false)}/>
      )}

      {showPermMatrix && full && (
        <PermissionMatrixSheet
          members={full.members.filter((m) => m.role === "admin" || m.role === "owner")}
          onClose={() => setShowPermMatrix(false)}
          onToggle={async (memberId, perm, currentPerms) => {
            const next = currentPerms.includes(perm) ? currentPerms.filter((p) => p !== perm) : [...currentPerms, perm];
            try {
              await Chats.setMemberRole(chat.id, memberId, "admin", next);
              reloadFull();
            } catch (problem) { toast(problem.message || "Could not update permission"); }
          }}
        />
      )}
    </Sheet>
  );
}

function PermissionMatrixSheet({ members, onClose, onToggle }) {
  return (
    <Sheet title="Permission Matrix" onClose={onClose}>
      <div style={{ overflowX: "auto", paddingBottom: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${G.border}`, position: "sticky", left: 0, background: G.bg, zIndex: 1, minWidth: 100 }}>
                Member
              </th>
              {ADMIN_PERMISSIONS.map((perm) => (
                <th key={perm} style={{ textAlign: "center", padding: "6px 4px", borderBottom: `1px solid ${G.border}`, fontSize: 11, whiteSpace: "nowrap" }}>
                  {PERMISSION_LABELS[perm]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const perms = member.role === "owner" ? ADMIN_PERMISSIONS : (member.permissions || ADMIN_PERMISSIONS);
              return (
                <tr key={member.id}>
                  <td style={{ padding: "7px 8px", borderBottom: `1px solid ${G.border}`, position: "sticky", left: 0, background: G.bg, zIndex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Av av={member.avatar_letter} color={member.color} size={22} photoId={member.avatar_attachment_id}/>
                      <div>
                        <div style={{ fontSize: 12.5, lineHeight: 1.2 }}>{member.name}</div>
                        <div style={{ fontSize: 10, color: G.muted, textTransform: "capitalize" }}>{member.role}</div>
                      </div>
                    </div>
                  </td>
                  {ADMIN_PERMISSIONS.map((perm) => {
                    const has = perms.includes(perm);
                    const isOwner = member.role === "owner";
                    return (
                      <td key={perm} style={{ textAlign: "center", padding: "7px 4px", borderBottom: `1px solid ${G.border}` }}>
                        <div
                          onClick={isOwner ? undefined : () => onToggle(member.id, perm, perms)}
                          style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            width: 24, height: 24, borderRadius: 6,
                            background: has ? "#22c55e22" : "#ef444422",
                            cursor: isOwner ? "default" : "pointer",
                            opacity: isOwner ? 0.6 : 1,
                          }}
                          title={isOwner ? "Owner has all permissions" : `Toggle ${PERMISSION_LABELS[perm]}`}
                        >
                          {has ? I.check("#22c55e", 14) : I.close("#ef4444", 14)}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}

const MUTE_CHOICES = [
  { label: "8 hours", seconds: 8 * 3600 },
  { label: "1 week", seconds: 7 * 24 * 3600 },
  { label: "Always", seconds: 100 * 365 * 24 * 3600 },
];

export function muteLabel(mutedUntil) {
  const secondsLeft = mutedUntil - Date.now() / 1000;
  if (secondsLeft > 50 * 365 * 24 * 3600) return "Muted";
  if (secondsLeft > 24 * 3600) return `Muted for ${Math.round(secondsLeft / (24 * 3600))}d`;
  return `Muted for ${Math.round(secondsLeft / 3600)}h`;
}

const TONE_LABELS = { default: "Default", chime: "Chime", pop: "Pop", marimba: "Marimba", none: "Silent" };

function ToneSheet({ current, onClose, onPicked }) {
  return (
    <Sheet title="Notification sound" onClose={onClose}>
      {TONE_OPTIONS.map((tone) => (
        <div key={tone}
             onClick={() => { if (tone !== "none") playNotifyTone(tone); onPicked(tone); }}
             style={{
               display: "flex", alignItems: "center", justifyContent: "space-between",
               padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
               background: G.dim, border: `1px solid ${tone === current ? G.accent : G.border}`,
               fontSize: 14,
             }}>
          {TONE_LABELS[tone]}
          {tone === current && I.check(G.accent, 16)}
        </div>
      ))}
    </Sheet>
  );
}

/** Telegram-style Topics chip strip: "All", "General", then each open topic. */
function TopicStrip({ topics, activeTopicId, onSelect, onCreated, chatId, toast }) {
  const [topicPrompt, topicModal] = usePrompt();
  const open = topics.filter((t) => !t.closed_at);
  async function newTopic() {
    const name = ((await topicPrompt("New topic name")) || "").trim();
    if (!name) return;
    try {
      const topic = await Chats.createTopic(chatId, name);
      onCreated(topic);
      onSelect(topic.id);
    } catch (problem) {
      toast?.(problem.message || "Could not create topic");
    }
  }
  const chips = [
    { id: "all", label: "All" },
    { id: "general", label: "General" },
    ...open.map((t) => ({ id: t.id, label: t.name })),
  ];
  return (
    <div style={{
      display: "flex", gap: 6, padding: "8px 12px", overflowX: "auto",
      borderBottom: `1px solid ${G.border}`, flexShrink: 0,
    }}>
      {chips.map((chip) => (
        <div key={chip.id} onClick={() => onSelect(chip.id)} style={{
          padding: "6px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 600,
          whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0,
          border: `1px solid ${activeTopicId === chip.id ? G.accent : G.border}`,
          background: activeTopicId === chip.id ? G.accentSoft : "transparent",
          color: activeTopicId === chip.id ? G.accentText : G.sub,
        }}>{chip.label}</div>
      ))}
      <div onClick={newTopic} style={{
        padding: "6px 12px", borderRadius: 16, fontSize: 12.5, fontWeight: 600,
        whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0,
        border: `1px dashed ${G.border}`, color: G.muted,
      }}>+ Topic</div>
      {topicModal}
    </div>
  );
}

const LABEL_COLORS = ["#22c55e", "#f59e0b", "#ef4444", "#6366f1", "#06b6d4", "#ec4899"];

/**
 * WhatsApp-Business-style chat labels — a personal taxonomy (Me.labels)
 * applied to any number of chats, many-per-chat. Only the account that set
 * them ever sees them; the other side of the chat has no idea.
 */
function LabelSheet({ chatId, applied, onClose, onSaved, toast }) {
  const [all, setAll] = useState(null);
  const [selected, setSelected] = useState(new Set(applied.map((l) => l.id)));
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => { Me.labels().then(setAll).catch(() => setAll([])); }, []);

  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function createLabel() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const color = LABEL_COLORS[(all?.length || 0) % LABEL_COLORS.length];
      const label = await Me.createLabel(name, color);
      setAll((current) => [...(current || []), label]);
      setSelected((current) => new Set(current).add(label.id));
      setNewName("");
    } catch (problem) {
      toast?.(problem.message || "Could not create label");
    } finally {
      setCreating(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const labelIds = [...selected];
      await Chats.setLabels(chatId, labelIds);
      onSaved((all || []).filter((l) => selected.has(l.id)));
    } catch (problem) {
      toast?.(problem.message || "Could not save labels");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet title="Labels" onClose={onClose}>
      {all === null ? <Spinner small/> : (
        <>
          {all.length === 0 && (
            <div style={{ fontSize: 13, color: G.muted, padding: "4px 0 12px" }}>
              No labels yet — create your first one below.
            </div>
          )}
          {all.map((label) => (
            <label key={label.id} onClick={(e) => e.stopPropagation()} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", cursor: "pointer",
            }}>
              <input type="checkbox" checked={selected.has(label.id)} onChange={() => toggle(label.id)}/>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: label.color }}/>
              <span style={{ fontSize: 14 }}>{label.name}</span>
            </label>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
                   placeholder="New label name" maxLength={40}
                   onKeyDown={(e) => { if (e.key === "Enter") createLabel(); }}
                   style={{
                     flex: 1, padding: "9px 12px", borderRadius: 10, border: `1px solid ${G.border}`,
                     background: G.dim, color: G.text, fontSize: 13.5,
                   }}/>
            <Button variant="ghost" onClick={createLabel} disabled={!newName.trim() || creating}>+ Add</Button>
          </div>
          <Button onClick={save} disabled={saving} style={{ width: "100%", marginTop: 14 }}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      )}
    </Sheet>
  );
}

function ProductPickerSheet({ onClose, onPick }) {
  const [products, setProducts] = useState(null);

  useEffect(() => { Products.mine().then(setProducts).catch(() => setProducts([])); }, []);

  return (
    <Sheet title="Share a product" onClose={onClose}>
      {products === null ? <Spinner small/> : products.length === 0 ? (
        <div style={{ fontSize: 13, color: G.muted, padding: "10px 0" }}>
          No products in your catalog yet — add one from Settings &gt; Business &amp; Automation.
        </div>
      ) : products.map((product) => (
        <div key={product.id} onClick={() => onPick(product)} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", cursor: "pointer",
          borderBottom: `1px solid ${G.border}`,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 8, background: G.dim, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>{I.tag(G.sub, 18)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{product.name}</div>
            <div style={{ fontSize: 12.5, color: G.muted }}>₹{(product.price_cents / 100).toFixed(2)}</div>
          </div>
        </div>
      ))}
    </Sheet>
  );
}

export function MuteSheet({ mutedUntil, onClose, onPicked }) {
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
    return <img src={blobUrl} alt={message.text || "Photo"} onClick={onOpen}
                style={{ ...boxStyle, cursor: onOpen ? "pointer" : "default" }}/>;
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
        <img src={blobUrl} alt={current.text || "Photo"} onClick={(e) => e.stopPropagation()}
             style={{ maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain" }}/>
      )}
    </div>
  );
}

// A round icon button for the lightbox top bar.
function LbIconBtn({ onClick, title, children }) {
  return (
    <div onClick={onClick} title={title} style={{
      width: 38, height: 38, borderRadius: "50%", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "#ffffff14", color: "#fff", fontSize: 20, lineHeight: 1, userSelect: "none",
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "#ffffff2a"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "#ffffff14"; }}>
      {children}
    </div>
  );
}

// One thumbnail in the lightbox's bottom strip. Fetches its own (cached) blob
// so the strip fills in progressively rather than blocking on all of them.
function LightboxThumb({ item, active, onClick }) {
  const [url, setUrl] = useState(null);
  const attachmentId = item?.payload?.attachment_id;
  useEffect(() => {
    if (!attachmentId) return;
    let cancelled = false;
    let objectUrl = null;
    Uploads.fetchBlobUrl(attachmentId, { cache: true })
      .then((u) => { if (cancelled) { URL.revokeObjectURL(u); return; } objectUrl = u; setUrl(u); })
      .catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachmentId]);
  return (
    <div onClick={onClick} style={{
      width: 52, height: 52, flexShrink: 0, borderRadius: 8, overflow: "hidden", cursor: "pointer",
      border: `2px solid ${active ? G.accent : "transparent"}`, background: "#222", position: "relative",
    }}>
      {url && <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>}
      {item.kind === "video" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#0004" }}>
          {I.play("#fff", 16)}
        </div>
      )}
    </div>
  );
}

/**
 * WhatsApp-style full-screen media viewer for a whole chat's photos/videos:
 * a top bar (sender + time + zoom / edit / forward / download / close),
 * prev/next navigation, wheel- and button-zoom with drag-to-pan, and a bottom
 * thumbnail strip of every image/video in the conversation. Opened from a
 * bubble tap (ChatView lifts the media list up so navigation spans the whole
 * chat, not just the one photo).
 */
function ChatMediaLightbox({ items, index, onIndexChange, onClose, me, members, onForward, toast }) {
  const current = items[index];
  const [blobUrl, setBlobUrl] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState(false);
  const [editFile, setEditFile] = useState(null);
  const dragRef = useRef(null);
  const attachmentId = current?.payload?.attachment_id;
  const isVideo = current?.kind === "video";

  useEffect(() => {
    setBlobUrl(null);
    if (!attachmentId) return;
    let cancelled = false;
    let objectUrl = null;
    Uploads.fetchBlobUrl(attachmentId, { cache: true })
      .then((u) => { if (cancelled) { URL.revokeObjectURL(u); return; } objectUrl = u; setBlobUrl(u); })
      .catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachmentId]);

  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [index]);

  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      if (event.key === "ArrowRight" && index < items.length - 1) onIndexChange(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndexChange, onClose]);

  // Resolve the sender from the roster (or `me`) so their real profile PHOTO
  // shows in the viewer header — the raw message rarely carries the avatar id.
  const senderPerson = !current ? null
    : current.sender_id === me.id ? me
    : members.find((m) => m.id === current.sender_id) || null;
  const senderName = !current ? "" : current.sender_id === me.id
    ? "You"
    : (senderPerson?.name || current.sender_name || "");
  const senderPhoto = senderPerson?.avatar_attachment_id || current?.sender_avatar_attachment_id;
  const senderColor = senderPerson?.color || current?.sender_color || G.accent;
  const senderLetter = senderPerson?.avatar_letter || (senderName || "?")[0];

  function download() {
    if (!blobUrl) return;
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = current.payload?.file_name || (isVideo ? "video.mp4" : "photo.jpg");
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function openEditor() {
    if (!blobUrl) return;
    try {
      const blob = await (await fetch(blobUrl)).blob();
      setEditFile(new File([blob], current.payload?.file_name || "photo.jpg", { type: blob.type || "image/jpeg" }));
      setEditing(true);
    } catch { toast && toast("Could not open the editor"); }
  }

  function saveEdited(edited) {
    setEditing(false);
    const url = URL.createObjectURL(edited);
    const link = document.createElement("a");
    link.href = url;
    link.download = edited.name || "edited.jpg";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast && toast("Saved edited photo");
  }

  function onWheel(event) {
    if (isVideo) return;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((z) => Math.min(6, Math.max(1, z * factor)));
  }
  function onImgPointerDown(event) {
    // Zoomed in → drag to pan. At normal zoom → arm a horizontal swipe that
    // flips to the previous/next media (WhatsApp-style).
    dragRef.current = { x: event.clientX, y: event.clientY, pan, swipe: zoom <= 1 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onImgPointerMove(event) {
    if (!dragRef.current || dragRef.current.swipe) return;
    setPan({ x: dragRef.current.pan.x + (event.clientX - dragRef.current.x), y: dragRef.current.pan.y + (event.clientY - dragRef.current.y) });
  }
  function onImgPointerUp(event) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.swipe) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0 && index > 0) onIndexChange(index - 1);
        else if (dx < 0 && index < items.length - 1) onIndexChange(index + 1);
      }
    }
  }

  if (editing && editFile) {
    return <Suspense fallback={null}><PhotoEditor file={editFile} onCancel={() => setEditing(false)} onDone={saveEdited}/></Suspense>;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b0b0b", zIndex: 1250, display: "flex", flexDirection: "column" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, color: "#fff" }}>
          {current && (
            <Av av={senderLetter} color={senderColor} size={36} photoId={senderPhoto}/>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {senderName || "Media"}
            </div>
            <div style={{ fontSize: 12, color: "#ffffff99" }}>{current ? whenLabel(current.created_at) : ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {!isVideo && <LbIconBtn onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2)))} title="Zoom out">−</LbIconBtn>}
          {!isVideo && <LbIconBtn onClick={() => setZoom((z) => Math.min(6, +(z + 0.5).toFixed(2)))} title="Zoom in">+</LbIconBtn>}
          {!isVideo && <LbIconBtn onClick={openEditor} title="Edit">{I.edit("#fff", 18)}</LbIconBtn>}
          {onForward && current && <LbIconBtn onClick={() => { onForward(current); onClose(); }} title="Forward">{I.fwd("#fff", 18)}</LbIconBtn>}
          <LbIconBtn onClick={download} title="Download">{I.download("#fff", 18)}</LbIconBtn>
          <LbIconBtn onClick={onClose} title="Close">×</LbIconBtn>
        </div>
      </div>

      {/* Stage */}
      <div onWheel={onWheel} style={{
        flex: 1, minHeight: 0, position: "relative", display: "flex",
        alignItems: "center", justifyContent: "center", overflow: "hidden",
      }}>
        {index > 0 && (
          <div onClick={() => onIndexChange(index - 1)} style={{
            position: "absolute", left: 10, zIndex: 2, cursor: "pointer", color: "#fff",
            width: 44, height: 44, borderRadius: "50%", background: "#ffffff1a",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, userSelect: "none",
          }}>‹</div>
        )}
        {index < items.length - 1 && (
          <div onClick={() => onIndexChange(index + 1)} style={{
            position: "absolute", right: 10, zIndex: 2, cursor: "pointer", color: "#fff",
            width: 44, height: 44, borderRadius: "50%", background: "#ffffff1a",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, userSelect: "none",
          }}>›</div>
        )}

        {!blobUrl ? (
          <Spinner/>
        ) : isVideo ? (
          <video src={blobUrl} controls autoPlay style={{ maxWidth: "94vw", maxHeight: "100%" }}/>
        ) : (
          <img src={blobUrl} alt={current.text || "Photo"} draggable={false}
               onPointerDown={onImgPointerDown} onPointerMove={onImgPointerMove}
               onPointerUp={onImgPointerUp} onPointerCancel={onImgPointerUp}
               style={{
                 maxWidth: "96vw", maxHeight: "100%", objectFit: "contain",
                 transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                 transition: dragRef.current ? "none" : "transform 0.12s ease-out",
                 cursor: zoom > 1 ? "grab" : "default", touchAction: "none",
               }}/>
        )}
      </div>

      {/* Thumbnail strip */}
      {items.length > 1 && (
        <div style={{
          display: "flex", gap: 6, padding: "10px 12px", overflowX: "auto", flexShrink: 0,
          justifyContent: items.length > 6 ? "flex-start" : "center", background: "#000",
        }}>
          {items.map((it, i) => (
            <LightboxThumb key={it.id || i} item={it} active={i === index} onClick={() => onIndexChange(i)}/>
          ))}
        </div>
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

  // A full shareable URL (App.jsx auto-joins on ?invite=<code>), not just the
  // bare code — this is what the link button and the QR both point at.
  const link = code ? `https://web.talkex.in/?invite=${code}` : "";

  function copy() {
    navigator.clipboard?.writeText(link);
    toast("Link copied");
  }

  async function share() {
    if (navigator.share) {
      try { await navigator.share({ title: chat.name || "Join on TalkEx", url: link }); } catch { /* cancelled */ }
    } else { copy(); }
  }

  return (
    <Sheet title="Invite link" onClose={onClose}>
      {code ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            <Suspense fallback={null}><QrView value={link} size={190}/></Suspense>
          </div>
          <div style={{
            padding: "12px 14px", borderRadius: 12, background: G.dim,
            border: `1px solid ${G.border}`, fontSize: 12.5,
            wordBreak: "break-all", marginBottom: 12, color: G.text,
          }}>{link}</div>
          <div style={{ fontSize: 12, color: G.muted, marginBottom: 14 }}>
            Anyone who opens this link (or scans the QR) can join — no invitation needed.
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <Button onClick={share} style={{ flex: 1 }}>Share link</Button>
            <Button variant="ghost" onClick={copy} style={{ flex: 1 }}>Copy</Button>
            <Button variant="ghost" onClick={generate} disabled={busy} style={{ flex: 1 }}>Rotate</Button>
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

const FOLDER_PRESETS = ["", "Work", "Family", "Friends"];

export function FolderSheet({ current, onClose, onPicked }) {
  const [custom, setCustom] = useState(FOLDER_PRESETS.includes(current) ? "" : current);

  return (
    <Sheet title="Add to list" onClose={onClose}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {FOLDER_PRESETS.map((option) => (
          <button key={option || "none"} onClick={() => onPicked(option)}
            style={{
              padding: "8px 16px", borderRadius: 20, cursor: "pointer",
              border: `1px solid ${current === option ? G.accent : G.border}`,
              background: current === option ? G.accentSoft : "transparent",
              color: current === option ? G.accentText : G.sub, fontSize: 13,
            }}>{option || "None"}</button>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 6 }}>Or a custom list name</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={custom} onChange={(event) => setCustom(event.target.value.slice(0, 32))}
               placeholder="e.g. Clients" style={{
                 flex: 1, padding: "11px 13px", borderRadius: 10, border: `1px solid ${G.border}`,
                 background: G.dim, color: G.text, fontSize: 14, boxSizing: "border-box",
               }}/>
        <Button onClick={() => custom.trim() && onPicked(custom.trim())} disabled={!custom.trim()}>Save</Button>
      </div>
    </Sheet>
  );
}

const REPORT_REASONS = [
  "Spam", "Scam or fraud", "Inappropriate content", "Harassment or abuse", "Something else",
];

function ReportSheet({ onClose, onSubmit }) {
  return (
    <Sheet title="Report" onClose={onClose}>
      <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
        This is sent to us for review — the other person is never told you reported them.
      </div>
      {REPORT_REASONS.map((reason) => (
        <div key={reason} onClick={() => onSubmit(reason)} style={{
          padding: "13px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
          background: G.dim, border: `1px solid ${G.border}`, fontSize: 14,
        }}>{reason}</div>
      ))}
    </Sheet>
  );
}

export function LockSheet({ chatId, mode, onClose, onDone, toast }) {
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
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  // GET /users no longer hands back the whole directory for an empty/1-char
  // query (see list_users in main.py) — it's a real name/username search
  // now, not a dump, so this needs a search box the same way Discover's
  // people tab does, rather than fetching once on mount.
  useEffect(() => {
    if (query.trim().length < 2) { setPeople([]); return; }
    let cancelled = false;
    setLoading(true);
    Users.list(query).then((result) => { if (!cancelled) setPeople(result); })
      .catch(() => {}).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query]);

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
      <Field value={query} onChange={(event) => setQuery(event.target.value)}
             placeholder="Search by name or username…" style={{ marginBottom: 12 }} autoFocus/>
      {loading ? <Spinner small/> : (
        <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 14 }}>
          {!query.trim() && (
            <div style={{ fontSize: 13, color: G.muted }}>Search for people to add.</div>
          )}
          {query.trim() && candidates.length === 0 && (
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

function AddBroadcastRecipientsSheet({ chatId, existingIds, onClose, onAdded }) {
  const [people, setPeople] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) { setPeople([]); return; }
    let cancelled = false;
    setLoading(true);
    Users.list(query).then((result) => { if (!cancelled) setPeople(result); })
      .catch(() => {}).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query]);

  const candidates = people.filter((person) => !existingIds.includes(person.id));

  function toggle(userId) {
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  async function save() {
    if (!selected.length) return;
    setBusy(true);
    try {
      await Chats.addBroadcastRecipients(chatId, selected);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add recipients" onClose={onClose}>
      <Field value={query} onChange={(event) => setQuery(event.target.value)}
             placeholder="Search by name or username…" style={{ marginBottom: 12 }} autoFocus/>
      {loading ? <Spinner small/> : (
        <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 14 }}>
          {!query.trim() && (
            <div style={{ fontSize: 13, color: G.muted }}>Search for people to add.</div>
          )}
          {query.trim() && candidates.length === 0 && (
            <div style={{ fontSize: 13, color: G.muted }}>Everyone found is already a recipient.</div>
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
