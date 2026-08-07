"""
SQLite storage for TalkEx.

Why SQLite and not the in-memory dicts the first version used: the old store lost
every account and every message the moment the process restarted. On a free host
that sleeps after 15 minutes of inactivity, that happened several times a day.

Why plain SQL and not an ORM: every query in this project is small enough to read
in one sitting. Keeping the SQL visible means you can see exactly what hits the
disk, which is the whole point of moving off dicts.

One design decision worth calling out: channels and communities are NOT separate
tables. They are rows in `chats` with a different `type`. That means membership,
permissions, pagination, search and read-receipts are written once and work for
DMs, groups, channels and community sub-channels alike.
"""

import os
import sqlite3
import threading

# The database file. Override with DATA_DIR when deploying so the file lands on a
# mounted disk rather than inside the container image.
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(DATA_DIR, "talkex.db")

# SQLite allows many concurrent readers but only one writer at the FILE
# level — WAL mode is what makes that true. It says nothing about calling
# .execute() on the one shared CONNECTION OBJECT this module holds from two
# threads at the same literal instant, which is its own hazard entirely
# (surfaces as sqlite3.InterfaceError: "bad parameter or other API misuse").
# This lock serialises every access to that connection, reads included.
#
# Reentrant on purpose, not a plain Lock: query_one()/query_all() are called
# from inside a `with db.transaction() as conn:` block in a few places (e.g.
# create_broadcast's per-recipient existence check) — that block already
# holds this same lock for its whole duration, on the same thread. A plain
# Lock would deadlock the moment such code tried to acquire it a second
# time; RLock tracks the owning thread and permits that same thread back in.
_write_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def connect() -> sqlite3.Connection:
    """Open the connection once and reuse it for the life of the process."""
    global _conn
    if _conn is not None:
        return _conn

    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)

    # Rows come back as mappings so callers can write row["text"] instead of row[3].
    conn.row_factory = sqlite3.Row

    # WAL keeps readers from blocking on the writer. Without it, a single slow
    # write stalls every request in flight.
    conn.execute("PRAGMA journal_mode = WAL")

    # NORMAL is the right durability trade for a chat app: it survives an
    # application crash, and only risks the last transaction on a full power cut.
    conn.execute("PRAGMA synchronous = NORMAL")

    # SQLite does not enforce foreign keys unless you ask it to, per connection.
    conn.execute("PRAGMA foreign_keys = ON")

    # If another writer holds the lock, wait up to 5 seconds instead of failing
    # instantly with "database is locked".
    conn.execute("PRAGMA busy_timeout = 5000")

    _conn = conn
    return conn


def close():
    """Close the connection. Used by tests that rebuild the database."""
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


# ── Query helpers ─────────────────────────────────────────────────────────────
# Every one of these takes bound parameters. No query in this project is built by
# string concatenation, which is what keeps SQL injection off the table entirely.

def query_all(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    # Locked for the same reason execute() below is: this app holds one
    # sqlite3.Connection object shared across every request-handling thread
    # (check_same_thread=False is what permits that in the first place).
    # WAL mode is what makes concurrent access to the DATABASE FILE safe; it
    # says nothing about calling .execute() on that one shared CONNECTION
    # OBJECT from two threads at the literal same instant, which is its own,
    # separate hazard — SQLite's own error for hitting it is exactly the
    # unhelpful "bad parameter or other API misuse" this used to surface as.
    with _write_lock:
        return connect().execute(sql, params).fetchall()


def query_one(sql: str, params: tuple = ()) -> sqlite3.Row | None:
    with _write_lock:
        return connect().execute(sql, params).fetchone()


def execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    """Run a single write and commit it."""
    conn = connect()
    with _write_lock:
        cursor = conn.execute(sql, params)
        conn.commit()
        return cursor


def get_setting(key: str, default: str | None = None) -> str | None:
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else default


def set_setting(key: str, value: str):
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


class transaction:
    """
    Run several writes so that either all of them land or none do.

        with db.transaction() as tx:
            tx.execute(...)
            tx.execute(...)

    Used wherever a half-finished write would leave broken state — creating a
    chat and its first member, or assigning a message its sequence number.
    """

    def __enter__(self) -> sqlite3.Connection:
        self.conn = connect()
        _write_lock.acquire()
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            _write_lock.release()
        return False


# ── Schema ────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL,
    phone         TEXT NOT NULL DEFAULT '',
    bio           TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '#6366f1',
    avatar_letter TEXT NOT NULL DEFAULT '?',
    password_hash TEXT NOT NULL,
    created_at    REAL NOT NULL,
    last_seen     REAL NOT NULL DEFAULT 0,
    is_bot        INTEGER NOT NULL DEFAULT 0,
    is_superadmin INTEGER NOT NULL DEFAULT 0,

    -- Privacy switches. Kept on the user row because every one of them has to be
    -- checked on read paths that are already loading the user.
    show_last_seen      INTEGER NOT NULL DEFAULT 1,
    show_read_receipts  INTEGER NOT NULL DEFAULT 1,
    show_phone_number   INTEGER NOT NULL DEFAULT 1,

    -- NULL means active. Set when the owner deactivates their own account —
    -- hidden from search/new DMs, but logging back in still works (that's
    -- how you reactivate) rather than being permanently locked out.
    disabled_at         REAL,

    -- NULL means "no real photo, show the letter avatar." Points at a row
    -- in attachments (avatar_of_user_id), the same upload pipeline chat
    -- media already uses.
    avatar_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL
);

-- Usernames are compared case-insensitively. Without this, "Rahul" and "rahul"
-- are two accounts and login becomes ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));


-- One live OTP per phone number, for both first-time signup and changing an
-- existing account's number. A fresh request overwrites the row (ON
-- CONFLICT DO UPDATE in main.py) — requesting a new code invalidates
-- whatever code was issued before it, same as every real OTP flow.
CREATE TABLE IF NOT EXISTS phone_otps (
    phone      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);


-- Same shape and same reasoning as phone_otps above, for connecting and
-- verifying an email address — WhatsApp-style: purely for account recovery
-- (a two-step PIN reset link), never a login credential of its own.
CREATE TABLE IF NOT EXISTS email_otps (
    email      TEXT PRIMARY KEY,
    code_hash  TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);


CREATE TABLE IF NOT EXISTS sessions (
    -- We store a hash of the token, never the token itself. If the database
    -- leaks, the stolen rows cannot be replayed as valid bearer tokens.
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,

    -- What to show in the "linked devices" list. Client-supplied, informational
    -- only — nothing security-relevant depends on this string.
    device_label TEXT NOT NULL DEFAULT 'Unknown device'
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);


-- WhatsApp-Web-style device linking: a new device shows this code (as a QR and
-- as text), an already-signed-in device approves it, and the new device picks
-- up a real session token by polling. `raw_token` is the one place this
-- project stores an unhashed credential at rest — necessary because the new
-- device has no other channel to receive it on, and it is cleared the moment
-- it is delivered, from a row that is one-time-use and expires in minutes.
CREATE TABLE IF NOT EXISTS device_links (
    code                TEXT PRIMARY KEY,
    -- 'pending' -> 'approved' -> 'consumed' (token collected), or 'denied' / 'expired'
    status              TEXT NOT NULL DEFAULT 'pending',
    device_label        TEXT NOT NULL DEFAULT 'New device',
    raw_token           TEXT,
    approved_by_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at          REAL NOT NULL,
    expires_at          REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_links_expiry ON device_links (expires_at);


-- Programmatic sending — the WhatsApp-Business-API equivalent: a key an
-- external script authenticates with to send messages, kept entirely separate
-- from the interactive session-token path so a leaked bulk-sending key cannot
-- be used to read someone's chats, change their profile, or sign in as them.
CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Same principle as sessions: only the hash is stored, so a database leak
    -- cannot be replayed as a working key.
    key_hash     TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL DEFAULT 'API key',
    -- The first few characters, kept in the clear so the owner can tell which
    -- key is which in their list — the full value is shown exactly once, at
    -- creation, and never again.
    key_prefix   TEXT NOT NULL,
    created_at   REAL NOT NULL,
    last_used_at REAL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);


-- The "Automation" pillar's other half: instead of a script pushing
-- messages out through api_keys, this is your own server getting told the
-- instant one arrives — an HTTP POST to `url`, HMAC-signed with `secret` so
-- the receiving end can verify it really came from here.
CREATE TABLE IF NOT EXISTS webhooks (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url                TEXT NOT NULL,
    secret             TEXT NOT NULL,
    created_at         REAL NOT NULL,
    last_triggered_at  REAL,
    last_status        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks (user_id);


-- Saved snippets for the composer's quick-reply picker — a business-account
-- staple (canned answers to the questions that come up every day) that has
-- nothing to do with any one chat, so it lives on the user, not a chat_id.
CREATE TABLE IF NOT EXISTS canned_replies (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canned_replies_user ON canned_replies (user_id);


-- App-wide config the superadmin panel edits at runtime (SMS/email provider
-- credentials) instead of only through env vars set at deploy time. A plain
-- key/value store rather than dedicated columns somewhere, since this is a
-- short, occasionally-growing list of unrelated settings, not one entity's
-- structured fields.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);


-- Business message templates — WhatsApp Business API's idea that a message
-- meant to go out to people who haven't started the conversation needs
-- sign-off first, so a compromised or careless account can't use the bulk
-- API to blast arbitrary text. Any account can propose one; only a
-- superadmin can move it out of 'pending'.
CREATE TABLE IF NOT EXISTS message_templates (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    content     TEXT NOT NULL,
    -- 'pending' | 'approved' | 'rejected'
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  REAL NOT NULL,
    reviewed_at REAL
);

CREATE INDEX IF NOT EXISTS idx_message_templates_user ON message_templates (user_id);
CREATE INDEX IF NOT EXISTS idx_message_templates_status ON message_templates (status);


CREATE TABLE IF NOT EXISTS chats (
    id          TEXT PRIMARY KEY,
    -- 'dm' | 'group' | 'channel' | 'community' | 'community_channel'
    type        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#6366f1',
    avatar_letter TEXT NOT NULL DEFAULT '?',
    owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- Community sub-channels point at their community. NULL for everything else.
    parent_id   TEXT REFERENCES chats(id) ON DELETE CASCADE,

    created_at  REAL NOT NULL,
    is_verified INTEGER NOT NULL DEFAULT 0,

    -- Highest sequence number handed out in this chat. Bumped inside the same
    -- transaction as the message insert so two senders can never collide.
    last_seq    INTEGER NOT NULL DEFAULT 0,

    -- Chat-wide disappearing timer in seconds. NULL means messages persist.
    disappear_secs INTEGER,

    -- Secret chats hold a PIN hash. NULL means the chat is not locked.
    pin_hash    TEXT,

    -- Shareable join code for a private group/channel. NULL until an
    -- owner/admin generates one. High-entropy (secrets.token_urlsafe), so
    -- unlike a chat id it is never enumerable — knowing it IS the permission.
    invite_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats (parent_id);
CREATE INDEX IF NOT EXISTS idx_chats_type ON chats (type);


-- Who a broadcast list (chats.type = 'broadcast') fans out to. Deliberately
-- NOT `chat_members` — a recipient never gets to open or see the broadcast
-- "chat" itself (only the owner has a chat_members row for it, role='owner'),
-- matching real broadcast-list semantics: each recipient only ever sees the
-- fanned-out copy that lands in their own ordinary DM with the sender, and
-- recipients can never see each other or the recipient list.
CREATE TABLE IF NOT EXISTS broadcast_recipients (
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at REAL NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_chat ON broadcast_recipients (chat_id);


CREATE TABLE IF NOT EXISTS chat_members (
    chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 'owner' | 'admin' | 'member' | 'subscriber'
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at REAL NOT NULL,

    -- The read receipt. One integer per member replaces a per-message read
    -- table: "read up to seq N" answers unread counts with a single comparison.
    last_read_seq INTEGER NOT NULL DEFAULT 0,

    -- Unix timestamp until which notifications are silenced. 0 means unmuted.
    muted_until REAL NOT NULL DEFAULT 0,

    is_pinned INTEGER NOT NULL DEFAULT 0,

    -- Telegram-style chat folder this member filed the chat under.
    folder    TEXT NOT NULL DEFAULT '',

    -- Unsent text kept per member so a draft follows you between devices.
    draft     TEXT NOT NULL DEFAULT '',

    -- Archived chats stay out of the main list without being muted or left.
    -- A new message un-archives it, same as WhatsApp — an archive is a "not
    -- right now," not a "never show me this conversation again."
    archived  INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (chat_id, user_id)
);

-- Listing "my chats" is the single most frequent query in the app, so the index
-- is keyed on user first.
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members (user_id);


CREATE TABLE IF NOT EXISTS messages (
    id        TEXT PRIMARY KEY,
    chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,

    -- Position within this chat, starting at 1. A client that reconnects asks
    -- for everything after the last seq it saw, so it replays exactly what it
    -- missed rather than refetching the whole history.
    seq       INTEGER NOT NULL,

    sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,

    -- 'text' | 'photo' | 'voice' | 'document' | 'location' | 'contact' | 'poll' | 'system'
    kind      TEXT NOT NULL DEFAULT 'text',
    text      TEXT NOT NULL DEFAULT '',

    -- Kind-specific payload as JSON: file name, coordinates, poll options.
    -- Kept as one column because nothing queries inside it.
    payload   TEXT,

    reply_to_id    TEXT REFERENCES messages(id) ON DELETE SET NULL,
    forwarded_from TEXT NOT NULL DEFAULT '',

    created_at REAL NOT NULL,
    edited_at  REAL,
    deleted_at REAL,

    -- Set only by the sender retracting their OWN message. Unlike
    -- deleted_at (an owner/admin removing someone else's, which leaves a
    -- "This message was deleted" tombstone for accountability), an unsent
    -- message is fully invisible to everyone but the sender — no tombstone,
    -- no trace it ever existed. The row still survives (same gapless-seq
    -- reasoning as deleted_at) but is filtered out of every read entirely.
    unsent_at  REAL,

    -- When a disappearing message becomes invisible. NULL means it stays.
    expires_at REAL,

    -- Generated by the sender before the request goes out. If the network drops
    -- and the client retries, the UNIQUE index below turns the second insert
    -- into a lookup of the first, so a flaky connection cannot double-post.
    client_msg_id TEXT,

    view_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq
    ON messages (chat_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
    ON messages (chat_id, client_msg_id)
    WHERE client_msg_id IS NOT NULL;

-- Paging a chat backwards from the newest message.
CREATE INDEX IF NOT EXISTS idx_messages_chat_seq_desc
    ON messages (chat_id, seq DESC);

-- Finding messages that are due to disappear.
CREATE INDEX IF NOT EXISTS idx_messages_expiry
    ON messages (expires_at)
    WHERE expires_at IS NOT NULL;


CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at REAL NOT NULL,

    -- One row per person per emoji. The old counter could be incremented
    -- forever by one user and could never be undone.
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id);


CREATE TABLE IF NOT EXISTS poll_votes (
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_index INTEGER NOT NULL,
    created_at   REAL NOT NULL,

    -- One vote per person per poll. Enforced here rather than in application
    -- code so two simultaneous votes cannot both pass a "have you voted" check.
    PRIMARY KEY (message_id, user_id)
);


CREATE TABLE IF NOT EXISTS pinned_messages (
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    pinned_at  REAL NOT NULL,
    PRIMARY KEY (chat_id, message_id)
);


-- "Delete for me": hides a message from one member's own view without
-- touching the shared row, so it stays intact for everyone else and the
-- chat's sequence numbering is never affected by what one person hid for
-- themselves. Distinct from the real delete on `messages.deleted_at`, which
-- is "delete for everyone" and clears the content for the whole chat.
CREATE TABLE IF NOT EXISTS message_hidden_for (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden_at  REAL NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_user ON message_hidden_for (user_id);


CREATE TABLE IF NOT EXISTS stories (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL DEFAULT '',
    emoji      TEXT NOT NULL DEFAULT '',
    background TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,

    -- A status can be queued for later, exactly like a scheduled message.
    -- 'scheduled' -> 'live' -> 'expired', moved along by the scheduler.
    -- 'cancelled' is a user deleting it before it ever went out.
    status     TEXT NOT NULL DEFAULT 'live',

    -- When a scheduled status should go live. NULL means it already is.
    -- expires_at is only meaningful once that has happened, so for a scheduled
    -- status it is written as publish_at + 24h at creation time.
    publish_at REAL,

    -- 'text' | 'photo' | 'video' | 'audio' | 'link'. Text is the original
    -- shape; the rest carry an uploaded file (attachment_id) or a URL
    -- (link_url) alongside the same caption/emoji/background fields.
    kind          TEXT NOT NULL DEFAULT 'text',
    attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
    link_url      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_stories_expiry ON stories (expires_at);

-- The scheduler asks "what is due to publish" on every tick, so lead with status.
CREATE INDEX IF NOT EXISTS idx_stories_due ON stories (status, publish_at);


CREATE TABLE IF NOT EXISTS story_views (
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at REAL NOT NULL,
    PRIMARY KEY (story_id, user_id)
);


-- One reaction per viewer per story, not one row per (story, user, emoji)
-- the way message `reactions` allows several emoji to stack per person —
-- a story reaction is a single quick "how did this land," so sending a new
-- emoji replaces the old one rather than adding a second.
CREATE TABLE IF NOT EXISTS story_reactions (
    story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (story_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_story_reactions_story ON story_reactions (story_id);


CREATE TABLE IF NOT EXISTS scheduled_messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,

    -- Same kind/payload pair as `messages`, so anything you can send now you can
    -- also queue for later rather than only plain text.
    kind       TEXT NOT NULL DEFAULT 'text',
    payload    TEXT,

    send_at    REAL NOT NULL,
    created_at REAL NOT NULL,
    -- 'pending' | 'sent' | 'cancelled' | 'failed'
    status     TEXT NOT NULL DEFAULT 'pending',

    -- Filled in when the scheduler delivers it. Its presence is also what stops
    -- a retry from sending the same thing twice.
    sent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,

    -- Why it failed, when it did. Without this a failed send is invisible.
    error      TEXT NOT NULL DEFAULT ''
);

-- The background sender scans for due rows, so the index leads with send_at.
CREATE INDEX IF NOT EXISTS idx_scheduled_due
    ON scheduled_messages (send_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_sender
    ON scheduled_messages (sender_id);


CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Set when the upload is actually sent as a message. Until then the file is
    -- visible only to whoever uploaded it, and an upload that is never sent gets
    -- swept away by the scheduler.
    message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,

    -- Same idea as message_id, for a status/story photo/video/audio instead
    -- of a chat message. A row is attached to at most one of the three.
    story_id    TEXT REFERENCES stories(id) ON DELETE CASCADE,

    -- Same idea again, for a profile photo. Unlike message/story
    -- attachments (visible only to chat members), an avatar is meant to be
    -- visible to any authenticated user — that's the whole point of a
    -- profile photo — so download_file's authorization branches on this
    -- differently than the other two.
    avatar_of_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,

    -- The name the sender's device used. Display only — it is NEVER used to
    -- build a path, because a name like "../../etc/passwd" would escape the
    -- upload directory. The file on disk is named after the id above.
    file_name    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,

    created_at  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

-- idx_attachments_story and the story-aware version of idx_attachments_orphans
-- are created in _add_missing_columns() instead of here, since they reference
-- the `story_id` column and this script runs (unconditionally, every boot)
-- before that column is guaranteed to exist on a pre-existing database.


CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);


-- Same shape as blocks, but far lighter: muting someone's status only
-- hides their status updates from your own list — it says nothing about
-- being able to message them, call them, or see their profile, unlike a
-- block. One-directional and never announced to the muted person, same as
-- muting a chat.
CREATE TABLE IF NOT EXISTS muted_statuses (
    muter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    PRIMARY KEY (muter_id, muted_id)
);


-- A saved address-book entry, same idea as a phone's contacts app: a name you
-- picked plus a phone number, independent of whether that number is on
-- TalkEx yet. Resolved against `users.phone` on read to show "on
-- TalkEx" (with a real profile to open) versus a plain phone-only entry.
CREATE TABLE IF NOT EXISTS contacts (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts (owner_id);

-- One entry per phone number per address book, same as a real contacts app
-- refusing to save the same number twice under a different name silently.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_owner_phone ON contacts (owner_id, phone);


CREATE TABLE IF NOT EXISTS meetings (
    id       TEXT PRIMARY KEY,

    -- A meeting always belongs to a chat. That is what decides who may see it
    -- and who gets reminded, so there is no separate invitee-permission system.
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    host_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    title    TEXT NOT NULL,
    agenda   TEXT NOT NULL DEFAULT '',

    starts_at    REAL NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 30,
    join_url     TEXT NOT NULL DEFAULT '',

    -- 'scheduled' -> 'live' -> 'ended', or 'cancelled' at any point.
    status       TEXT NOT NULL DEFAULT 'scheduled',

    -- Minutes before the start to send the reminder.
    reminder_min INTEGER NOT NULL DEFAULT 10,

    -- Stamped the moment the reminder goes out. Checking it is NULL is what
    -- keeps a restart from re-sending a reminder that already went.
    reminded_at  REAL,

    -- The card posted into the chat when the meeting was created, so the card
    -- can be updated in place when the meeting starts, ends or is cancelled.
    message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,

    created_at   REAL NOT NULL
);

-- Both scheduler passes (reminders, and flipping to live/ended) scan by status
-- and time, so this index carries the whole background loop.
CREATE INDEX IF NOT EXISTS idx_meetings_due ON meetings (status, starts_at);
CREATE INDEX IF NOT EXISTS idx_meetings_chat ON meetings (chat_id, starts_at);


CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- 'pending' | 'going' | 'maybe' | 'declined'
    response     TEXT NOT NULL DEFAULT 'pending',
    responded_at REAL,

    PRIMARY KEY (meeting_id, user_id)
);

-- "What am I invited to this week" reads by user.
CREATE INDEX IF NOT EXISTS idx_participants_user ON meeting_participants (user_id);


-- A personal bookmark, distinct from a chat's shared `pinned_messages`: a
-- star is visible only to the person who set it, on any message in any chat
-- they are a member of, and never shown to anyone else.
CREATE TABLE IF NOT EXISTS message_stars (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    starred_at REAL NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

-- "All of my starred messages, newest first" is the only read pattern.
CREATE INDEX IF NOT EXISTS idx_stars_user ON message_stars (user_id, starred_at);


-- A browser's Push API subscription. `endpoint` is the push service's own
-- unique URL for this browser+device+origin, so it doubles as the natural
-- dedup key — re-subscribing (a new tab, a cleared service worker) replaces
-- the old row for the same endpoint rather than piling up duplicates.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions (endpoint);

-- The exception/inclusion set behind users.story_audience — only meaningful
-- when that mode is 'except' or 'only'; a plain 'contacts' user has no rows
-- here at all. One shared table for both modes since a row is never read
-- without also knowing which mode it belongs to.
CREATE TABLE IF NOT EXISTS story_audience_list (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    other_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, other_user_id)
);

-- A person flagging a user, chat, or single message for review. Reports are
-- never surfaced back to the person reported — this is a one-way signal for
-- whoever moderates the platform, not a dispute the two sides see.
CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    reason      TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);

CREATE TABLE IF NOT EXISTS e2ee_one_time_keys (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_e2ee_otk_user ON e2ee_one_time_keys (user_id);
"""


def init():
    """Create the schema. Safe to call on every boot — every statement is IF NOT EXISTS."""
    conn = connect()
    with _write_lock:
        conn.executescript(SCHEMA)
        conn.commit()
    _add_missing_columns(conn)
    _backfill_avatar_colors(conn)
    _build_search_index(conn)


# Columns added to tables that shipped in an earlier version.
#
# `CREATE TABLE IF NOT EXISTS` does nothing at all when the table already
# exists, so a database created before these columns were added would keep the
# old shape and every query naming them would fail at runtime. ALTER TABLE ADD
# COLUMN is cheap in SQLite (it rewrites no rows), so we just make sure each one
# is present on every boot.
COLUMNS_ADDED_LATER = [
    ("stories", "status", "TEXT NOT NULL DEFAULT 'live'"),
    ("stories", "publish_at", "REAL"),
    ("scheduled_messages", "kind", "TEXT NOT NULL DEFAULT 'text'"),
    ("scheduled_messages", "payload", "TEXT"),
    ("scheduled_messages", "sent_message_id", "TEXT"),
    ("scheduled_messages", "error", "TEXT NOT NULL DEFAULT ''"),
    ("sessions", "device_label", "TEXT NOT NULL DEFAULT 'Unknown device'"),
    ("users", "two_step_pin_hash", "TEXT"),
    ("users", "two_step_recovery_codes", "TEXT"),
    ("chats", "invite_code", "TEXT"),
    ("chat_members", "archived", "INTEGER NOT NULL DEFAULT 0"),
    ("users", "show_phone_number", "INTEGER NOT NULL DEFAULT 1"),
    ("messages", "unsent_at", "REAL"),
    ("users", "disabled_at", "REAL"),
    ("users", "avatar_attachment_id", "TEXT"),
    ("attachments", "avatar_of_user_id", "TEXT"),
    ("stories", "kind", "TEXT NOT NULL DEFAULT 'text'"),
    ("stories", "attachment_id", "TEXT"),
    ("stories", "link_url", "TEXT NOT NULL DEFAULT ''"),
    ("attachments", "story_id", "TEXT"),
    ("stories", "font", "TEXT NOT NULL DEFAULT 'system'"),
    ("stories", "font_size", "TEXT NOT NULL DEFAULT 'medium'"),
    ("chats", "slow_mode_secs", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "view_once", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "silent", "INTEGER NOT NULL DEFAULT 0"),
    ("messages", "view_once_opened_at", "REAL"),
    ("users", "email", "TEXT NOT NULL DEFAULT ''"),
    # NULL until the email above has actually been verified — the same
    # "connected but not yet confirmed" gap a pending email address needs
    # (a request-otp call stages nothing on the user row at all; this is
    # only ever written by a successful confirm).
    ("users", "email_verified_at", "REAL"),
    # When this user last opened the Calls tab — a single watermark rather
    # than per-call read state, since the call log is already a cross-chat
    # view rather than one conversation with its own seq/last_read_seq pair.
    ("users", "calls_seen_at", "REAL NOT NULL DEFAULT 0"),
    # WhatsApp Business's "away message" — an ordinary text auto-reply sent
    # from this user's own account when a DM lands and they've turned it on.
    ("users", "away_enabled", "INTEGER NOT NULL DEFAULT 0"),
    ("users", "away_message", "TEXT NOT NULL DEFAULT ''"),
    # Set automatically on login when the username matches SUPERADMIN_USERNAME
    # — see main.py's ensure_superadmin(). Nothing else ever sets this.
    ("users", "is_superadmin", "INTEGER NOT NULL DEFAULT 0"),
    # Global "Calling" privacy switch (Settings > Privacy). Off means this
    # user can neither be called nor place calls anywhere — see
    # calling_permitted() in main.py. Meetings never check this; they don't
    # route through the calling system at all.
    ("users", "calling_enabled", "INTEGER NOT NULL DEFAULT 1"),
    # Per-membership override: calling can be on globally but switched off
    # for one specific chat. Defaults on so nothing changes for anyone who
    # never touches the setting.
    ("chat_members", "calls_enabled", "INTEGER NOT NULL DEFAULT 1"),
    # A lighter-weight shortlist than folders — one tap, no naming a list,
    # surfaces in its own filter tab. Independent of is_pinned; a chat can
    # be both, either, or neither.
    ("chat_members", "is_favorite", "INTEGER NOT NULL DEFAULT 0"),
    # 'contacts' (everyone you share a chat with, the long-standing default)
    # | 'except' (that, minus story_audience_list) | 'only' (nobody except
    # story_audience_list).
    ("users", "story_audience", "TEXT NOT NULL DEFAULT 'contacts'"),
    # Off (the default) is "auto join" — anyone permitted to call in this
    # chat lands straight in the room, same as before this existed at all.
    # On means anyone who isn't the host lands in a holding state until the
    # host admits them — see group_call_join_request/_admit/_deny in main.py.
    ("meetings", "waiting_room", "INTEGER NOT NULL DEFAULT 0"),
    # NULL means no password set. Checked the same way a two-step PIN is —
    # hashed at rest, never the raw text.
    ("meetings", "password_hash", "TEXT"),
    # Per-member, Instagram-"Vanish mode"-style opt-in: when on, leaving
    # this chat (see /chats/{id}/leave-view in main.py) hides every message
    # this member has already read — a one-sided view preference, not a
    # shared/mutual chat setting, so turning it on never affects what the
    # other member(s) see of their own history.
    ("chat_members", "vanish_mode", "INTEGER NOT NULL DEFAULT 0"),
    # WhatsApp-style forwarding control: off by default, meaning only the
    # story's own author can forward/share it anywhere. The author turns
    # this on per-story (not a standing account setting) to let whoever
    # views it re-share it too — see forward_story/_share checks in main.py.
    ("stories", "allow_share", "INTEGER NOT NULL DEFAULT 0"),
    # Off by default — a linked device stays signed in for the normal
    # SESSION_TTL_SECONDS (30 days), same as every session always has. When
    # a user turns this on for a specific device (Settings > Linked
    # devices), that one session's expires_at is pulled in to 4 hours out
    # instead, and turning it back off restores the normal long expiry —
    # see toggle_session_short_lived in main.py.
    ("sessions", "short_lived", "INTEGER NOT NULL DEFAULT 0"),
    # Social / external profile links — shown on the user's profile card.
    ("users", "link_website", "TEXT NOT NULL DEFAULT ''"),
    ("users", "link_facebook", "TEXT NOT NULL DEFAULT ''"),
    ("users", "link_instagram", "TEXT NOT NULL DEFAULT ''"),
    ("users", "link_twitter", "TEXT NOT NULL DEFAULT ''"),
    ("users", "link_youtube", "TEXT NOT NULL DEFAULT ''"),
    ("users", "link_linkedin", "TEXT NOT NULL DEFAULT ''"),
    # E2EE public keys — stored as base64-encoded strings.
    # The private keys NEVER leave the client device.
    ("users", "e2ee_identity_key", "TEXT NOT NULL DEFAULT ''"),
    ("users", "e2ee_signed_pre_key", "TEXT NOT NULL DEFAULT ''"),
]


def _add_missing_columns(conn: sqlite3.Connection):
    with _write_lock:
        for table, column, definition in COLUMNS_ADDED_LATER:
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        # Only safe here, after the loop above has guaranteed the column
        # exists — creating this index inside SCHEMA (which runs first, on
        # every boot) would fail on a database old enough to still be missing
        # `invite_code` at that point.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chats_invite_code ON chats (invite_code)")
        # Same reasoning for `story_id`, added to `attachments` after it first shipped.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_story ON attachments (story_id)")
        # Same again for `avatar_of_user_id`.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attachments_avatar ON attachments (avatar_of_user_id)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attachments_orphans ON attachments (created_at) "
            "WHERE message_id IS NULL AND story_id IS NULL AND avatar_of_user_id IS NULL"
        )
        conn.commit()


# Same spread main.py's register endpoint now picks new accounts' colors
# from — duplicated here rather than imported, since db.py must not depend
# on main.py (main.py already depends on db.py; the reverse would be
# circular). This is the exact class of "reasonable to duplicate a few
# lines rather than force an import direction" already used elsewhere in
# this file (see the deterministic-DM-id logic repeated in main.py itself).
_AVATAR_PALETTE = [
    "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#0ea5e9",
    "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#84cc16",
]


def _backfill_avatar_colors(conn: sqlite3.Connection):
    """
    One-time fixup for accounts created before per-account colors existed —
    every one of them got the exact same hardcoded '#6366f1', which is
    indistinguishable from every other letter avatar in a chat. Since color
    was never actually user-editable anywhere in the app, any account still
    sitting on that literal default is safe to assume it was never a
    deliberate choice.
    """
    with _write_lock:
        stuck = conn.execute(
            "SELECT id FROM users WHERE color = '#6366f1'").fetchall()
        for row in stuck:
            color = _AVATAR_PALETTE[sum(row["id"].encode()) % len(_AVATAR_PALETTE)]
            conn.execute("UPDATE users SET color = ? WHERE id = ?", (color, row["id"]))
        conn.commit()


def _build_search_index(conn: sqlite3.Connection):
    """
    Full-text search over message text.

    This is separate from SCHEMA because FTS5 is a compile-time option. Most
    Python builds ship with it, but if this one does not we fall back to LIKE
    scanning rather than refusing to boot. search_available() tells the API
    layer which path to take.
    """
    global _fts_available
    try:
        with _write_lock:
            conn.executescript("""
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
                    text,
                    content = 'messages',
                    content_rowid = 'rowid'
                );

                -- Keep the index in step with the table. Doing this in triggers
                -- means no code path can insert a message and forget to index it.
                CREATE TRIGGER IF NOT EXISTS messages_fts_insert
                AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
                END;

                CREATE TRIGGER IF NOT EXISTS messages_fts_delete
                AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts (messages_fts, rowid, text)
                    VALUES ('delete', old.rowid, old.text);
                END;

                CREATE TRIGGER IF NOT EXISTS messages_fts_update
                AFTER UPDATE OF text ON messages BEGIN
                    INSERT INTO messages_fts (messages_fts, rowid, text)
                    VALUES ('delete', old.rowid, old.text);
                    INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
                END;
            """)
            conn.commit()
        _fts_available = True
    except sqlite3.OperationalError:
        # FTS5 not compiled into this SQLite build.
        _fts_available = False


_fts_available = False


def search_available() -> bool:
    return _fts_available
