// Client-side spam detection — flags suspicious messages before they're
// rendered. Not a replacement for server-side moderation, but catches
// obvious spam patterns (floods, repeated text, link-heavy messages)
// and lets group admins act quickly.

const recentMessages = new Map();
const WINDOW_MS = 10000;
const MAX_IN_WINDOW = 8;
const LINK_PATTERN = /https?:\/\/\S+/gi;
const MAX_LINKS = 5;
const REPEAT_THRESHOLD = 3;

// checkSpam is called straight from Bubble's render body (see ChatView.jsx),
// which fires on every re-render of that message — a typing indicator, a
// read receipt, another message arriving nearby, anything that re-renders
// the list. Without this cache, pushing into `history` on every one of
// those calls meant a single "Hi" sent once could rack up 3+ "duplicate"
// entries purely from re-renders and get flagged as a repeat before the
// person had sent it more than once — the flood/repeat counters need to
// advance once per REAL message, not once per render. Capped so a very
// long-lived session doesn't grow this without bound.
const resultCache = new Map(); // message.id -> spam result (or null)
const RESULT_CACHE_MAX = 2000;

export function checkSpam(message, senderId) {
  if (!message?.text || !senderId) return null;

  const cacheKey = message.id ?? message.client_msg_id;
  if (cacheKey != null && resultCache.has(cacheKey)) {
    return resultCache.get(cacheKey);
  }

  // The message's OWN timestamp, not Date.now() at the moment this runs.
  // This used to stamp every entry with "right now" regardless of when the
  // message was actually sent — harmless for a message that just arrived
  // live, but opening a chat renders its whole loaded history in one burst,
  // and every one of THOSE messages got stamped with the same "now" too.
  // Any chat where one person had sent 8+ messages ANY TIME in its history
  // (yesterday, last month, whenever) looked exactly like 8 messages that
  // all just landed in the same second — a guaranteed false "flood", and
  // three same-text messages sent hours apart a guaranteed false "repeat".
  // created_at is server epoch SECONDS (messages.created_at in db.py) —
  // scaled to ms to compare against WINDOW_MS.
  const ts = message.created_at != null ? message.created_at * 1000 : Date.now();
  const text = message.text;
  const key = senderId;

  if (!recentMessages.has(key)) recentMessages.set(key, []);
  const history = recentMessages.get(key);
  history.push({ text, ts });
  // History can arrive out of chronological order (older messages loading
  // in after newer ones already rendered, e.g. scrolling up) — sorting
  // before trimming keeps the window correct regardless of render order.
  history.sort((a, b) => a.ts - b.ts);

  // Trimmed relative to the NEWEST timestamp seen for this sender so far,
  // not this specific message's ts — so a burst of old history rendering
  // in after a genuinely recent message doesn't get sliced away before the
  // recent-window checks below can see it.
  const latestTs = history[history.length - 1].ts;
  while (history.length > 0 && latestTs - history[0].ts > WINDOW_MS) history.shift();

  let result = null;
  if (history.length > MAX_IN_WINDOW) {
    result = { reason: "flood", label: "Flood detected — too many messages in a short time" };
  } else {
    const duplicates = history.filter((h) => h.text === text).length;
    if (duplicates >= REPEAT_THRESHOLD) {
      result = { reason: "repeat", label: "Repeated message detected" };
    } else {
      const links = text.match(LINK_PATTERN);
      if (links && links.length > MAX_LINKS) {
        result = { reason: "links", label: `Message contains ${links.length} links` };
      } else if (text.length > 3 && /^(.)\1{20,}$/.test(text)) {
        result = { reason: "gibberish", label: "Looks like gibberish / character spam" };
      }
    }
  }

  if (cacheKey != null) {
    if (resultCache.size >= RESULT_CACHE_MAX) {
      resultCache.delete(resultCache.keys().next().value); // evict oldest
    }
    resultCache.set(cacheKey, result);
  }
  return result;
}

export function getSpamSettings() {
  try { return JSON.parse(localStorage.getItem("talkex_spam_filter") || '{"enabled":true}'); }
  catch { return { enabled: true }; }
}

export function setSpamSettings(settings) {
  localStorage.setItem("talkex_spam_filter", JSON.stringify(settings));
}

export function clearHistory() {
  recentMessages.clear();
}
