// Local mirror of chats, messages and already-seen media — what makes the
// app usable with no connection, the way WhatsApp's local database does.
//
// Every store here is a cache, never a source of truth: the server is
// always right when it's reachable, and everything written here is a copy
// of something the server already returned. Losing this database (a
// private-mode tab, a cleared site data) costs nothing but re-fetching —
// it never loses a message, since nothing is ever written here that
// wasn't already safely on the server first.
//
// IndexedDB is callback/event based; every function below wraps that in a
// promise so the rest of the app never has to think about it. Every public
// function also swallows its own errors — a blocked or unsupported
// IndexedDB (private browsing, a corrupted DB) must degrade to "no offline
// cache," never break the online path that already works fine without it.

const DB_NAME = "talkex-offline";
const DB_VERSION = 2;
const MAX_BLOB_BYTES = 60 * 1024 * 1024; // ~60MB of cached media before old entries are evicted

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("chats")) {
        db.createObjectStore("chats", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: "id" });
        store.createIndex("by_chat", "chat_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        const store = db.createObjectStore("blobs", { keyPath: "attachment_id" });
        store.createIndex("by_last_accessed", "last_accessed", { unique: false });
      }
      // A photo/video/voice/document that couldn't be sent because the
      // upload itself needs a network round-trip a plain text Outbox entry
      // doesn't. The raw File/Blob is stored directly — IndexedDB structured
      // clones Blobs natively, no base64 encoding needed.
      if (!db.objectStoreNames.contains("pending_uploads")) {
        const store = db.createObjectStore("pending_uploads", { keyPath: "client_msg_id" });
        store.createIndex("by_chat", "chat_id", { unique: false });
      }
      // Every other write that isn't a new message: edit, unsend, delete,
      // react, vote, pin, star, mark-read. One shared queue, replayed in
      // the order they were made — an edit queued after a react has to
      // still land after it once both retry.
      if (!db.objectStoreNames.contains("pending_actions")) {
        db.createObjectStore("pending_actions", { keyPath: "id", autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    // A blocked/failed open (corrupted DB, disabled storage) degrades to "no
    // cache" rather than surfacing an error nobody can act on.
    request.onerror = () => resolve(null);
  });

  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function requestToPromise(request) {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

// ── Chats ────────────────────────────────────────────────────────────────────

export async function saveChats(chats) {
  const db = await openDb();
  if (!db || !Array.isArray(chats)) return;
  const store = tx(db, "chats", "readwrite");
  for (const chat of chats) store.put(chat);
}

export async function getChats() {
  const db = await openDb();
  if (!db) return [];
  const all = await requestToPromise(tx(db, "chats", "readonly").getAll());
  if (!all) return [];
  // Same ordering the server uses: pinned first, then most recent activity.
  return [...all].sort((a, b) => {
    if (Boolean(b.is_pinned) !== Boolean(a.is_pinned)) return b.is_pinned ? 1 : -1;
    return (b.last_seq || 0) - (a.last_seq || 0);
  });
}

// ── Messages ─────────────────────────────────────────────────────────────────

export async function saveMessages(chatId, messages) {
  const db = await openDb();
  if (!db || !Array.isArray(messages)) return;
  const store = tx(db, "messages", "readwrite");
  for (const message of messages) {
    // chat_id isn't always on the message object the server returns (it's
    // implied by the URL it was fetched from) — stamped here so the index
    // above can find it again.
    store.put({ ...message, chat_id: chatId });
  }
}

export async function getMessages(chatId, { beforeSeq, limit = 50 } = {}) {
  const db = await openDb();
  if (!db) return [];
  const index = tx(db, "messages", "readonly").index("by_chat");
  const all = await requestToPromise(index.getAll(IDBKeyRange.only(chatId)));
  if (!all) return [];
  let list = all.filter((m) => !beforeSeq || m.seq < beforeSeq);
  list.sort((a, b) => a.seq - b.seq);
  if (list.length > limit) list = list.slice(list.length - limit);
  return list;
}

// ── Media blobs ──────────────────────────────────────────────────────────────

export async function saveBlob(attachmentId, blob, contentType) {
  const db = await openDb();
  if (!db || !blob) return;
  const store = tx(db, "blobs", "readwrite");
  store.put({
    attachment_id: attachmentId, blob, content_type: contentType,
    size: blob.size, last_accessed: Date.now(),
  });
  pruneBlobs(db).catch(() => {});
}

export async function getBlob(attachmentId) {
  const db = await openDb();
  if (!db) return null;
  const record = await requestToPromise(tx(db, "blobs", "readonly").get(attachmentId));
  if (!record) return null;
  // Touch it on read so eviction below is a real LRU, not just insertion order.
  tx(db, "blobs", "readwrite").put({ ...record, last_accessed: Date.now() });
  return record.blob;
}

async function pruneBlobs(db) {
  const store = tx(db, "blobs", "readonly");
  const all = await requestToPromise(store.getAll());
  if (!all) return;
  const total = all.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (total <= MAX_BLOB_BYTES) return;

  const oldestFirst = [...all].sort((a, b) => a.last_accessed - b.last_accessed);
  const writeStore = tx(db, "blobs", "readwrite");
  let remaining = total;
  for (const entry of oldestFirst) {
    if (remaining <= MAX_BLOB_BYTES) break;
    writeStore.delete(entry.attachment_id);
    remaining -= entry.size || 0;
  }
}

// ── Pending uploads (queued photo/video/voice/document sends) ────────────────

export async function queuePendingUpload(entry) {
  const db = await openDb();
  if (!db) return false;
  tx(db, "pending_uploads", "readwrite").put({ ...entry, created_at: Date.now() });
  return true;
}

export async function getPendingUploads(chatId) {
  const db = await openDb();
  if (!db) return [];
  const index = tx(db, "pending_uploads", "readonly").index("by_chat");
  const all = await requestToPromise(index.getAll(IDBKeyRange.only(chatId)));
  return all ? all.sort((a, b) => a.created_at - b.created_at) : [];
}

export async function getAllPendingUploads() {
  const db = await openDb();
  if (!db) return [];
  const all = await requestToPromise(tx(db, "pending_uploads", "readonly").getAll());
  return all ? all.sort((a, b) => a.created_at - b.created_at) : [];
}

export async function removePendingUpload(clientMsgId) {
  const db = await openDb();
  if (!db) return;
  tx(db, "pending_uploads", "readwrite").delete(clientMsgId);
}

// ── Pending actions (everything that isn't a new message) ────────────────────
// edit / unsend / delete_everyone / hide / react / unreact / vote / pin /
// unpin / star / unstar / mark_read — queued in the order they happened and
// replayed in that same order once the network is back.

export async function queueAction(type, args) {
  const db = await openDb();
  if (!db) return false;
  tx(db, "pending_actions", "readwrite").add({ type, args, created_at: Date.now() });
  return true;
}

export async function getActions() {
  const db = await openDb();
  if (!db) return [];
  const all = await requestToPromise(tx(db, "pending_actions", "readonly").getAll());
  return all ? all.sort((a, b) => a.id - b.id) : [];
}

export async function removeAction(id) {
  const db = await openDb();
  if (!db) return;
  tx(db, "pending_actions", "readwrite").delete(id);
}

export async function countPending() {
  const [uploads, actions] = await Promise.all([getAllPendingUploads(), getActions()]);
  return uploads.length + actions.length;
}

// ── Profile ──────────────────────────────────────────────────────────────────
// Kept in localStorage rather than IndexedDB — it's one small object, not a
// collection, and localStorage is synchronous, which matters for the very
// first paint before anything async has had a chance to resolve.

const PROFILE_KEY = "ht_user";

export function saveProfile(user) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(user));
  } catch {
    // Storage full or blocked — the cache is best-effort, not required.
  }
}

export function getCachedProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearCachedProfile() {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    // Nothing to do if storage itself is unavailable.
  }
}
