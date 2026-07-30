# ⚡ TalkEx

Chat • Meetings • Business • Automation

Messaging app combining the features people expect from WhatsApp (status,
disappearing messages, read receipts, groups) with the ones they expect from
Telegram (channels, communities, edit, scheduled sending, folders, saved
messages), plus scheduled status and meeting scheduling.

**Stack:** Python + FastAPI + SQLite (backend) · React + Vite (frontend) · WebSockets

---

## Status

| Area | State |
|---|---|
| Backend | **Rebuilt and verified.** 113 tests green, smoke-tested against a live server. |
| Frontend | **Rebuilt and verified in-browser.** Split out of the single 896-line component; every feature below exercised end to end against a live server, not just unit-tested. |

**Voice/video calling is real**, not the fake UI v1's README once listed:
1:1 WebRTC calls (audio or video), signaled over the app's existing
authenticated WebSocket — no separate signaling server. See "Calling" below
for exactly what that does and does not include (there is no TURN relay, so
two peers behind strict/symmetric NATs can still fail to connect directly).

Every message/meeting/status/upload/membership/read-receipt feature described in
this README has been clicked through in an actual browser against the live
backend — not just covered by pytest. Two real bugs only surfaced that way: a
`Cache-Control: immutable` header that let a browser serve one account's private
photo to a different logged-in account on the same device (fixed — see
Attachments below), and an owner-less-group state when the owner left with no
reassignment (fixed — see Membership below).

Dev ports are **3020** (web) and **8090** (API) — 3000 and 8000 were already
taken by other projects on this machine.

---

## What changed from v1, and why

The first version kept everything in Python dictionaries and had no
authorisation checks. These were not style problems:

| Problem | Consequence |
|---|---|
| All state in memory | A restart erased every account and message. On a host that sleeps after 15 minutes idle, that happened several times a day. |
| `GET /messages/{chat_id}` had no membership check | Any logged-in account could read any conversation by guessing its id. |
| `/ws/{chat_id}/{user_id}` took the user id from the URL | Anyone could connect as anyone and stream their messages. |
| `or req.username == "demo"` in login | Logged anyone in as the demo account with any password. Hashes were unsalted SHA-256. |
| `GET /messages/scheduled` declared after `GET /messages/{chat_id}` | The wildcard matched first, so the endpoint was unreachable dead code. |
| Scheduled messages, disappearing messages, status expiry | Present in the UI, never actually ran. Nothing was scheduled. |
| Reactions stored as `{emoji: count}` | Could not be undone, and one person could increment the same emoji forever. |
| A WebSocket per chat | Every chat switch cost a full handshake, and you stopped receiving from the chat you left. |

All of the above are fixed. The details of each fix are commented in place.

### Found in a later audit pass, also fixed

| Problem | Consequence |
|---|---|
| Blocking was checked only when a DM was created | A block did nothing to an existing conversation. Now enforced on send, in both directions. |
| Going offline was announced on every socket close | Someone with a phone and a laptop appeared to go offline whenever either closed a tab. Now only when the last device disconnects. |
| Catch-up was wired only to the browser `online` event | A socket that dropped without the browser going offline — flaky signal, server restart — never fetched what it missed. Now runs on every reconnect. |
| DMs stored `name = ''` and nothing resolved the peer | Every direct message was labelled "Direct message". |
| `vote` caught bare `Exception` | A locked database was reported to the user as "you have already voted". |
| One reactions query per message, one last-message query per chat | Opening the app and reading a chat both scaled with a query per row. Both now batch. |
| Community sub-channels were joinable directly | Knowing a sub-channel id let you into a community you had never joined. |
| No login throttling | Unlimited password guesses. Now 8 failures per username per 5 minutes. |
| No React error boundary | One render error blanked the whole app with no way back. |
| `reloadChats()` ran per inbound message | A busy chat refetched the entire chat list on every message. Now debounced. |
| `pinned_messages` was dead schema; `view_count` was never incremented | Both had tables and neither had endpoints. |
| Expired session rows were never deleted | The table grew for the life of the deployment. |

---

## Backend layout

```
backend/
├── db.py          SQLite schema and query helpers. All SQL is written out.
├── auth.py        PBKDF2 password hashing, session tokens stored as hashes.
├── models.py      Request bodies (pydantic).
├── chatstore.py   Message reads and writes: sequence numbers, de-duplication.
├── realtime.py    The WebSocket hub. One authenticated socket per device.
├── scheduler.py   The background loop behind every timed feature.
├── main.py        HTTP and WebSocket routes.
└── test_api.py    30 tests.
```

### The three ideas worth knowing

**Everything is a chat.** DMs, groups, channels, communities and community
sub-channels are all rows in `chats` with a different `type`. Membership,
permissions, paging, search and read receipts are written once and apply to all
of them. The old code had three parallel systems and two of them were missing
the checks.

**Every chat has a gapless sequence number.** A client that reconnects sends the
highest `seq` it holds and receives only what came after it, instead of
refetching whole conversations. Deleted messages keep their row with the text
cleared, because a hole in the sequence is indistinguishable from a message that
failed to arrive.

**Sends carry a `client_msg_id`.** A `UNIQUE (chat_id, client_msg_id)` index
means a retry after a dropped connection returns the message that already
exists rather than posting a second copy. That is what makes the client's
automatic retry safe.

### The scheduler

One loop, ticking every 5 seconds, drives four features:

- **Scheduled messages** — sent when due
- **Scheduled status** — published when due, retired 24h after publication
- **Meetings** — reminder before the start, then `live`, then `ended`
- **Disappearing messages** — content cleared when the timer runs out

Two properties it is built around:

- *It survives a restart.* Due work is a query against SQLite, not a timer held
  in memory. A process that was asleep for an hour wakes and catches up.
- *It never sends twice.* Every pass claims its rows with a conditional
  `UPDATE ... WHERE status = 'pending'` and only acts if that changed a row. The
  worst case after a crash is something not sent, never something sent twice.

---

## Running it

```bash
cd backend
python -m venv venv
venv\Scripts\activate          # Windows
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Interactive API docs: http://localhost:8000/docs

```bash
cd frontend
npm install
npm run dev
```

If `npm run dev` fails with `Cannot find module @rollup/rollup-win32-x64-msvc`,
that is a known npm bug with optional dependencies. Delete `node_modules` and
`package-lock.json` and run `npm install` again.

### Frontend layout

```
frontend/src/
├── api.js          HTTP client, Realtime socket, offline outbox
├── useRealtime.js  Hook owning the single socket
├── ui.jsx          Palette, icons, shared components, date formatting
├── App.jsx         Shell: auth, tab bar, event fan-out
└── screens/
    ├── Login.jsx     Sign in / register
    ├── ChatList.jsx  Conversations, folders, unread
    ├── ChatView.jsx  Messages, composer, polls, meetings, timers
    ├── Discover.jsx  People, channels, communities
    ├── Status.jsx    Status incl. scheduled
    ├── Planner.jsx   Upcoming meetings and the scheduled queue
    └── Settings.jsx  Profile and privacy
```

The one rule worth knowing: **a message can arrive twice** — once as the reply
to your own POST, once as the echo the server pushes over the socket.
`upsertMessage()` in `ChatView.jsx` matches on id and then on `client_msg_id`
and is used by both paths, so whichever wins the race the result is one copy.
Handling the two paths separately is what produced a duplicated message in one
ordering and a vanishing one in the other.

### Tests

```bash
cd backend
python -m pytest test_api.py -q
```

Covers access control between accounts, retry de-duplication, sequence catch-up,
reactions, WebSocket authentication and routing, and each of the four scheduled
behaviours. Scheduler tests call `scheduler.tick(now=...)` with a chosen
timestamp rather than sleeping, so they are fast and deterministic.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | the backend directory | Where `talkex.db` is written. Point this at a mounted disk in production. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated. The old server sent `*` together with `allow_credentials`, which browsers reject and which would let any site call the API with the user's credentials. |

---

## Deployment note

**A free hosting tier with an ephemeral filesystem will still lose the
database.** Moving off in-memory dicts fixes restarts, not a host that discards
the disk. For real use, either attach a persistent disk and point `DATA_DIR` at
it, or run it on a small VPS. SQLite in WAL mode handles this workload
comfortably; the constraint is durable storage, not the database.

---

## API

Scheduled messages live under `/scheduled`, deliberately not under
`/messages/...`, so the wildcard-shadowing bug from v1 cannot recur.

### Auth
```
POST   /auth/register          {name, username, password, phone, bio}
POST   /auth/login             {username, password}
POST   /auth/logout
GET    /me
PATCH  /me                     {name?, bio?, color?, show_last_seen?, show_read_receipts?}
```

### Users
```
GET    /users?q=               directory search
GET    /users/{id}
POST   /users/{id}/block
DELETE /users/{id}/block
GET    /blocks
```

### Chats
```
GET    /chats                  your chats, with unread counts
GET    /chats/{id}
POST   /chats/dm/{user_id}
POST   /chats/group            {name, member_ids[], description, color}
POST   /chats/channel          {name, description, color}
POST   /chats/community        {name, description, color, channels[]}
GET    /chats/{id}/channels    a community's sub-channels
POST   /chats/{id}/channels    add a sub-channel to an existing community (owner/admin)
GET    /discover               public channels and communities
POST   /chats/{id}/join
POST   /chats/{id}/leave       reassigns ownership if the owner leaves — see below
PATCH  /chats/{id}/settings    {is_pinned?, folder?, muted_until?, draft?}
PUT    /chats/{id}/disappearing {seconds}   null switches it off
POST   /chats/{id}/lock        {pin}   fails if already locked — remove the lock first to change the PIN
POST   /chats/{id}/unlock      {pin}   proves you know it; does not turn the lock off
DELETE /chats/{id}/lock        {pin}   turns the lock off, same proof required
POST   /chats/{id}/read        {seq}
GET    /chats/{id}/read-state  who has read up to where (omits opted-out members)
GET    /chats/{id}/pins
```

### Membership (group / channel / community / community sub-channel)
```
POST   /chats/{id}/members             {user_ids[]}   owner/admin only
DELETE /chats/{id}/members/{user_id}   owner/admin only; an admin can't remove another admin
PATCH  /chats/{id}/members/{user_id}   {role: admin|member}   owner only
```

**Ownership never dangles.** When the owner leaves, the server picks a
successor — the longest-standing admin, or failing that the longest-standing
member — and promotes them, rather than leaving `owner_id` pointing at someone
no longer in the chat. A chat that empties out completely just goes
ownerless; there is no one left to manage anyway.

### Messages
```
GET    /chats/{id}/messages?limit=&before_seq=&after_seq=
POST   /messages               {chat_id, text, kind, payload?, reply_to_id?,
                                client_msg_id?, disappear_secs?, poll_options?}
PATCH  /messages/{id}          {text}
DELETE /messages/{id}          "Unsend" / "delete for everyone" — sender, or an owner/admin removing someone else's
POST   /messages/{id}/hide     "Delete for me" — hides it from only your own view, nothing broadcast
POST   /messages/{id}/reactions    {emoji}
DELETE /messages/{id}/reactions?emoji=
POST   /messages/{id}/vote     {option_index}
POST   /messages/forward       {message_id, to_chat_ids[]}
POST   /messages/{id}/pin
DELETE /messages/{id}/pin
POST   /messages/{id}/view     channel post view count
GET    /search?q=              your own chats only
```

### Attachments
```
POST /uploads                  multipart file upload -> {attachment_id, ...}
GET  /uploads/{id}             the bytes, authorised against the chat the file was sent to
```

Send a `photo`, `voice`, or `document` message by uploading first, then passing
`payload: {attachment_id}` to `POST /messages`. Two steps on purpose — a
retried send never re-transmits the file. `text/html` and `image/svg+xml` are
refused outright (both can carry script); everything else is capped at 25MB,
enforced while streaming rather than after buffering the whole upload.
Voice notes record in the browser via `MediaRecorder` and go through this same
pipeline with `kind: "voice"`.

Two more kinds need no upload step, just a `payload`: `location`
(`{lat, lng}`, validated server-side as numeric and in-range — sent from the
browser's own `navigator.geolocation`) and `contact` (`{name, phone}`, both
required and trimmed server-side). The attach sheet in the composer offers
Photo / Document / Location / Contact as one grid, matching the familiar
WhatsApp-style attach menu.

**The download endpoint sends `Cache-Control: private, no-cache`, not
`immutable`.** An earlier version used a year-long immutable cache, which is
wrong for anything authorization-gated: browsers cache by URL, not by
`Authorization` header, so a long-lived entry let a second account signed in
on the same device load the first account's private photo straight from disk
— confirmed by checking the server's access log and finding the request never
arrived. `no-cache` still lets the browser hold the bytes, but forces a
revalidation request through the same membership check on every access.

### Scheduled messages
```
POST   /scheduled              {chat_id, text, send_at, kind?, payload?}
GET    /scheduled?chat_id=
PATCH  /scheduled/{id}         {send_at?, text?}
DELETE /scheduled/{id}         cancel
```

### Status
```
POST   /stories                {text, emoji, background, publish_at?}
GET    /stories                live statuses from your contacts
GET    /stories/mine           yours, including still-queued ones
POST   /stories/{id}/view
DELETE /stories/{id}
```

### Meetings
```
POST   /meetings               {chat_id, title, agenda, starts_at, duration_min,
                                join_url, reminder_min, invite_user_ids[]}
GET    /meetings?upcoming_only=
GET    /chats/{id}/meetings
GET    /meetings/{id}
PATCH  /meetings/{id}          host only
DELETE /meetings/{id}          cancel, host only
POST   /meetings/{id}/rsvp     {response: going|maybe|declined}
```

### WebSocket
```
GET /ws?token=<session token>
```

One authenticated socket per device. Client sends `{type:"ping"}`,
`{type:"typing", chat_id}`, and the call-signaling types below. Server sends
`message`, `message_edited`, `message_deleted`, `message_expired`, `reaction`,
`poll_updated`, `read`, `pins_changed`, `members_changed`,
`chat_owner_changed`, `typing`, `presence`, `disappearing_changed`,
`story_published`, `meeting_created`, `meeting_updated`, `meeting_cancelled`,
`meeting_reminder`, `meeting_started`, `meeting_ended`,
`scheduled_message_failed`, `removed_from_chat`, plus the call-signaling
relay types.

Membership is read from the database on every fan-out, so a client cannot
receive a chat's traffic by asking for it.

### Calling

1:1 voice and video calls, signaled entirely over the socket above — `call_invite`,
`call_answer`, `call_ice`, `call_reject`, `call_end`, `call_busy`, each carrying
`{to, chat_id, ...}` and relayed to the target verbatim plus `from`. The
server's only job is deciding whether the sender may say anything to the
target at all: same DM, target is the actual peer in it (`dm_peer_id`), and
neither has blocked the other — it never touches SDP or ICE contents. A
target that fails that check gets a `call_error` back instead of silence.

Group calling is out of scope — calls are DM-only, checked server-side, not
just hidden in the UI. There is also no TURN relay (`useCall.js` only
configures a public STUN server), so two peers behind strict/symmetric NATs
can discover their own address but may still fail to connect directly; running
a TURN server is real infrastructure this pass didn't include.

Exactly one side of a call ever writes its outcome into the chat as a
`kind: "call"` message (`{call_kind, status, duration_secs}`, `status` one of
`completed | declined | unanswered | busy`) — the caller, always, regardless
of which side actually ends the call. Two-sided logging would double up every
call in the shared chat history.

### Rate limiting

`/auth/login` locks out a username after 8 failed attempts for 5 minutes.
`POST /messages` is capped at 20 sends per 10 seconds per account. Both are an
in-memory sliding window, per process — a speed bump against one runaway
client, not a durable audit trail, and both reset on restart.

### Read receipts

Every member's `last_read_seq` is tracked; `GET /chats/{id}/read-state`
returns it for everyone except you and anyone who has switched read receipts
off (they are omitted entirely, not just unlabeled — turning receipts off has
to actually withhold the information). A message is "read" once the lowest
`last_read_seq` among everyone else in the chat is at or past its `seq` — in a
DM that's simply the other person; in a group it's "has everyone seen this,"
the same rule WhatsApp groups use. The client renders a single grey checkmark
for sent-not-read and a double bright checkmark for read, updating live off
the `read` socket event.

### Two-step verification

An optional PIN required after the password, checked on every login rather
than kept as a per-device trust flag.

```
GET    /me/two-step             {enabled}
POST   /me/two-step             {pin, current_pin?}   sets the first PIN, or changes one (current_pin required)
DELETE /me/two-step             {current_pin}          turns it off

POST   /auth/login/verify-pin   {pending_token, pin}   the second step, in place of a normal login response
```

`POST /auth/login` returns `{token, user}` as always for an account with no
PIN set. For one that has it on, a correct password gets back
`{requires_pin: true, pending_token}` instead — no session exists yet. The
pending token lives in memory only (never written to disk: nothing about a
five-minute-lived, one-time login attempt is worth persisting through a
restart), expires in 5 minutes, and is burned after 5 wrong guesses,
whichever comes first. `verify-pin` is what actually calls `start_session()`.

Same "prove you know the old one" rule as chat-lock PINs: setting the first
PIN needs nothing extra, changing or removing one already in place always
requires `current_pin`, checked server-side — a stolen but still-live session
cannot silently swap in an attacker's PIN and lock the real owner out.

### Linked devices (QR sign-in)

WhatsApp Web's flow, built on the same session machinery as an ordinary login
— approving a code just runs the same `start_session()` a fresh sign-in would.

```
POST /auth/link/start           {device_label?}   no auth — returns {code, expires_at, qr_svg}
GET  /auth/link/{code}/poll     no auth — {status: pending|approved|denied|expired|consumed, token?, user?}
GET  /auth/link/{code}/info     authed — {device_label, requested_at}, what the approver sees
POST /auth/link/{code}/approve  authed — mints a new session for the approver's account
POST /auth/link/{code}/deny     authed

GET    /me/sessions             every device signed in as you
DELETE /me/sessions/{id}        sign a device out remotely, including this one
```

A new, signed-out device calls `/start`, shows the returned `qr_svg` (a real
SVG rendered server-side by the `qrcode` library — see `backend/qr.py`; a
hand-written QR encoder was considered and rejected, since QR's Reed-Solomon
error correction is exactly the kind of thing that can look right and quietly
fail to scan) alongside the plain-text `code`, then polls. An already
signed-in device enters the same code from Settings → Linked devices → Link a
device, sees who's asking via `/info`, and approves or denies. The polling
device picks up a real token on its next poll and signs in — no QR scanning
required for the flow to work; the code doubles as manual-entry text.

The `code` itself is the QR payload, not a URL — this runs on localhost in
development, where a scannable URL would not be reachable from a phone on a
different network anyway.

A code is single-use: `raw_token` is stored on the `device_links` row only
between approval and the next poll, then wiped (status → `consumed`). The
background sweep never removes an `approved` row before its own expiry, even
though the approver is finished with it — the new device may not have polled
again yet, and deleting on status alone would race that device out of ever
collecting its token.

### Bulk messaging API (API keys)

The WhatsApp Business API equivalent — a script authenticates with a key
instead of a session token, and can send messages and nothing else. Kept on a
completely separate lookup from `current_user()` so a leaked bulk key can
never read a chat, change a profile, or sign in as the account, and a leaked
session token can never be used to send bulk messages.

```
POST   /me/api-keys            {label?}   returns the raw key ONCE — {id, key, label, prefix}
GET    /me/api-keys            list — id, label, prefix, created_at, last_used_at (never the key itself)
DELETE /me/api-keys/{id}

POST   /api/v1/messages        {to: "username", text, client_msg_id?}   Bearer <api key>
```

`POST /api/v1/messages` addresses a recipient by username, not an internal
chat id — an external caller has no reason to know one — and always sends
into the same DM a human clicking that username would land in, found or
created with the identical deterministic id the interactive endpoint uses. A
reply from the recipient shows up in the ordinary app UI, not a parallel
inbox. Text only, DMs only: reaching into a group or channel is out of scope
for what this exists to do. Blocking is enforced both ways. Capped at 60
sends/minute per account, a separate limiter from the interactive 20/10s tier
— steady bulk traffic is expected here, not something to be suspicious of the
way a human account's send rate is.
