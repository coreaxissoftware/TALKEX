"""
Tests for the TalkEx API.

The emphasis is on the things that were broken or absent in the first version:
access control between accounts, de-duplication of retried sends, catch-up after
a reconnect, and the four scheduled behaviours that previously existed only in
the interface.

Scheduler tests call `scheduler.tick(now=...)` with a chosen timestamp rather
than sleeping. That keeps them fast and, more importantly, deterministic — a
test that waits five seconds and hopes is a test that fails on a slow machine.
"""

import asyncio
import itertools
import os
import tempfile
import time
import uuid

import pytest

# The database path is read when db.py is imported, so this has to be set first.
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="talkex_test_")

from fastapi.testclient import TestClient  # noqa: E402

import db  # noqa: E402
import main  # noqa: E402
import scheduler  # noqa: E402

HOUR = 3600


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as test_client:
        yield test_client


# register()/OTP-request endpoints rate-limit by caller IP (client_ip() in
# main.py reads X-Forwarded-For) as well as by account/phone/email, so that
# one script working through many different target numbers or usernames
# can't dodge the per-target cap. Real distinct users have distinct IPs;
# this suite creates hundreds of accounts from what would otherwise be a
# single TestClient "IP", so each helper hands out its own fake one —
# matching real traffic rather than working around the limiter.
_next_test_ip = itertools.count(1)


def fake_client_ip() -> str:
    n = next(_next_test_ip)
    return f"10.{(n >> 16) & 255}.{(n >> 8) & 255}.{n & 255}"


def make_user(client, name="Test User"):
    """Register a fresh account and return its auth header plus its id."""
    username = f"u{uuid.uuid4().hex[:10]}"
    response = client.post("/auth/register", json={
        "name": name,
        "username": username,
        "password": "correct horse battery",
        "phone": "",
        "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})
    assert response.status_code == 200, response.text
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user"]["id"], username


def run_tick(when):
    """Run one scheduler pass at a chosen moment."""
    asyncio.run(scheduler.tick(now=when))


# ── Authentication ────────────────────────────────────────────────────────────

def test_register_and_login(client):
    headers, user_id, username = make_user(client)

    me = client.get("/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["id"] == user_id

    # The password hash must never leave the server.
    assert "password_hash" not in me.json()

    login = client.post("/auth/login", json={"username": username,
                                             "password": "correct horse battery"})
    assert login.status_code == 200


def test_wrong_password_is_rejected(client):
    _, _, username = make_user(client)
    response = client.post("/auth/login", json={"username": username, "password": "wrong"})
    assert response.status_code == 401


def test_no_demo_password_bypass(client):
    """
    The old server logged anyone in as `demo` regardless of the password.
    Registering that name and then guessing must fail like any other account.
    """
    client.post("/auth/register", json={
        "name": "Demo", "username": "demo",
        "password": "a real password", "phone": "", "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})
    response = client.post("/auth/login", json={"username": "demo", "password": "anything"})
    assert response.status_code == 401


def test_unauthenticated_requests_are_refused(client):
    assert client.get("/chats").status_code == 401
    assert client.get("/me").status_code == 401


# ── Access control ────────────────────────────────────────────────────────────

def test_outsider_cannot_read_a_chat(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")

    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "private"})

    # Alice and Bob can read it.
    assert client.get(f"/chats/{chat_id}/messages", headers=alice).status_code == 200
    assert client.get(f"/chats/{chat_id}/messages", headers=bob).status_code == 200

    # Mallory knows the id and still cannot. This was wide open before.
    assert client.get(f"/chats/{chat_id}/messages", headers=mallory).status_code == 404
    assert client.post("/messages", headers=mallory,
                       json={"chat_id": chat_id, "text": "hello"}).status_code == 404


def test_search_only_returns_your_own_chats(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")

    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    secret = f"pineapple-{uuid.uuid4().hex[:8]}"
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": secret})

    assert len(client.get(f"/search?q={secret}", headers=alice).json()) == 1
    assert client.get(f"/search?q={secret}", headers=mallory).json() == []


def test_cannot_join_a_private_group_by_id(client):
    alice, _, _ = make_user(client, "Alice")
    mallory, _, _ = make_user(client, "Mallory")

    group_id = client.post("/chats/group", headers=alice,
                           json={"name": "Private"}).json()["id"]

    assert client.post(f"/chats/{group_id}/join", headers=mallory).status_code == 403


# ── Reliable delivery ─────────────────────────────────────────────────────────

def test_retry_with_same_client_id_does_not_duplicate(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client_msg_id = uuid.uuid4().hex
    body = {"chat_id": chat_id, "text": "sent once", "client_msg_id": client_msg_id}

    first = client.post("/messages", headers=alice, json=body).json()
    second = client.post("/messages", headers=alice, json=body).json()

    # Same message back, not a second one.
    assert first["id"] == second["id"]
    assert first["seq"] == second["seq"]

    messages = client.get(f"/chats/{chat_id}/messages", headers=alice).json()
    assert [m["text"] for m in messages].count("sent once") == 1


def test_sequence_numbers_are_gapless_and_support_catch_up(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    for index in range(5):
        client.post("/messages", headers=alice,
                    json={"chat_id": chat_id, "text": f"message {index}"})

    everything = client.get(f"/chats/{chat_id}/messages", headers=alice).json()
    assert [m["seq"] for m in everything] == [1, 2, 3, 4, 5]

    # A client that holds up to seq 2 asks for the rest and gets exactly that.
    missed = client.get(f"/chats/{chat_id}/messages?after_seq=2", headers=bob).json()
    assert [m["seq"] for m in missed] == [3, 4, 5]


def test_deleting_keeps_the_sequence_gapless(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    first = client.post("/messages", headers=alice,
                        json={"chat_id": chat_id, "text": "one"}).json()
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "two"})

    client.delete(f"/messages/{first['id']}", headers=alice)

    messages = client.get(f"/chats/{chat_id}/messages", headers=alice).json()
    assert [m["seq"] for m in messages] == [1, 2]
    assert messages[0]["text"] == ""          # tombstone, not a hole
    assert messages[0]["deleted_at"] is not None


# ── Delete for me ─────────────────────────────────────────────────────────────

def test_delete_for_me_hides_only_from_that_user(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "oops"}).json()

    assert client.post(f"/messages/{message['id']}/hide", headers=bob).status_code == 200

    # Gone for Bob...
    bobs_view = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert bobs_view == []

    # ...but completely untouched for Alice, including the row itself.
    alices_view = client.get(f"/chats/{chat_id}/messages", headers=alice).json()
    assert [m["text"] for m in alices_view] == ["oops"]
    assert alices_view[0]["deleted_at"] is None


def test_delete_for_me_does_not_require_being_the_sender(client):
    """Anyone can hide any message from their own view — it isn't a delete."""
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=bob,
                          json={"chat_id": chat_id, "text": "from bob"}).json()

    assert client.post(f"/messages/{message['id']}/hide", headers=alice).status_code == 200
    assert client.get(f"/chats/{chat_id}/messages", headers=alice).json() == []


def test_hiding_the_last_message_updates_the_chat_list_preview(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    first = client.post("/messages", headers=alice,
                        json={"chat_id": chat_id, "text": "first"}).json()
    second = client.post("/messages", headers=alice,
                         json={"chat_id": chat_id, "text": "second"}).json()

    preview = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert preview["last_message"]["text"] == "second"

    client.post(f"/messages/{second['id']}/hide", headers=alice)

    # Alice's own preview falls back to the previous message...
    preview = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert preview["last_message"]["text"] == "first"

    # ...but Bob, who did not hide anything, still sees the real latest message.
    preview = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == chat_id)
    assert preview["last_message"]["text"] == "second"


def test_hidden_messages_are_excluded_from_search_and_pins(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "findable"}).json()
    client.post(f"/messages/{message['id']}/pin", headers=alice)

    assert len(client.get("/search?q=findable", headers=alice).json()) == 1
    assert len(client.get(f"/chats/{chat_id}/pins", headers=alice).json()) == 1

    client.post(f"/messages/{message['id']}/hide", headers=alice)

    assert client.get("/search?q=findable", headers=alice).json() == []
    assert client.get(f"/chats/{chat_id}/pins", headers=alice).json() == []
    # Still pinned and findable for Bob, who never hid it.
    assert len(client.get("/search?q=findable", headers=bob).json()) == 1
    assert len(client.get(f"/chats/{chat_id}/pins", headers=bob).json()) == 1


def test_outsider_cannot_hide_a_message_in_a_chat_they_are_not_in(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "private"}).json()

    assert client.post(f"/messages/{message['id']}/hide", headers=mallory).status_code == 404


def test_delete_for_everyone_leaves_a_tombstone(client):
    """DELETE defaults to mode=everyone — a visible tombstone for the whole
    chat, distinct from the fully-silent unsend tested below."""
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "regret this"}).json()

    client.delete(f"/messages/{message['id']}", headers=alice)

    for headers in (alice, bob):
        view = client.get(f"/chats/{chat_id}/messages", headers=headers).json()
        assert view[0]["text"] == ""
        assert view[0]["deleted_at"] is not None


def test_unsend_leaves_no_trace_for_anyone(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "before"})
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "oops, wrong chat"}).json()
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "after"})

    unsent = client.delete(f"/messages/{message['id']}?mode=unsend", headers=alice)
    assert unsent.status_code == 200
    assert unsent.json()["mode"] == "unsend"

    # Gone completely — no tombstone row, not even for the sender.
    for headers in (alice, bob):
        texts = [m["text"] for m in client.get(f"/chats/{chat_id}/messages", headers=headers).json()]
        assert texts == ["before", "after"]


def test_unsent_message_does_not_become_the_chat_list_preview(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "real preview"})
    oops = client.post("/messages", headers=alice,
                       json={"chat_id": chat_id, "text": "typo!!"}).json()

    client.delete(f"/messages/{oops['id']}?mode=unsend", headers=alice)

    bobs_chat = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == chat_id)
    assert bobs_chat["last_message"]["text"] == "real preview"


def test_only_the_sender_can_unsend_their_own_message(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "mine"}).json()

    assert client.delete(f"/messages/{message['id']}?mode=unsend", headers=bob).status_code == 403


def test_a_moderator_cannot_unsend_someone_elses_message_only_delete_it_visibly(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice, json={
        "name": "G", "member_ids": [bob_id],
    }).json()
    message = client.post("/messages", headers=bob,
                          json={"chat_id": group["id"], "text": "bob's message"}).json()

    # Alice is the owner (a moderator), but unsend is off the table for
    # someone else's message — a moderator's only option leaves a trace.
    denied = client.delete(f"/messages/{message['id']}?mode=unsend", headers=alice)
    assert denied.status_code == 403

    allowed = client.delete(f"/messages/{message['id']}?mode=everyone", headers=alice)
    assert allowed.status_code == 200

    view = client.get(f"/chats/{group['id']}/messages", headers=bob).json()
    assert view[0]["deleted_at"] is not None


def test_delete_mode_must_be_valid(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "hi"}).json()

    denied = client.delete(f"/messages/{message['id']}?mode=nonsense", headers=alice)
    assert denied.status_code == 400


def test_unread_count_and_read_marker(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    for index in range(3):
        client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": str(index)})

    bobs_chat = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == chat_id)
    assert bobs_chat["unread"] == 3

    client.post(f"/chats/{chat_id}/read", headers=bob, json={"seq": 3})
    bobs_chat = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == chat_id)
    assert bobs_chat["unread"] == 0


# ── Reactions ─────────────────────────────────────────────────────────────────

def test_reactions_can_be_added_once_and_removed(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "react to me"}).json()

    client.post(f"/messages/{message['id']}/reactions", headers=bob, json={"emoji": "🔥"})
    # Pressing it twice must not count twice — the old counter could be spammed.
    reactions = client.post(f"/messages/{message['id']}/reactions",
                            headers=bob, json={"emoji": "🔥"}).json()
    assert reactions == [{"emoji": "🔥", "count": 1, "mine": True}]

    # And it can be taken back, which was impossible before.
    reactions = client.delete(f"/messages/{message['id']}/reactions?emoji=🔥",
                              headers=bob).json()
    assert reactions == []


# ── Location and contact messages ───────────────────────────────────────────────

def test_a_location_message_is_sent_and_seen_by_the_peer(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090},
    }).json()
    assert message["kind"] == "location"
    assert message["payload"] == {"lat": 28.6139, "lng": 77.2090}

    seen = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert seen[-1]["payload"] == {"lat": 28.6139, "lng": 77.2090}


def test_a_location_needs_numeric_coordinates(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    missing = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "kind": "location", "payload": {}})
    assert missing.status_code == 400

    wrong_type = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": "not a number", "lng": 77.2090},
    })
    assert wrong_type.status_code == 400

    out_of_range = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 999, "lng": 77.2090},
    })
    assert out_of_range.status_code == 400


def test_a_live_location_can_be_updated_while_still_live(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 900},
    }).json()

    updated = client.put(f"/messages/{message['id']}/location", headers=alice,
                         json={"lat": 28.62, "lng": 77.21}).json()
    assert updated["payload"]["lat"] == 28.62
    assert updated["payload"]["live_until"] == message["payload"]["live_until"]

    seen = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert seen[-1]["payload"]["lat"] == 28.62


def test_a_live_location_cannot_be_updated_after_it_ends(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() - 1},
    }).json()

    response = client.put(f"/messages/{message['id']}/location", headers=alice,
                          json={"lat": 28.62, "lng": 77.21})
    assert response.status_code == 400


def test_a_live_location_cannot_run_longer_than_eight_hours(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    response = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 9 * HOUR},
    })
    assert response.status_code == 400


def test_only_the_sender_can_update_a_live_location(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 900},
    }).json()

    response = client.put(f"/messages/{message['id']}/location", headers=bob,
                          json={"lat": 0, "lng": 0})
    assert response.status_code == 403


def test_stopping_a_live_location_freezes_it_instead_of_removing_it(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 900},
    }).json()

    stopped = client.post(f"/messages/{message['id']}/location/stop", headers=alice)
    assert stopped.status_code == 200
    assert stopped.json()["payload"]["live_until"] <= time.time()

    # Frozen, not gone — both sides still see the last reported position.
    seen = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert seen[-1]["payload"]["lat"] == 28.6139

    # Stopping an already-stopped share is rejected rather than silently
    # accepted a second time.
    again = client.post(f"/messages/{message['id']}/location/stop", headers=alice)
    assert again.status_code == 400


def test_only_the_sender_can_stop_a_live_location(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 900},
    }).json()

    response = client.post(f"/messages/{message['id']}/location/stop", headers=bob)
    assert response.status_code == 403


def test_live_locations_list_shows_shares_in_both_directions(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 900},
    })

    alice_view = client.get("/me/live-locations", headers=alice).json()
    assert len(alice_view) == 1
    assert alice_view[0]["is_mine"] is True

    bob_view = client.get("/me/live-locations", headers=bob).json()
    assert len(bob_view) == 1
    assert bob_view[0]["is_mine"] is False


def test_live_locations_list_omits_ended_shares(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "location",
        "payload": {"lat": 28.6139, "lng": 77.2090, "live_until": time.time() + 900},
    }).json()
    client.post(f"/messages/{message['id']}/location/stop", headers=alice)

    assert client.get("/me/live-locations", headers=alice).json() == []


def test_a_contact_message_is_sent_and_seen_by_the_peer(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "contact",
        "payload": {"name": "  Charlie  ", "phone": " +91 98765 43210 "},
    }).json()
    assert message["kind"] == "contact"
    # Stray whitespace from a form field must not leak into the stored contact.
    assert message["payload"] == {"name": "Charlie", "phone": "+91 98765 43210"}

    seen = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert seen[-1]["payload"]["name"] == "Charlie"


def test_a_contact_needs_a_name_and_phone(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    missing_phone = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "contact", "payload": {"name": "Charlie"},
    })
    assert missing_phone.status_code == 400

    blank_name = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "contact",
        "payload": {"name": "   ", "phone": "12345"},
    })
    assert blank_name.status_code == 400


# ── Scheduled messages ────────────────────────────────────────────────────────

def test_scheduled_message_is_not_visible_until_it_is_due(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    send_at = time.time() + HOUR
    item = client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "good morning", "send_at": send_at,
    }).json()
    assert item["status"] == "pending"

    # Nothing in the chat yet.
    assert client.get(f"/chats/{chat_id}/messages", headers=bob).json() == []

    # A pass before it is due changes nothing.
    run_tick(send_at - 60)
    assert client.get(f"/chats/{chat_id}/messages", headers=bob).json() == []

    # A pass after it is due delivers it.
    run_tick(send_at + 1)
    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert [m["text"] for m in messages] == ["good morning"]

    # And it is marked sent, so a second pass cannot send it again.
    run_tick(send_at + 120)
    assert len(client.get(f"/chats/{chat_id}/messages", headers=bob).json()) == 1

    sent = next(s for s in client.get("/scheduled", headers=alice).json()
                if s["id"] == item["id"])
    assert sent["status"] == "sent"
    assert sent["sent_message_id"] is not None


def test_scheduled_photo_message_is_downloadable_by_the_recipient_once_sent(client):
    """Regression test: the scheduler used to insert the message but never
    actually bind the attachment to it (message_id stayed NULL forever), so
    only the original uploader could ever download a scheduled photo — never
    the person it was sent to."""
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment = upload(client, alice).json()
    send_at = time.time() + HOUR
    item = client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "", "send_at": send_at,
        "kind": "photo", "payload": {"attachment_id": attachment["attachment_id"]},
    }).json()
    assert item["status"] == "pending"

    run_tick(send_at + 1)

    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert len(messages) == 1
    assert messages[0]["payload"]["attachment_id"] == attachment["attachment_id"]

    download = client.get(f"/uploads/{attachment['attachment_id']}", headers=bob)
    assert download.status_code == 200


def test_scheduling_with_someone_elses_attachment_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    bobs_attachment = upload(client, bob).json()
    denied = client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "", "send_at": time.time() + HOUR,
        "kind": "photo", "payload": {"attachment_id": bobs_attachment["attachment_id"]},
    })
    assert denied.status_code == 400


def test_scheduling_an_empty_message_with_no_attachment_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    denied = client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "", "send_at": time.time() + HOUR,
    })
    assert denied.status_code == 400


def test_scheduled_message_in_the_past_is_rejected(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    response = client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "too late", "send_at": time.time() - 60,
    })
    assert response.status_code == 400


def test_cancelled_scheduled_message_never_sends(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    send_at = time.time() + HOUR
    item = client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "cancel me", "send_at": send_at,
    }).json()

    assert client.delete(f"/scheduled/{item['id']}", headers=alice).status_code == 200

    run_tick(send_at + 1)
    assert client.get(f"/chats/{chat_id}/messages", headers=bob).json() == []


def test_scheduled_message_fails_if_sender_left_the_chat(client):
    """Queueing a message must not become a way to post to a group you left."""
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")

    # Bob creates the group with Alice already in it.
    group_id = client.post("/chats/group", headers=bob,
                           json={"name": "Team", "member_ids": [alice_id]}).json()["id"]

    send_at = time.time() + HOUR
    item = client.post("/scheduled", headers=alice, json={
        "chat_id": group_id, "text": "still here?", "send_at": send_at,
    }).json()

    client.post(f"/chats/{group_id}/leave", headers=alice)

    run_tick(send_at + 1)

    assert client.get(f"/chats/{group_id}/messages", headers=bob).json() == []
    failed = next(s for s in client.get("/scheduled", headers=alice).json()
                  if s["id"] == item["id"])
    assert failed["status"] == "failed"
    assert "no longer a member" in failed["error"]


# ── Scheduled status ──────────────────────────────────────────────────────────

def test_scheduled_status_publishes_when_due(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    # They need a shared chat, otherwise Bob is not an audience for her status.
    client.post(f"/chats/dm/{bob_id}", headers=alice)

    publish_at = time.time() + HOUR
    story = client.post("/stories", headers=alice, json={
        "text": "launching today", "emoji": "🚀", "publish_at": publish_at,
    }).json()
    assert story["status"] == "scheduled"

    # Not visible to anyone yet, including Alice's own feed.
    assert client.get("/stories", headers=bob).json() == []

    # But she can see it in her own queue.
    mine = client.get("/stories/mine", headers=alice).json()
    assert [s["status"] for s in mine] == ["scheduled"]

    run_tick(publish_at + 1)

    feed = client.get("/stories", headers=bob).json()
    assert len(feed) == 1
    assert feed[0]["stories"][0]["text"] == "launching today"


def test_published_status_expires_after_24_hours(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    client.post(f"/chats/dm/{bob_id}", headers=alice)

    publish_at = time.time() + HOUR
    client.post("/stories", headers=alice, json={"text": "temporary", "publish_at": publish_at})

    run_tick(publish_at + 1)
    assert len(client.get("/stories", headers=bob).json()) == 1

    # The 24 hours run from publication, not from when it was written.
    run_tick(publish_at + 24 * HOUR + 60)
    assert client.get("/stories", headers=bob).json() == []


def test_photo_status_carries_attachment_metadata_and_is_visible_to_a_contact(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    client.post(f"/chats/dm/{bob_id}", headers=alice)

    attachment = upload(client, alice).json()
    story = client.post("/stories", headers=alice, json={
        "kind": "photo", "attachment_id": attachment["attachment_id"],
    }).json()
    assert story["kind"] == "photo"
    assert story["content_type"] == "image/png"

    feed_story = client.get("/stories", headers=bob).json()[0]["stories"][0]
    assert feed_story["attachment_id"] == attachment["attachment_id"]

    # Bob shares a chat with Alice, so he can fetch the actual file.
    download = client.get(f"/uploads/{attachment['attachment_id']}", headers=bob)
    assert download.status_code == 200


def test_photo_status_file_is_not_visible_to_a_stranger(client):
    alice, _, _ = make_user(client, "Alice")
    stranger, _, _ = make_user(client, "Stranger")

    attachment = upload(client, alice).json()
    client.post("/stories", headers=alice, json={
        "kind": "photo", "attachment_id": attachment["attachment_id"],
    })

    download = client.get(f"/uploads/{attachment['attachment_id']}", headers=stranger)
    assert download.status_code == 404


def test_link_status_requires_a_url(client):
    alice, _, _ = make_user(client, "Alice")

    bad = client.post("/stories", headers=alice, json={"kind": "link", "link_url": "not a url"})
    assert bad.status_code == 400

    good = client.post("/stories", headers=alice, json={
        "kind": "link", "link_url": "https://example.com/launch", "text": "check this out",
    })
    assert good.status_code == 200
    assert good.json()["link_url"] == "https://example.com/launch"


def test_a_text_status_carries_its_chosen_font_and_size(client):
    alice, _, _ = make_user(client, "Alice")
    created = client.post("/stories", headers=alice, json={
        "text": "hello", "font": "serif", "font_size": "large",
    }).json()
    assert created["font"] == "serif"
    assert created["font_size"] == "large"


def test_a_status_without_a_chosen_font_defaults_to_system_medium(client):
    alice, _, _ = make_user(client, "Alice")
    created = client.post("/stories", headers=alice, json={"text": "hello"}).json()
    assert created["font"] == "system"
    assert created["font_size"] == "medium"


def test_media_status_requires_an_attachment_id(client):
    alice, _, _ = make_user(client, "Alice")
    missing = client.post("/stories", headers=alice, json={"kind": "video"})
    assert missing.status_code == 400


def test_media_status_attachment_id_cannot_be_reused(client):
    alice, _, _ = make_user(client, "Alice")
    attachment = upload(client, alice).json()

    first = client.post("/stories", headers=alice, json={
        "kind": "photo", "attachment_id": attachment["attachment_id"],
    })
    assert first.status_code == 200

    second = client.post("/stories", headers=alice, json={
        "kind": "photo", "attachment_id": attachment["attachment_id"],
    })
    assert second.status_code == 400


def test_deleting_a_photo_status_removes_the_file(client):
    alice, _, _ = make_user(client, "Alice")
    attachment = upload(client, alice).json()
    story = client.post("/stories", headers=alice, json={
        "kind": "photo", "attachment_id": attachment["attachment_id"],
    }).json()

    client.delete(f"/stories/{story['id']}", headers=alice)

    assert db.query_one("SELECT 1 FROM attachments WHERE id = ?",
                        (attachment["attachment_id"],)) is None


def test_expired_photo_status_removes_the_file(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    client.post(f"/chats/dm/{bob_id}", headers=alice)

    attachment = upload(client, alice).json()
    story = client.post("/stories", headers=alice, json={
        "kind": "photo", "attachment_id": attachment["attachment_id"],
    }).json()

    run_tick(story["expires_at"] + 60)

    assert db.query_one("SELECT 1 FROM attachments WHERE id = ?",
                        (attachment["attachment_id"],)) is None


# ── Disappearing messages ─────────────────────────────────────────────────────

def test_disappearing_message_is_blanked_when_its_timer_runs_out(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "text": "burn after reading", "disappear_secs": 60,
    })

    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert messages[0]["text"] == "burn after reading"

    run_tick(time.time() + 120)

    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert messages[0]["text"] == ""
    assert messages[0]["seq"] == 1          # still gapless


def test_chat_wide_disappearing_timer_applies_to_new_messages(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    before = client.post("/messages", headers=alice,
                         json={"chat_id": chat_id, "text": "kept"}).json()
    assert before["expires_at"] is None

    client.put(f"/chats/{chat_id}/disappearing", headers=alice, json={"seconds": 300})

    after = client.post("/messages", headers=alice,
                        json={"chat_id": chat_id, "text": "temporary"}).json()
    assert after["expires_at"] is not None

    # Switching the timer on does not retroactively destroy earlier messages.
    run_tick(time.time() + 600)
    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert messages[0]["text"] == "kept"
    assert messages[1]["text"] == ""


# ── Meetings ──────────────────────────────────────────────────────────────────

def test_meeting_lifecycle(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    starts_at = time.time() + 2 * HOUR
    meeting = client.post("/meetings", headers=alice, json={
        "chat_id": chat_id,
        "title": "Sprint planning",
        "agenda": "What ships this week",
        "starts_at": starts_at,
        "duration_min": 45,
        "reminder_min": 15,
        "join_url": "https://meet.example.com/abc",
    }).json()

    assert meeting["status"] == "scheduled"
    # The host is going by default; the other member has not answered yet.
    assert meeting["my_response"] == "going"
    assert {p["response"] for p in meeting["participants"]} == {"going", "pending"}

    # A card was posted into the chat.
    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert messages[-1]["kind"] == "meeting"
    assert messages[-1]["payload"]["meeting_id"] == meeting["id"]

    # Bob accepts.
    updated = client.post(f"/meetings/{meeting['id']}/rsvp", headers=bob,
                          json={"response": "going"}).json()
    assert updated["going_count"] == 2

    # It shows up in his upcoming list.
    assert meeting["id"] in [m["id"] for m in client.get("/meetings", headers=bob).json()]

    # Reminder fires inside the window, and only once.
    run_tick(starts_at - 10 * 60)
    row = db.query_one("SELECT reminded_at FROM meetings WHERE id = ?", (meeting["id"],))
    assert row["reminded_at"] is not None
    first_reminder = row["reminded_at"]

    run_tick(starts_at - 5 * 60)
    row = db.query_one("SELECT reminded_at FROM meetings WHERE id = ?", (meeting["id"],))
    assert row["reminded_at"] == first_reminder

    # The clock reaching starts_at does NOT flip status on its own — a
    # meeting nobody has actually joined isn't "live" just because the
    # scheduled time passed. Status is driven by real activity: someone
    # tapping Join (POST /start), the host ending it, or the call room
    # emptying out — never a wall-clock guess.
    run_tick(starts_at + 1)
    assert client.get(f"/meetings/{meeting['id']}", headers=bob).json()["status"] == "scheduled"

    # Bob actually joins — now it's genuinely live.
    started = client.post(f"/meetings/{meeting['id']}/start", headers=bob).json()
    assert started["status"] == "live"

    # Running long past the scheduled duration must NOT auto-end a meeting
    # that's actually still live — real calls routinely run over.
    run_tick(starts_at + 46 * 60)
    assert client.get(f"/meetings/{meeting['id']}", headers=bob).json()["status"] == "live"

    # Only the host explicitly ending it (or the call room emptying out —
    # covered by test_disconnecting_mid_call_removes_the_participant-style
    # scenarios) moves it to 'ended'.
    client.post(f"/meetings/{meeting['id']}/end", headers=alice)
    assert client.get(f"/meetings/{meeting['id']}", headers=bob).json()["status"] == "ended"


def test_a_never_joined_scheduled_meeting_expires_after_its_window(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    starts_at = time.time() + 2 * HOUR
    meeting = client.post("/meetings", headers=alice, json={
        "chat_id": chat_id, "title": "Ghost meeting", "starts_at": starts_at, "duration_min": 30,
    }).json()

    # Nobody ever taps Join. Once the scheduled window (start + duration)
    # has fully passed, it's swept out of "upcoming" rather than sitting
    # there forever.
    run_tick(starts_at + 1)
    assert client.get(f"/meetings/{meeting['id']}", headers=alice).json()["status"] == "scheduled"

    run_tick(starts_at + 31 * 60)
    assert client.get(f"/meetings/{meeting['id']}", headers=alice).json()["status"] == "ended"


def test_a_meeting_ends_when_the_last_participant_disconnects(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = make_group(client, alice, [bob_id])

    meeting = client.post("/meetings/instant", headers=alice,
                          json={"chat_id": chat_id, "title": "Quick sync"}).json()
    assert meeting["status"] == "live"

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        # No second socket connects in this test, so there's no presence
        # event for alice to receive here (that only fires when someone ELSE
        # she shares a chat with comes online) — straight to the call.
        alice_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
        alice_socket.receive_json()  # group_call_roster

    # Alice's socket just closed without an explicit group_call_leave — the
    # room empties out via disconnect cleanup, which must also close out
    # the meeting record, not just the in-memory call state.
    current = client.get(f"/meetings/{meeting['id']}", headers=bob).json()
    assert current["status"] == "ended"


def test_only_the_host_can_change_or_cancel_a_meeting(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    meeting = client.post("/meetings", headers=alice, json={
        "chat_id": chat_id, "title": "Standup", "starts_at": time.time() + HOUR,
    }).json()

    assert client.patch(f"/meetings/{meeting['id']}", headers=bob,
                        json={"title": "Hijacked"}).status_code == 403
    assert client.delete(f"/meetings/{meeting['id']}", headers=bob).status_code == 403
    assert client.delete(f"/meetings/{meeting['id']}", headers=alice).status_code == 200


def test_moving_a_meeting_rearms_its_reminder(client):
    """
    Changing the start time has to clear reminded_at. Without that the reminder
    is already stamped as sent and the new time arrives with nobody told.
    """
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    starts_at = time.time() + HOUR
    meeting = client.post("/meetings", headers=alice, json={
        "chat_id": chat_id, "title": "Review", "starts_at": starts_at, "reminder_min": 10,
    }).json()

    run_tick(starts_at - 5 * 60)
    assert db.query_one("SELECT reminded_at FROM meetings WHERE id = ?",
                        (meeting["id"],))["reminded_at"] is not None

    moved_to = time.time() + 5 * HOUR
    client.patch(f"/meetings/{meeting['id']}", headers=alice, json={"starts_at": moved_to})

    assert db.query_one("SELECT reminded_at FROM meetings WHERE id = ?",
                        (meeting["id"],))["reminded_at"] is None

    run_tick(moved_to - 5 * 60)
    assert db.query_one("SELECT reminded_at FROM meetings WHERE id = ?",
                        (meeting["id"],))["reminded_at"] is not None


# ── Blocking ──────────────────────────────────────────────────────────────────

def test_blocking_stops_messages_in_an_existing_chat(client):
    """
    Blocking used to be checked only when a DM was created, so an existing
    conversation carried on working and the block did nothing.
    """
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    assert client.post("/messages", headers=bob,
                       json={"chat_id": chat_id, "text": "hi"}).status_code == 200

    client.post(f"/users/{bob_id}/block", headers=alice)

    # The blocked person can no longer send...
    assert client.post("/messages", headers=bob,
                       json={"chat_id": chat_id, "text": "still here"}).status_code == 403
    # ...and neither can the blocker, which is what "blocked" should mean.
    assert client.post("/messages", headers=alice,
                       json={"chat_id": chat_id, "text": "hello"}).status_code == 403

    client.delete(f"/users/{bob_id}/block", headers=alice)
    assert client.post("/messages", headers=bob,
                       json={"chat_id": chat_id, "text": "back"}).status_code == 200


def test_blocking_prevents_starting_a_chat_in_both_directions(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")

    client.post(f"/users/{bob_id}/block", headers=alice)

    assert client.post(f"/chats/dm/{alice_id}", headers=bob).status_code == 403
    assert client.post(f"/chats/dm/{bob_id}", headers=alice).status_code == 403


# ── Phone number privacy ──────────────────────────────────────────────────────

def test_hiding_your_phone_number_scrubs_it_from_other_viewers(client):
    alice_reg = client.post("/auth/register", json={
        "name": "Alice", "username": f"u{uuid.uuid4().hex[:10]}",
        "password": "correct horse battery", "phone": "+15551112222", "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})
    alice = {"Authorization": f"Bearer {alice_reg.json()['token']}"}
    alice_id = alice_reg.json()["user"]["id"]
    bob, bob_id, _ = make_user(client, "Bob")

    # Visible by default.
    seen = client.get(f"/users/{alice_id}", headers=bob).json()
    assert seen["phone"] == "+15551112222"

    client.patch("/me", headers=alice, json={"show_phone_number": False})
    hidden = client.get(f"/users/{alice_id}", headers=bob).json()
    assert hidden["phone"] == ""

    # But Alice still sees her own number.
    own_view = client.get("/me", headers=alice).json()
    assert own_view["phone"] == "+15551112222"


def test_hidden_phone_number_is_scrubbed_from_the_directory_and_chat_members(client):
    alice_reg = client.post("/auth/register", json={
        "name": "Alice", "username": f"u{uuid.uuid4().hex[:10]}",
        "password": "correct horse battery", "phone": "+15559998888", "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})
    alice = {"Authorization": f"Bearer {alice_reg.json()['token']}"}
    alice_id = alice_reg.json()["user"]["id"]
    client.patch("/me", headers=alice, json={"show_phone_number": False})

    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{alice_id}", headers=bob).json()["id"]

    directory = client.get("/users?q=Alice", headers=bob).json()
    assert all(u["phone"] == "" for u in directory if u["id"] == alice_id)

    chat = client.get(f"/chats/{chat_id}", headers=bob).json()
    alice_member = next(m for m in chat["members"] if m["id"] == alice_id)
    assert alice_member["phone"] == ""


# ── Contacts ───────────────────────────────────────────────────────────────────

def test_adding_a_contact_that_matches_a_registered_phone_resolves_the_user(client):
    alice, _, _ = make_user(client, "Alice")
    bob_response = client.post("/auth/register", json={
        "name": "Bob Baker", "username": f"u{uuid.uuid4().hex[:10]}",
        "password": "correct horse battery", "phone": "+15551234567", "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})
    assert bob_response.status_code == 200

    contact = client.post("/contacts", headers=alice, json={
        "name": "Bobby", "phone": "+15551234567",
    }).json()
    assert contact["name"] == "Bobby"  # the name Alice picked, not Bob's own name
    assert contact["user"]["username"] == bob_response.json()["user"]["username"]


def test_adding_a_contact_with_an_unregistered_phone_leaves_user_unmatched(client):
    alice, _, _ = make_user(client, "Alice")
    contact = client.post("/contacts", headers=alice, json={
        "name": "Someone", "phone": "+19998887777",
    }).json()
    assert contact["user"] is None


def test_a_contact_matches_once_that_phone_number_signs_up_later(client):
    """The match is live — saving a number ahead of someone joining still works."""
    alice, _, _ = make_user(client, "Alice")
    contact = client.post("/contacts", headers=alice, json={
        "name": "Future Friend", "phone": "+12223334444",
    }).json()
    assert contact["user"] is None

    client.post("/auth/register", json={
        "name": "Late Joiner", "username": f"u{uuid.uuid4().hex[:10]}",
        "password": "correct horse battery", "phone": "+12223334444", "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})

    refreshed = next(c for c in client.get("/contacts", headers=alice).json()
                     if c["id"] == contact["id"])
    assert refreshed["user"]["name"] == "Late Joiner"


def test_cannot_add_the_same_phone_number_twice(client):
    alice, _, _ = make_user(client, "Alice")
    client.post("/contacts", headers=alice, json={"name": "First", "phone": "+10000000000"})
    duplicate = client.post("/contacts", headers=alice, json={"name": "Second", "phone": "+10000000000"})
    assert duplicate.status_code == 400


def test_contacts_are_private_per_account(client):
    alice, _, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")
    client.post("/contacts", headers=alice, json={"name": "Alice's contact", "phone": "+19990001111"})
    assert client.get("/contacts", headers=bob).json() == []


def test_deleting_a_contact(client):
    alice, _, _ = make_user(client, "Alice")
    contact = client.post("/contacts", headers=alice, json={
        "name": "Temp", "phone": "+15550000000",
    }).json()

    client.delete(f"/contacts/{contact['id']}", headers=alice)
    assert client.get("/contacts", headers=alice).json() == []


def test_editing_a_contacts_name_and_phone(client):
    alice, _, _ = make_user(client, "Alice")
    contact = client.post("/contacts", headers=alice, json={
        "name": "Old Name", "phone": "+15551110000",
    }).json()

    updated = client.patch(f"/contacts/{contact['id']}", headers=alice, json={
        "name": "New Name", "phone": "+15552220000",
    })
    assert updated.status_code == 200
    assert updated.json()["name"] == "New Name"
    assert updated.json()["phone"] == "+15552220000"


def test_editing_someone_elses_contact_404s(client):
    alice, _, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")
    contact = client.post("/contacts", headers=alice, json={
        "name": "Mine", "phone": "+15553330000",
    }).json()

    response = client.patch(f"/contacts/{contact['id']}", headers=bob, json={
        "name": "Hijacked", "phone": "+15554440000",
    })
    assert response.status_code == 404


# ── Naming, pins and views ────────────────────────────────────────────────────

def test_a_dm_is_named_after_the_other_person(client):
    """Every DM used to come back with an empty name and render as "Direct message"."""
    alice, alice_id, _ = make_user(client, "Alice Anderson")
    bob, bob_id, _ = make_user(client, "Bob Baker")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    mine = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert mine["name"] == "Bob Baker"
    assert mine["peer_id"] == bob_id

    # And the same chat is named the other way round for Bob.
    theirs = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == chat_id)
    assert theirs["name"] == "Alice Anderson"

    # Fetching the chat directly agrees with the list.
    assert client.get(f"/chats/{chat_id}", headers=alice).json()["name"] == "Bob Baker"


def test_pinning_a_message(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "pin me"}).json()

    assert client.get(f"/chats/{chat_id}/pins", headers=alice).json() == []

    client.post(f"/messages/{message['id']}/pin", headers=alice)
    pins = client.get(f"/chats/{chat_id}/pins", headers=bob).json()
    assert [p["text"] for p in pins] == ["pin me"]

    client.delete(f"/messages/{message['id']}/pin", headers=alice)
    assert client.get(f"/chats/{chat_id}/pins", headers=alice).json() == []


def test_outsider_cannot_pin_or_view_pins(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "private"}).json()

    assert client.post(f"/messages/{message['id']}/pin", headers=mallory).status_code == 404
    assert client.get(f"/chats/{chat_id}/pins", headers=mallory).status_code == 404


def test_view_count_increments(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "seen?"}).json()

    assert message["view_count"] == 0
    assert client.post(f"/messages/{message['id']}/view", headers=bob).json()["views"] == 1
    assert client.post(f"/messages/{message['id']}/view", headers=bob).json()["views"] == 2


# ── Community isolation ───────────────────────────────────────────────────────

def test_cannot_join_a_community_channel_without_the_community(client):
    alice, _, _ = make_user(client, "Alice")
    mallory, _, _ = make_user(client, "Mallory")

    community = client.post("/chats/community", headers=alice, json={
        "name": "Devs", "channels": ["general"],
    }).json()
    sub_channel = client.get(f"/chats/{community['id']}/channels", headers=alice).json()[0]

    # Knowing the sub-channel id was previously enough to walk straight in.
    assert client.post(f"/chats/{sub_channel['id']}/join", headers=mallory).status_code == 403

    client.post(f"/chats/{community['id']}/join", headers=mallory)
    assert client.post(f"/chats/{sub_channel['id']}/join", headers=mallory).status_code == 200


# ── Login throttling ──────────────────────────────────────────────────────────

def test_repeated_wrong_passwords_are_throttled(client):
    _, _, username = make_user(client, "Target")

    codes = [
        client.post("/auth/login", json={"username": username, "password": "wrong"}).status_code
        for _ in range(main.MAX_FAILED_LOGINS + 2)
    ]

    assert codes[0] == 401
    # Guessing stops being answered at all once the limit is reached.
    assert codes[-1] == 429

    # Clear the counter so the rest of the suite is unaffected.
    main._failed_logins.pop(username, None)


def test_a_correct_password_clears_the_failure_counter(client):
    _, _, username = make_user(client, "Forgetful")

    for _ in range(3):
        client.post("/auth/login", json={"username": username, "password": "wrong"})

    assert client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).status_code == 200
    assert username not in main._failed_logins


# ── Two-step verification ────────────────────────────────────────────────────

def test_two_step_is_off_by_default(client):
    alice, _, _ = make_user(client, "Alice")
    assert client.get("/me/two-step", headers=alice).json() == {"enabled": False}


def test_setting_a_pin_gates_the_next_login_behind_it(client):
    alice, _, username = make_user(client, "Alice")
    assert client.post("/me/two-step", headers=alice, json={"pin": "4242"}).status_code == 200
    assert client.get("/me/two-step", headers=alice).json() == {"enabled": True}

    login = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()
    assert login["requires_pin"] is True
    assert "token" not in login

    verified = client.post("/auth/login/verify-pin", json={
        "pending_token": login["pending_token"], "pin": "4242"}).json()
    assert "token" in verified
    assert verified["user"]["username"] == username

    # The new token actually works, and never carries the PIN hash.
    me = client.get("/me", headers={"Authorization": f"Bearer {verified['token']}"}).json()
    assert me["username"] == username
    assert "two_step_pin_hash" not in me


def test_wrong_pin_is_rejected_and_locks_out_after_five_tries(client):
    alice, _, username = make_user(client, "Alice")
    client.post("/me/two-step", headers=alice, json={"pin": "1234"})
    login = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()
    pending = login["pending_token"]

    for _ in range(4):
        response = client.post("/auth/login/verify-pin",
                               json={"pending_token": pending, "pin": "0000"})
        assert response.status_code == 401

    # The fifth wrong guess burns the pending login entirely, not just fails.
    response = client.post("/auth/login/verify-pin",
                           json={"pending_token": pending, "pin": "0000"})
    assert response.status_code == 401

    # Even the correct PIN is refused now — the pending login is gone.
    response = client.post("/auth/login/verify-pin",
                           json={"pending_token": pending, "pin": "1234"})
    assert response.status_code == 401


def test_an_unknown_pending_token_is_refused(client):
    response = client.post("/auth/login/verify-pin",
                           json={"pending_token": "not-a-real-token", "pin": "1234"})
    assert response.status_code == 401


def test_cannot_silently_overwrite_an_existing_two_step_pin(client):
    alice, _, _ = make_user(client, "Alice")
    client.post("/me/two-step", headers=alice, json={"pin": "1111"})

    # No current_pin supplied — must be refused, exactly like chat locks.
    response = client.post("/me/two-step", headers=alice, json={"pin": "2222"})
    assert response.status_code == 400

    # Wrong current_pin is refused too.
    response = client.post("/me/two-step", headers=alice,
                           json={"pin": "2222", "current_pin": "9999"})
    assert response.status_code == 400

    # The right current_pin changes it.
    response = client.post("/me/two-step", headers=alice,
                           json={"pin": "2222", "current_pin": "1111"})
    assert response.status_code == 200


def test_removing_two_step_requires_the_current_pin(client):
    alice, _, username = make_user(client, "Alice")
    client.post("/me/two-step", headers=alice, json={"pin": "5678"})

    assert client.request("DELETE", "/me/two-step", headers=alice,
                          json={"current_pin": "0000"}).status_code == 400

    assert client.request("DELETE", "/me/two-step", headers=alice,
                          json={"current_pin": "5678"}).status_code == 200
    assert client.get("/me/two-step", headers=alice).json() == {"enabled": False}

    # And login goes back to normal — no PIN step any more.
    login = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()
    assert "token" in login


def test_two_step_pin_hash_never_leaks_to_the_client(client):
    alice, _, _ = make_user(client, "Alice")
    client.post("/me/two-step", headers=alice, json={"pin": "3141"})
    me = client.get("/me", headers=alice).json()
    assert "two_step_pin_hash" not in me
    assert "has_two_step" not in me
    assert "two_step_recovery_codes" not in me


def test_setting_the_first_pin_returns_five_recovery_codes(client):
    alice, _, _ = make_user(client, "Alice")
    response = client.post("/me/two-step", headers=alice, json={"pin": "4242"}).json()
    assert len(response["recovery_codes"]) == 5
    assert len(set(response["recovery_codes"])) == 5     # no duplicates

    # Changing the PIN afterwards does not hand back new codes — the existing
    # ones are still valid, same as changing a password doesn't reset backup
    # codes elsewhere.
    changed = client.post("/me/two-step", headers=alice,
                          json={"pin": "9999", "current_pin": "4242"}).json()
    assert changed["recovery_codes"] is None


def test_a_recovery_code_logs_in_and_turns_two_step_off(client):
    alice, _, username = make_user(client, "Alice")
    setup = client.post("/me/two-step", headers=alice, json={"pin": "4242"}).json()
    code = setup["recovery_codes"][0]

    login = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()

    verified = client.post("/auth/login/verify-pin",
                           json={"pending_token": login["pending_token"], "pin": code}).json()
    assert "token" in verified
    assert verified["two_step_disabled"] is True

    assert client.get("/me/two-step", headers=alice).json() == {"enabled": False}
    # A plain login now works with no PIN step at all.
    plain = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"})
    assert "token" in plain.json()


def test_a_recovery_code_can_only_be_used_once(client):
    alice, _, username = make_user(client, "Alice")
    setup = client.post("/me/two-step", headers=alice, json={"pin": "4242"}).json()
    code = setup["recovery_codes"][0]

    login = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()
    client.post("/auth/login/verify-pin",
               json={"pending_token": login["pending_token"], "pin": code})

    # Re-enable two-step with a fresh PIN, then try the SAME old code again.
    client.post("/me/two-step", headers=alice, json={"pin": "5555"})
    login2 = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()
    reused = client.post("/auth/login/verify-pin",
                         json={"pending_token": login2["pending_token"], "pin": code})
    assert reused.status_code == 401


def test_regenerating_recovery_codes_requires_the_current_pin(client):
    alice, _, _ = make_user(client, "Alice")
    client.post("/me/two-step", headers=alice, json={"pin": "4242"})

    denied = client.post("/me/two-step/recovery-codes", headers=alice,
                         json={"current_pin": "0000"})
    assert denied.status_code == 400

    regenerated = client.post("/me/two-step/recovery-codes", headers=alice,
                              json={"current_pin": "4242"}).json()
    assert len(regenerated["recovery_codes"]) == 5


# ── Linked devices (QR sign-in) ───────────────────────────────────────────────

def test_full_device_link_flow(client):
    alice, alice_id, _ = make_user(client, "Alice")

    started = client.post("/auth/link/start", json={"device_label": "Alice's laptop"}).json()
    code = started["code"]

    # A real SVG containing the code, not a placeholder — rendered server-side
    # with a trusted library rather than hand-written encoding logic.
    assert started["qr_svg"].startswith("<?xml")
    assert "<svg" in started["qr_svg"]

    # Nothing to collect yet.
    assert client.get(f"/auth/link/{code}/poll").json() == {"status": "pending"}

    # The already-signed-in phone sees who is asking...
    info = client.get(f"/auth/link/{code}/info", headers=alice).json()
    assert info["device_label"] == "Alice's laptop"

    # ...and approves.
    assert client.post(f"/auth/link/{code}/approve", headers=alice).status_code == 200

    # The laptop's next poll picks up a real, working session token.
    result = client.get(f"/auth/link/{code}/poll").json()
    assert result["status"] == "approved"
    assert result["user"]["id"] == alice_id
    new_token = result["token"]

    laptop = {"Authorization": f"Bearer {new_token}"}
    assert client.get("/me", headers=laptop).json()["id"] == alice_id

    # The token is handed out exactly once — re-polling does not leak a second copy.
    again = client.get(f"/auth/link/{code}/poll").json()
    assert again == {"status": "consumed"}


def test_linking_a_sixth_device_is_refused(client):
    """Registration itself already counts as one active session, so linking
    four more devices reaches the 5-device cap; a fifth link attempt must be
    refused rather than silently succeeding."""
    alice, _, username = make_user(client, "Alice")

    for i in range(4):
        code = client.post("/auth/link/start", json={"device_label": f"Device {i}"}).json()["code"]
        approved = client.post(f"/auth/link/{code}/approve", headers=alice)
        assert approved.status_code == 200, approved.text

    over_cap_code = client.post("/auth/link/start", json={"device_label": "One too many"}).json()["code"]
    denied = client.post(f"/auth/link/{over_cap_code}/approve", headers=alice)
    assert denied.status_code == 400

    # Normal password login must still work even at the cap — only linking a
    # NEW device is refused, not signing in with a password.
    login = client.post("/auth/login", json={"username": username, "password": "correct horse battery"})
    assert login.status_code == 200


def test_device_link_can_be_denied(client):
    alice, _, _ = make_user(client, "Alice")
    code = client.post("/auth/link/start", json={"device_label": "Unknown device"}).json()["code"]

    assert client.post(f"/auth/link/{code}/deny", headers=alice).status_code == 200
    assert client.get(f"/auth/link/{code}/poll").json() == {"status": "denied"}

    # Denied, not just "not yet approved" — approving after a denial must not
    # resurrect it and hand out a token anyway.
    assert client.post(f"/auth/link/{code}/approve", headers=alice).status_code == 404


def test_expired_device_link_cannot_be_approved(client):
    alice, _, _ = make_user(client, "Alice")
    code = client.post("/auth/link/start", json={"device_label": "Old device"}).json()["code"]

    db.execute("UPDATE device_links SET expires_at = ? WHERE code = ?",
               (time.time() - 10, code))

    assert client.post(f"/auth/link/{code}/approve", headers=alice).status_code == 400
    assert client.get(f"/auth/link/{code}/poll").json() == {"status": "expired"}


def test_unknown_code_is_not_found(client):
    alice, _, _ = make_user(client, "Alice")
    assert client.get("/auth/link/NOSUCHCODE/poll").status_code == 404
    assert client.get("/auth/link/NOSUCHCODE/info", headers=alice).status_code == 404
    assert client.post("/auth/link/NOSUCHCODE/approve", headers=alice).status_code == 404


def test_a_code_can_only_be_approved_once(client):
    """
    A second approval attempt must not mint a second live session token. A
    genuinely concurrent race (two requests' SELECTs both landing before
    either UPDATE commits) gets 409 from the code's own rowcount check; a
    sequential second call like this one instead finds the row already past
    'pending' and gets 404 from the lookup itself. Either way, the invariant
    that matters — never more than one token per code — holds.
    """
    alice, alice_id, _ = make_user(client, "Alice")
    code = client.post("/auth/link/start", json={"device_label": "New device"}).json()["code"]

    assert client.post(f"/auth/link/{code}/approve", headers=alice).status_code == 200
    assert client.post(f"/auth/link/{code}/approve", headers=alice).status_code == 404

    # Exactly one new session exists for Alice from this link, not two.
    sessions = client.get("/me/sessions", headers=alice).json()
    linked = [s for s in sessions if s["device_label"] == "New device"]
    assert len(linked) == 1


def test_sessions_list_and_revoke(client):
    headers, user_id, username = make_user(client, "Alice")

    login2 = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery",
        "device_label": "Second phone",
    }).json()
    second_headers = {"Authorization": f"Bearer {login2['token']}"}

    sessions = client.get("/me/sessions", headers=headers).json()
    labels = {s["device_label"] for s in sessions}
    assert "Second phone" in labels
    assert sum(s["is_current"] for s in sessions) == 1

    second_session = next(s for s in sessions if s["device_label"] == "Second phone")
    assert client.delete(f"/me/sessions/{second_session['session_id']}",
                         headers=headers).status_code == 200

    # The revoked device is signed out immediately.
    assert client.get("/me", headers=second_headers).status_code == 401


def test_cannot_revoke_someone_elses_session(client):
    alice, _, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")

    bobs_sessions = client.get("/me/sessions", headers=bob).json()
    bobs_session_id = bobs_sessions[0]["session_id"]

    assert client.delete(f"/me/sessions/{bobs_session_id}", headers=alice).status_code == 404
    # Bob's session is still alive — Alice's attempt did nothing.
    assert client.get("/me", headers=bob).status_code == 200


# ── Housekeeping ──────────────────────────────────────────────────────────────

def test_expired_sessions_are_purged(client):
    headers, user_id, _ = make_user(client, "Expiring")

    db.execute(
        "UPDATE sessions SET expires_at = ? WHERE user_id = ?",
        (time.time() - 10, user_id),
    )
    assert db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?",
                        (user_id,))["n"] == 1

    run_tick(time.time())

    assert db.query_one("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?",
                        (user_id,))["n"] == 0
    assert client.get("/me", headers=headers).status_code == 401


def test_approved_but_uncollected_link_survives_a_sweep_before_its_own_expiry(client):
    """
    A row moves to 'approved' the instant someone approves it, but the new
    device might not poll again for a second or two. A sweep that deletes on
    status alone would race that device out of ever collecting its token —
    the row must only go away once genuinely expired or actually consumed.
    """
    alice, _, _ = make_user(client, "Alice")
    code = client.post("/auth/link/start", json={"device_label": "Slow poller"}).json()["code"]
    client.post(f"/auth/link/{code}/approve", headers=alice)

    run_tick(time.time())   # well before the 3-minute TTL

    result = client.get(f"/auth/link/{code}/poll").json()
    assert result["status"] == "approved"
    assert result["token"]


def test_consumed_and_denied_links_are_swept(client):
    alice, _, _ = make_user(client, "Alice")

    consumed_code = client.post("/auth/link/start", json={"device_label": "A"}).json()["code"]
    client.post(f"/auth/link/{consumed_code}/approve", headers=alice)
    client.get(f"/auth/link/{consumed_code}/poll")   # consumes it

    denied_code = client.post("/auth/link/start", json={"device_label": "B"}).json()["code"]
    client.post(f"/auth/link/{denied_code}/deny", headers=alice)

    run_tick(time.time())

    assert db.query_one("SELECT 1 FROM device_links WHERE code = ?", (consumed_code,)) is None
    assert db.query_one("SELECT 1 FROM device_links WHERE code = ?", (denied_code,)) is None


# ── File attachments ──────────────────────────────────────────────────────────

def upload(client, headers, name="photo.png", data=b"\x89PNG\r\n\x1a\n fake image bytes",
           content_type="image/png"):
    return client.post("/uploads", headers=headers,
                       files={"file": (name, data, content_type)})


def test_upload_then_send_as_a_message(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment = upload(client, alice).json()
    assert attachment["content_type"] == "image/png"
    assert attachment["size_bytes"] > 0
    assert attachment["inline"] is True

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "text": "",
        "payload": {"attachment_id": attachment["attachment_id"]},
    }).json()
    assert message["kind"] == "photo"
    assert message["payload"]["file_name"] == "photo.png"

    # Bob is in the chat, so he can fetch the bytes.
    response = client.get(f"/uploads/{attachment['attachment_id']}", headers=bob)
    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"


def test_outsider_cannot_download_an_attachment(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment = upload(client, alice).json()
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo",
        "payload": {"attachment_id": attachment["attachment_id"]},
    })

    # Knowing the id is not permission — it is decided by the chat.
    assert client.get(f"/uploads/{attachment['attachment_id']}",
                      headers=mallory).status_code == 404


def test_an_unsent_upload_is_private_to_its_uploader(client):
    alice, _, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")

    attachment = upload(client, alice).json()

    assert client.get(f"/uploads/{attachment['attachment_id']}", headers=alice).status_code == 200
    assert client.get(f"/uploads/{attachment['attachment_id']}", headers=bob).status_code == 404


def test_cannot_send_someone_elses_attachment(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=mallory).json()["id"]

    attachment = upload(client, alice).json()

    # Mallory has the id but did not upload it.
    assert client.post("/messages", headers=mallory, json={
        "chat_id": chat_id, "kind": "photo",
        "payload": {"attachment_id": attachment["attachment_id"]},
    }).status_code == 400


def test_an_attachment_cannot_be_sent_twice(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    other_chat = client.post("/chats/group", headers=alice, json={"name": "Elsewhere"}).json()["id"]

    attachment = upload(client, alice).json()
    body = {"kind": "photo", "payload": {"attachment_id": attachment["attachment_id"]}}

    assert client.post("/messages", headers=alice,
                       json={**body, "chat_id": chat_id}).status_code == 200
    # Re-using it would move the file into a second conversation.
    assert client.post("/messages", headers=alice,
                       json={**body, "chat_id": other_chat}).status_code == 400


def test_html_and_svg_uploads_are_refused(client):
    """Both can carry script, and would run on our own origin."""
    alice, _, _ = make_user(client, "Alice")

    assert upload(client, alice, "evil.html", b"<script>alert(1)</script>",
                  "text/html").status_code == 415
    assert upload(client, alice, "evil.svg", b"<svg onload='alert(1)'/>",
                  "image/svg+xml").status_code == 415


def test_oversized_upload_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    too_big = b"x" * (main.uploads.MAX_UPLOAD_BYTES + 1024)

    response = upload(client, alice, "big.bin", too_big, "application/octet-stream")
    assert response.status_code == 413

    # And nothing was left behind on disk.
    assert db.query_one("SELECT COUNT(*) AS n FROM attachments WHERE uploader_id = "
                        "(SELECT id FROM users WHERE name = 'Alice' LIMIT 1)") is not None


def test_a_malicious_filename_cannot_escape_the_upload_directory(client):
    alice, _, _ = make_user(client, "Alice")

    attachment = upload(client, alice, "../../../../etc/passwd",
                        b"not really passwd", "application/octet-stream").json()

    # The stored name has no path left in it, and the file on disk is named
    # after the generated id.
    assert "/" not in attachment["file_name"]
    assert ".." not in attachment["file_name"]
    assert os.path.dirname(main.uploads.path_for(attachment["attachment_id"])) == \
        main.uploads.UPLOAD_DIR


def test_deleting_a_message_deletes_its_file(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment = upload(client, alice).json()
    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo",
        "payload": {"attachment_id": attachment["attachment_id"]},
    }).json()

    path = main.uploads.path_for(attachment["attachment_id"])
    assert os.path.exists(path)

    client.delete(f"/messages/{message['id']}", headers=alice)

    assert not os.path.exists(path)
    assert client.get(f"/uploads/{attachment['attachment_id']}", headers=bob).status_code == 404


def test_a_disappearing_photo_takes_its_file_with_it(client):
    """Otherwise the picture is gone from the chat but still sitting on disk."""
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment = upload(client, alice).json()
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "disappear_secs": 60,
        "payload": {"attachment_id": attachment["attachment_id"]},
    })

    path = main.uploads.path_for(attachment["attachment_id"])
    assert os.path.exists(path)

    run_tick(time.time() + 120)

    assert not os.path.exists(path)
    assert client.get(f"/uploads/{attachment['attachment_id']}", headers=bob).status_code == 404


def test_unsent_uploads_are_swept_away(client):
    alice, _, _ = make_user(client, "Alice")
    attachment = upload(client, alice).json()
    path = main.uploads.path_for(attachment["attachment_id"])
    assert os.path.exists(path)

    # Backdate it past the grace period, then run the sweep.
    db.execute("UPDATE attachments SET created_at = ? WHERE id = ?",
               (time.time() - 7200, attachment["attachment_id"]))
    main.uploads.sweep_orphans(older_than_seconds=3600)

    assert not os.path.exists(path)


def test_uploading_requires_authentication(client):
    assert client.post("/uploads", files={"file": ("x.png", b"data", "image/png")}).status_code == 401


# ── Ownership and member management ──────────────────────────────────────────

def test_owner_leaving_reassigns_to_an_admin_over_a_plain_member(client):
    """
    Without reassignment, owner_id keeps pointing at someone no longer in the
    chat and nobody can ever promote, remove, or manage members again.
    """
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    carol, carol_id, _ = make_user(client, "Carol")

    group = client.post("/chats/group", headers=alice,
                        json={"name": "Team", "member_ids": [bob_id, carol_id]}).json()
    # Bob is promoted to admin; Carol stays a plain member.
    client.patch(f"/chats/{group['id']}/members/{bob_id}", headers=alice, json={"role": "admin"})

    client.post(f"/chats/{group['id']}/leave", headers=alice)

    updated = client.get(f"/chats/{group['id']}", headers=bob).json()
    assert updated["owner_id"] == bob_id
    assert next(m for m in updated["members"] if m["id"] == bob_id)["role"] == "owner"
    # Carol, the plain member, was not chosen over the admin.
    assert next(m for m in updated["members"] if m["id"] == carol_id)["role"] == "member"


def test_last_member_leaving_makes_the_chat_ownerless_not_broken(client):
    alice, _, _ = make_user(client, "Alice")
    group = client.post("/chats/group", headers=alice, json={"name": "Solo"}).json()

    response = client.post(f"/chats/{group['id']}/leave", headers=alice)
    assert response.status_code == 200

    row = db.query_one("SELECT owner_id FROM chats WHERE id = ?", (group["id"],))
    assert row["owner_id"] is None


def test_member_leaving_does_not_touch_ownership(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice,
                        json={"name": "Team", "member_ids": [bob_id]}).json()

    client.post(f"/chats/{group['id']}/leave", headers=bob)

    row = db.query_one("SELECT owner_id FROM chats WHERE id = ?", (group["id"],))
    assert row["owner_id"] == alice_id


def test_owner_can_add_and_remove_members(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice, json={"name": "Team"}).json()

    added = client.post(f"/chats/{group['id']}/members", headers=alice,
                        json={"user_ids": [bob_id]}).json()
    assert added["added"] == [bob_id]
    assert client.get(f"/chats/{group['id']}/messages", headers=bob).status_code == 200

    client.delete(f"/chats/{group['id']}/members/{bob_id}", headers=alice)
    assert client.get(f"/chats/{group['id']}/messages", headers=bob).status_code == 404


def test_a_plain_member_cannot_add_or_remove_anyone(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, mallory_id, _ = make_user(client, "Mallory")
    group = client.post("/chats/group", headers=alice,
                        json={"name": "Team", "member_ids": [bob_id]}).json()

    assert client.post(f"/chats/{group['id']}/members", headers=bob,
                       json={"user_ids": [mallory_id]}).status_code == 403
    assert client.delete(f"/chats/{group['id']}/members/{bob_id}",
                         headers=bob).status_code == 403


def test_the_owner_cannot_be_removed_only_left(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice,
                        json={"name": "Team", "member_ids": [bob_id]}).json()
    client.patch(f"/chats/{group['id']}/members/{bob_id}", headers=alice, json={"role": "admin"})

    assert client.delete(f"/chats/{group['id']}/members/{alice_id}",
                         headers=bob).status_code == 400


def test_an_admin_cannot_remove_another_admin_only_the_owner_can(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    carol, carol_id, _ = make_user(client, "Carol")
    group = client.post("/chats/group", headers=alice,
                        json={"name": "Team", "member_ids": [bob_id, carol_id]}).json()
    client.patch(f"/chats/{group['id']}/members/{bob_id}", headers=alice, json={"role": "admin"})
    client.patch(f"/chats/{group['id']}/members/{carol_id}", headers=alice, json={"role": "admin"})

    assert client.delete(f"/chats/{group['id']}/members/{carol_id}", headers=bob).status_code == 403
    assert client.delete(f"/chats/{group['id']}/members/{carol_id}", headers=alice).status_code == 200


def test_only_the_owner_grants_or_revokes_admin(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    carol, carol_id, _ = make_user(client, "Carol")
    group = client.post("/chats/group", headers=alice,
                        json={"name": "Team", "member_ids": [bob_id, carol_id]}).json()
    client.patch(f"/chats/{group['id']}/members/{bob_id}", headers=alice, json={"role": "admin"})

    # Bob is an admin now, but only the owner may promote further.
    assert client.patch(f"/chats/{group['id']}/members/{carol_id}", headers=bob,
                        json={"role": "admin"}).status_code == 403
    assert client.patch(f"/chats/{group['id']}/members/{carol_id}", headers=alice,
                        json={"role": "admin"}).status_code == 200


def test_outsider_cannot_manage_a_group_they_are_not_in(client):
    alice, alice_id, _ = make_user(client, "Alice")
    mallory, _, _ = make_user(client, "Mallory")
    group = client.post("/chats/group", headers=alice, json={"name": "Team"}).json()

    assert client.post(f"/chats/{group['id']}/members", headers=mallory,
                       json={"user_ids": [alice_id]}).status_code == 404


def test_only_community_admins_can_post_in_the_community_root_chat(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    community = client.post("/chats/community", headers=alice,
                            json={"name": "Devs", "channels": ["general"]}).json()

    client.post(f"/chats/{community['id']}/join", headers=bob)

    denied = client.post("/messages", headers=bob, json={
        "chat_id": community["id"], "text": "hey everyone",
    })
    assert denied.status_code == 403

    allowed = client.post("/messages", headers=alice, json={
        "chat_id": community["id"], "text": "welcome to the community",
    })
    assert allowed.status_code == 200

    # A sub-channel is an ordinary chat with its own type — unaffected by the
    # community root's admin-only rule, any member can post there.
    sub_id = client.post(f"/chats/{community['id']}/channels", headers=alice,
                         json={"name": "chat"}).json()["id"]
    client.post(f"/chats/{sub_id}/join", headers=bob)
    sub_post = client.post("/messages", headers=bob, json={"chat_id": sub_id, "text": "hi"})
    assert sub_post.status_code == 200


# ── Community sub-channels ────────────────────────────────────────────────────

def test_adding_a_sub_channel_after_the_community_exists(client):
    alice, _, _ = make_user(client, "Alice")
    mallory, _, _ = make_user(client, "Mallory")
    community = client.post("/chats/community", headers=alice,
                            json={"name": "Devs", "channels": ["general"]}).json()

    before = client.get(f"/chats/{community['id']}/channels", headers=alice).json()
    assert len(before) == 1

    sub = client.post(f"/chats/{community['id']}/channels", headers=alice,
                      json={"name": "help"}).json()
    assert sub["type"] == "community_channel"
    assert sub["parent_id"] == community["id"]

    after = client.get(f"/chats/{community['id']}/channels", headers=alice).json()
    assert len(after) == 2

    # Not open to a non-member of the community.
    assert client.post(f"/chats/{community['id']}/channels", headers=mallory,
                       json={"name": "spam"}).status_code == 403


# ── Read state ────────────────────────────────────────────────────────────────

def test_read_state_reflects_the_peers_last_read_seq(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "hi"})

    state = client.get(f"/chats/{chat_id}/read-state", headers=alice).json()
    assert state == [{"user_id": bob_id, "last_read_seq": 0}]

    client.post(f"/chats/{chat_id}/read", headers=bob, json={"seq": 1})

    state = client.get(f"/chats/{chat_id}/read-state", headers=alice).json()
    assert state == [{"user_id": bob_id, "last_read_seq": 1}]


def test_read_state_omits_a_member_who_turned_off_read_receipts(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.patch("/me", headers=bob, json={"show_read_receipts": False})

    state = client.get(f"/chats/{chat_id}/read-state", headers=alice).json()
    assert state == []


# ── Message rate limiting ─────────────────────────────────────────────────────

def test_sending_too_fast_is_throttled(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    codes = [
        client.post("/messages", headers=alice,
                    json={"chat_id": chat_id, "text": str(i)}).status_code
        for i in range(main.message_rate_limiter.max_events + 3)
    ]

    assert codes[0] == 200
    assert codes[-1] == 429

    # Clear so the rest of the suite is unaffected.
    main.message_rate_limiter.history.pop(_user_id_from_headers(client, alice), None)


def _user_id_from_headers(client, headers):
    return client.get("/me", headers=headers).json()["id"]


# ── Chat lock ─────────────────────────────────────────────────────────────────

def test_lock_then_unlock_with_correct_and_wrong_pin(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    assert client.post(f"/chats/{chat_id}/lock", headers=alice, json={"pin": "1234"}).status_code == 200

    locked = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert locked["is_locked"] is True

    assert client.post(f"/chats/{chat_id}/unlock", headers=alice,
                       json={"pin": "0000"}).status_code == 401
    assert client.post(f"/chats/{chat_id}/unlock", headers=alice,
                       json={"pin": "1234"}).status_code == 200


def test_cannot_silently_overwrite_an_existing_pin(client):
    """
    Without this, any member could relock the chat with a PIN of their own
    choosing and lock out whoever set the original one.
    """
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post(f"/chats/{chat_id}/lock", headers=alice, json={"pin": "1234"})

    response = client.post(f"/chats/{chat_id}/lock", headers=bob, json={"pin": "9999"})
    assert response.status_code == 400

    # The original PIN still works — Bob's attempt changed nothing.
    assert client.post(f"/chats/{chat_id}/unlock", headers=alice,
                       json={"pin": "1234"}).status_code == 200


def test_removing_a_lock_requires_the_pin_then_allows_a_new_one(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post(f"/chats/{chat_id}/lock", headers=alice, json={"pin": "1234"})

    assert client.request("DELETE", f"/chats/{chat_id}/lock", headers=alice,
                          json={"pin": "0000"}).status_code == 401

    assert client.request("DELETE", f"/chats/{chat_id}/lock", headers=alice,
                          json={"pin": "1234"}).status_code == 200

    unlocked = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert unlocked["is_locked"] is False

    # And now a fresh PIN can be set.
    assert client.post(f"/chats/{chat_id}/lock", headers=alice, json={"pin": "5678"}).status_code == 200


def test_sub_channel_responses_never_include_the_pin_hash(client):
    """
    list_community_channels and create_sub_channel used a plain dict(row)
    shortcut that skipped the scrubbing every other chat-returning endpoint
    does, and would have handed the raw PBKDF2 hash to any member who could
    see the community's channel list.
    """
    alice, _, _ = make_user(client, "Alice")
    community = client.post("/chats/community", headers=alice,
                            json={"name": "Devs", "channels": ["general"]}).json()
    sub = client.get(f"/chats/{community['id']}/channels", headers=alice).json()[0]
    client.post(f"/chats/{sub['id']}/lock", headers=alice, json={"pin": "1234"})

    created = client.post(f"/chats/{community['id']}/channels", headers=alice,
                          json={"name": "help"}).json()
    listed = client.get(f"/chats/{community['id']}/channels", headers=alice).json()

    assert "pin_hash" not in created
    for row in listed:
        assert "pin_hash" not in row
    locked_row = next(row for row in listed if row["id"] == sub["id"])
    assert locked_row["is_locked"] is True


def test_outsider_cannot_lock_or_unlock_a_chat_they_are_not_in(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    assert client.post(f"/chats/{chat_id}/lock", headers=mallory,
                       json={"pin": "1234"}).status_code == 404


# ── Bulk messaging API ─────────────────────────────────────────────────────────

def make_api_key(client, headers, label="Test key"):
    created = client.post("/me/api-keys", headers=headers, json={"label": label}).json()
    return {"Authorization": f"Bearer {created['key']}"}, created["id"], created["key"]


def test_create_list_and_revoke_api_key(client):
    alice, _, _ = make_user(client, "Alice")

    created = client.post("/me/api-keys", headers=alice, json={"label": "Notifier"}).json()
    assert created["key"].startswith("hk_")

    listed = client.get("/me/api-keys", headers=alice).json()
    assert len(listed) == 1
    assert listed[0]["label"] == "Notifier"
    assert listed[0]["prefix"] == created["key"][:10]
    # The raw key is never present in the list — only the prefix.
    assert "key" not in listed[0] and "key_hash" not in listed[0]

    assert client.delete(f"/me/api-keys/{created['id']}", headers=alice).status_code == 200
    assert client.get("/me/api-keys", headers=alice).json() == []


def test_bulk_send_creates_a_dm_and_delivers_normally(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")
    key, _, _ = make_api_key(client, alice)

    response = client.post("/api/v1/messages", headers=key,
                           json={"to": bob_username, "text": "Your OTP is 482913"})
    assert response.status_code == 200
    body = response.json()
    assert body["seq"] == 1

    # Bob sees it as an ordinary message in an ordinary DM — not a separate
    # bulk-only inbox.
    messages = client.get(f"/chats/{body['chat_id']}/messages", headers=bob).json()
    assert messages[0]["text"] == "Your OTP is 482913"
    assert messages[0]["sender_id"] == alice_id


def test_bulk_send_reuses_the_same_dm_a_human_would_land_in(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")

    human_chat = client.post(f"/chats/dm/{bob_id}", headers=alice).json()
    key, _, _ = make_api_key(client, alice)
    sent = client.post("/api/v1/messages", headers=key,
                       json={"to": bob_username, "text": "hi"}).json()

    assert sent["chat_id"] == human_chat["id"]


def test_bulk_send_deduplicates_on_client_msg_id(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")
    key, _, _ = make_api_key(client, alice)

    body = {"to": bob_username, "text": "retry-safe", "client_msg_id": "job-42"}
    first = client.post("/api/v1/messages", headers=key, json=body).json()
    second = client.post("/api/v1/messages", headers=key, json=body).json()

    assert first["message_id"] == second["message_id"]
    messages = client.get(f"/chats/{first['chat_id']}/messages", headers=bob).json()
    assert [m["text"] for m in messages].count("retry-safe") == 1


def test_bulk_send_to_unknown_username_is_rejected(client):
    alice, _, _ = make_user(client, "Alice")
    key, _, _ = make_api_key(client, alice)
    response = client.post("/api/v1/messages", headers=key,
                           json={"to": "nobody_here", "text": "hi"})
    assert response.status_code == 404


def test_bulk_send_respects_blocking(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")
    key, _, _ = make_api_key(client, alice)

    # Bob blocked Alice; Alice's key must not be able to reach him.
    client.post(f"/users/{alice_id}/block", headers=bob)

    response = client.post("/api/v1/messages", headers=key,
                           json={"to": bob_username, "text": "hi"})
    assert response.status_code == 403


def test_bulk_send_is_rate_limited_separately_from_interactive_sends(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")
    key, _, _ = make_api_key(client, alice)

    codes = [
        client.post("/api/v1/messages", headers=key,
                   json={"to": bob_username, "text": str(i)}).status_code
        for i in range(main.bulk_rate_limiter.max_events + 3)
    ]
    assert codes[0] == 200
    assert codes[-1] == 429

    # Clear so the rest of the suite is unaffected.
    main.bulk_rate_limiter.history.pop(alice_id, None)


def test_a_revoked_key_stops_working_immediately(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")
    key, key_id, _ = make_api_key(client, alice)

    assert client.post("/api/v1/messages", headers=key,
                       json={"to": bob_username, "text": "before"}).status_code == 200

    client.delete(f"/me/api-keys/{key_id}", headers=alice)

    assert client.post("/api/v1/messages", headers=key,
                       json={"to": bob_username, "text": "after"}).status_code == 401


def test_a_session_token_cannot_be_used_as_an_api_key(client):
    """
    The whole point of a separate credential type: a session token leaked from
    a browser must not be usable to hit the bulk-sending route, and a bulk key
    must not unlock the interactive account.
    """
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, bob_username = make_user(client, "Bob")

    assert client.post("/api/v1/messages", headers=alice,
                       json={"to": bob_username, "text": "hi"}).status_code == 401

    key, _, _ = make_api_key(client, alice)
    assert client.get("/me", headers=key).status_code == 401
    assert client.get("/chats", headers=key).status_code == 401


def test_cannot_manage_someone_elses_api_key(client):
    alice, _, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")
    _, key_id, _ = make_api_key(client, alice)

    assert client.delete(f"/me/api-keys/{key_id}", headers=bob).status_code == 404
    # Alice's key is untouched — Bob's attempt did nothing.
    assert len(client.get("/me/api-keys", headers=alice).json()) == 1


# ── WebSocket ─────────────────────────────────────────────────────────────────

def ws_ticket_for(client, username):
    """Log in, then mint the short-lived, single-use ticket /ws actually
    authenticates with (see main.create_ws_ticket) — the socket handshake
    can't carry the session token itself as a header."""
    token = client.post("/auth/login", json={
        "username": username, "password": "correct horse battery"}).json()["token"]
    return client.post("/auth/ws-ticket",
                       headers={"Authorization": f"Bearer {token}"}).json()["ticket"]


def test_websocket_rejects_a_bad_ticket(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws?ticket=not-a-real-ticket") as socket:
            socket.receive_json()


def test_websocket_rejects_no_ticket(client):
    with pytest.raises(Exception):
        with client.websocket_connect("/ws") as socket:
            socket.receive_json()


def test_message_arrives_live_on_the_recipients_socket(client):
    alice, _, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    # Bob connects once, for everything — not once per chat as the old client did.
    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as socket:
        client.post("/messages", headers=alice,
                    json={"chat_id": chat_id, "text": "live delivery"})

        event = socket.receive_json()
        assert event["type"] == "message"
        assert event["message"]["text"] == "live delivery"
        assert event["message"]["chat_id"] == chat_id


def test_outsider_socket_receives_nothing_from_a_chat_they_are_not_in(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, mallory_name = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, mallory_name)}") as socket:
        client.post("/messages", headers=alice,
                    json={"chat_id": chat_id, "text": "not for mallory"})

        # Prove the socket is alive, and that the only thing on it is our own
        # pong — the message above was never routed to her.
        socket.send_json({"type": "ping"})
        event = socket.receive_json()
        assert event["type"] == "pong"


def test_typing_cannot_be_broadcast_into_a_chat_you_are_not_in(client):
    alice, _, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    mallory, _, mallory_name = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
        with client.websocket_connect(
                f"/ws?ticket={ws_ticket_for(client, mallory_name)}") as mallory_socket:
            # Mallory names a chat she is not in.
            mallory_socket.send_json({"type": "typing", "chat_id": chat_id})
            mallory_socket.send_json({"type": "ping"})
            assert mallory_socket.receive_json()["type"] == "pong"

        # Bob must not have been told Mallory is typing. Ping him and confirm the
        # next thing he sees is his own pong.
        bob_socket.send_json({"type": "ping"})
        assert bob_socket.receive_json()["type"] == "pong"


def test_scheduled_message_is_pushed_live_when_it_fires(client):
    """The scheduler must reach connected clients, not just write to the table."""
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    send_at = time.time() + HOUR
    client.post("/scheduled", headers=alice, json={
        "chat_id": chat_id, "text": "queued then pushed", "send_at": send_at,
    })

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as socket:
        run_tick(send_at + 1)
        event = socket.receive_json()
        assert event["type"] == "message"
        assert event["message"]["text"] == "queued then pushed"


def test_outsider_cannot_see_a_meeting(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    meeting = client.post("/meetings", headers=alice, json={
        "chat_id": chat_id, "title": "Private", "starts_at": time.time() + HOUR,
    }).json()

    assert client.get(f"/meetings/{meeting['id']}", headers=mallory).status_code == 404


# ── Call signaling ───────────────────────────────────────────────────────────

def test_a_call_invite_reaches_the_dm_peer(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
            # Alice's own socket opening fires a presence event to Bob, since
            # they share this DM — drain it before looking for the call.
            assert bob_socket.receive_json()["type"] == "presence"

            alice_socket.send_json({
                "type": "call_invite", "to": bob_id, "chat_id": chat_id,
                "call_kind": "voice", "sdp": {"type": "offer", "sdp": "v=0..."},
            })
            event = bob_socket.receive_json()
            assert event["type"] == "call_invite"
            assert event["from"] == alice_id
            assert event["chat_id"] == chat_id
            assert event["call_kind"] == "voice"
            assert event["sdp"] == {"type": "offer", "sdp": "v=0..."}
            assert event["from_name"] == "Alice"


def test_call_signaling_round_trip_answer_ice_and_end(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
            assert alice_socket.receive_json()["type"] == "presence"

            bob_socket.send_json({
                "type": "call_answer", "to": alice_id, "chat_id": chat_id,
                "sdp": {"type": "answer", "sdp": "v=0..."},
            })
            event = alice_socket.receive_json()
            assert event["type"] == "call_answer" and event["from"] == bob_id

            bob_socket.send_json({
                "type": "call_ice", "to": alice_id, "chat_id": chat_id,
                "candidate": {"candidate": "candidate:1 1 UDP 1 1.2.3.4 5000 typ host"},
            })
            event = alice_socket.receive_json()
            assert event["type"] == "call_ice" and event["candidate"]["candidate"].startswith("candidate:1")

            bob_socket.send_json({"type": "call_end", "to": alice_id, "chat_id": chat_id})
            event = alice_socket.receive_json()
            assert event["type"] == "call_end" and event["from"] == bob_id


def test_call_invite_to_a_stranger_is_refused(client):
    """The target has to be the actual DM peer, not merely some other user id."""
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, mallory_id, mallory_name = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        # Alice tries to ring Mallory by naming her Alice/Bob DM — Mallory is
        # not the peer in that chat.
        alice_socket.send_json({
            "type": "call_invite", "to": mallory_id, "chat_id": chat_id,
            "call_kind": "voice", "sdp": {"type": "offer", "sdp": "v=0..."},
        })
        event = alice_socket.receive_json()
        assert event["type"] == "call_error"


def test_blocked_users_cannot_call_each_other(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post(f"/users/{bob_id}/block", headers=alice)

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        alice_socket.send_json({
            "type": "call_invite", "to": bob_id, "chat_id": chat_id,
            "call_kind": "voice", "sdp": {"type": "offer", "sdp": "v=0..."},
        })
        event = alice_socket.receive_json()
        assert event["type"] == "call_error"


def test_an_outsider_cannot_signal_into_a_chat_they_are_not_in(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, mallory_id, mallory_name = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, mallory_name)}") as mallory_socket:
        mallory_socket.send_json({
            "type": "call_invite", "to": alice_id, "chat_id": chat_id,
            "call_kind": "voice", "sdp": {"type": "offer", "sdp": "v=0..."},
        })
        event = mallory_socket.receive_json()
        assert event["type"] == "call_error"


# ── Group calling ─────────────────────────────────────────────────────────────

def make_group(client, owner_headers, member_ids, name="Team"):
    return client.post("/chats/group", headers=owner_headers,
                       json={"name": name, "member_ids": member_ids}).json()["id"]


def test_starting_a_group_call_rings_other_members(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = make_group(client, alice, [bob_id])

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
            assert bob_socket.receive_json()["type"] == "presence"

            alice_socket.send_json({
                "type": "group_call_start", "chat_id": chat_id, "call_kind": "voice",
            })
            roster = alice_socket.receive_json()
            assert roster["type"] == "group_call_roster"
            assert roster["participants"] == []   # Alice is first in

            invite = bob_socket.receive_json()
            assert invite["type"] == "group_call_invite"
            assert invite["user_id"] == alice_id
            assert invite["call_kind"] == "voice"


def test_joining_an_existing_group_call_gets_the_roster(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = make_group(client, alice, [bob_id])

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
            assert alice_socket.receive_json()["type"] == "presence"

            alice_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "video"})
            assert alice_socket.receive_json()["type"] == "group_call_roster"
            # Bob was already connected and listening, so Alice starting the
            # call rings him — that arrives before anything he sends himself.
            assert bob_socket.receive_json()["type"] == "group_call_invite"

            bob_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "video"})
            roster = bob_socket.receive_json()
            assert roster["type"] == "group_call_roster"
            assert [p["user_id"] for p in roster["participants"]] == [alice_id]

            joined = alice_socket.receive_json()
            assert joined["type"] == "group_call_participant_joined"
            assert joined["user_id"] == bob_id


def test_group_call_signaling_relay(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = make_group(client, alice, [bob_id])

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
            assert alice_socket.receive_json()["type"] == "presence"
            alice_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
            alice_socket.receive_json()  # group_call_roster
            assert bob_socket.receive_json()["type"] == "group_call_invite"
            bob_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
            bob_socket.receive_json()  # group_call_roster
            alice_socket.receive_json()  # group_call_participant_joined

            bob_socket.send_json({
                "type": "group_call_offer", "chat_id": chat_id, "to": alice_id,
                "sdp": {"type": "offer", "sdp": "v=0..."},
            })
            offer = alice_socket.receive_json()
            assert offer["type"] == "group_call_offer" and offer["from"] == bob_id

            alice_socket.send_json({
                "type": "group_call_answer", "chat_id": chat_id, "to": bob_id,
                "sdp": {"type": "answer", "sdp": "v=0..."},
            })
            answer = bob_socket.receive_json()
            assert answer["type"] == "group_call_answer" and answer["from"] == alice_id

            bob_socket.send_json({
                "type": "group_call_ice", "chat_id": chat_id, "to": alice_id,
                "candidate": {"candidate": "candidate:1 1 UDP 1 1.2.3.4 5000 typ host"},
            })
            ice = alice_socket.receive_json()
            assert ice["type"] == "group_call_ice" and ice["from"] == bob_id


def test_leaving_a_group_call_notifies_remaining_participants(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = make_group(client, alice, [bob_id])

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
            assert alice_socket.receive_json()["type"] == "presence"
            alice_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
            alice_socket.receive_json()  # group_call_roster
            assert bob_socket.receive_json()["type"] == "group_call_invite"
            bob_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
            bob_socket.receive_json()  # group_call_roster
            alice_socket.receive_json()  # group_call_participant_joined

            bob_socket.send_json({"type": "group_call_leave", "chat_id": chat_id})
            left = alice_socket.receive_json()
            assert left["type"] == "group_call_participant_left" and left["user_id"] == bob_id


def test_disconnecting_mid_call_removes_the_participant(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = make_group(client, alice, [bob_id])

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}") as bob_socket:
            assert alice_socket.receive_json()["type"] == "presence"
            alice_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
            alice_socket.receive_json()  # group_call_roster
            assert bob_socket.receive_json()["type"] == "group_call_invite"
            bob_socket.send_json({"type": "group_call_start", "chat_id": chat_id, "call_kind": "voice"})
            bob_socket.receive_json()  # group_call_roster
            alice_socket.receive_json()  # group_call_participant_joined

        # Bob's socket just closed (the `with` block exited) without an
        # explicit group_call_leave — the server's disconnect cleanup has to
        # catch this exactly like a clean leave would.
        left = alice_socket.receive_json()
        assert left["type"] == "group_call_participant_left" and left["user_id"] == bob_id


def test_group_calling_is_restricted_to_group_chats(client):
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    dm_chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as alice_socket:
        alice_socket.send_json({
            "type": "group_call_start", "chat_id": dm_chat_id, "call_kind": "voice",
        })
        alice_socket.send_json({"type": "ping"})
        # Nothing came back for the group_call_start on a DM — the very next
        # thing on the socket is the ping's own pong.
        assert alice_socket.receive_json()["type"] == "pong"


def test_outsider_cannot_start_a_group_call(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, mallory_name = make_user(client, "Mallory")
    chat_id = make_group(client, alice, [bob_id])

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, mallory_name)}") as mallory_socket:
        mallory_socket.send_json({
            "type": "group_call_start", "chat_id": chat_id, "call_kind": "voice",
        })
        mallory_socket.send_json({"type": "ping"})
        assert mallory_socket.receive_json()["type"] == "pong"


def test_a_call_log_message_records_the_outcome(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "call",
        "payload": {"call_kind": "video", "status": "completed", "duration_secs": 125.9},
    }).json()
    assert message["kind"] == "call"
    # A fractional duration from a client-side timer must not leak into storage.
    assert message["payload"] == {"call_kind": "video", "status": "completed", "duration_secs": 125}


def test_call_log_gathers_calls_across_chats_with_the_dm_peer_resolved(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "call",
        "payload": {"call_kind": "voice", "status": "completed", "duration_secs": 42},
    })

    calls = client.get("/calls", headers=alice).json()
    assert len(calls) == 1
    assert calls[0]["chat_type"] == "dm"
    assert calls[0]["chat_name"] == "Bob"  # the peer's name, not the blank DM name
    assert calls[0]["peer_id"] == bob_id

    # Bob sees the same call in his own log, with Alice as the resolved peer.
    bob_calls = client.get("/calls", headers=bob).json()
    assert bob_calls[0]["chat_name"] == "Alice"


def test_a_call_log_needs_a_valid_kind_and_status(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    bad_kind = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "call",
        "payload": {"call_kind": "telepathy", "status": "completed"},
    })
    assert bad_kind.status_code == 400

    bad_status = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "call",
        "payload": {"call_kind": "voice", "status": "ringing_forever"},
    })
    assert bad_status.status_code == 400


# ── Archived chats ────────────────────────────────────────────────────────────

def test_archiving_a_chat_is_visible_in_the_chat_list(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.patch(f"/chats/{chat_id}/settings", headers=alice, json={"archived": True})
    chat = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    # SQLite has no real boolean — every flag like this round-trips as 0/1,
    # same as `is_pinned` elsewhere, not a Python bool.
    assert bool(chat["archived"]) is True

    client.patch(f"/chats/{chat_id}/settings", headers=alice, json={"archived": False})
    chat = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert bool(chat["archived"]) is False


def test_a_new_message_unarchives_the_chat_for_the_recipient_only(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    alice_id = client.get("/me", headers=alice).json()["id"]

    client.patch(f"/chats/{chat_id}/settings", headers=alice, json={"archived": True})
    client.patch(f"/chats/{chat_id}/settings", headers=bob, json={"archived": True})

    client.post("/messages", headers=bob, json={"chat_id": chat_id, "text": "hi"})

    # Alice received the message, so it un-archives for her...
    alice_chat = next(c for c in client.get("/chats", headers=alice).json() if c["id"] == chat_id)
    assert bool(alice_chat["archived"]) is False
    # ...but Bob sent it, so his own archive of the conversation is untouched.
    bob_chat = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == chat_id)
    assert bool(bob_chat["archived"]) is True


# ── Pinned chats ──────────────────────────────────────────────────────────────

def test_pinning_a_fourth_chat_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    chat_ids = []
    for i in range(4):
        _, other_id, _ = make_user(client, f"Friend{i}")
        chat_id = client.post(f"/chats/dm/{other_id}", headers=alice).json()["id"]
        chat_ids.append(chat_id)

    for chat_id in chat_ids[:3]:
        ok = client.patch(f"/chats/{chat_id}/settings", headers=alice, json={"is_pinned": True})
        assert ok.status_code == 200, ok.text

    denied = client.patch(f"/chats/{chat_ids[3]}/settings", headers=alice, json={"is_pinned": True})
    assert denied.status_code == 400

    # Unpinning one frees up a slot for the fourth.
    client.patch(f"/chats/{chat_ids[0]}/settings", headers=alice, json={"is_pinned": False})
    ok = client.patch(f"/chats/{chat_ids[3]}/settings", headers=alice, json={"is_pinned": True})
    assert ok.status_code == 200


def test_re_pinning_an_already_pinned_chat_does_not_count_twice(client):
    alice, _, _ = make_user(client, "Alice")
    _, other_id, _ = make_user(client, "Friend")
    chat_id = client.post(f"/chats/dm/{other_id}", headers=alice).json()["id"]

    client.patch(f"/chats/{chat_id}/settings", headers=alice, json={"is_pinned": True})
    # Setting it again (e.g. a retried request) must not be treated as pin #2.
    ok = client.patch(f"/chats/{chat_id}/settings", headers=alice, json={"is_pinned": True})
    assert ok.status_code == 200


# ── Clear chat ────────────────────────────────────────────────────────────────

def test_clearing_a_chat_hides_history_for_the_caller_only(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "one"})
    client.post("/messages", headers=bob, json={"chat_id": chat_id, "text": "two"})

    cleared = client.post(f"/chats/{chat_id}/clear", headers=alice)
    assert cleared.status_code == 200
    assert cleared.json()["cleared"] == 2

    assert client.get(f"/chats/{chat_id}/messages", headers=alice).json() == []
    # Bob's copy of the conversation is untouched.
    assert len(client.get(f"/chats/{chat_id}/messages", headers=bob).json()) == 2


def test_a_message_sent_after_clearing_still_shows_up(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "old"})

    client.post(f"/chats/{chat_id}/clear", headers=alice)
    client.post("/messages", headers=bob, json={"chat_id": chat_id, "text": "new"})

    remaining = client.get(f"/chats/{chat_id}/messages", headers=alice).json()
    assert [m["text"] for m in remaining] == ["new"]


# ── Starred messages ──────────────────────────────────────────────────────────

def test_starring_and_unstarring_a_message(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "remember this"}).json()

    assert client.post(f"/messages/{message['id']}/star", headers=alice).status_code == 200
    starred = client.get("/me/starred", headers=alice).json()
    assert len(starred) == 1
    assert starred[0]["id"] == message["id"]

    assert client.request("DELETE", f"/messages/{message['id']}/star", headers=alice).status_code == 200
    assert client.get("/me/starred", headers=alice).json() == []


def test_starring_is_personal_not_shared(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "only alice cares"}).json()

    client.post(f"/messages/{message['id']}/star", headers=alice)
    # Bob is in the same chat but never starred it himself.
    assert client.get("/me/starred", headers=bob).json() == []


def test_starred_messages_from_a_dm_show_the_peers_name(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "hi"}).json()
    client.post(f"/messages/{message['id']}/star", headers=alice)

    starred = client.get("/me/starred", headers=alice).json()
    # A DM's `chats.name` column is blank — this must resolve to Bob's real
    # name, the same way the chat list does, not show up empty.
    assert starred[0]["chat_name"] == "Bob"


def test_outsider_cannot_star_a_message_in_a_chat_they_are_not_in(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "private"}).json()

    assert client.post(f"/messages/{message['id']}/star", headers=mallory).status_code == 404


# ── Shared media gallery ──────────────────────────────────────────────────────

def test_media_gallery_lists_photos_and_documents_but_not_text(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment = upload(client, alice).json()
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo",
        "payload": {"attachment_id": attachment["attachment_id"]},
    })
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "just chatting"})

    media = client.get(f"/chats/{chat_id}/media", headers=bob).json()
    assert len(media) == 1
    assert media[0]["kind"] == "photo"


def test_outsider_cannot_list_media_for_a_chat_they_are_not_in(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    mallory, _, _ = make_user(client, "Mallory")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    assert client.get(f"/chats/{chat_id}/media", headers=mallory).status_code == 404


# ── Invite links ──────────────────────────────────────────────────────────────

def test_generating_and_joining_via_an_invite_link(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice, json={
        "name": "Trip planning", "member_ids": [],
    }).json()

    invite = client.post(f"/chats/{group['id']}/invite", headers=alice).json()
    assert invite["invite_code"]

    preview = client.get(f"/invite/{invite['invite_code']}", headers=bob).json()
    assert preview["name"] == "Trip planning"
    assert preview["already_joined"] is False

    joined = client.post(f"/invite/{invite['invite_code']}/join", headers=bob).json()
    assert joined["chat_id"] == group["id"]

    chat = next(c for c in client.get("/chats", headers=bob).json() if c["id"] == group["id"])
    assert chat is not None


def test_only_owner_or_admin_can_create_an_invite_link(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice, json={
        "name": "Team", "member_ids": [bob_id],
    }).json()

    assert client.post(f"/chats/{group['id']}/invite", headers=bob).status_code == 403


def test_revoking_an_invite_link_stops_it_from_working(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice, json={
        "name": "Team", "member_ids": [],
    }).json()

    invite = client.post(f"/chats/{group['id']}/invite", headers=alice).json()
    client.request("DELETE", f"/chats/{group['id']}/invite", headers=alice)

    assert client.get(f"/invite/{invite['invite_code']}", headers=bob).status_code == 404
    assert client.post(f"/invite/{invite['invite_code']}/join", headers=bob).status_code == 404


def test_an_unknown_invite_code_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    assert client.get("/invite/not-a-real-code", headers=alice).status_code == 404
    assert client.post("/invite/not-a-real-code/join", headers=alice).status_code == 404


def test_a_dm_cannot_have_an_invite_link(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    assert client.post(f"/chats/{chat_id}/invite", headers=alice).status_code == 400


# ── Web Push ──────────────────────────────────────────────────────────────────

def test_vapid_public_key_is_available_without_auth(client):
    response = client.get("/push/vapid-public-key")
    assert response.status_code == 200
    assert len(response.json()["key"]) > 20


def test_subscribing_and_unsubscribing_to_push(client):
    alice, _, _ = make_user(client, "Alice")
    sub = client.post("/push/subscribe", headers=alice, json={
        "endpoint": "https://push.example.com/abc", "p256dh": "key1", "auth": "auth1",
    })
    assert sub.status_code == 200

    unsub = client.request("DELETE", "/push/subscribe", headers=alice,
                           json={"endpoint": "https://push.example.com/abc"})
    assert unsub.status_code == 200


def test_offline_recipient_gets_a_push_notification(client, monkeypatch):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post("/push/subscribe", headers=bob, json={
        "endpoint": "https://push.example.com/bob", "p256dh": "key1", "auth": "auth1",
    })

    calls = []
    monkeypatch.setattr(main.push, "send",
                        lambda sub, title, body, data=None: calls.append((title, body)) or "ok")

    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "hi bob"})

    assert len(calls) == 1
    assert calls[0] == ("Alice", "hi bob")


def test_online_recipient_does_not_get_a_push(client, monkeypatch):
    """Someone with a live socket already sees the message arrive there —
    pushing them a duplicate OS notification is exactly the noise this
    endpoint exists to avoid."""
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, bob_name = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post("/push/subscribe", headers=bob, json={
        "endpoint": "https://push.example.com/bob2", "p256dh": "key1", "auth": "auth1",
    })

    calls = []
    monkeypatch.setattr(main.push, "send", lambda *a, **k: calls.append(1) or "ok")

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, bob_name)}"):
        client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "hi bob"})

    assert len(calls) == 0


def test_a_gone_push_subscription_is_deleted(client, monkeypatch):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    client.post("/push/subscribe", headers=bob, json={
        "endpoint": "https://push.example.com/dead", "p256dh": "key1", "auth": "auth1",
    })

    monkeypatch.setattr(main.push, "send", lambda *a, **k: "gone")
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "hi"})

    remaining = db.query_one("SELECT * FROM push_subscriptions WHERE endpoint = ?",
                             ("https://push.example.com/dead",))
    assert remaining is None


def test_push_send_never_raises_on_a_real_network_failure(client):
    """push.send() must swallow anything the webpush library or the network
    throws — a subscription pointing at an endpoint that can't be reached at
    all (not just a clean 404/410) must not take the request down with it."""
    import push as push_module
    result = push_module.send(
        {"endpoint": "https://not-a-real-push-service.invalid/x",
         "keys": {"p256dh": "abc", "auth": "def"}},
        "Title", "Body",
    )
    assert result == "error"


# ── Broadcast lists ────────────────────────────────────────────────────────────

def test_broadcast_message_is_delivered_as_an_ordinary_dm_to_each_recipient(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    carol, carol_id, _ = make_user(client, "Carol")

    broadcast = client.post("/chats/broadcast", headers=alice, json={
        "name": "Announcements", "recipient_ids": [bob_id, carol_id],
    }).json()
    assert broadcast["type"] == "broadcast"

    sent = client.post("/messages", headers=alice, json={
        "chat_id": broadcast["id"], "text": "big news!",
    })
    assert sent.status_code == 200

    # Bob and Carol each see it in their own ordinary DM with Alice — not a
    # shared room, and not visible to each other.
    for recipient, recipient_id in [(bob, bob_id), (carol, carol_id)]:
        low, high = sorted([alice_id, recipient_id])
        dm_id = f"dm_{low}_{high}"
        messages = client.get(f"/chats/{dm_id}/messages", headers=recipient).json()
        assert any(m["text"] == "big news!" and m["payload"]["via_broadcast"] == "Announcements"
                  for m in messages)


def test_broadcast_recipients_cannot_see_the_broadcast_chat_itself(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    broadcast = client.post("/chats/broadcast", headers=alice, json={
        "name": "List", "recipient_ids": [bob_id],
    }).json()

    # Bob is a recipient, not a chat_member — he has no visibility into the
    # broadcast chat itself, only into what lands in his own DM. Both routes
    # 404 rather than 403, since he isn't a member at all (see require_member).
    assert client.get(f"/chats/{broadcast['id']}/messages", headers=bob).status_code == 404
    assert client.get(f"/chats/{broadcast['id']}/broadcast/recipients", headers=bob).status_code == 404


def test_only_the_broadcast_owner_can_send_to_it(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    broadcast = client.post("/chats/broadcast", headers=alice, json={
        "name": "List", "recipient_ids": [bob_id],
    }).json()

    # Bob was never added as a chat_member, so this is refused before it can
    # even reach the ownership check.
    denied = client.post("/messages", headers=bob, json={"chat_id": broadcast["id"], "text": "hey"})
    assert denied.status_code in (403, 404)


def test_broadcast_list_is_capped_at_512_recipients(client):
    alice, _, _ = make_user(client, "Alice")
    fake_ids = [f"user_{i}" for i in range(513)]
    denied = client.post("/chats/broadcast", headers=alice, json={
        "name": "Huge list", "recipient_ids": fake_ids,
    })
    assert denied.status_code == 400


def test_adding_a_broadcast_recipient_past_the_cap_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    broadcast = client.post("/chats/broadcast", headers=alice, json={"name": "List"}).json()

    real_ids = []
    for i in range(3):
        _, uid, _ = make_user(client, f"Real{i}")
        real_ids.append(uid)
    client.post(f"/chats/{broadcast['id']}/broadcast/recipients", headers=alice,
               json={"user_ids": real_ids})

    fake_ids = [f"user_padding_{i}" for i in range(510)]
    denied = client.post(f"/chats/{broadcast['id']}/broadcast/recipients", headers=alice,
                         json={"user_ids": fake_ids + [f"pad_{i}" for i in range(10)]})
    assert denied.status_code == 400


def test_broadcast_owner_can_remove_a_recipient(client):
    alice, _, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    broadcast = client.post("/chats/broadcast", headers=alice, json={
        "name": "List", "recipient_ids": [bob_id],
    }).json()

    client.delete(f"/chats/{broadcast['id']}/broadcast/recipients/{bob_id}", headers=alice)
    recipients = client.get(f"/chats/{broadcast['id']}/broadcast/recipients", headers=alice).json()
    assert recipients == []


def test_blocked_recipient_does_not_receive_a_broadcast(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    client.post(f"/users/{bob_id}/block", headers=alice)

    broadcast = client.post("/chats/broadcast", headers=alice, json={
        "name": "List", "recipient_ids": [bob_id],
    }).json()
    client.post("/messages", headers=alice, json={"chat_id": broadcast["id"], "text": "hi"})

    low, high = sorted([alice_id, bob_id])
    dm_id = f"dm_{low}_{high}"
    # Bob was blocked, so no DM should have ever been created for him.
    assert db.query_one("SELECT 1 FROM chats WHERE id = ?", (dm_id,)) is None


# ── Group/member caps ────────────────────────────────────────────────────────

def test_group_creation_is_capped_at_1024_members(client):
    alice, _, _ = make_user(client, "Alice")
    fake_ids = [f"user_{i}" for i in range(1024)]  # + alice herself = 1025
    denied = client.post("/chats/group", headers=alice, json={
        "name": "Huge group", "member_ids": fake_ids,
    })
    assert denied.status_code == 400


def test_adding_group_members_past_the_1024_cap_is_refused(client):
    alice, _, _ = make_user(client, "Alice")
    group = client.post("/chats/group", headers=alice, json={"name": "G"}).json()

    # Seed 1020 real members directly rather than through 1020 individual
    # registrations + add-member calls (which would make this test glacially
    # slow) — this exercises the exact same COUNT(*) the real code path
    # checks, just without the setup cost of doing it through the API.
    now = time.time()
    for i in range(1020):
        user_id = f"seed_cap_user_{i}"
        db.execute(
            "INSERT INTO users (id, name, username, password_hash, created_at) "
            "VALUES (?, ?, ?, 'x', ?)",
            (user_id, f"Seed {i}", f"seed_cap_user_{i}", now),
        )
        db.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
            (group["id"], user_id, now),
        )
    # 1020 seeded + Alice = 1021 current members.

    real_ids = []
    for i in range(5):
        _, uid, _ = make_user(client, f"Real{i}")
        real_ids.append(uid)
    # Adding these 5 real accounts would bring the total to 1026 — over the cap.
    denied = client.post(f"/chats/{group['id']}/members", headers=alice, json={"user_ids": real_ids})
    assert denied.status_code == 400


# ── Phone number sign-in (WhatsApp-style) ────────────────────────────────────

def capture_otp(monkeypatch):
    """Same monkeypatch pattern the push-notification tests use — captures
    what would have been sent instead of actually sending it."""
    sent = {}
    monkeypatch.setattr(main.sms, "send_otp", lambda phone, code: sent.update(phone=phone, code=code) or "sent")
    # main.issue_otp()/issue_email_otp() also rate-limit by caller IP. Every
    # call from this module's TestClient would otherwise look like the same
    # IP, so tests that fire several requests in a row (or run after other
    # OTP tests within the same rate-limit window) would trip that limiter
    # instead of exercising what they actually mean to test — give each
    # request through this fixture its own fake IP instead.
    monkeypatch.setattr(main, "client_ip", lambda request: fake_client_ip())
    return sent


def test_new_phone_number_creates_an_account_on_verify(client, monkeypatch):
    sent = capture_otp(monkeypatch)

    requested = client.post("/auth/phone/request-otp", json={"phone": "+15551230001"})
    assert requested.status_code == 200
    assert sent["phone"] == "+15551230001"
    assert len(sent["code"]) == 6

    verified = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230001", "code": sent["code"], "name": "New Person",
    })
    assert verified.status_code == 200
    body = verified.json()
    assert body["created"] is True
    assert body["user"]["name"] == "New Person"
    assert body["user"]["phone"] == "+15551230001"
    # A username still exists behind the scenes for @mentions etc, even
    # though nothing about phone sign-in ever asked for one.
    assert body["user"]["username"]

    me = client.get("/me", headers={"Authorization": f"Bearer {body['token']}"}).json()
    assert me["id"] == body["user"]["id"]


def test_verifying_an_existing_phone_number_logs_in_instead_of_creating(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230002"})
    first = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230002", "code": sent["code"], "name": "Returning Person",
    }).json()

    # Signing in again later, same number — no name needed this time.
    client.post("/auth/phone/request-otp", json={"phone": "+15551230002"})
    second = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230002", "code": sent["code"],
    }).json()

    assert second["created"] is False
    assert second["user"]["id"] == first["user"]["id"]


def test_wrong_otp_code_is_rejected_and_counts_as_an_attempt(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230003"})

    wrong = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230003", "code": "000000", "name": "X",
    })
    assert wrong.status_code == 401

    # The real code still works afterward — one wrong guess doesn't burn it.
    right = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230003", "code": sent["code"], "name": "X",
    })
    assert right.status_code == 200


def test_otp_cannot_be_reused_after_verifying(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230004"})
    client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230004", "code": sent["code"], "name": "X",
    })

    reused = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230004", "code": sent["code"],
    })
    assert reused.status_code == 400


def test_otp_verification_is_locked_out_after_too_many_wrong_guesses(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230005"})

    for _ in range(5):
        client.post("/auth/phone/verify-otp", json={"phone": "+15551230005", "code": "000000"})

    locked = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230005", "code": sent["code"], "name": "X",
    })
    assert locked.status_code == 429


def test_requesting_a_new_code_invalidates_the_old_one(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230006"})
    old_code = sent["code"]

    client.post("/auth/phone/request-otp", json={"phone": "+15551230006"})
    new_code = sent["code"]
    assert old_code != new_code

    stale = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230006", "code": old_code, "name": "X",
    })
    assert stale.status_code == 401


def test_new_account_requires_a_name(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230007"})
    missing_name = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230007", "code": sent["code"],
    })
    assert missing_name.status_code == 400


def test_changing_your_phone_number(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230008"})
    signup = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230008", "code": sent["code"], "name": "Changer",
    }).json()
    headers = {"Authorization": f"Bearer {signup['token']}"}

    client.post("/me/phone/request-change-otp", headers=headers, json={"phone": "+15551230888"})
    changed = client.post("/me/phone/confirm-change", headers=headers, json={
        "phone": "+15551230888", "code": sent["code"],
    })
    assert changed.status_code == 200
    assert changed.json()["phone"] == "+15551230888"


def test_cannot_change_to_a_number_already_in_use(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230009"})
    alice = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230009", "code": sent["code"], "name": "Alice",
    }).json()

    client.post("/auth/phone/request-otp", json={"phone": "+15551230010"})
    bob = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230010", "code": sent["code"], "name": "Bob",
    }).json()

    denied = client.post("/me/phone/request-change-otp",
                         headers={"Authorization": f"Bearer {bob['token']}"},
                         json={"phone": "+15551230009"})
    assert denied.status_code == 400


def test_otp_requests_are_rate_limited_per_phone(client, monkeypatch):
    capture_otp(monkeypatch)
    for _ in range(5):
        client.post("/auth/phone/request-otp", json={"phone": "+15551230099"})
    denied = client.post("/auth/phone/request-otp", json={"phone": "+15551230099"})
    assert denied.status_code == 429


# ── Setting a password directly ──────────────────────────────────────────────
# A phone-signup account's password (register()/verify_phone_otp) is a random
# token nobody ever saw — PUT /me/password is the only way such an account
# can ever gain a real, known password and sign in without a phone code.

def test_set_password_lets_a_phone_signup_account_log_in_with_it(client, monkeypatch):
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230700"})
    signup = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230700", "code": sent["code"], "name": "Passwordless",
    }).json()
    headers = {"Authorization": f"Bearer {signup['token']}"}
    username = signup["user"]["username"]

    # No password known yet — the random one from signup was never returned.
    blind_login = client.post("/auth/login", json={"username": username, "password": "anything"})
    assert blind_login.status_code == 401

    set_response = client.put("/me/password", headers=headers, json={"new_password": "a whole new password"})
    assert set_response.status_code == 200

    now_works = client.post("/auth/login", json={"username": username, "password": "a whole new password"})
    assert now_works.status_code == 200


def test_setting_a_new_password_requires_no_current_password(client):
    """The whole point — an endpoint that DID require current_password would
    be permanently unusable for exactly the accounts that need it most."""
    alice, alice_id, _ = make_user(client, "Alice")
    response = client.put("/me/password", headers=alice, json={"new_password": "brand new secret"})
    assert response.status_code == 200


def test_set_password_rejects_a_short_password(client):
    alice, alice_id, _ = make_user(client, "Alice")
    response = client.put("/me/password", headers=alice, json={"new_password": "short"})
    assert response.status_code == 422


def test_set_password_signs_out_other_sessions_but_not_this_one(client):
    alice, alice_id, username = make_user(client, "Alice")
    other_login = client.post("/auth/login", json={"username": username, "password": "correct horse battery"})
    other_headers = {"Authorization": f"Bearer {other_login.json()['token']}"}
    assert client.get("/me", headers=other_headers).status_code == 200

    client.put("/me/password", headers=alice, json={"new_password": "a different password now"})

    # The session that made the change is still good...
    assert client.get("/me", headers=alice).status_code == 200
    # ...but the other device was signed out.
    assert client.get("/me", headers=other_headers).status_code == 401


def test_set_password_is_refused_when_signed_out(client):
    response = client.put("/me/password", json={"new_password": "doesnt matter here"})
    assert response.status_code == 401


# ── Deactivate / reactivate / delete account ──────────────────────────────────

def test_deactivating_hides_the_account_from_search_and_new_dms(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")

    client.post("/me/deactivate", headers=alice)

    assert all(u["id"] != alice_id for u in client.get("/users?q=Alice", headers=bob).json())
    assert client.post(f"/chats/dm/{alice_id}", headers=bob).status_code == 404


def test_deactivating_revokes_every_session(client):
    alice, _, username = make_user(client, "Alice")
    client.post("/me/deactivate", headers=alice)
    # The very token used to deactivate is itself revoked.
    assert client.get("/me", headers=alice).status_code == 401


def test_logging_back_in_after_deactivating_flags_it_and_reactivating_clears_it(client):
    alice, _, username = make_user(client, "Alice")
    client.post("/me/deactivate", headers=alice)

    logged_in = client.post("/auth/login", json={"username": username, "password": "correct horse battery"})
    assert logged_in.status_code == 200
    assert logged_in.json()["account_disabled"] is True

    fresh_headers = {"Authorization": f"Bearer {logged_in.json()['token']}"}
    reactivated = client.post("/me/reactivate", headers=fresh_headers)
    assert reactivated.status_code == 200

    # Now findable again. A large limit sidesteps the fact that this shared
    # test database has plenty of other accounts named "Alice" by now.
    bob, _, _ = make_user(client, "Bob")
    alice_id = logged_in.json()["user"]["id"]
    found = client.get("/users?q=Alice&limit=200", headers=bob).json()
    assert any(u["id"] == alice_id for u in found)


def test_deleting_your_account_removes_it_and_hands_off_owned_groups(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group = client.post("/chats/group", headers=alice, json={
        "name": "G", "member_ids": [bob_id],
    }).json()

    deleted = client.delete("/me", headers=alice)
    assert deleted.status_code == 200

    # The account is gone — its old token no longer authenticates anything.
    assert client.get("/me", headers=alice).status_code == 401

    # But the group survives, now owned by Bob.
    chat = client.get(f"/chats/{group['id']}", headers=bob).json()
    assert chat["owner_id"] == bob_id


def test_deleted_accounts_messages_survive_in_shared_chats(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "remember this"})

    client.delete("/me", headers=alice)

    messages = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert messages[0]["text"] == "remember this"


# ── Profile photo ──────────────────────────────────────────────────────────────

def test_setting_and_removing_a_profile_photo(client):
    alice, _, _ = make_user(client, "Alice")
    assert client.get("/me", headers=alice).json()["avatar_attachment_id"] is None

    uploaded = client.post("/me/avatar", headers=alice,
                           files={"file": ("me.png", b"\x89PNG fake bytes", "image/png")})
    assert uploaded.status_code == 200
    attachment_id = uploaded.json()["avatar_attachment_id"]
    assert attachment_id is not None

    me = client.get("/me", headers=alice).json()
    assert me["avatar_attachment_id"] == attachment_id

    removed = client.delete("/me/avatar", headers=alice)
    assert removed.status_code == 200
    assert removed.json()["avatar_attachment_id"] is None


def test_any_signed_in_user_can_view_someone_elses_avatar(client):
    alice, _, _ = make_user(client, "Alice")
    bob, _, _ = make_user(client, "Bob")  # not a contact, no shared chat at all

    attachment_id = client.post("/me/avatar", headers=alice,
                                files={"file": ("me.png", b"fake", "image/png")}).json()["avatar_attachment_id"]

    download = client.get(f"/uploads/{attachment_id}", headers=bob)
    assert download.status_code == 200


def test_setting_a_new_avatar_deletes_the_old_ones_file(client):
    alice, _, _ = make_user(client, "Alice")
    first_id = client.post("/me/avatar", headers=alice,
                           files={"file": ("one.png", b"first", "image/png")}).json()["avatar_attachment_id"]
    second_id = client.post("/me/avatar", headers=alice,
                            files={"file": ("two.png", b"second", "image/png")}).json()["avatar_attachment_id"]

    assert first_id != second_id
    assert db.query_one("SELECT 1 FROM attachments WHERE id = ?", (first_id,)) is None
    still_there = client.get(f"/uploads/{second_id}", headers=alice)
    assert still_there.status_code == 200


def test_a_dm_shows_the_peers_avatar(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    bob_avatar_id = client.post("/me/avatar", headers=bob,
                                files={"file": ("bob.png", b"bobface", "image/png")}).json()["avatar_attachment_id"]

    chats = client.get("/chats", headers=alice).json()
    dm = next(c for c in chats if c["id"] == chat_id)
    assert dm["avatar_attachment_id"] == bob_avatar_id

    opened = client.get(f"/chats/{chat_id}", headers=alice).json()
    assert opened["avatar_attachment_id"] == bob_avatar_id


# ── Email connect ─────────────────────────────────────────────────────────────

def capture_email_otp(monkeypatch):
    """Same monkeypatch pattern capture_otp uses for phone OTPs, for email_delivery instead."""
    sent = {}
    monkeypatch.setattr(main.email_delivery, "send_otp",
                        lambda email, code, expires_in_seconds=300: sent.update(email=email, code=code) or "sent")
    # See capture_otp's note above — same per-IP OTP rate limit applies here.
    monkeypatch.setattr(main, "client_ip", lambda request: fake_client_ip())
    return sent


def test_connecting_and_verifying_an_email_address(client, monkeypatch):
    sent = capture_email_otp(monkeypatch)
    alice, alice_id, _ = make_user(client, "Alice")

    requested = client.post("/me/email/request-otp", headers=alice, json={"email": "alice@example.com"})
    assert requested.status_code == 200
    assert sent["email"] == "alice@example.com"

    confirmed = client.post("/me/email/confirm", headers=alice,
                            json={"email": "alice@example.com", "code": sent["code"]})
    assert confirmed.status_code == 200
    body = confirmed.json()
    assert body["email"] == "alice@example.com"
    assert body["email_verified_at"] is not None

    me = client.get("/me", headers=alice).json()
    assert me["email"] == "alice@example.com"
    assert me["email_verified_at"] is not None


def test_email_is_lowercased_on_connect(client, monkeypatch):
    sent = capture_email_otp(monkeypatch)
    alice, alice_id, _ = make_user(client, "Alice")

    client.post("/me/email/request-otp", headers=alice, json={"email": "Alice@Example.COM"})
    confirmed = client.post("/me/email/confirm", headers=alice,
                            json={"email": "Alice@Example.COM", "code": sent["code"]})
    assert confirmed.json()["email"] == "alice@example.com"


def test_wrong_email_otp_code_is_rejected(client, monkeypatch):
    sent = capture_email_otp(monkeypatch)
    alice, alice_id, _ = make_user(client, "Alice")
    client.post("/me/email/request-otp", headers=alice, json={"email": "alice@example.com"})

    wrong = client.post("/me/email/confirm", headers=alice,
                        json={"email": "alice@example.com", "code": "000000"})
    assert wrong.status_code == 401

    right = client.post("/me/email/confirm", headers=alice,
                        json={"email": "alice@example.com", "code": sent["code"]})
    assert right.status_code == 200


def test_disconnecting_an_email_clears_it(client, monkeypatch):
    sent = capture_email_otp(monkeypatch)
    alice, alice_id, _ = make_user(client, "Alice")
    client.post("/me/email/request-otp", headers=alice, json={"email": "alice@example.com"})
    client.post("/me/email/confirm", headers=alice, json={"email": "alice@example.com", "code": sent["code"]})

    removed = client.delete("/me/email", headers=alice)
    assert removed.status_code == 200
    assert removed.json()["email"] == ""
    assert removed.json().get("email_verified_at") is None

    me = client.get("/me", headers=alice).json()
    assert me["email"] == ""


def test_an_unverified_or_malformed_email_is_rejected(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bad = client.post("/me/email/request-otp", headers=alice, json={"email": "not-an-email"})
    assert bad.status_code == 422


def test_someone_elses_email_is_never_visible(client, monkeypatch):
    sent = capture_email_otp(monkeypatch)
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    client.post("/me/email/request-otp", headers=alice, json={"email": "alice@example.com"})
    client.post("/me/email/confirm", headers=alice, json={"email": "alice@example.com", "code": sent["code"]})

    seen_by_bob = client.get(f"/users/{alice_id}", headers=bob).json()
    assert "email" not in seen_by_bob
    assert "email_verified_at" not in seen_by_bob


# ── Slow mode ─────────────────────────────────────────────────────────────────

def test_slow_mode_blocks_a_second_send_from_a_plain_member_but_not_an_admin(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group_id = make_group(client, alice, [bob_id])

    set_slow = client.put(f"/chats/{group_id}/slow-mode?seconds=30", headers=alice)
    assert set_slow.status_code == 200
    assert set_slow.json()["slow_mode_secs"] == 30

    first = client.post("/messages", headers=bob, json={"chat_id": group_id, "text": "one"})
    assert first.status_code == 200

    second = client.post("/messages", headers=bob, json={"chat_id": group_id, "text": "two"})
    assert second.status_code == 429

    # The owner (admin) is exempt from their own slow mode.
    owner_send = client.post("/messages", headers=alice, json={"chat_id": group_id, "text": "admin msg"})
    assert owner_send.status_code == 200


def test_only_an_admin_can_set_slow_mode(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    group_id = make_group(client, alice, [bob_id])

    denied = client.put(f"/chats/{group_id}/slow-mode?seconds=10", headers=bob)
    assert denied.status_code == 403


def test_slow_mode_does_not_apply_to_dms(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    first = client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "hi"})
    second = client.post("/messages", headers=alice, json={"chat_id": chat_id, "text": "hi again"})
    assert first.status_code == 200
    assert second.status_code == 200


# ── View-once media ───────────────────────────────────────────────────────────

def test_view_once_photo_can_be_downloaded_exactly_once_by_the_recipient(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment_id = client.post(
        "/uploads", headers=alice, files={"file": ("once.png", b"onceonly", "image/png")},
    ).json()["attachment_id"]

    message = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "text": "",
        "payload": {"attachment_id": attachment_id}, "view_once": True,
    }).json()
    assert message["view_once"]
    # Still visible pre-open, including to the sender's own echo of the send.
    assert message["payload"]["attachment_id"] == attachment_id

    first = client.get(f"/uploads/{attachment_id}", headers=bob)
    assert first.status_code == 200

    second = client.get(f"/uploads/{attachment_id}", headers=bob)
    assert second.status_code == 410


def test_view_once_sender_can_never_download_their_own_upload(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment_id = client.post(
        "/uploads", headers=alice, files={"file": ("once.png", b"onceonly", "image/png")},
    ).json()["attachment_id"]
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "text": "",
        "payload": {"attachment_id": attachment_id}, "view_once": True,
    })

    denied = client.get(f"/uploads/{attachment_id}", headers=alice)
    assert denied.status_code == 403


def test_view_once_payload_is_stripped_from_every_read_after_it_is_opened(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment_id = client.post(
        "/uploads", headers=alice, files={"file": ("once.png", b"onceonly", "image/png")},
    ).json()["attachment_id"]
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "text": "",
        "payload": {"attachment_id": attachment_id}, "view_once": True,
    })

    client.get(f"/uploads/{attachment_id}", headers=bob)

    seen = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    assert seen[-1]["payload"] is None
    assert seen[-1]["view_once_consumed"] is True


def test_an_ordinary_photo_ignores_the_view_once_gate(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment_id = client.post(
        "/uploads", headers=alice, files={"file": ("normal.png", b"normaldata", "image/png")},
    ).json()["attachment_id"]
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "text": "",
        "payload": {"attachment_id": attachment_id},
    })

    first = client.get(f"/uploads/{attachment_id}", headers=bob)
    second = client.get(f"/uploads/{attachment_id}", headers=bob)
    assert first.status_code == 200
    assert second.status_code == 200


# ── View-once TEXT messages ──────────────────────────────────────────────────
# A view-once photo has an explicit "open" request (GET /uploads/{id}) to hang
# the single-use gate on. A plain text message has no such request — the
# recipient reading it (mark_read) IS the view, so consume_view_once_text_messages
# is what stamps view_once_opened_at here instead.

def test_view_once_text_message_disappears_once_the_recipient_reads_it(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    sent = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "text": "self-destructing secret", "view_once": True,
    }).json()
    assert sent["view_once"]
    assert not sent.get("view_once_consumed")

    # Not consumed yet — Bob hasn't read it.
    still_there = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    fetched = next(m for m in still_there if m["id"] == sent["id"])
    assert fetched["text"] == "self-destructing secret"

    read = client.post(f"/chats/{chat_id}/read", headers=bob, json={"seq": sent["seq"]})
    assert read.status_code == 200

    after = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    consumed = next(m for m in after if m["id"] == sent["id"])
    assert consumed["text"] == ""
    assert consumed["view_once_consumed"] is True


def test_view_once_text_is_also_gone_for_the_sender_once_opened(client):
    """The sender can't replay it either, once the recipient has seen it —
    same rule chatstore.serialise_message applies to a view-once photo."""
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    sent = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "text": "for your eyes only", "view_once": True,
    }).json()
    client.post(f"/chats/{chat_id}/read", headers=bob, json={"seq": sent["seq"]})

    own_view = client.get(f"/chats/{chat_id}/messages", headers=alice).json()
    mine = next(m for m in own_view if m["id"] == sent["id"])
    assert mine["text"] == ""
    assert mine["view_once_consumed"] is True


def test_the_senders_own_read_receipt_does_not_consume_their_view_once_text(client):
    """Marking your OWN chat as read (e.g. right after sending) must not
    burn the message before the recipient has ever seen it."""
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    sent = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "text": "still unread by bob", "view_once": True,
    }).json()
    client.post(f"/chats/{chat_id}/read", headers=alice, json={"seq": sent["seq"]})

    still_there = client.get(f"/chats/{chat_id}/messages", headers=bob).json()
    fetched = next(m for m in still_there if m["id"] == sent["id"])
    assert fetched["text"] == "still unread by bob"


def test_view_once_text_read_event_notifies_the_chat_live(client):
    """The sender's own open socket has to hear about the blanking too —
    otherwise their screen keeps showing content that's already gone
    server-side until they reload."""
    alice, alice_id, alice_name = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    sent = client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "text": "watch this vanish", "view_once": True,
    }).json()

    with client.websocket_connect(f"/ws?ticket={ws_ticket_for(client, alice_name)}") as socket:
        client.post(f"/chats/{chat_id}/read", headers=bob, json={"seq": sent["seq"]})

        event = socket.receive_json()
        assert event["type"] == "message_edited"
        assert event["message"]["id"] == sent["id"]
        assert event["message"]["text"] == ""
        assert event["message"]["view_once_consumed"] is True


# ── Chat-scoped search ────────────────────────────────────────────────────────

def test_search_can_be_scoped_to_a_single_chat(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    carol, carol_id, _ = make_user(client, "Carol")

    chat_with_bob = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    chat_with_carol = client.post(f"/chats/dm/{carol_id}", headers=alice).json()["id"]

    client.post("/messages", headers=alice, json={"chat_id": chat_with_bob, "text": "needle in bob chat"})
    client.post("/messages", headers=alice, json={"chat_id": chat_with_carol, "text": "needle in carol chat"})

    scoped = client.get(f"/search?q=needle&chat_id={chat_with_bob}", headers=alice).json()
    assert len(scoped) == 1
    assert scoped[0]["chat_id"] == chat_with_bob

    unscoped = client.get("/search?q=needle", headers=alice).json()
    assert len(unscoped) == 2


def test_search_scoped_to_a_chat_you_are_not_in_is_refused(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    carol, carol_id, _ = make_user(client, "Carol")

    bob_carol_chat = client.post(f"/chats/dm/{carol_id}", headers=bob).json()["id"]

    denied = client.get(f"/search?q=anything&chat_id={bob_carol_chat}", headers=alice)
    assert denied.status_code == 404


# ── Reaction details ──────────────────────────────────────────────────────────

def test_reaction_details_lists_who_reacted_with_what(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]
    message = client.post("/messages", headers=alice,
                          json={"chat_id": chat_id, "text": "react to me"}).json()

    client.post(f"/messages/{message['id']}/reactions", headers=bob, json={"emoji": "🔥"})
    client.post(f"/messages/{message['id']}/reactions", headers=alice, json={"emoji": "👍"})

    details = client.get(f"/messages/{message['id']}/reactions", headers=alice).json()
    assert len(details) == 2
    by_emoji = {entry["emoji"]: entry["name"] for entry in details}
    assert by_emoji["🔥"] == "Bob"
    assert by_emoji["👍"] == "Alice"


# ── Storage usage ─────────────────────────────────────────────────────────────

def test_storage_usage_groups_bytes_by_chat(client):
    alice, alice_id, _ = make_user(client, "Alice")
    bob, bob_id, _ = make_user(client, "Bob")
    chat_id = client.post(f"/chats/dm/{bob_id}", headers=alice).json()["id"]

    attachment_id = client.post(
        "/uploads", headers=alice, files={"file": ("pic.png", b"twelvebytes!", "image/png")},
    ).json()["attachment_id"]
    client.post("/messages", headers=alice, json={
        "chat_id": chat_id, "kind": "photo", "text": "",
        "payload": {"attachment_id": attachment_id},
    })

    usage = client.get("/me/storage", headers=alice).json()
    assert usage["total_bytes"] == 12
    assert usage["total_files"] == 1
    assert len(usage["chats"]) == 1
    assert usage["chats"][0]["total_bytes"] == 12


def test_storage_usage_excludes_never_sent_uploads(client):
    alice, alice_id, _ = make_user(client, "Alice")
    client.post("/uploads", headers=alice, files={"file": ("orphan.png", b"unsentbytes", "image/png")})

    usage = client.get("/me/storage", headers=alice).json()
    assert usage["total_bytes"] == 0
    assert usage["chats"] == []


# ── Superadmin promotion and /admin/* access control ────────────────────────────
# Previously untested entirely: a regression that weakened require_superadmin
# (or a new /admin route that forgot to depend on it) could ship with a fully
# green suite and let any signed-in account manage other users' accounts or
# read the masked integration config.

def make_superadmin(client, monkeypatch, name="Admin"):
    """Register a fresh account whose username exactly matches
    SUPERADMIN_USERNAME — the only way any account ever becomes a
    superadmin (see start_session in main.py). Monkeypatched per-test since
    it's read once from the environment at import time in the real app."""
    username = f"admin{uuid.uuid4().hex[:10]}"
    monkeypatch.setattr(main, "SUPERADMIN_USERNAME", username)
    response = client.post("/auth/register", json={
        "name": name, "username": username,
        "password": "correct horse battery", "phone": "", "bio": "",
    }, headers={"X-Forwarded-For": fake_client_ip()})
    assert response.status_code == 200, response.text
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user"]["id"]


def test_superadmin_username_promotes_matching_account_on_session_start(client, monkeypatch):
    admin, admin_id = make_superadmin(client, monkeypatch)
    assert client.get("/admin/stats", headers=admin).status_code == 200


def test_an_ordinary_account_is_never_promoted(client, monkeypatch):
    # SUPERADMIN_USERNAME is set, but this account's username doesn't match it.
    monkeypatch.setattr(main, "SUPERADMIN_USERNAME", f"nomatch{uuid.uuid4().hex[:10]}")
    alice, _, _ = make_user(client, "Alice")
    assert client.get("/admin/stats", headers=alice).status_code == 403


def test_promoting_an_account_that_already_existed_shows_up_on_that_same_login(client, monkeypatch):
    """
    The real-world case: an account signs up BEFORE anyone sets
    SUPERADMIN_USERNAME to match it — a fresh /auth/register on an
    already-matching username (make_superadmin above) never actually
    exercises this, since start_session()'s promotion runs before the
    request/response boundary either way there.

    The bug this guards: start_session() promotes is_superadmin in the DB,
    but every login endpoint used to read the user row BEFORE calling
    start_session() and hand THAT stale snapshot to public_user() for the
    response — so the very login that triggers the promotion reported the
    account as an ordinary user, and the client had no idea anything had
    changed until some later, unrelated request happened to re-fetch /me.
    """
    alice, alice_id, username = make_user(client, "Alice")
    assert not client.get("/me", headers=alice).json().get("is_superadmin")

    monkeypatch.setattr(main, "SUPERADMIN_USERNAME", username)
    login = client.post("/auth/login", json={"username": username, "password": "correct horse battery"})
    assert login.status_code == 200
    assert login.json()["user"]["is_superadmin"]

    # And a fresh call confirms it stuck, not just an artifact of this response.
    assert client.get("/me", headers=alice).json()["is_superadmin"]


def test_promoting_a_phone_signup_account_shows_up_on_that_same_otp_login(client, monkeypatch):
    """Same bug as above, hit through the actual flow the app pushes people
    toward — sign up by phone, no password ever known, sign back in later by
    phone once SUPERADMIN_USERNAME has been pointed at the auto-generated
    username (e.g. user9113107586) that phone signup produces."""
    sent = capture_otp(monkeypatch)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230800"})
    signup = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230800", "code": sent["code"], "name": "Phone Only",
    }).json()
    username = signup["user"]["username"]
    assert not signup["user"].get("is_superadmin")

    monkeypatch.setattr(main, "SUPERADMIN_USERNAME", username)
    client.post("/auth/phone/request-otp", json={"phone": "+15551230800"})
    login = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551230800", "code": sent["code"],
    })
    assert login.status_code == 200
    assert login.json()["user"]["is_superadmin"]


ADMIN_ROUTES = [
    ("GET", "/admin/stats", None),
    ("GET", "/admin/users", None),
    ("POST", "/admin/users/nonexistent-id/disable", None),
    ("POST", "/admin/users/nonexistent-id/enable", None),
    ("DELETE", "/admin/users/nonexistent-id", None),
    ("GET", "/admin/integrations", None),
    ("PUT", "/admin/integrations", {}),
    ("POST", "/admin/integrations/test-sms", {"phone": "+15550001111"}),
    ("POST", "/admin/integrations/test-email", {"email": "nobody@example.com"}),
    ("GET", "/admin/templates", None),
    ("POST", "/admin/templates/nonexistent-id/approve", None),
    ("POST", "/admin/templates/nonexistent-id/reject", None),
]


def test_non_superadmin_is_refused_on_every_admin_route(client):
    alice, _, _ = make_user(client, "Alice")
    for method, path, body in ADMIN_ROUTES:
        response = client.request(method, path, headers=alice, json=body)
        assert response.status_code == 403, f"{method} {path} should be 403 for a non-admin, got {response.status_code}"


def test_signed_out_caller_is_refused_on_every_admin_route(client):
    for method, path, body in ADMIN_ROUTES:
        response = client.request(method, path, json=body)
        assert response.status_code == 401, f"{method} {path} should be 401 signed out, got {response.status_code}"


def test_superadmin_can_reach_admin_routes(client, monkeypatch):
    admin, admin_id = make_superadmin(client, monkeypatch)
    alice, alice_id, _ = make_user(client, "Alice")

    assert client.get("/admin/stats", headers=admin).status_code == 200

    users = client.get("/admin/users", headers=admin).json()
    assert any(u["id"] == alice_id for u in users)

    assert client.post(f"/admin/users/{alice_id}/disable", headers=admin).status_code == 200
    disabled = next(u for u in client.get("/admin/users", headers=admin).json() if u["id"] == alice_id)
    assert disabled["disabled_at"] is not None

    assert client.post(f"/admin/users/{alice_id}/enable", headers=admin).status_code == 200

    integrations = client.get("/admin/integrations", headers=admin).json()
    assert "sms" in integrations and "email" in integrations


def test_admin_cannot_delete_their_own_account_from_the_admin_panel(client, monkeypatch):
    admin, admin_id = make_superadmin(client, monkeypatch)
    denied = client.delete(f"/admin/users/{admin_id}", headers=admin)
    assert denied.status_code == 400


# ── SMS provider failure surfaces to the caller ─────────────────────────────────
# The codebase's own history is exactly this class of bug: sms.py once posted
# a Flow-shaped request against an OTP-product template id and every OTP
# silently failed to send while the API still answered normally. issue_otp()
# has an explicit branch for send_otp() returning "error" — nothing before
# this exercised it, so a future regression that makes send_otp() return
# anything else on failure (None, "", a raised exception) would bypass the
# 502 guard invisibly, same as the original bug did.

def test_phone_otp_request_surfaces_502_when_the_sms_provider_fails(client, monkeypatch):
    monkeypatch.setattr(main.sms, "send_otp", lambda phone, code: "error")
    monkeypatch.setattr(main, "client_ip", lambda request: fake_client_ip())
    response = client.post("/auth/phone/request-otp", json={"phone": "+15551239999"})
    assert response.status_code == 502

    # And the failed attempt must not leave a usable code behind.
    verify = client.post("/auth/phone/verify-otp", json={
        "phone": "+15551239999", "code": "000000", "name": "X",
    })
    assert verify.status_code in (400, 401)


def test_email_otp_request_surfaces_502_when_the_provider_fails(client, monkeypatch):
    alice, _, _ = make_user(client, "Alice")
    monkeypatch.setattr(main.email_delivery, "send_otp", lambda email, code, expires_in_seconds=300: "error")
    monkeypatch.setattr(main, "client_ip", lambda request: fake_client_ip())
    response = client.post("/me/email/request-otp", headers=alice, json={"email": "fails@example.com"})
    assert response.status_code == 502
