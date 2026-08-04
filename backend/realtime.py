"""
Live delivery over WebSockets.

The first version opened one socket per chat, keyed by a user id passed in the
URL path. That was wrong twice over:

  * No authentication. `/ws/channel_tech/user_priya` connected you as Priya and
    streamed you her messages. The user id was simply whatever the caller typed.
  * One socket per chat. Switching chats tore the connection down and opened a
    new one, so every chat switch cost a full handshake and you stopped
    receiving anything from the chat you just left.

Here there is exactly one socket per device, authenticated by the same bearer
token the REST API uses. The server knows which chats you belong to, so it
routes events to you without the client subscribing to anything.
"""

import asyncio
import time
from typing import Any

from fastapi import WebSocket

import db

# How often the server pings an idle connection. A socket that is dead because
# the phone lost signal looks identical to an idle one until you write to it.
HEARTBEAT_SECONDS = 25


class Hub:
    """Tracks who is connected and fans events out to the right people."""

    def __init__(self):
        # One user can be signed in on several devices, so each maps to a set.
        self._connections: dict[str, set[WebSocket]] = {}

        # Subset of the above that's actually in the FOREGROUND right now —
        # see set_focus(). A backgrounded tab keeps its socket (so it still
        # gets live events/messages the instant it's brought back), but was
        # previously indistinguishable from an actively-open one for
        # presence purposes: opening the app once and leaving the tab in
        # the background — or just minimized on a phone — reported the
        # account as permanently "online" for as long as the socket
        # happened to stay connected, with no notion of actually being away.
        self._focused: dict[str, set[WebSocket]] = {}

        # Guards the dictionaries above. Adding and removing happens from
        # many concurrent request handlers.
        self._lock = asyncio.Lock()

    async def add(self, user_id: str, socket: WebSocket):
        async with self._lock:
            self._connections.setdefault(user_id, set()).add(socket)
            # A freshly opened socket starts focused, matching the previous
            # "connecting counts as online" behavior — the client sends an
            # explicit "focus" message the moment it actually goes to the
            # background (see set_focus / the websocket handler's "focus"
            # case), not before.
            self._focused.setdefault(user_id, set()).add(socket)

    async def remove(self, user_id: str, socket: WebSocket):
        async with self._lock:
            sockets = self._connections.get(user_id)
            if sockets:
                sockets.discard(socket)
                if not sockets:
                    # Drop the key so `online_users` does not report a user
                    # with an empty set as connected.
                    del self._connections[user_id]
            focused = self._focused.get(user_id)
            if focused:
                focused.discard(socket)
                if not focused:
                    del self._focused[user_id]

    async def set_focus(self, user_id: str, socket: WebSocket, focused: bool) -> bool:
        """
        Record whether a specific device's tab is actually in the
        foreground right now. Returns whether this changed the user's
        overall is_online() answer (i.e. gained/lost their last focused
        device), so the caller knows whether a presence broadcast is
        actually warranted rather than firing one on every tab switch.
        """
        async with self._lock:
            was_online = bool(self._focused.get(user_id))
            if focused:
                self._focused.setdefault(user_id, set()).add(socket)
            else:
                sockets = self._focused.get(user_id)
                if sockets:
                    sockets.discard(socket)
                    if not sockets:
                        del self._focused[user_id]
            is_online_now = bool(self._focused.get(user_id))
            return was_online != is_online_now

    def is_online(self, user_id: str) -> bool:
        """
        Whether this account currently has the app in the FOREGROUND on at
        least one device — not merely "has a socket open," which a
        backgrounded or minimized tab keeps for as long as it's left that
        way. Message delivery (send_to_chat/send_to_user) intentionally
        still targets every open socket regardless of focus, so a
        backgrounded tab keeps receiving live events; only the presence
        indicator (the green dot / "online" label) reads this.
        """
        return bool(self._focused.get(user_id))

    def online_users(self) -> set[str]:
        """Every user with at least one open socket, focused or not — used
        to scope send_to_chat's membership lookup, where a backgrounded tab
        must still receive events, not the presence indicator."""
        return set(self._connections.keys())

    def has_connection(self, user_id: str) -> bool:
        """
        Whether this account has ANY open socket at all — connected but
        backgrounded still counts, unlike is_online() above. This is the
        right check before falling back to a push notification: a
        backgrounded tab still receives a live send_to_user/send_to_chat
        delivery over its open socket, so it needs no push; a user with
        no socket at all (app closed, phone locked past whatever keeps a
        mobile browser's WebSocket alive, a different idle device) will
        never see the live event and is the actual case a push covers.
        """
        return bool(self._connections.get(user_id))

    async def send_to_user(self, user_id: str, event: dict[str, Any]):
        """
        Deliver to every device a user has open.

        A send can fail because the peer vanished without a close frame. We
        collect those and drop them rather than letting one dead socket stop
        delivery to the user's other devices.
        """
        sockets = list(self._connections.get(user_id, ()))
        if not sockets:
            return

        dead = []
        for socket in sockets:
            try:
                await socket.send_json(event)
            except Exception:
                dead.append(socket)

        for socket in dead:
            await self.remove(user_id, socket)

    async def send_to_chat(self, chat_id: str, event: dict[str, Any], exclude_user: str = ""):
        """
        Deliver to everyone in a chat.

        Membership is read from the database rather than from a room the client
        joined, so a client cannot receive a chat's traffic by asking for it.

        The db call here is deliberately the plain synchronous one, not
        moved to a worker thread — this method is reached from a
        connection's disconnect/cleanup path (see websocket_endpoint's
        `finally`), and offloading it there proved to open a real
        cancellation window: if the ASGI layer tears the socket down while
        the call is mid-flight on another thread, the awaiting coroutine can
        get cancelled before it resumes, and whoever this event was meant
        for never receives it (reproduced as group_call_participant_left
        silently never arriving when a participant's socket dropped
        mid-call). A single indexed SELECT blocking the loop briefly is the
        safer trade until this has a cancellation-aware fix — e.g. a
        dedicated writer task fed by a queue instead of asyncio.to_thread.
        """
        online = self._connections.keys()
        if not online:
            return

        # Scoped by chat_id alone — bounded by that chat's membership, not by
        # how many users are online site-wide. An IN (...) clause keyed by the
        # online set (the previous approach) grows a bound parameter per
        # connected user across the WHOLE server and raises
        # sqlite3.OperationalError ("too many SQL variables") once concurrent
        # connections pass SQLite's parameter limit — filtering against the
        # online set in Python afterward avoids that ceiling entirely.
        online_set = set(online)
        rows = db.query_all(
            "SELECT user_id FROM chat_members WHERE chat_id = ?", (chat_id,),
        )
        for row in rows:
            user_id = row["user_id"]
            if user_id == exclude_user or user_id not in online_set:
                continue
            await self.send_to_user(user_id, event)

    async def broadcast_presence(self, user_id: str, online: bool):
        """
        Tell the people who can see this user that they came or went.

        Only members of a shared chat are told — presence is not public, and a
        user who has switched off "last seen" is not announced at all.
        Same plain-sync-call reasoning as send_to_chat above — this runs on
        both connect AND the disconnect path.
        """
        user = db.query_one("SELECT show_last_seen FROM users WHERE id = ?", (user_id,))
        if user is None or not user["show_last_seen"]:
            return

        rows = db.query_all(
            """
            SELECT DISTINCT other.user_id
            FROM chat_members AS mine
            JOIN chat_members AS other ON other.chat_id = mine.chat_id
            WHERE mine.user_id = ? AND other.user_id != ?
            """,
            (user_id, user_id),
        )

        event = {
            "type": "presence",
            "user_id": user_id,
            "online": online,
            "last_seen": time.time(),
        }
        for row in rows:
            await self.send_to_user(row["user_id"], event)


hub = Hub()
