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

        # Guards the dictionary above. Adding and removing happens from many
        # concurrent request handlers.
        self._lock = asyncio.Lock()

    async def add(self, user_id: str, socket: WebSocket):
        async with self._lock:
            self._connections.setdefault(user_id, set()).add(socket)

    async def remove(self, user_id: str, socket: WebSocket):
        async with self._lock:
            sockets = self._connections.get(user_id)
            if not sockets:
                return
            sockets.discard(socket)
            if not sockets:
                # Drop the key so `is_online` does not report a user with an
                # empty set as connected.
                del self._connections[user_id]

    def is_online(self, user_id: str) -> bool:
        return user_id in self._connections

    def online_users(self) -> set[str]:
        return set(self._connections.keys())

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
        """
        # Only members who actually have a socket open can receive anything, so
        # the query is narrowed to those rather than fetching every member of a
        # channel with thousands of subscribers and skipping almost all of them.
        online = self._connections.keys()
        if not online:
            return

        placeholders = ",".join("?" for _ in online)
        rows = db.query_all(
            f"SELECT user_id FROM chat_members "
            f"WHERE chat_id = ? AND user_id IN ({placeholders})",
            (chat_id, *online),
        )
        for row in rows:
            if row["user_id"] == exclude_user:
                continue
            await self.send_to_user(row["user_id"], event)

    async def broadcast_presence(self, user_id: str, online: bool):
        """
        Tell the people who can see this user that they came or went.

        Only members of a shared chat are told — presence is not public, and a
        user who has switched off "last seen" is not announced at all.
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
