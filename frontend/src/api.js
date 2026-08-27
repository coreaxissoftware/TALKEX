// TalkEx API client.
//
// Three things here are what make the app feel fast and behave on a bad
// connection. They are worth understanding before changing anything:
//
//   One socket.      The old client opened a WebSocket per chat and threw it
//                    away on every chat switch. This one opens a single
//                    authenticated socket and keeps it, so switching chats is
//                    instant and you keep receiving from every conversation.
//
//   Catch-up.        Every chat has a gapless sequence number. After a
//                    reconnect the client asks for everything after the highest
//                    seq it holds, instead of refetching whole conversations.
//
//   Outbox.          A send that fails is kept and retried. Each one carries a
//                    client_msg_id that the server de-duplicates on, so a retry
//                    can never post the same message twice — which is what
//                    makes retrying safe enough to do automatically.

import * as offlineDb from "./offlineDb.js";

const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const WS_BASE = BASE.replace(/^http/, "ws");

let token = localStorage.getItem("ht_token") || "";

export const setToken = (value) => {
  token = value;
  localStorage.setItem("ht_token", value);
};

export const clearToken = () => {
  token = "";
  localStorage.removeItem("ht_token");
  offlineDb.clearCachedProfile();
};

export const getToken = () => token;

// ── Invite referral (?ref=<username>) ─────────────────────────────────────────
//
// Someone opening an invite link lands here logged-out and then walks through
// register/OTP — by the time they submit, the URL has usually been cleaned up
// (see the ?ref handler in App.jsx). So we capture the referrer's username ONCE
// at load, before anything touches the URL, and stash it. It's read back into
// the registration payload and cleared the moment an account is created, so it
// only ever credits the very first signup on this device — never a later one.
const REF_KEY = "talkex_ref";
const REF_DM_KEY = "talkex_ref_dm";
(function captureReferral() {
  try {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get("ref");
    if (!ref) return;
    const clean = ref.slice(0, 32);
    localStorage.setItem(REF_KEY, clean);
    localStorage.setItem(REF_DM_KEY, clean);
    url.searchParams.delete("ref");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch { /* no URL / storage — nothing to capture */ }
})();
export const storedReferral = () => {
  try { return localStorage.getItem(REF_KEY) || undefined; } catch { return undefined; }
};
export const clearStoredReferral = () => {
  try { localStorage.removeItem(REF_KEY); } catch { /* ignore */ }
};
export const storedRefDm = () => {
  try { return localStorage.getItem(REF_DM_KEY) || undefined; } catch { return undefined; }
};
export const clearRefDm = () => {
  try { localStorage.removeItem(REF_DM_KEY); } catch { /* ignore */ }
};

const PHONE_LINK_KEY = "talkex_phone_link";
const PHONE_TEXT_KEY = "talkex_phone_text";
(function capturePhoneLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    let phone = null;
    let text = params.get("text");
    const path = window.location.pathname.replace(/^\/+/, "");
    if (path && /^\+?\d[\d\s-]{5,}$/.test(path)) {
      phone = path.replace(/[\s-]/g, "");
    }
    if (!phone && params.get("phone")) {
      phone = params.get("phone").replace(/[^\d+]/g, "");
    }
    if (!phone || phone.replace(/\D/g, "").length < 6) return;
    localStorage.setItem(PHONE_LINK_KEY, phone);
    if (text) localStorage.setItem(PHONE_TEXT_KEY, text.slice(0, 1000));
  } catch { /* ignore */ }
})();
export const storedPhoneLink = () => {
  try { return localStorage.getItem(PHONE_LINK_KEY) || undefined; } catch { return undefined; }
};
export const storedPhoneText = () => {
  try { return localStorage.getItem(PHONE_TEXT_KEY) || undefined; } catch { return undefined; }
};
export const clearPhoneLink = () => {
  try { localStorage.removeItem(PHONE_LINK_KEY); localStorage.removeItem(PHONE_TEXT_KEY); } catch { /* ignore */ }
};
export const publicProfileByPhone = (phone) =>
  fetch(BASE + `/api/public/profile/${encodeURIComponent(phone)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

// ── Saved accounts (quick account switching) ──────────────────────────────────
// A directory of accounts this browser has signed into before, alongside
// (not instead of) the single active `ht_token` above — switching just swaps
// which one that is and reloads, the same way Slack/Discord's "workspaces"
// are really just one active session at a time in a single tab, not several
// live at once. Session tokens are stored the same way `ht_token` itself
// already is, so this adds no new class of exposure beyond what a stolen
// browser profile already meant.
const ACCOUNTS_KEY = "ht_accounts";

function readSavedAccounts() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeSavedAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function listSavedAccounts() {
  return readSavedAccounts();
}

export function rememberAccount(user, accountToken) {
  const accounts = readSavedAccounts().filter((account) => account.userId !== user.id);
  accounts.push({
    userId: user.id, name: user.name, username: user.username,
    avatarLetter: user.avatar_letter, color: user.color, token: accountToken,
  });
  writeSavedAccounts(accounts);
}

export function forgetAccount(userId) {
  writeSavedAccounts(readSavedAccounts().filter((account) => account.userId !== userId));
}

// Reloads the page on purpose — swapping every piece of live state this app
// holds (chats, the realtime socket, offline cache) by hand invites exactly
// the kind of half-migrated state a fresh load already avoids for free.
export function switchToAccount(userId) {
  const account = readSavedAccounts().find((candidate) => candidate.userId === userId);
  if (!account) return;
  setToken(account.token);
  window.location.reload();
}

// Thrown for any non-2xx response, carrying the status so callers can tell a
// 401 (log back in) from a 404 (it is gone) from a 500 (retry later).
export class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `Request failed with ${status}`);
    this.status = status;
  }
}

async function request(method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new ApiError(response.status, problem.detail);
  }

  // 204s and empty bodies would otherwise blow up on .json().
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const get = (path) => request("GET", path);
const post = (path, body) => request("POST", path, body);
const patch = (path, body) => request("PATCH", path, body);
const put = (path, body) => request("PUT", path, body);
const remove = (path, body) => request("DELETE", path, body);

// ── Auth ─────────────────────────────────────────────────────────────────────

// A stable, readable label for "which device is this" — shown in the linked
// devices list and offered (not forced) as the label when linking a new one.
// Not a fingerprinting mechanism, just a hint a human can recognise.
export function guessDeviceLabel() {
  const ua = navigator.userAgent;
  const platform = /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac/.test(ua) ? "Mac"
    : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${platform}`;
}

export const Auth = {
  register: (details) => post("/auth/register", { ...details, ref: storedReferral(), device_label: guessDeviceLabel() }),
  // Returns either {token, user} directly, or {requires_pin: true, pending_token}
  // when the account has two-step verification on — the caller has to check
  // which shape came back before treating this as a completed sign-in.
  login: (credentials) => post("/auth/login", { ...credentials, device_label: guessDeviceLabel() }),
  verifyTwoStepPin: (pendingToken, pin) =>
    post("/auth/login/verify-pin", { pending_token: pendingToken, pin }),
  logout: () => post("/auth/logout"),

  // Linked devices (WhatsApp-Web-style sign-in).
  //
  // startLink/pollLink run WITHOUT a token — this device does not have one
  // yet, that is the entire point. approveLink/denyLink run on the device
  // that is already signed in.
  startLink: () => post("/auth/link/start", { device_label: guessDeviceLabel() }),
  pollLink: (code) => get(`/auth/link/${code}/poll`),
  linkInfo: (code) => get(`/auth/link/${code}/info`),
  approveLink: (code) => post(`/auth/link/${code}/approve`),
  denyLink: (code) => post(`/auth/link/${code}/deny`),

  // WhatsApp-style phone sign-in: request a code, then verify it. Verifying
  // either logs an existing number in or (name required) creates a new
  // account — the server decides which based on whether the number's seen.
  requestPhoneOtp: (phone) => post("/auth/phone/request-otp", { phone }),
  verifyPhoneOtp: (phone, code, name) =>
    post("/auth/phone/verify-otp", { phone, code, name, ref: storedReferral(), device_label: guessDeviceLabel() }),

  // A one-time, ~30-second ticket for opening the WebSocket. The socket
  // handshake can't send a custom Authorization header, so without this the
  // only way to authenticate it is putting the real session token in the
  // connection URL — which reverse proxies/CDNs/browser history routinely
  // log, live for up to 30 days. This gets minted fresh (over a normal,
  // header-authenticated request) right before each connect instead.
  wsTicket: () => post("/auth/ws-ticket"),
};

export const Me = {
  // Cached on every successful read/write so App.jsx has something to show
  // when a cold, offline load can't reach the server at all — see the
  // session-check effect there for how a network failure differs from a
  // real 401 (only the latter actually signs you out).
  get: () => get("/me").then((user) => { offlineDb.saveProfile(user); return user; }),
  update: (changes) => patch("/me", changes).then((user) => { offlineDb.saveProfile(user); return user; }),

  // Changing your phone number reuses the same OTP mechanism as signing up
  // with one — a code goes to the NEW number, and confirming it swaps it in.
  requestPhoneChangeOtp: (phone) => post("/me/phone/request-change-otp", { phone }),
  confirmPhoneChange: (phone, code) => post("/me/phone/confirm-change", { phone, code }),

  // Connecting a recovery email — same two-call OTP shape. Never a login
  // credential on its own, only where a two-step PIN reset link would go.
  requestEmailOtp: (email) => post("/me/email/request-otp", { email }),
  confirmEmail: (email, code) => post("/me/email/confirm", { email, code }),
  removeEmail: () => remove("/me/email"),

  // A phone-signup account gets an auto-generated username it was never
  // shown (e.g. user9113107586) — this is the first way to ever pick your
  // own, for @mentions and signing in with a password instead of a phone
  // code. usernameAvailable reports your OWN current username as
  // available, so re-submitting it unchanged never reads as taken.
  usernameAvailable: (username) => get(`/me/username-available?username=${encodeURIComponent(username)}`),
  setUsername: (username) => put("/me/username", { username }),

  // Deactivate hides the account and signs it out everywhere; logging back
  // in still works, and doing so is how you reactivate (see Auth.login's
  // account_disabled flag). Delete is permanent.
  deactivate: () => post("/me/deactivate"),
  reactivate: () => post("/me/reactivate"),
  deleteAccount: () => remove("/me"),

  // No currentPassword param — a phone-signup account's password was a
  // random value nobody, including its owner, ever saw, so there's never
  // one to prove. The signed-in session is the only proof of identity this
  // needs, same as account deletion above. Revokes every other session.
  setPassword: (newPassword) => put("/me/password", { new_password: newPassword }),

  sessions: () => get("/me/sessions"),
  revokeSession: (sessionId) => remove(`/me/sessions/${sessionId}`),
  // Per-device: on pulls that device's session expiry in to 4 hours out,
  // off restores the normal 30-day session.
  setSessionShortLived: (sessionId, shortLived) =>
    patch(`/me/sessions/${sessionId}`, { short_lived: shortLived }),

  // Two-step verification: an optional PIN required after the password on
  // login. currentPin is omitted to set the first PIN, required to change one.
  // setTwoStep returns {enabled, recovery_codes} — codes are non-null only
  // the moment the first PIN is set, shown once, never retrievable again.
  twoStep: () => get("/me/two-step"),
  setTwoStep: (pin, currentPin) => post("/me/two-step", { pin, current_pin: currentPin || null }),
  removeTwoStep: (currentPin) => remove("/me/two-step", { current_pin: currentPin }),
  regenerateRecoveryCodes: (currentPin) =>
    post("/me/two-step/recovery-codes", { current_pin: currentPin }),

  // Bulk-sending API keys — see /api/v1/messages. Management runs on the
  // normal session; the key itself authenticates separately, for a script,
  // not for this app.
  apiKeys: () => get("/me/api-keys"),
  createApiKey: (label) => post("/me/api-keys", { label }),
  revokeApiKey: (keyId) => remove(`/me/api-keys/${keyId}`),

  // Webhooks — the reverse of the bulk API: this app calling OUT to your own
  // server the instant a message arrives, instead of a script calling in.
  webhooks: () => get("/me/webhooks"),
  createWebhook: (url) => post("/me/webhooks", { url }),
  deleteWebhook: (webhookId) => remove(`/me/webhooks/${webhookId}`),

  // Progress toward the invite-earned blue tick — { invited, target, earned }.
  blueTickProgress: () => get("/me/blue-tick-progress"),

  // In-app product feedback: { answers: {questionKey: answer}, comment }.
  submitFeedback: (answers, comment) => post("/feedback", { answers, comment }),

  // Keyword-triggered auto-replies (the flow-builder step up from the
  // single away_message) — checked first, in order, on every incoming DM.
  autoReplyRules: () => get("/me/auto-reply-rules"),
  createAutoReplyRule: (triggerText, responseText) =>
    post("/me/auto-reply-rules", { trigger_text: triggerText, response_text: responseText }),
  deleteAutoReplyRule: (ruleId) => remove(`/me/auto-reply-rules/${ruleId}`),

  // Saved quick-reply snippets for the composer picker.
  cannedReplies: () => get("/me/canned-replies"),
  createCannedReply: (label, text) => post("/me/canned-replies", { label, text }),
  deleteCannedReply: (replyId) => remove(`/me/canned-replies/${replyId}`),

  // WhatsApp-Business-style chat labels — personal taxonomy, many-per-chat.
  labels: () => get("/me/labels"),
  createLabel: (name, color) => post("/me/labels", { name, color }),
  deleteLabel: (labelId) => remove(`/me/labels/${labelId}`),

  // Personal bookmarks across every chat — distinct from a chat's shared pins.
  starred: () => get("/me/starred"),

  // Every live location currently active anywhere you're a member — both
  // shares you started and ones being shared with you.
  liveLocations: () => get("/me/live-locations"),

  storage: () => get("/me/storage"),

  // Who gets to see status updates you post from now on.
  storyAudience: () => get("/me/story-audience"),
  setStoryAudience: (mode, userIds) => put("/me/story-audience", { mode, user_ids: userIds }),

  // Profile photo — one call sets it, unlike a chat attachment there's no
  // separate upload-then-attach step.
  async setAvatar(file) {
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${BASE}/me/avatar`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(response.status, problem.detail);
    }
    return response.json();
  },
  removeAvatar: () => remove("/me/avatar"),
  // Cover/banner photo — same single-call upload-and-set as the avatar.
  async setCover(file) {
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${BASE}/me/cover`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(response.status, problem.detail);
    }
    return response.json();
  },
  removeCover: () => remove("/me/cover"),
};

export const Users = {
  list: (query = "") => get(`/users?q=${encodeURIComponent(query)}`),
  get: (userId) => get(`/users/${userId}`),

  // Given phone numbers from the device, return the ones already on TalkEx —
  // WhatsApp's "contacts who are on here" suggestion list.
  matchContacts: (phones) => post(`/users/match-contacts`, { phones }),
  byPhone: (phone) => get(`/users/by-phone/${encodeURIComponent(phone)}`),
  block: (userId) => post(`/users/${userId}/block`),
  unblock: (userId) => remove(`/users/${userId}/block`),
  blocked: () => get("/blocks"),

  // Telegram-style People Nearby — off until setNearby(true, lat, lng).
  setNearby: (enabled, lat = null, lng = null) => put("/me/nearby", { enabled, lat, lng }),
  nearby: (radiusKm = 50) => get(`/discover/nearby?radius_km=${radiusKm}`),
};

// A one-way flag for whoever moderates the platform — the target is never
// told, and nothing here takes any action on its own.
export const Report = {
  submit: (targetType, targetId, reason, details = "") =>
    post("/report", { target_type: targetType, target_id: targetId, reason, details }),
};

// ── Contacts ─────────────────────────────────────────────────────────────────

export const Contacts = {
  list: () => get("/contacts"),
  add: (name, phone) => post("/contacts", { name, phone }),
  update: (contactId, name, phone) => patch(`/contacts/${contactId}`, { name, phone }),
  remove: (contactId) => remove(`/contacts/${contactId}`),
};

// ── Chats ────────────────────────────────────────────────────────────────────

export const Chats = {
  // Network first (it's always the freshest copy); on failure — genuinely
  // offline, server unreachable — fall back to whatever the last successful
  // call cached. Only rethrows if there's nothing cached either, so a caller
  // that has no offline handling of its own still fails exactly like before.
  list: async () => {
    try {
      const chats = await get("/chats");
      offlineDb.saveChats(chats);
      return chats;
    } catch (error) {
      const cached = await offlineDb.getChats();
      if (cached.length > 0) return cached;
      throw error;
    }
  },
  get: (chatId) => get(`/chats/${chatId}`),
  dm: (userId) => post(`/chats/dm/${userId}`),
  createGroup: (details) => post("/chats/group", details),
  createChannel: (details) => post("/chats/channel", details),
  createCommunity: (details) => post("/chats/community", details),
  createBroadcast: (details) => post("/chats/broadcast", details),
  broadcastRecipients: (chatId) => get(`/chats/${chatId}/broadcast/recipients`),
  addBroadcastRecipients: (chatId, userIds) => post(`/chats/${chatId}/broadcast/recipients`, { user_ids: userIds }),
  removeBroadcastRecipient: (chatId, userId) => remove(`/chats/${chatId}/broadcast/recipients/${userId}`),
  channels: (communityId) => get(`/chats/${communityId}/channels`),
  createSubChannel: (communityId, details) => post(`/chats/${communityId}/channels`, details),

  discover: () => get("/discover"),
  join: (chatId) => post(`/chats/${chatId}/join`),
  leave: (chatId) => post(`/chats/${chatId}/leave`),

  // Per-member preferences: pin, folder, mute, draft, archived.
  settings: (chatId, changes) => patch(`/chats/${chatId}/settings`, changes),

  // "Clear chat" — hides your own copy of every message already in the chat.
  // Anything sent after this call still shows up normally.
  clear: (chatId) => post(`/chats/${chatId}/clear`),

  // Vanish mode: a purely personal preference (never shown to or affecting
  // the other member) — once on, leaveView() hides every message this
  // account has already read, the moment it's called. The screen calls it
  // on unmount, so re-opening the chat shows only what wasn't seen yet.
  setVanishMode: (chatId, enabled) => put(`/chats/${chatId}/vanish-mode?enabled=${enabled}`),
  leaveView: (chatId) => post(`/chats/${chatId}/leave-view`),

  // Shared media (photos/videos/documents) for a chat's info screen.
  media: (chatId) => get(`/chats/${chatId}/media`),

  // Best-effort title/description/image for a link card under a chat
  // message — the server does the actual fetch (a browser can't reliably
  // read another origin's HTML itself) and caches the result briefly.
  linkPreview: (url) => get(`/link-preview?url=${encodeURIComponent(url)}`),

  // Shareable join links for groups/channels/communities. Rotating replaces
  // the code outright — the old link stops working the moment a new one is
  // generated, not just when someone remembers to revoke it.
  createInvite: (chatId) => post(`/chats/${chatId}/invite`),
  createBreakoutRooms: (chatId, assignments) => post(`/chats/${chatId}/breakout-rooms`, { assignments }),
  closeBreakoutRooms: (chatId) => post(`/chats/${chatId}/breakout-rooms/close`),
  revokeInvite: (chatId) => remove(`/chats/${chatId}/invite`),
  previewInvite: (code) => get(`/invite/${code}`),
  joinViaInvite: (code) => post(`/invite/${code}/join`),

  // Chat-wide disappearing timer. Pass null to switch it off.
  setDisappearing: (chatId, seconds) => put(`/chats/${chatId}/disappearing`, { seconds }),
  setSlowMode: (chatId, seconds) => put(`/chats/${chatId}/slow-mode?seconds=${seconds}`),

  // Admin toggle: whether messages/posts in this channel or group can be reacted to.
  setReactionsPolicy: (chatId, enabled) => put(`/chats/${chatId}/reactions-policy?enabled=${enabled}`),

  // An ephemeral, chat-list-hidden group that hosts an ad-hoc multi-party
  // call (what "add participant" during a 1:1 call creates).
  createCallRoom: (memberIds, name = "Group call") =>
    post("/call-rooms", { name, member_ids: memberIds }),

  // Edit a group/channel/community's own name & description (admin action).
  updateInfo: (chatId, fields) => put(`/chats/${chatId}/info`, fields),
  // Group/channel photo — one call sets it, mirroring Me.setAvatar.
  async setAvatar(chatId, file) {
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${BASE}/chats/${chatId}/avatar`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(response.status, problem.detail);
    }
    return response.json();
  },
  removeAvatar: (chatId) => remove(`/chats/${chatId}/avatar`),
  // WhatsApp's "Only admins can send messages" group switch.
  setSendPolicy: (chatId, adminsOnly) => put(`/chats/${chatId}/send-policy?admins_only=${adminsOnly}`),

  // Telegram-style Topics: named sub-threads inside a group.
  setTopicsPolicy: (chatId, enabled) => put(`/chats/${chatId}/topics-policy?enabled=${enabled}`),
  topics: (chatId) => get(`/chats/${chatId}/topics`),
  createTopic: (chatId, name) => post(`/chats/${chatId}/topics`, { name }),
  closeTopic: (chatId, topicId) => remove(`/chats/${chatId}/topics/${topicId}`),

  // Replaces this chat's full set of your own labels (see Me.labels).
  setLabels: (chatId, labelIds) => put(`/chats/${chatId}/labels`, { label_ids: labelIds }),
  // Hand the group over to another member (owner only).
  makeOwner: (chatId, userId) => post(`/chats/${chatId}/members/${userId}/make-owner`, {}),
  // Groups both you and another user belong to.
  commonGroups: (otherId) => get(`/users/${otherId}/common-groups`),

  // Discussion comments on channel/community posts.
  comments: (messageId) => get(`/messages/${messageId}/comments`),
  addComment: (messageId, text) => post(`/messages/${messageId}/comments`, { text }),
  deleteComment: (commentId) => remove(`/comments/${commentId}`),
  setCommentsPolicy: (chatId, enabled) => put(`/chats/${chatId}/comments-policy?enabled=${enabled}`),

  // A channel's public @handle. Empty string clears it (makes it private).
  setChannelUsername: (chatId, username) =>
    put(`/chats/${chatId}/username?username=${encodeURIComponent(username)}`),
  getChannelByUsername: (username) =>
    get(`/chats/by-username/${encodeURIComponent(username.replace(/^@/, ""))}`),

  // Join approval (admin-gated). Joining an approval-gated chat returns
  // { joined:false, requested:true } instead of adding the member.
  setJoinApproval: (chatId, enabled) => put(`/chats/${chatId}/approval?enabled=${enabled}`),
  setChannelSignature: (chatId, enabled) => put(`/chats/${chatId}/signature?enabled=${enabled}`),
  joinRequests: (chatId) => get(`/chats/${chatId}/join-requests`),
  approveJoinRequest: (chatId, userId) => post(`/chats/${chatId}/join-requests/${userId}/approve`),
  denyJoinRequest: (chatId, userId) => post(`/chats/${chatId}/join-requests/${userId}/deny`),

  lock: (chatId, pin) => post(`/chats/${chatId}/lock`, { pin }),
  unlock: (chatId, pin) => post(`/chats/${chatId}/unlock`, { pin }),
  removeLock: (chatId, pin) => remove(`/chats/${chatId}/lock`, { pin }),

  markRead: (chatId, seq) => post(`/chats/${chatId}/read`, { seq }),

  // Acknowledge a message was RECEIVED (delivered) up to `seq` — turns the
  // sender's single tick into a double. Fire-and-forget; unlike read, there's
  // no privacy setting to withhold it.
  markDelivered: (chatId, seq) => post(`/chats/${chatId}/delivered`, { seq }),

  // How far every other member has read AND received. Each row now carries
  // last_delivered_seq (always) and last_read_seq (null when that member has
  // read receipts off) so the client can draw single/double/blue ticks.
  readState: (chatId) => get(`/chats/${chatId}/read-state`),

  // Owner/admin membership management, separate from the self-serve join/leave.
  addMembers: (chatId, userIds) => post(`/chats/${chatId}/members`, { user_ids: userIds }),
  removeMember: (chatId, userId) => remove(`/chats/${chatId}/members/${userId}`),
  setMemberRole: (chatId, userId, role, permissions) =>
    patch(`/chats/${chatId}/members/${userId}`, permissions ? { role, permissions } : { role }),
};

// ── Messages ─────────────────────────────────────────────────────────────────

export const Messages = {
  // Newest page of a chat. Same offline fallback shape as Chats.list above —
  // try the network, fall back to the local mirror of this exact chat only
  // if the network attempt fails outright.
  list: async (chatId, limit = 50) => {
    try {
      const messages = await get(`/chats/${chatId}/messages?limit=${limit}`);
      offlineDb.saveMessages(chatId, messages);
      return messages;
    } catch (error) {
      const cached = await offlineDb.getMessages(chatId, { limit });
      if (cached.length > 0) return cached;
      throw error;
    }
  },

  // Scrolling up through history.
  before: async (chatId, seq, limit = 50) => {
    try {
      const messages = await get(`/chats/${chatId}/messages?before_seq=${seq}&limit=${limit}`);
      offlineDb.saveMessages(chatId, messages);
      return messages;
    } catch (error) {
      const cached = await offlineDb.getMessages(chatId, { beforeSeq: seq, limit });
      if (cached.length > 0) return cached;
      throw error;
    }
  },

  // Catching up after a reconnect: only what came after seq.
  after: (chatId, seq, limit = 200) =>
    get(`/chats/${chatId}/messages?after_seq=${seq}&limit=${limit}`),

  send: (message) => post("/messages", message),
  edit: (messageId, text) => patch(`/messages/${messageId}`, { text }),

  // Two genuinely different actions, not just different labels on one:
  //   unsend   — sender only, own message, vanishes with NO trace for
  //              anyone (not even a "this message was deleted" tombstone).
  //   everyone — sender or a moderator; leaves a visible tombstone behind.
  //              The only option a moderator has on someone else's message —
  //              accountability requires the removal to be visible.
  unsend: (messageId) => remove(`/messages/${messageId}?mode=unsend`),
  deleteForEveryone: (messageId) => remove(`/messages/${messageId}?mode=everyone`),

  // "Delete for me" — hides it from only your own view. Anyone in the chat
  // can do this to any message; it never touches the shared row.
  hide: (messageId) => post(`/messages/${messageId}/hide`),

  react: (messageId, emoji) => post(`/messages/${messageId}/reactions`, { emoji }),
  unreact: (messageId, emoji) =>
    remove(`/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`),
  reactionDetails: (messageId) => get(`/messages/${messageId}/reactions`),

  vote: (messageId, optionIndex) =>
    post(`/messages/${messageId}/vote`, { option_index: optionIndex }),

  // One tick of a live-shared location. Only valid while its live_until is
  // still ahead of now, and only from whoever started sharing it.
  updateLocation: (messageId, lat, lng) => put(`/messages/${messageId}/location`, { lat, lng }),

  // Ends a live share early — the location freezes at its last position
  // instead of disappearing, same as letting the timer run out.
  stopLiveLocation: (messageId) => post(`/messages/${messageId}/location/stop`),

  forward: (messageId, toChatIds) =>
    post("/messages/forward", { message_id: messageId, to_chat_ids: toChatIds }),

  pin: (messageId) => post(`/messages/${messageId}/pin`),
  unpin: (messageId) => remove(`/messages/${messageId}/pin`),

  // Personal, cross-chat bookmark — see Me.starred() for the full list.
  star: (messageId) => post(`/messages/${messageId}/star`),
  unstar: (messageId) => remove(`/messages/${messageId}/star`),

  // Explicit "I opened this" gesture for a view-once TEXT message — the
  // text equivalent of tapping to reveal a view-once photo/video. Returns
  // the text so the tap that spends the one view can also show it, before
  // the next fetch of this message comes back blanked.
  openViewOnce: (messageId) => post(`/messages/${messageId}/view-once-open`),
};

// ── Offline write queue ───────────────────────────────────────────────────────
//
// The message Outbox above (sendReliably) is the original, narrow mechanism:
// one queue, one job — a new text message. Everything else you can do to a
// message (react, edit, delete, vote, pin, star) or a chat (mark read) is
// queued here instead, in one shared, ordered list, so replaying it later
// reapplies whatever you did in the same sequence you did it in.
//
// A 4xx from the server is never queued — that's the server actively
// refusing the request (already deleted, not a member, etc.), and no amount
// of retrying changes that. Only a real connectivity failure (no ApiError,
// fetch() rejecting before a status even exists) goes in the queue.

async function requestBackgroundSync(tag = "talkex-flush") {
  if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.sync.register(tag);
  } catch {
    // Background Sync isn't available here (unsupported engine despite the
    // feature check, permission denied, private mode) — the existing
    // online/visibilitychange-triggered flush still covers the common case
    // of "the tab was open the whole time."
  }
}

async function withOfflineQueue(type, args, run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      throw error; // the server will never accept this — nothing to queue
    }
    await offlineDb.queueAction(type, args);
    requestBackgroundSync();
    return null; // caller treats null as "queued, apply it optimistically"
  }
}

// What ChatView (and anywhere else that lets you act on a message) should
// call instead of the raw Messages.* / Chats.markRead — same arguments,
// but a null return means "no network right now, queued for later" instead
// of throwing.
export const Actions = {
  react: (messageId, emoji) =>
    withOfflineQueue("react", { messageId, emoji }, () => Messages.react(messageId, emoji)),
  unreact: (messageId, emoji) =>
    withOfflineQueue("unreact", { messageId, emoji }, () => Messages.unreact(messageId, emoji)),
  edit: (messageId, text) =>
    withOfflineQueue("edit", { messageId, text }, () => Messages.edit(messageId, text)),
  unsend: (messageId) =>
    withOfflineQueue("unsend", { messageId }, () => Messages.unsend(messageId)),
  deleteForEveryone: (messageId) =>
    withOfflineQueue("delete_everyone", { messageId }, () => Messages.deleteForEveryone(messageId)),
  hide: (messageId) =>
    withOfflineQueue("hide", { messageId }, () => Messages.hide(messageId)),
  vote: (messageId, optionIndex) =>
    withOfflineQueue("vote", { messageId, optionIndex }, () => Messages.vote(messageId, optionIndex)),
  pin: (messageId) =>
    withOfflineQueue("pin", { messageId }, () => Messages.pin(messageId)),
  unpin: (messageId) =>
    withOfflineQueue("unpin", { messageId }, () => Messages.unpin(messageId)),
  star: (messageId) =>
    withOfflineQueue("star", { messageId }, () => Messages.star(messageId)),
  unstar: (messageId) =>
    withOfflineQueue("unstar", { messageId }, () => Messages.unstar(messageId)),
  markRead: (chatId, seq) =>
    withOfflineQueue("mark_read", { chatId, seq }, () => Chats.markRead(chatId, seq)),
};

// Replays a queued action through the exact same raw call the online path
// uses — never through Actions.* above, which would just queue it again if
// this runs while still offline.
const ACTION_REPLAY = {
  react: (a) => Messages.react(a.messageId, a.emoji),
  unreact: (a) => Messages.unreact(a.messageId, a.emoji),
  edit: (a) => Messages.edit(a.messageId, a.text),
  unsend: (a) => Messages.unsend(a.messageId),
  delete_everyone: (a) => Messages.deleteForEveryone(a.messageId),
  hide: (a) => Messages.hide(a.messageId),
  vote: (a) => Messages.vote(a.messageId, a.optionIndex),
  pin: (a) => Messages.pin(a.messageId),
  unpin: (a) => Messages.unpin(a.messageId),
  star: (a) => Messages.star(a.messageId),
  unstar: (a) => Messages.unstar(a.messageId),
  mark_read: (a) => Chats.markRead(a.chatId, a.seq),
};

export async function flushPendingActions() {
  const actions = await offlineDb.getActions();
  for (const action of actions) {
    try {
      await ACTION_REPLAY[action.type](action.args);
      await offlineDb.removeAction(action.id);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        // Something changed underneath this while it sat queued (the
        // message was already deleted by someone else, etc.) — the server
        // will never accept it now, so drop it rather than retry forever.
        await offlineDb.removeAction(action.id);
        continue;
      }
      break; // still offline or the server's unreachable — stop here, the rest keep waiting
    }
  }
}

// A queued photo/video/voice/document. Two network steps just like a normal
// send (Uploads.create, then Messages.send) — the difference is that
// failing either one queues the raw file itself, not a half-finished
// attachment id that would be meaningless once retried later.
export async function sendFileReliably({
  chatId, file, kind, text = "", viewOnce = false, clientMsgId = null, signal = null, onProgress = null,
}) {
  const id = clientMsgId || newClientMessageId();
  try {
    const attachment = await Uploads.create(file, { signal, onProgress });
    return await Messages.send({
      chat_id: chatId, kind, text,
      payload: { attachment_id: attachment.attachment_id },
      client_msg_id: id,
      view_once: viewOnce && (kind === "photo" || kind === "video"),
    });
  } catch (error) {
    // A deliberate cancel (the person tapped × on the upload) is not a
    // network failure — queuing it for a background retry would silently
    // resurrect and send a file they explicitly stopped. Let it propagate
    // as-is so the caller's own catch just cleans up the optimistic bubble.
    if (error?.name === "AbortError") throw error;
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
    await offlineDb.queuePendingUpload({
      client_msg_id: id, chat_id: chatId, kind, text, view_once: viewOnce,
      file, file_name: file.name, content_type: file.type,
    });
    requestBackgroundSync();
    return null;
  }
}

export async function flushPendingUploads() {
  const pending = await offlineDb.getAllPendingUploads();
  for (const item of pending) {
    try {
      const attachment = await Uploads.create(item.file);
      const stored = await Messages.send({
        chat_id: item.chat_id, kind: item.kind, text: item.text || "",
        payload: { attachment_id: attachment.attachment_id },
        client_msg_id: item.client_msg_id,
        view_once: item.view_once && (item.kind === "photo" || item.kind === "video"),
      });
      await offlineDb.removePendingUpload(item.client_msg_id);
      // Whichever ChatView has this chat open reconciles its optimistic
      // bubble on this same event — the flush can run from App.jsx's
      // top-level listener, not necessarily from inside that component.
      window.dispatchEvent(new CustomEvent("ht:queued-sent", { detail: stored }));
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        await offlineDb.removePendingUpload(item.client_msg_id);
        window.dispatchEvent(new CustomEvent("ht:queued-failed", {
          detail: { clientMsgId: item.client_msg_id, chatId: item.chat_id },
        }));
        continue;
      }
      break; // still offline — stop, try the rest next time
    }
  }
}

// Runs every queue there is, in one call — what App.jsx's online/
// visibilitychange listener actually calls.
export async function flushEverything() {
  await Outbox.flush();
  await flushPendingUploads();
  await flushPendingActions();
}

export const Pins = {
  list: (chatId) => get(`/chats/${chatId}/pins`),
};

// ── Web Push ─────────────────────────────────────────────────────────────────

export const Push = {
  vapidPublicKey: () => get("/push/vapid-public-key"),
  subscribe: (subscription) => post("/push/subscribe", subscription),
  unsubscribe: (endpoint) => remove("/push/subscribe", { endpoint }),
  // Native (FCM) device token for the Capacitor Android app.
  registerFcmToken: (token, platform = "android") => post("/push/fcm-token", { token, platform }),
  unregisterFcmToken: (token) => remove("/push/fcm-token", { token }),
};

// ── Uploads ──────────────────────────────────────────────────────────────────

export const Uploads = {
  /**
   * Send a file to the server and get back an attachment id to put in a
   * message's payload. Two steps on purpose: if the send that follows fails
   * and is retried, the file is not re-transmitted.
   *
   * `signal` (an AbortController's) is what lets ChatView's cancel button
   * actually stop an in-flight upload instead of just hiding it client-side
   * while the transfer keeps running in the background — fetch() aborts
   * both the request and (per spec) the underlying TCP write.
   */
  async create(file, { signal, onProgress } = {}) {
    const body = new FormData();
    body.append("file", file);

    if (onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${BASE}/uploads`);
        xhr.timeout = 5 * 60 * 1000; // 5 minutes — generous for large files
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); }
            catch { reject(new ApiError(xhr.status, "Bad response")); }
          } else {
            let detail = "Upload failed";
            try { detail = JSON.parse(xhr.responseText).detail || detail; } catch {}
            reject(new ApiError(xhr.status, detail));
          }
        };
        xhr.onerror = () => reject(new ApiError(0, "Network error"));
        xhr.ontimeout = () => reject(new ApiError(0, "Upload timed out — try a smaller file or check your connection"));
        if (signal) {
          if (signal.aborted) {
            const err = new Error("Upload cancelled");
            err.name = "AbortError";
            reject(err);
            return;
          }
          signal.addEventListener("abort", () => xhr.abort());
        }
        xhr.onabort = () => {
          const err = new Error("Upload cancelled");
          err.name = "AbortError";
          reject(err);
        };
        xhr.send(body);
      });
    }

    const controller = signal ? undefined : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), 5 * 60 * 1000) : undefined;
    const response = await fetch(`${BASE}/uploads`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
      signal: signal || controller?.signal,
    });
    if (timer) clearTimeout(timer);

    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(response.status, problem.detail);
    }
    return response.json();
  },

  /** The URL to fetch or display an attachment. Auth still applies server-side. */
  url(attachmentId) {
    return `${BASE}/uploads/${attachmentId}`;
  },

  /**
   * Fetch an attachment as a blob URL, carrying the auth header a plain <img>
   * or <a href> cannot send.
   *
   * `cache: true` is the offline-friendly path — ordinary chat media and
   * avatars, where the bytes never change once uploaded, so a local copy is
   * always still correct. It is checked FIRST (not as a fallback), since
   * that's also what saves the network round-trip entirely for anything
   * already seen once. Left false (the default) for anything that must never
   * be persisted client-side — view-once media above all, where a cached
   * copy would silently defeat the whole "opens exactly once" guarantee the
   * server enforces on the download itself.
   */
  async fetchBlobUrl(attachmentId, { cache = false } = {}) {
    if (cache) {
      const cached = await offlineDb.getBlob(attachmentId);
      if (cached) return URL.createObjectURL(cached);
    }

    try {
      const response = await fetch(`${BASE}/uploads/${attachmentId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new ApiError(response.status, "Could not load file");
      const blob = await response.blob();
      if (cache) offlineDb.saveBlob(attachmentId, blob, blob.type);
      return URL.createObjectURL(blob);
    } catch (error) {
      // A real network failure (offline, DNS, server down — fetch() itself
      // throws a plain TypeError for these, not an ApiError) is the one case
      // worth a second look at the cache: an HTTP error response already
      // checked it above and came up empty, so re-checking would be wasted
      // work, but this path never did.
      if (cache && !(error instanceof ApiError)) {
        const cached = await offlineDb.getBlob(attachmentId);
        if (cached) return URL.createObjectURL(cached);
      }
      throw error;
    }
  },
};

export const Search = {
  query: (text, chatId) => get(`/search?q=${encodeURIComponent(text)}${chatId ? `&chat_id=${chatId}` : ""}`),
};

// ── Scheduled messages ───────────────────────────────────────────────────────

export const Scheduled = {
  // sendAt is a Unix timestamp in seconds. Date.now() is milliseconds, so
  // remember to divide — passing milliseconds schedules it for the year 57000.
  create: ({ chatId, text, sendAt, kind = "text", payload = null }) =>
    post("/scheduled", { chat_id: chatId, text, send_at: sendAt, kind, payload }),

  list: (chatId) => get(chatId ? `/scheduled?chat_id=${chatId}` : "/scheduled"),
  update: (itemId, changes) => patch(`/scheduled/${itemId}`, changes),
  cancel: (itemId) => remove(`/scheduled/${itemId}`),
};

// ── Status / stories ─────────────────────────────────────────────────────────

export const Stories = {
  // kind defaults to "text". photo/video/audio need attachmentId (from
  // Uploads.create); link needs linkUrl. Omit publishAt to post now, or pass
  // a Unix timestamp to queue it.
  create: ({ text, emoji, background, kind = "text", attachmentId = null,
             linkUrl = null, publishAt = null, font = "system", fontSize = "medium",
             allowShare = false, music = null }) =>
    post("/stories", {
      text, emoji, background, kind,
      attachment_id: attachmentId, link_url: linkUrl, publish_at: publishAt,
      font, font_size: fontSize, allow_share: allowShare,
      music_url: music?.previewUrl || null, music_title: music?.title || null,
      music_artist: music?.artist || null,
      music_artwork: music?.artworkLarge || music?.artwork || null,
    }),

  list: () => get("/stories"),
  mine: () => get("/stories/mine"),
  view: (storyId) => post(`/stories/${storyId}/view`),
  delete: (storyId) => remove(`/stories/${storyId}`),

  // One reaction per viewer — sending a new emoji replaces theirs, it
  // doesn't stack. `reactions`/`viewers` are author-only.
  react: (storyId, emoji) => post(`/stories/${storyId}/react`, { emoji }),
  unreact: (storyId) => remove(`/stories/${storyId}/react`),
  reactions: (storyId) => get(`/stories/${storyId}/reactions`),
  viewers: (storyId) => get(`/stories/${storyId}/viewers`),
  forward: (storyId, chatIds) => post(`/stories/${storyId}/forward`, { to_chat_ids: chatIds }),

  // Hides someone's status updates from your own list only — reversible,
  // silent, and unrelated to blocking (see mute_status in main.py).
  muteStatus: (userId) => post(`/users/${userId}/mute-status`),
  unmuteStatus: (userId) => remove(`/users/${userId}/mute-status`),
  mutedStatuses: () => get("/muted-statuses"),

  // Pin a story past its normal 24h lifetime onto the profile — Instagram's
  // Highlights. Author-only to set/unset; anyone who could see the original
  // story can read the reel back.
  highlight: (storyId, label = "") => post(`/stories/${storyId}/highlight`, { label }),
  unhighlight: (storyId) => remove(`/stories/${storyId}/highlight`),
  highlights: (userId) => get(`/users/${userId}/highlights`),
};

// ── Call history ─────────────────────────────────────────────────────────────

export const Calls = {
  list: () => get("/calls"),
  missedCount: () => get("/calls/missed-count"),
  markSeen: () => post("/calls/seen"),
};

// ── Meetings ─────────────────────────────────────────────────────────────────

export const Meetings = {
  create: ({ chatId, title, agenda = "", startsAt, durationMin = 30,
             joinUrl = "", reminderMin = 10, inviteUserIds = [], waitingRoom = false, password = "" }) =>
    post("/meetings", {
      chat_id: chatId, title, agenda, starts_at: startsAt,
      duration_min: durationMin, join_url: joinUrl,
      reminder_min: reminderMin, invite_user_ids: inviteUserIds,
      waiting_room: waitingRoom, password,
    }),

  mine: (upcomingOnly = true) => get(`/meetings?upcoming_only=${upcomingOnly}`),
  forChat: (chatId) => get(`/chats/${chatId}/meetings`),
  get: (meetingId) => get(`/meetings/${meetingId}`),
  update: (meetingId, changes) => patch(`/meetings/${meetingId}`, changes),
  cancel: (meetingId) => remove(`/meetings/${meetingId}`),
  rsvp: (meetingId, response) => post(`/meetings/${meetingId}/rsvp`, { response }),

  // No scheduling step — live immediately, in-app join only (no join_url).
  startInstant: (chatId, title, waitingRoom = false, password = "") =>
    post("/meetings/instant", { chat_id: chatId, title, waiting_room: waitingRoom, password }),
  // Whoever taps Join first moves a scheduled meeting to 'live' for everyone.
  start: (meetingId) => post(`/meetings/${meetingId}/start`),
  end: (meetingId) => post(`/meetings/${meetingId}/end`),

  // The .ics endpoint returns a calendar file, not JSON, so this can't go
  // through the get() helper — fetched directly and handed to the browser
  // as a download, the same way setAvatar's upload bypasses post() above.
  async downloadIcs(meetingId) {
    const response = await fetch(`${BASE}/meetings/${meetingId}/ics`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new ApiError(response.status);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `meeting-${meetingId}.ics`;
    link.click();
    URL.revokeObjectURL(url);
  },
};

// ── Realtime ─────────────────────────────────────────────────────────────────

const HEARTBEAT_MS = 20000;
const MAX_BACKOFF_MS = 30000;

export class Realtime {
  // handlers: { onEvent, onStatus, onReconnect }
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.socket = null;
    this.attempt = 0;
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.closedOnPurpose = false;
    // Bumped on every connect() call so a ticket fetch that's still in
    // flight when a NEWER connect() (or close()) happens can tell it's been
    // superseded and must not go on to open a socket.
    this.connectId = 0;
    // False until the first successful open, so the initial connection is not
    // treated as a reconnect — the screen has just loaded its data anyway.
    this.hasConnectedBefore = false;
  }

  connect() {
    if (!token) return;
    this.closedOnPurpose = false;
    this.connectId += 1;
    const connectId = this.connectId;

    // The handshake can't carry a custom Authorization header, so a fresh,
    // single-use ticket is minted over the normal (header-authenticated)
    // API right before opening the socket, instead of putting the real
    // session token in the connection URL — see Auth.wsTicket.
    Auth.wsTicket()
      .then(({ ticket }) => {
        if (this.closedOnPurpose || connectId !== this.connectId) return;
        this.openSocket(ticket);
      })
      .catch(() => {
        if (this.closedOnPurpose || connectId !== this.connectId) return;
        this.setStatus("reconnecting");
        this.scheduleReconnect();
      });
  }

  openSocket(ticket) {
    this.socket = new WebSocket(`${WS_BASE}/ws?ticket=${encodeURIComponent(ticket)}`);

    this.socket.onopen = () => {
      // Reset the backoff only once a connection actually succeeds. Resetting
      // it on the attempt would turn a server that accepts and immediately
      // drops into a tight reconnect loop.
      this.attempt = 0;
      this.setStatus("online");
      this.startHeartbeat();

      // Anything queued while we were offline goes out now.
      Outbox.flush();

      // Tell the app it needs to catch up. Everything a socket missed while it
      // was down has to be fetched with after_seq — the server does not replay
      // events on reconnect, so without this a dropped connection silently
      // loses every message sent during the gap.
      if (this.hasConnectedBefore) this.handlers.onReconnect?.();
      this.hasConnectedBefore = true;
    };

    this.socket.onmessage = (event) => {
      // Any message from the server counts as proof the pipe is alive in
      // the read direction, not just pongs — startHeartbeat's dead-pipe
      // check reads this to decide whether to force a reconnect.
      this.lastPongAt = Date.now();
      const payload = JSON.parse(event.data);
      if (payload.type === "pong") return;
      this.handlers.onEvent?.(payload);
    };

    this.socket.onclose = (event) => {
      this.stopHeartbeat();

      // 1008 is the server refusing the token. Retrying cannot fix that, so
      // stop and let the app send the user back to the login screen.
      if (event.code === 1008) {
        this.setStatus("unauthorized");
        return;
      }

      if (!this.closedOnPurpose) {
        this.setStatus("reconnecting");
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      // onclose always follows, so reconnection is handled there. Doing it in
      // both places would open two sockets.
    };
  }

  scheduleReconnect() {
    // Exponential backoff with jitter. Without the jitter, every client that
    // dropped when the server restarted would come back at the same instant.
    const base = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = base * (0.5 + Math.random() / 2);
    this.attempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    // A socket whose network vanished looks open until you try to write
    // to it. The ping is what turns a silently dead link into a close
    // event — and send()'s own broken-socket path (see above) now
    // immediately kicks a reconnect on the very first failure instead of
    // waiting for onclose to eventually fire the usual back-off flow.
    let missedPongs = 0;
    this.lastPongAt = Date.now();
    this.heartbeat = setInterval(() => {
      // Server sends {type:"pong"} for every ping (see main.py's
      // websocket_endpoint) — a stretch of pings with no reply means the
      // pipe is dead in ONE direction even if the write itself succeeded,
      // which is a very common way a "connected" socket becomes useless.
      // Two missed pongs (≥40s of silence from the server) trips a
      // manual reconnect rather than trusting the underlying transport
      // to eventually notice.
      if (Date.now() - this.lastPongAt > HEARTBEAT_MS * 2 + 5000) {
        missedPongs += 1;
        if (missedPongs >= 2) {
          this.socket?.close();  // triggers onclose → scheduleReconnect
          return;
        }
      } else {
        missedPongs = 0;
      }
      this.send({ type: "ping" });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(payload));
        return true;
      } catch {
        // The socket said OPEN but write threw — a very-recently-dead
        // connection the readyState hasn't caught up on yet. Fall through
        // to the reconnect path below so this isn't silently lost.
      }
    }
    // Socket isn't usable: kick a reconnect immediately (not the slow
    // heartbeat-driven one) so the next attempt has a real chance, and
    // report failure so the caller can surface an error instead of
    // pretending the message went out. Nothing above ever checked this
    // return value before — a call_invite quietly dropped on the floor
    // is exactly what left "Calling…" spinning until the ring timeout.
    if (!this.closedOnPurpose && !this.reconnectTimer && this.socket?.readyState !== WebSocket.CONNECTING) {
      this.attempt = 0; // don't back off — this is a user-initiated action, not a passive drop
      this.connect();
    }
    return false;
  }

  typing(chatId) {
    this.send({ type: "typing", chat_id: chatId });
  }

  setStatus(status) {
    this.handlers.onStatus?.(status);
  }

  close() {
    this.closedOnPurpose = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }
}

// ── Outbox ───────────────────────────────────────────────────────────────────

const OUTBOX_KEY = "ht_outbox";

export const Outbox = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    } catch {
      return [];
    }
  },

  write(items) {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  },

  add(message) {
    const items = Outbox.read();
    items.push(message);
    Outbox.write(items);
  },

  drop(clientMsgId) {
    Outbox.write(Outbox.read().filter((item) => item.client_msg_id !== clientMsgId));
  },

  // Try everything queued. Safe to call as often as you like: each item carries
  // its client_msg_id, and the server returns the existing message rather than
  // storing a second copy.
  async flush() {
    for (const item of Outbox.read()) {
      try {
        await Messages.send(item);
        Outbox.drop(item.client_msg_id);
      } catch (error) {
        // A rejection the server will never accept — no longer a member, chat
        // deleted, message malformed — must not sit in the queue retrying
        // forever. Only network and server errors are worth keeping.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          Outbox.drop(item.client_msg_id);
        }
        break;
      }
    }
  },
};

// ── Message templates ────────────────────────────────────────────────────────

export const Templates = {
  create: (name, content) => post("/me/templates", { name, content }),
  list: () => get("/me/templates"),
  remove: (templateId) => remove(`/me/templates/${templateId}`),
};

// ── Superadmin ────────────────────────────────────────────────────────────────
// Every call here 403s for anyone whose account isn't flagged
// is_superadmin — the panel that uses these only ever renders for someone
// who already got a successful response from one of them.

export const Admin = {
  stats: () => get("/admin/stats"),
  users: (q = "") => get(`/admin/users?q=${encodeURIComponent(q)}`),
  disableUser: (userId) => post(`/admin/users/${userId}/disable`),
  enableUser: (userId) => post(`/admin/users/${userId}/enable`),
  deleteUser: (userId) => remove(`/admin/users/${userId}`),
  purgeGuests: () => post("/admin/purge-guests"),
  feedback: () => get("/admin/feedback"),

  integrations: () => get("/admin/integrations"),
  updateIntegrations: (fields) => put("/admin/integrations", fields),
  testSms: (phone) => post("/admin/integrations/test-sms", { phone }),
  testEmail: (email) => post("/admin/integrations/test-email", { email }),

  templates: (status = "") => get(`/admin/templates?status=${encodeURIComponent(status)}`),
  approveTemplate: (templateId) => post(`/admin/templates/${templateId}/approve`),
  rejectTemplate: (templateId) => post(`/admin/templates/${templateId}/reject`),
};

// ── Music ─────────────────────────────────────────────────────────────────────

export const Music = {
  search: (q = "", limit = 25) => get(`/api/music/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  trending: () => get("/api/music/trending"),
};

// Composer's GIF picker (Tenor, proxied server-side). search() throws a 503
// ApiError when TENOR_API_KEY isn't configured — GifPicker shows that as a
// "not set up" state rather than a blank/broken grid.
export const Gifs = {
  search: (q = "", limit = 30) => get(`/api/gifs/search?q=${encodeURIComponent(q)}&limit=${limit}`),
};

// WhatsApp-Business-Catalog-style product listings.
export const Products = {
  mine: () => get("/me/products"),
  ofUser: (userId) => get(`/users/${userId}/products`),
  create: (fields) => post("/me/products", fields),
  update: (productId, fields) => patch(`/me/products/${productId}`, fields),
  delete: (productId) => remove(`/me/products/${productId}`),
};

// Inline "Translate" on a received message. Throws a 503 ApiError when
// GOOGLE_TRANSLATE_API_KEY isn't configured — the caller shows that as
// "translation isn't set up" rather than a generic failure toast.
export const Translate = {
  text: (text, target) =>
    get(`/api/translate?text=${encodeURIComponent(text)}&target=${encodeURIComponent(target)}`),
};

// ── SFU (LiveKit) ────────────────────────────────────────────────────────────

export const Sfu = {
  config: () => get("/sfu/config"),
  token: (chatId) => post("/sfu/token", { chat_id: chatId }),
};

// ── Payments (Razorpay) ──────────────────────────────────────────────────────

export const Payments = {
  config: () => get("/payments/config"),
  createOrder: (plan) => post("/payments/create-order", { plan }),
  verify: (data) => post("/payments/verify", data),
  history: () => get("/payments/history"),
};

// ── E2EE Key Management ─────────────────────────────────────────────────────

export const E2EE = {
  uploadKeys: (keys) => post("/me/keys", keys),
  getUserKeys: (userId) => get(`/users/${userId}/keys`),
  myKeyCount: () => get("/me/keys/count"),
};

// A shareable meeting link — App.jsx's ?meeting= handler is the other half
// of this: opening it lands straight on the meeting's chat. It's still a
// TalkEx account + chat membership gate underneath (GET /meetings/{id}
// 404s otherwise), same as opening the chat any other way — this is a
// convenience shortcut, not a new access grant.
export function meetingLink(meetingId) {
  return `https://web.talkex.in/?meeting=${meetingId}`;
}

export function newClientMessageId() {
  return crypto.randomUUID();
}

// Send with automatic retry. Returns the stored message on success, or null if
// it was queued for later — the caller shows it optimistically either way.
export async function sendReliably({ chatId, text, kind = "text", payload = null,
                                     replyToId = null, disappearSecs = null,
                                     clientMsgId = null, viewOnce = false, silent = false,
                                     topicId = null }) {
  const message = {
    chat_id: chatId,
    text,
    kind,
    payload,
    reply_to_id: replyToId,
    disappear_secs: disappearSecs,
    view_once: viewOnce,
    silent,
    topic_id: topicId,
    // The caller passes this in when it has already drawn the message
    // optimistically, so the copy on screen and the copy that comes back over
    // the socket can be recognised as the same thing.
    client_msg_id: clientMsgId || newClientMessageId(),
  };

  try {
    return await Messages.send(message);
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      throw error;                   // the server will never accept this
    }
    Outbox.add(message);             // offline or server trouble: keep it
    requestBackgroundSync();
    return null;
  }
}
