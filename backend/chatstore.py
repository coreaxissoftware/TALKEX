"""
Writing and reading messages.

This lives apart from the HTTP layer because two different callers need it: a
person pressing send, and the background scheduler delivering something that was
queued earlier. Putting it here keeps the sequence-number and de-duplication
rules in one place, so a scheduled message is stored by exactly the same code
path as a live one.
"""

import json
import sqlite3
import time
import uuid

import db


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ── Membership ────────────────────────────────────────────────────────────────

def is_member(chat_id: str, user_id: str) -> bool:
    """
    Whether a user belongs to a chat.

    Every read and write path calls this. The old server had no equivalent: any
    logged-in account could fetch any chat's messages by guessing its id.
    """
    row = db.query_one(
        "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?",
        (chat_id, user_id),
    )
    return row is not None


def shares_chat_with(user_a: str, user_b: str) -> bool:
    """
    Whether two accounts are both members of at least one chat.

    This is the same "who's a contact" rule /stories already uses to decide
    whose statuses show up in your feed — used again to gate access to a
    status's photo/video/audio file, since a random attachment id is not
    access control on its own.
    """
    row = db.query_one(
        """
        SELECT 1 FROM chat_members AS mine
        JOIN chat_members AS other ON other.chat_id = mine.chat_id
        WHERE mine.user_id = ? AND other.user_id = ?
        LIMIT 1
        """,
        (user_a, user_b),
    )
    return row is not None


def reassign_owner_if_needed(chat_id: str, leaving_user_id: str):
    """
    Hand off ownership when the owner leaves.

    Without this, a group whose owner leaves keeps `owner_id` pointing at
    someone no longer in `chat_members` — nobody can promote an admin, remove a
    member, or manage the chat again, forever. Call this after the DELETE that
    removes the leaving member, so the successor query cannot pick them back up.

    Does nothing if the person leaving was not the owner — an ordinary member
    leaving is not an ownership event.
    """
    chat = db.query_one("SELECT owner_id FROM chats WHERE id = ?", (chat_id,))
    if chat is None or chat["owner_id"] != leaving_user_id:
        return None

    # Prefer promoting an existing admin — they already have management
    # standing in the chat. Among equals, whoever joined first.
    successor = db.query_one(
        """
        SELECT user_id FROM chat_members
        WHERE chat_id = ?
        ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC
        LIMIT 1
        """,
        (chat_id,),
    )

    if successor is None:
        # Nobody is left to hand it to. An ownerless chat with zero members
        # governs nothing, so this is not a broken state — just an empty one.
        db.execute("UPDATE chats SET owner_id = NULL WHERE id = ?", (chat_id,))
        return None

    with db.transaction() as conn:
        conn.execute("UPDATE chats SET owner_id = ? WHERE id = ?",
                     (successor["user_id"], chat_id))
        conn.execute("UPDATE chat_members SET role = 'owner' WHERE chat_id = ? AND user_id = ?",
                     (chat_id, successor["user_id"]))

    return successor["user_id"]


def member_role(chat_id: str, user_id: str) -> str | None:
    row = db.query_one(
        "SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?",
        (chat_id, user_id),
    )
    return row["role"] if row else None


# ── Writing ───────────────────────────────────────────────────────────────────

def insert_message(
    chat_id: str,
    sender_id: str,
    text: str = "",
    kind: str = "text",
    payload: dict | None = None,
    reply_to_id: str | None = None,
    client_msg_id: str | None = None,
    disappear_secs: int | None = None,
    forwarded_from: str = "",
    view_once: bool = False,
    silent: bool = False,
) -> tuple[dict, bool]:
    """
    Store one message and return it, plus whether it was newly created.

    The `False` case is the de-duplication path: if the sender already used this
    client_msg_id in this chat, we return the message that exists instead of
    writing a second one. That is what makes a retry over a flaky connection
    safe — the client can send the same request as many times as it likes.

    The sequence number and the message insert happen in one transaction. If
    they did not, two people sending at the same instant could read the same
    `last_seq` and both claim it, and the UNIQUE index on (chat_id, seq) would
    reject one of their messages outright.
    """
    now = time.time()

    # Work out when this message disappears, if it does. A per-message timer
    # wins over the chat-wide one so you can send a single self-destructing note
    # in a chat that otherwise keeps history.
    if disappear_secs is None:
        chat = db.query_one("SELECT disappear_secs FROM chats WHERE id = ?", (chat_id,))
        disappear_secs = chat["disappear_secs"] if chat else None
    expires_at = now + disappear_secs if disappear_secs else None

    message_id = new_id("msg")

    try:
        with db.transaction() as conn:
            # BEGIN IMMEDIATE in db.transaction() already took the write lock, so
            # nobody else can read last_seq between this line and the update.
            row = conn.execute(
                "SELECT last_seq FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()
            if row is None:
                raise LookupError("chat not found")

            seq = row["last_seq"] + 1
            conn.execute("UPDATE chats SET last_seq = ? WHERE id = ?", (seq, chat_id))

            conn.execute(
                """
                INSERT INTO messages (
                    id, chat_id, seq, sender_id, kind, text, payload,
                    reply_to_id, forwarded_from, created_at, expires_at, client_msg_id,
                    view_once, silent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id, chat_id, seq, sender_id, kind, text,
                    json.dumps(payload) if payload else None,
                    reply_to_id, forwarded_from, now, expires_at, client_msg_id,
                    1 if view_once else 0, 1 if silent else 0,
                ),
            )
    except sqlite3.IntegrityError:
        # The only unique constraint a caller can trip is (chat_id, client_msg_id).
        # Hitting it means this exact message was already accepted, so hand back
        # the original rather than reporting an error the client cannot act on.
        if client_msg_id:
            existing = db.query_one(
                "SELECT * FROM messages WHERE chat_id = ? AND client_msg_id = ?",
                (chat_id, client_msg_id),
            )
            if existing:
                return serialise_message(existing), False
        raise

    stored = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    return serialise_message(stored), True


def hide_for_user(message_id: str, user_id: str):
    """
    "Delete for me." Only affects what this one user sees — the row, its text,
    and its seq position are untouched for every other member.
    """
    db.execute(
        "INSERT OR IGNORE INTO message_hidden_for (message_id, user_id, hidden_at) VALUES (?, ?, ?)",
        (message_id, user_id, time.time()),
    )


def clear_chat_for_user(chat_id: str, user_id: str) -> int:
    """
    "Clear chat" — hide every message currently in the chat for this one
    user, same one-sided mechanism as hide_for_user, just applied to the
    whole history at once rather than one message. A message that arrives
    AFTER this call is unaffected (clearing is a snapshot, not a standing
    rule) — same distinction WhatsApp's own "Clear chat" makes from leaving
    or deleting the conversation.
    """
    now = time.time()
    changed = db.execute(
        """
        INSERT OR IGNORE INTO message_hidden_for (message_id, user_id, hidden_at)
        SELECT id, ?, ? FROM messages WHERE chat_id = ?
        """,
        (user_id, now, chat_id),
    )
    return changed.rowcount


def vanish_seen_messages_for_user(chat_id: str, user_id: str) -> int:
    """
    Vanish mode's actual effect: hide every message this member has
    already read (seq <= their own last_read_seq), the moment they leave
    the chat — so the NEXT time they open it, everything they'd already
    seen is gone, same one-sided message_hidden_for mechanism
    clear_chat_for_user uses for "Clear chat."

    Scoped to last_read_seq rather than the whole history (unlike Clear
    chat): a message that arrived while this member was elsewhere and
    hasn't been read yet must still be there to actually read — vanishing
    it before it was ever seen would make the chat feel broken rather than
    private.
    """
    now = time.time()
    changed = db.execute(
        """
        INSERT OR IGNORE INTO message_hidden_for (message_id, user_id, hidden_at)
        SELECT m.id, ?, ?
        FROM messages AS m
        JOIN chat_members AS cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
        WHERE m.chat_id = ? AND m.seq <= cm.last_read_seq
        """,
        (user_id, now, user_id, chat_id),
    )
    return changed.rowcount


def set_last_read(chat_id: str, user_id: str, seq: int):
    """
    Move a member's read marker forward.

    Deliberately never moves backwards: an out-of-order request from a second
    device would otherwise resurrect messages the user has already seen.
    """
    db.execute(
        """
        UPDATE chat_members
        SET last_read_seq = ?
        WHERE chat_id = ? AND user_id = ? AND last_read_seq < ?
        """,
        (seq, chat_id, user_id, seq),
    )


def set_last_delivered(chat_id: str, user_id: str, seq: int):
    """Move a member's DELIVERY marker forward (never backwards), same rule as
    the read marker one step earlier in a message's life."""
    db.execute(
        """
        UPDATE chat_members
        SET last_delivered_seq = ?
        WHERE chat_id = ? AND user_id = ? AND last_delivered_seq < ?
        """,
        (seq, chat_id, user_id, seq),
    )


def mark_all_delivered(user_id: str) -> list[tuple[str, int]]:
    """
    Mark every chat this user is a member of as delivered up to its newest
    message — called the moment they (re)connect a socket, so anything sent
    while they were offline flips from a single to a double tick. Returns the
    (chat_id, seq) pairs that actually advanced, so the caller can tell just
    those chats' senders to refresh their ticks (and skips broadcasting for
    chats that were already fully delivered).
    """
    behind = db.query_all(
        """
        SELECT m.chat_id AS chat_id, c.last_seq AS last_seq
        FROM chat_members m
        JOIN chats c ON c.id = m.chat_id
        WHERE m.user_id = ? AND m.last_delivered_seq < c.last_seq
        """,
        (user_id,),
    )
    advanced: list[tuple[str, int]] = []
    for row in behind:
        db.execute(
            """
            UPDATE chat_members
            SET last_delivered_seq = ?
            WHERE chat_id = ? AND user_id = ? AND last_delivered_seq < ?
            """,
            (row["last_seq"], row["chat_id"], user_id, row["last_seq"]),
        )
        advanced.append((row["chat_id"], row["last_seq"]))
    return advanced


# ── Reading ───────────────────────────────────────────────────────────────────

def serialise_message(row, viewer_id: str = "", reactions=None) -> dict:
    """
    Turn a database row into the shape the client expects.

    A deleted message keeps its row so the sequence numbering stays gapless —
    the text is blanked here instead, and the client renders a tombstone.

    `reactions` can be passed in when the caller has already fetched them in
    bulk. Left out, this falls back to one query for this message, which is
    correct but is the N+1 pattern when serialising a whole page.
    """
    if row is None:
        return {}

    message = dict(row)

    if message.get("payload"):
        message["payload"] = json.loads(message["payload"])

    # Expand an attachment id into what the client needs to render it, so a page
    # of messages does not turn into one metadata request per image.
    payload = message.get("payload")
    if payload and payload.get("attachment_id"):
        details = attachment_details(payload["attachment_id"])
        if details:
            message["payload"] = {**payload, **details}

    if message.get("deleted_at"):
        message["text"] = ""
        message["payload"] = None

    # A view-once photo/video is only ever rendered for the recipient on the
    # single request that opens it (see download_file in main.py, which
    # stamps view_once_opened_at right before serving the file). A view-once
    # TEXT message has no separate "open" request to hang that stamp on —
    # main.py's mark_read stamps it instead, the moment the recipient
    # actually reads it, since there's nothing else to tap.
    # Every read after that — including the sender's own, so they can't
    # replay it either — gets the content stripped, same as an expired
    # disappearing message. Blanking `text` too (not just `payload`) matters
    # for BOTH cases: a view-once text message's content lives in `text`
    # with no payload at all, and a view-once photo can carry a caption in
    # `text` that used to keep leaking forever after the photo itself was
    # already gone.
    if message.get("view_once") and message.get("view_once_opened_at"):
        message["text"] = ""
        message["payload"] = None
        message["view_once_consumed"] = True

    # A disappearing message that is past its deadline is treated as gone even
    # if the sweep has not run yet, so a client polling at the wrong moment can
    # never see expired content.
    expires_at = message.get("expires_at")
    if expires_at and expires_at <= time.time():
        message["text"] = ""
        message["payload"] = None
        message["expired"] = True

    message["reactions"] = (
        reactions if reactions is not None
        else reactions_for(message["id"], viewer_id)
    )
    return message


def attachment_details(attachment_id: str) -> dict | None:
    """
    Display metadata for an attachment.

    Queried here rather than imported from uploads.py so this module keeps
    depending only on the database. The `inline` flag decides whether a client
    renders the file or shows a download row.
    """
    row = db.query_one(
        "SELECT file_name, content_type, size_bytes FROM attachments WHERE id = ?",
        (attachment_id,),
    )
    if row is None:
        return None
    return {
        "file_name": row["file_name"],
        "content_type": row["content_type"],
        "size_bytes": row["size_bytes"],
    }


def drop_attachments_for(message_id: str):
    """
    Delete the files belonging to a message.

    Called when a message is deleted or disappears. Without it a disappearing
    photo vanishes from the conversation while the image file stays on disk and
    remains downloadable by anyone who noted its id — which is not what
    "disappearing" is understood to mean.
    """
    rows = db.query_all("SELECT id FROM attachments WHERE message_id = ?", (message_id,))
    if not rows:
        return

    # Imported here rather than at module scope: uploads.py is about the
    # filesystem, and only this one function needs it.
    import uploads

    for row in rows:
        uploads.delete(row["id"])


def drop_attachments_for_story(story_id: str):
    """Same rule as drop_attachments_for, for a status/story's photo/video/audio."""
    rows = db.query_all("SELECT id FROM attachments WHERE story_id = ?", (story_id,))
    if not rows:
        return

    import uploads

    for row in rows:
        uploads.delete(row["id"])


def reactions_for_many(message_ids: list[str], viewer_id: str = "") -> dict[str, list[dict]]:
    """
    Reactions for a whole page of messages in one query.

    Serialising 50 messages used to mean 50 separate reaction queries. Reading a
    chat is the most frequent thing this app does, so that multiplier was the
    single worst cost on the read path.
    """
    if not message_ids:
        return {}

    placeholders = ",".join("?" for _ in message_ids)
    rows = db.query_all(
        f"SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({placeholders})",
        tuple(message_ids),
    )

    grouped: dict[str, dict[str, dict]] = {}
    for row in rows:
        by_emoji = grouped.setdefault(row["message_id"], {})
        entry = by_emoji.setdefault(row["emoji"], {"emoji": row["emoji"], "count": 0, "mine": False})
        entry["count"] += 1
        if row["user_id"] == viewer_id:
            entry["mine"] = True

    return {
        message_id: sorted(by_emoji.values(), key=lambda e: -e["count"])
        for message_id, by_emoji in grouped.items()
    }


def reactions_for(message_id: str, viewer_id: str = "") -> list[dict]:
    """
    Reactions grouped by emoji, with a flag for whether the viewer is in each.

    The old shape was {emoji: count}, which could not answer "did I react?" and
    so could never be undone by tapping again.
    """
    rows = db.query_all(
        "SELECT emoji, user_id FROM reactions WHERE message_id = ?",
        (message_id,),
    )

    grouped: dict[str, dict] = {}
    for row in rows:
        entry = grouped.setdefault(row["emoji"], {"emoji": row["emoji"], "count": 0, "mine": False})
        entry["count"] += 1
        if row["user_id"] == viewer_id:
            entry["mine"] = True

    return sorted(grouped.values(), key=lambda e: -e["count"])


def load_messages(chat_id: str, viewer_id: str, limit: int = 50,
                  before_seq: int | None = None, after_seq: int | None = None) -> list[dict]:
    """
    Read a page of a chat.

    Two directions, because they answer different questions:

      before_seq  scrolling up through history, newest page first
      after_seq   catching up after a reconnect — "what did I miss since seq N"

    The old endpoint returned every message in the chat on every open, which got
    slower for the whole lifetime of the conversation.
    """
    limit = max(1, min(limit, 200))

    # Excludes anything this viewer deleted for themselves (a NOT IN subquery
    # scoped to viewer_id, not a WHERE on the messages table itself — the
    # same row must still show normally to every other member) AND anything
    # the sender unsent (a flat WHERE, since an unsent message is invisible
    # to literally everyone, sender included — unlike deleted_at, there is no
    # per-viewer exception here).
    hidden_clause = (
        "AND m.unsent_at IS NULL "
        "AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)"
    )

    if after_seq is not None:
        rows = db.query_all(
            f"""
            SELECT m.* FROM messages m
            WHERE m.chat_id = ? AND m.seq > ? {hidden_clause}
            ORDER BY m.seq ASC
            LIMIT ?
            """,
            (chat_id, after_seq, viewer_id, limit),
        )
    elif before_seq is not None:
        rows = db.query_all(
            f"""
            SELECT m.* FROM messages m
            WHERE m.chat_id = ? AND m.seq < ? {hidden_clause}
            ORDER BY m.seq DESC
            LIMIT ?
            """,
            (chat_id, before_seq, viewer_id, limit),
        )
        rows = list(reversed(rows))
    else:
        rows = db.query_all(
            f"""
            SELECT m.* FROM messages m
            WHERE m.chat_id = ? {hidden_clause}
            ORDER BY m.seq DESC
            LIMIT ?
            """,
            (chat_id, viewer_id, limit),
        )
        rows = list(reversed(rows))

    # One reactions query for the whole page instead of one per message.
    reactions = reactions_for_many([row["id"] for row in rows], viewer_id)
    return [
        serialise_message(row, viewer_id, reactions.get(row["id"], []))
        for row in rows
    ]
