"""
The background scheduler.

Four features need something to happen at a time nobody is around to trigger:

    scheduled messages   send the text when the moment arrives
    scheduled status     publish it, then retire it 24 hours later
    meetings             remind everyone beforehand, then mark it live and ended
    disappearing         blank a message once its timer runs out

The first version of TalkEx had all four in the UI and none of them running.
A scheduled message was written to a dict and never looked at again; a
disappearing message disappeared only in the sense that the client stopped
drawing it. Everything below is one loop that reads what is due out of SQLite.

Two properties matter more than anything else here:

  It survives a restart.
      Due work is a query, not a timer object. A process that has been asleep
      for an hour wakes up, asks what is overdue, and catches up.

  It never sends twice.
      Every pass claims its rows with a conditional UPDATE before acting, and
      only proceeds if that UPDATE actually changed a row. If two ticks overlap,
      or the process dies between claiming and sending, the worst case is a
      message that is not sent — never one that is sent twice.
"""

import asyncio
import json
import time
import traceback

import chatstore
import db
from realtime import hub

# How often to look for due work. Five seconds is comfortably precise for
# "schedule this for 9am" while costing four indexed queries per tick.
TICK_SECONDS = 5.0

# How many items one pass will handle. A backlog is worked through over
# consecutive ticks rather than in one burst that blocks the event loop.
BATCH_LIMIT = 100

_task: asyncio.Task | None = None


def start():
    """Launch the loop. Called from the app's startup hook."""
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_run())
    return _task


async def stop():
    """Stop the loop. Called on shutdown and by tests."""
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    _task = None


async def _run():
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            # One bad row must not take the loop down with it. If this ever
            # stopped, every scheduled message and meeting reminder would
            # silently stop firing, which is far worse than a noisy log.
            traceback.print_exc()
        await asyncio.sleep(TICK_SECONDS)


async def tick(now: float | None = None):
    """
    One pass over everything that might be due.

    Exposed separately from the loop so tests can run a single pass at a chosen
    time instead of sleeping and hoping.
    """
    now = now if now is not None else time.time()
    await send_due_messages(now)
    await publish_due_stories(now)
    await expire_stories(now)
    await run_meetings(now)
    await expire_messages(now)
    purge_expired_sessions(now)
    sweep_orphan_uploads()


def sweep_orphan_uploads():
    """
    Remove files that were uploaded but never sent.

    Picking a file and then changing your mind leaves bytes on disk that no
    message points at. An hour is generous enough that a slow upload followed by
    a slow send is never caught by it.
    """
    import uploads
    uploads.sweep_orphans(older_than_seconds=3600)


def purge_expired_sessions(now: float):
    """
    Delete session rows that have already expired.

    Authentication rejects them anyway, so this is housekeeping rather than a
    security fix — without it the table grows for the life of the deployment and
    every login adds a row that is never removed.
    """
    db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))

    # Device-link codes are only useful for LINK_CODE_TTL_SECONDS (3 minutes).
    # 'approved' is deliberately NOT swept here even though the approver is
    # done with it — the new device has not necessarily polled yet to collect
    # its token. Sweeping on status alone would delete that token out from
    # under a device that just hasn't made its next request yet. Only truly
    # expired rows, or ones already fully resolved (denied / consumed), are
    # safe to remove — 'approved' waits for its own expires_at like anything
    # else.
    db.execute(
        "DELETE FROM device_links WHERE expires_at <= ? OR status IN ('denied', 'consumed')",
        (now,),
    )


# ── Scheduled messages ────────────────────────────────────────────────────────

async def send_due_messages(now: float):
    due = db.query_all(
        """
        SELECT * FROM scheduled_messages
        WHERE status = 'pending' AND send_at <= ?
        ORDER BY send_at ASC
        LIMIT ?
        """,
        (now, BATCH_LIMIT),
    )

    for item in due:
        # A burst of due work (many scheduled sends landing in the same
        # 5-second window) would otherwise run its synchronous db.execute()
        # calls back-to-back with no guaranteed yield point until the first
        # `await` further down — this hands control back to the event loop
        # once per item up front, so live request/websocket traffic isn't
        # starved for the whole batch's duration.
        await asyncio.sleep(0)

        # Claim it first. The WHERE clause repeats status = 'pending', so if
        # another tick got here first this updates nothing and we skip.
        claimed = db.execute(
            "UPDATE scheduled_messages SET status = 'sent' WHERE id = ? AND status = 'pending'",
            (item["id"],),
        )
        if claimed.rowcount == 0:
            continue

        try:
            # The sender may have left the chat between scheduling and sending.
            # Delivering anyway would let someone post to a group they were
            # removed from, simply by queueing it beforehand.
            if not chatstore.is_member(item["chat_id"], item["sender_id"]):
                raise PermissionError("sender is no longer a member of this chat")

            payload = json.loads(item["payload"]) if item["payload"] else None
            message, _ = chatstore.insert_message(
                chat_id=item["chat_id"],
                sender_id=item["sender_id"],
                text=item["text"],
                kind=item["kind"] or "text",
                payload=payload,
            )

            attachment_id = (payload or {}).get("attachment_id")
            if attachment_id:
                # Same two-step bind send_message does — the upload landed
                # first, pending, when the message was only scheduled; now
                # that a real message row exists, actually claim it. Without
                # this the file's attachments row keeps message_id NULL
                # forever, and download_file only ever lets the original
                # uploader see it — nobody else in the chat could open a
                # scheduled photo/video/document once it "arrived."
                import uploads
                uploads.attach_to_message(attachment_id, message["id"], item["sender_id"])
                message = chatstore.serialise_message(
                    db.query_one("SELECT * FROM messages WHERE id = ?", (message["id"],)),
                    item["sender_id"],
                )

            db.execute(
                "UPDATE scheduled_messages SET sent_message_id = ? WHERE id = ?",
                (message["id"], item["id"]),
            )

            await hub.send_to_chat(item["chat_id"], {"type": "message", "message": message})

        except Exception as error:
            # Record why, and leave it failed rather than pending: retrying a
            # message that failed because the sender was removed would just fail
            # again every five seconds forever.
            db.execute(
                "UPDATE scheduled_messages SET status = 'failed', error = ? WHERE id = ?",
                (str(error)[:500], item["id"]),
            )
            await hub.send_to_user(item["sender_id"], {
                "type": "scheduled_message_failed",
                "scheduled_id": item["id"],
                "chat_id": item["chat_id"],
                "error": str(error)[:500],
            })


# ── Scheduled status / stories ────────────────────────────────────────────────

async def publish_due_stories(now: float):
    due = db.query_all(
        """
        SELECT * FROM stories
        WHERE status = 'scheduled' AND publish_at <= ?
        ORDER BY publish_at ASC
        LIMIT ?
        """,
        (now, BATCH_LIMIT),
    )

    for story in due:
        claimed = db.execute(
            "UPDATE stories SET status = 'live' WHERE id = ? AND status = 'scheduled'",
            (story["id"],),
        )
        if claimed.rowcount == 0:
            continue

        # The 24-hour life starts now, not when it was written. Someone queueing
        # a status three days ahead should still get a full day of visibility.
        db.execute(
            "UPDATE stories SET created_at = ?, expires_at = ? WHERE id = ?",
            (now, now + 24 * 3600, story["id"]),
        )

        await _notify_contacts(story["user_id"], {
            "type": "story_published",
            "story_id": story["id"],
            "user_id": story["user_id"],
        })


async def expire_stories(now: float):
    """Retire live statuses whose 24 hours are up."""
    due = db.query_all(
        "SELECT id FROM stories WHERE status = 'live' AND expires_at <= ?", (now,))
    if not due:
        return
    db.execute(
        "UPDATE stories SET status = 'expired' WHERE status = 'live' AND expires_at <= ?",
        (now,),
    )
    # An expired status's photo/video/audio is gone the same way an expired
    # disappearing message's attachment is — otherwise the file just sits on
    # disk, downloadable by anyone who kept the id, forever.
    for story in due:
        chatstore.drop_attachments_for_story(story["id"])


async def _notify_contacts(user_id: str, event: dict):
    """Tell everyone who shares a chat with this user."""
    rows = db.query_all(
        """
        SELECT DISTINCT other.user_id
        FROM chat_members AS mine
        JOIN chat_members AS other ON other.chat_id = mine.chat_id
        WHERE mine.user_id = ? AND other.user_id != ?
        """,
        (user_id, user_id),
    )
    for row in rows:
        await hub.send_to_user(row["user_id"], event)


# ── Meetings ──────────────────────────────────────────────────────────────────

async def run_meetings(now: float):
    await _send_meeting_reminders(now)
    await _advance_meeting_status(now)


async def _send_meeting_reminders(now: float):
    """
    Ping participants shortly before the start.

    reminded_at doubles as the claim: it is NULL until the reminder goes out, so
    a restart in the middle of a reminder batch resumes without repeating the
    ones already sent.
    """
    due = db.query_all(
        """
        SELECT * FROM meetings
        WHERE status = 'scheduled'
          AND reminded_at IS NULL
          AND starts_at - (reminder_min * 60) <= ?
          AND starts_at > ?
        LIMIT ?
        """,
        (now, now, BATCH_LIMIT),
    )

    for meeting in due:
        await asyncio.sleep(0)  # see the matching note in send_due_messages
        claimed = db.execute(
            "UPDATE meetings SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL",
            (now, meeting["id"]),
        )
        if claimed.rowcount == 0:
            continue

        minutes_away = max(0, int((meeting["starts_at"] - now) / 60))
        event = {
            "type": "meeting_reminder",
            "meeting_id": meeting["id"],
            "chat_id": meeting["chat_id"],
            "title": meeting["title"],
            "starts_at": meeting["starts_at"],
            "minutes_away": minutes_away,
            "join_url": meeting["join_url"],
        }

        # Everyone invited, except those who already said no.
        for row in db.query_all(
            "SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND response != 'declined'",
            (meeting["id"],),
        ):
            await hub.send_to_user(row["user_id"], event)


async def _advance_meeting_status(now: float):
    """
    Expire scheduled meetings nobody ever joined — NOT a general
    scheduled-to-live-to-ended clock.

    'live' is deliberately never set here. It used to flip to 'live' the
    instant starts_at passed, whether or not anyone actually joined, and
    flip to 'ended' the instant the scheduled duration elapsed, whether or
    not the call was still going. A meeting only actually starting/ending
    is decided by real activity — someone tapping Join (start_meeting /
    group_call_start in main.py, which sets 'live'), the host explicitly
    ending it, or the call room emptying out on its own
    (_end_live_meeting_for_chat in main.py, which sets 'ended'). Ending a
    call the instant its ESTIMATED duration elapsed, even though people
    were still actively on it, is exactly the kind of bug that erodes trust
    in a "scheduled" feature.

    What's still handled here: a meeting that was scheduled and never
    started by the time its window closes would otherwise sit in everyone's
    "upcoming" list forever (list_my_meetings filters to status IN
    ('scheduled','live')) — this is the one case none of those
    activity-driven paths can catch, since nothing ever happened to trigger
    them.
    """
    expired = db.query_all(
        """
        SELECT * FROM meetings
        WHERE status = 'scheduled' AND starts_at + (duration_min * 60) <= ?
        LIMIT ?
        """,
        (now, BATCH_LIMIT),
    )
    for meeting in expired:
        claimed = db.execute(
            "UPDATE meetings SET status = 'ended' WHERE id = ? AND status = 'scheduled'",
            (meeting["id"],),
        )
        if claimed.rowcount:
            await hub.send_to_chat(meeting["chat_id"], {
                "type": "meeting_ended",
                "meeting_id": meeting["id"],
                "chat_id": meeting["chat_id"],
            })


# ── Disappearing messages ─────────────────────────────────────────────────────

async def expire_messages(now: float):
    """
    Blank messages whose timer has run out.

    The row stays and only the content is cleared, for two reasons: sequence
    numbers must stay gapless or a reconnecting client cannot tell a deleted
    message from one it failed to receive, and the client needs something to
    render as "this message expired".

    Reads are already defended against a late sweep — serialise_message() hides
    content past its expiry regardless — so this pass is about not keeping the
    text on disk, not about correctness of what gets shown.
    """
    expired = db.query_all(
        """
        SELECT id, chat_id FROM messages
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL
        LIMIT ?
        """,
        (now, BATCH_LIMIT),
    )
    if not expired:
        return

    for message in expired:
        # A disappearing photo has to take its file with it, or the picture is
        # still sitting on disk and still downloadable after it "disappeared".
        chatstore.drop_attachments_for(message["id"])

        db.execute(
            "UPDATE messages SET text = '', payload = NULL, deleted_at = ? WHERE id = ?",
            (now, message["id"]),
        )
        await hub.send_to_chat(message["chat_id"], {
            "type": "message_expired",
            "chat_id": message["chat_id"],
            "message_id": message["id"],
        })
