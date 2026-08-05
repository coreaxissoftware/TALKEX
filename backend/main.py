"""
TalkEx API.

Rewritten from the in-memory prototype. What changed, and why:

  Storage      Python dicts -> SQLite. A restart no longer erases the app.
  Auth         Unsalted SHA-256 and a "log in as demo with any password" branch
               -> PBKDF2 with per-user salts, and tokens stored as hashes.
  Access       Every chat was readable by every logged-in account. Now every
               read and write checks membership first.
  Realtime     One unauthenticated socket per chat, with the user id taken from
               the URL -> one authenticated socket per device.
  Paging       Endpoints returned entire tables. Now keyset pagination.
  Scheduling   Scheduled messages, disappearing messages and status expiry were
               UI-only. A background loop now actually runs them.

Route layout note: scheduled messages live under /scheduled, not under
/messages/... . In the old file `GET /messages/scheduled` was declared after
`GET /messages/{chat_id}`, so FastAPI matched the wildcard first and the
endpoint was unreachable dead code. Keeping the namespaces apart makes that
class of mistake impossible rather than merely fixed.
"""

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import socket
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from contextlib import asynccontextmanager
from html.parser import HTMLParser

logger = logging.getLogger("talkex.main")

from fastapi import (
    BackgroundTasks, Depends, FastAPI, File, HTTPException, Query, Request, UploadFile,
    WebSocket, WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import auth
import chatstore
import db
import email_delivery
import push
import qr
import scheduler
import sms
import uploads
from chatstore import new_id
from models import (
    AddContactRequest, AddMembersRequest, BroadcastRecipientsRequest, BulkSendRequest,
    ChatSettingsRequest, ConfirmEmailRequest, CreateApiKeyRequest, CreateBroadcastRequest,
    CreateCannedReplyRequest, CreateChannelRequest, CreateCommunityRequest, CreateGroupRequest,
    CreateMeetingRequest, CreateSubChannelRequest, CreateTemplateRequest, CreateWebhookRequest,
    CreateBreakoutRoomsRequest, DisappearingRequest, InstantMeetingRequest,
    EditMessageRequest, ForwardRequest, ForwardStoryRequest, LiveLocationUpdateRequest, LoginRequest,
    PushSubscribeRequest, PushUnsubscribeRequest, ReactRequest, ReadRequest,
    RegisterRequest, RemoveTwoStepRequest, RequestEmailOtpRequest, RequestOtpRequest,
    ReportRequest, RescheduleRequest, RsvpRequest,
    ScheduleRequest, SendMessageRequest, SetPasswordRequest, SetPinRequest, SetRoleRequest,
    SetSessionShortLivedRequest,
    SetTwoStepRequest, SetUsernameRequest, StartLinkRequest, StoryAudienceRequest, StoryRequest,
    TestEmailRequest, TestSmsRequest,
    UpdateContactRequest, UpdateIntegrationSettingsRequest, UpdateMeetingRequest,
    UpdateProfileRequest, VerifyOtpRequest, VerifyTwoStepRequest, VoteRequest,
)
from realtime import hub

STORY_LIFETIME_SECONDS = 24 * 3600
LIVE_LOCATION_MAX_SECONDS = 8 * 3600
MAX_GROUP_MEMBERS = 1024
MAX_BROADCAST_RECIPIENTS = 512

# Whoever's username matches this (case-insensitive) becomes the superadmin
# the instant they next sign in — see start_session() below. Set once by
# whoever deploys the app, pointing at their own account; nobody else can
# grant themselves this by any path through the API.
SUPERADMIN_USERNAME = os.environ.get("SUPERADMIN_USERNAME", "").strip().lower()
MAX_PINNED_CHATS = 3
MAX_LINKED_DEVICES = 5

# A spread of distinct, readable-on-white-text colors — used so a letter
# avatar without a real photo is visually distinguishable from the next
# person's, the way WhatsApp/Telegram contact colors vary. Picked once per
# account (deterministically, from its id) rather than randomly, so it never
# changes on its own between sessions.
AVATAR_PALETTE = [
    "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#0ea5e9",
    "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#84cc16",
]


def avatar_color_for(seed: str) -> str:
    return AVATAR_PALETTE[sum(seed.encode()) % len(AVATAR_PALETTE)]


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    scheduler.start()
    yield
    await scheduler.stop()
    db.close()


app = FastAPI(title="TalkEx API", version="2.0.0", lifespan=lifespan)

# The old server sent allow_origins=["*"] together with allow_credentials=True.
# Browsers reject that combination outright, and where it is honoured it lets
# any site on the internet call the API with the user's credentials. Origins are
# now listed explicitly.
DEFAULT_DEV_ORIGINS = "http://localhost:3000,http://localhost:3020,http://127.0.0.1:3020"

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", DEFAULT_DEV_ORIGINS).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

security = HTTPBearer(auto_error=False)


# ── Authentication ────────────────────────────────────────────────────────────

def current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Resolve the bearer token to a user, or refuse the request."""
    if credentials is None:
        raise HTTPException(401, "Not authenticated")

    session = db.query_one(
        "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
        (auth.hash_token(credentials.credentials),),
    )
    if session is None:
        raise HTTPException(401, "Invalid token")

    if session["expires_at"] <= time.time():
        # Clean it up on the way past so expired rows do not accumulate.
        db.execute("DELETE FROM sessions WHERE token_hash = ?",
                   (auth.hash_token(credentials.credentials),))
        raise HTTPException(401, "Session expired")

    user = db.query_one("SELECT * FROM users WHERE id = ?", (session["user_id"],))
    if user is None:
        raise HTTPException(401, "Account no longer exists")

    return dict(user)


def require_superadmin(user: dict = Depends(current_user)) -> dict:
    """
    Every /admin/* route depends on this instead of current_user directly —
    an ordinary, fully-authenticated session on a non-admin account must get
    a plain 403 here, not a peek at admin data followed by a check deeper in
    the handler that's easy to forget to add to the next endpoint.
    """
    if not user.get("is_superadmin"):
        raise HTTPException(403, "Superadmin access required")
    return user


def require_api_key(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """
    Resolve a bulk-sending API key to a user — entirely separate from
    current_user() above.

    Deliberately its own function rather than current_user() falling back to
    checking api_keys too: a session token must never work here and an API key
    must never work on the interactive routes. Keeping the two lookups apart is
    what makes that true by construction rather than by a shared code path
    someone could accidentally widen later.
    """
    if credentials is None:
        raise HTTPException(401, "Missing API key")

    key_hash = auth.hash_token(credentials.credentials)
    row = db.query_one("SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,))
    if row is None:
        raise HTTPException(401, "Invalid API key")

    user = db.query_one("SELECT * FROM users WHERE id = ?", (row["user_id"],))
    if user is None:
        raise HTTPException(401, "Account no longer exists")

    db.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (time.time(), row["id"]))
    return dict(user)


def public_user(row, viewer_id: str | None = None) -> dict:
    """
    A user as other people are allowed to see them: never a credential hash.

    `viewer_id` is left as None at every "this is about my own account" call
    site (login, register, GET /me, ...) — scrubbing your own phone number
    from your own response would make no sense, you're the one asking.
    Passed explicitly wherever the caller is looking at someone ELSE's
    profile, so that account's own show_phone_number choice applies.
    """
    if row is None:
        return {}
    user = dict(row)
    user.pop("password_hash", None)
    # Whether an account has two-step verification on is nobody else's
    # business — GET /me/two-step is the one place that answers it, and only
    # for the signed-in account asking about itself.
    user.pop("two_step_pin_hash", None)
    user.pop("two_step_recovery_codes", None)
    user["online"] = hub.is_online(user["id"])
    if not user.get("show_last_seen"):
        user["last_seen"] = None
    if viewer_id is not None and viewer_id != user["id"] and not user.get("show_phone_number", 1):
        user["phone"] = ""
    # Unlike the phone number, there's no visibility toggle for this at
    # all — a recovery email is never anyone else's business, full stop.
    if viewer_id is not None and viewer_id != user["id"]:
        user.pop("email", None)
        user.pop("email_verified_at", None)
        # Whether away mode is on, and what it says, is this account's own
        # automation config — not something a DM peer's client needs to see
        # (the away reply itself is the thing they get, as an ordinary
        # message, not a profile flag).
        user.pop("away_enabled", None)
        user.pop("away_message", None)
        user.pop("is_superadmin", None)
    return user


def start_session(user_id: str, device_label: str = "Unknown device") -> str:
    if SUPERADMIN_USERNAME:
        row = db.query_one("SELECT username, is_superadmin FROM users WHERE id = ?", (user_id,))
        if row and not row["is_superadmin"] and row["username"].lower() == SUPERADMIN_USERNAME:
            db.execute("UPDATE users SET is_superadmin = 1 WHERE id = ?", (user_id,))

    token, token_hash, expires_at = auth.new_session_token()
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device_label) "
        "VALUES (?, ?, ?, ?, ?)",
        (token_hash, user_id, time.time(), expires_at, device_label),
    )
    return token


@app.post("/auth/register")
def register(request: RegisterRequest, http_request: Request):
    ip_register_rate_limiter.check(client_ip(http_request))

    taken = db.query_one("SELECT 1 FROM users WHERE lower(username) = ?",
                         (request.username.lower(),))
    if taken:
        raise HTTPException(400, "Username already taken")

    user_id = new_id("user")
    try:
        db.execute(
            """
            INSERT INTO users (id, name, username, phone, bio, color, avatar_letter,
                               password_hash, created_at, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id, request.name, request.username.lower(), request.phone, request.bio,
                avatar_color_for(user_id), request.name[0].upper(),
                auth.hash_password(request.password), time.time(), time.time(),
            ),
        )
    except sqlite3.IntegrityError:
        # Two requests for the same username can both pass the "taken" check
        # above before either commits — the UNIQUE index is the real
        # guarantee, this just turns its failure into the same 400 the
        # up-front check gives instead of an unhandled 500.
        raise HTTPException(400, "Username already taken")

    # Everyone gets a private notes chat, the way Telegram's Saved Messages works.
    create_saved_messages_chat(user_id)

    token = start_session(user_id, request.device_label)
    user = db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    return {"token": token, "user": public_user(user)}


class RateLimiter:
    """
    A plain sliding-window limiter, keyed by whatever the caller passes in.

    In-memory and per-process on purpose, the same trade as the login lockout
    below: it is a speed bump against one runaway or malicious client, not a
    durable audit trail, and it resets on restart. Multiple app processes
    behind a load balancer would each keep their own count — fine for the
    single-process scale this app runs at; a shared store (Redis) would be the
    upgrade if that ever changes.
    """

    # A caller that varies the key on every request (e.g. a different phone
    # number each time) adds a permanent dict entry that's only ever pruned
    # the next time THAT SAME key is checked — which never happens again.
    # Sweeping every SWEEP_EVERY calls bounds memory growth without paying
    # the cost of a full scan on every single check().
    SWEEP_EVERY = 500

    def __init__(self, max_events: int, window_seconds: float):
        self.max_events = max_events
        self.window_seconds = window_seconds
        self.history: dict[str, list[float]] = defaultdict(list)
        self._checks_since_sweep = 0

    def check(self, key: str):
        now = time.time()
        recent = [at for at in self.history[key] if now - at < self.window_seconds]
        if len(recent) >= self.max_events:
            wait = int(self.window_seconds - (now - recent[0]))
            raise HTTPException(429, f"Too many requests. Wait {max(wait, 1)}s.")
        recent.append(now)
        self.history[key] = recent

        self._checks_since_sweep += 1
        if self._checks_since_sweep >= self.SWEEP_EVERY:
            self._checks_since_sweep = 0
            self._sweep(now)

    def _sweep(self, now: float):
        stale_keys = [k for k, at_list in self.history.items()
                      if not at_list or now - at_list[-1] >= self.window_seconds]
        for k in stale_keys:
            del self.history[k]


# Failed sign-in attempts, per username. Kept in memory on purpose: it is a
# speed bump against online guessing, not an audit trail, and it resets on
# restart. Anything stronger belongs at the proxy, where the attacker's address
# is actually known and not spoofable through a header.
MAX_FAILED_LOGINS = 8
LOCKOUT_SECONDS = 300

_failed_logins: dict[str, list[float]] = defaultdict(list)
_failed_login_checks_since_sweep = 0
_FAILED_LOGIN_SWEEP_EVERY = 500

# A signed-in account sending faster than this is spamming, not chatting.
# 20 messages / 10s is generous for a human typing fast in several chats at
# once, and low enough to blunt a script hammering the endpoint.
message_rate_limiter = RateLimiter(max_events=20, window_seconds=10)

# The bulk API's own tier, keyed by API key rather than user id, and separate
# from the interactive limiter above — a script sending notifications at a
# steady clip is expected traffic here, not the same "is this spam" question
# an interactive account's message rate answers.
bulk_rate_limiter = RateLimiter(max_events=60, window_seconds=60)

# Keyed by phone number — generous enough for a real user who fat-fingered a
# code a couple of times, tight enough that spamming an SMS provider's bill
# (or a phone number that isn't yours) isn't free.
otp_rate_limiter = RateLimiter(max_events=5, window_seconds=300)

# Keyed by reporter — reporting is a rare, deliberate action; this only
# exists to stop a script from flooding the queue, not to limit a genuine
# user filing a few real reports.
report_rate_limiter = RateLimiter(max_events=10, window_seconds=600)

# otp_rate_limiter above is keyed by the phone/email being texted, which
# does nothing to stop one caller from working through many DIFFERENT
# numbers — each stays under its own per-number cap while the caller
# racks up real, billed provider sends (SMS-pumping fraud). This one is
# keyed by caller IP instead, as a second, independent dimension.
ip_otp_rate_limiter = RateLimiter(max_events=40, window_seconds=300)

# Registration has no natural per-account key (there's no account yet), so
# this is IP-only — a speed bump against scripted mass account creation.
ip_register_rate_limiter = RateLimiter(max_events=10, window_seconds=600)

OTP_LIFETIME_SECONDS = 5 * 60
OTP_MAX_ATTEMPTS = 5


def client_ip(request: Request) -> str:
    """
    Best-effort caller IP for rate limiting.

    Render (and any reverse proxy) terminates the real connection, so
    request.client.host is the proxy's address, not the caller's — the
    actual client IP arrives in X-Forwarded-For instead. There's exactly
    one hop between the internet and this app (Render's edge), so the LAST
    entry is the one that hop itself appended and can be trusted; anything
    earlier in the list could have been set by the client itself and isn't
    proof of anything. Falls back to the direct socket address, then "" —
    an empty key still gets its own bucket, so it degrades to "one shared
    limit for anyone we can't identify" rather than throwing.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else ""


def generate_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def issue_otp(phone: str, ip: str = ""):
    """Generate, store (hashed) and 'send' a fresh code for this phone. A new
    call always invalidates whatever code was issued before it."""
    otp_rate_limiter.check(phone)
    if ip:
        ip_otp_rate_limiter.check(ip)
    code = generate_otp()
    db.execute(
        """
        INSERT INTO phone_otps (phone, code_hash, expires_at, attempts, created_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(phone) DO UPDATE SET
            code_hash = excluded.code_hash, expires_at = excluded.expires_at,
            attempts = 0, created_at = excluded.created_at
        """,
        (phone, auth.hash_otp(code), time.time() + OTP_LIFETIME_SECONDS, time.time()),
    )
    # A silently-swallowed provider failure here is exactly what makes an
    # undelivered OTP invisible: the endpoint would answer {"sent": true}
    # regardless, and the person is left staring at a code-entry screen for
    # a text that's never coming. Surface it instead — the OTP row above is
    # harmless left unused; "Resend" just overwrites it via the upsert.
    if sms.send_otp(phone, code) == "error":
        raise HTTPException(502, "Could not send the verification code — please try again in a moment")


def check_otp(phone: str, code: str):
    """
    Verify a code WITHOUT burning it. Raises HTTPException on any failure.

    Split from actually consuming it because a brand new phone number's
    verify call ends in an error (name required) rather than a completed
    sign-in — deleting the code on that first call would strand the
    follow-up call (same code, now with a name) with nothing left to check
    against. Only the caller that's sure it's about to complete the
    operation should also call consume_otp.
    """
    row = db.query_one("SELECT * FROM phone_otps WHERE phone = ?", (phone,))
    if row is None or row["expires_at"] <= time.time():
        raise HTTPException(400, "Code expired or never requested — request a new one")
    if row["attempts"] >= OTP_MAX_ATTEMPTS:
        raise HTTPException(429, "Too many attempts — request a new code")
    if not auth.verify_otp(code, row["code_hash"]):
        db.execute("UPDATE phone_otps SET attempts = attempts + 1 WHERE phone = ?", (phone,))
        raise HTTPException(401, "Incorrect code")


def consume_otp(phone: str):
    db.execute("DELETE FROM phone_otps WHERE phone = ?", (phone,))


def issue_email_otp(email: str, ip: str = ""):
    """Exact mirror of issue_otp above, for email_otps instead of phone_otps."""
    otp_rate_limiter.check(email)
    if ip:
        ip_otp_rate_limiter.check(ip)
    code = generate_otp()
    db.execute(
        """
        INSERT INTO email_otps (email, code_hash, expires_at, attempts, created_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(email) DO UPDATE SET
            code_hash = excluded.code_hash, expires_at = excluded.expires_at,
            attempts = 0, created_at = excluded.created_at
        """,
        (email, auth.hash_otp(code), time.time() + OTP_LIFETIME_SECONDS, time.time()),
    )
    if email_delivery.send_otp(email, code, OTP_LIFETIME_SECONDS) == "error":
        raise HTTPException(502, "Could not send the verification code — please try again in a moment")


def check_email_otp(email: str, code: str):
    row = db.query_one("SELECT * FROM email_otps WHERE email = ?", (email,))
    if row is None or row["expires_at"] <= time.time():
        raise HTTPException(400, "Code expired or never requested — request a new one")
    if row["attempts"] >= OTP_MAX_ATTEMPTS:
        raise HTTPException(429, "Too many attempts — request a new code")
    if not auth.verify_otp(code, row["code_hash"]):
        db.execute("UPDATE email_otps SET attempts = attempts + 1 WHERE email = ?", (email,))
        raise HTTPException(401, "Incorrect code")


def consume_email_otp(email: str):
    db.execute("DELETE FROM email_otps WHERE email = ?", (email,))


def unique_username_from_phone(phone: str) -> str:
    """
    A username still exists behind the scenes (@mentions, the bulk API's
    `to: username`, ...) even for an account that only ever signs in with a
    phone number — it's just never shown during phone signup, matching the
    WhatsApp flow where you're never asked to pick one.
    """
    digits = "".join(character for character in phone if character.isdigit())
    base = f"user{digits[-10:]}" if digits else f"user{secrets.token_hex(4)}"
    candidate = base
    suffix = 0
    while db.query_one("SELECT 1 FROM users WHERE lower(username) = ?", (candidate.lower(),)):
        suffix += 1
        candidate = f"{base}{suffix}"
    return candidate


@app.post("/auth/phone/request-otp")
def request_phone_otp(request: RequestOtpRequest, http_request: Request):
    """Step 1 of WhatsApp-style sign-in: text a code to this number, whether
    it belongs to a brand new account or an existing one."""
    issue_otp(request.phone, client_ip(http_request))
    return {"sent": True, "expires_in": OTP_LIFETIME_SECONDS}


@app.post("/auth/phone/verify-otp")
def verify_phone_otp(request: VerifyOtpRequest):
    """
    Step 2: check the code, then either sign an existing account in or, for a
    number nobody has used before, create one — same one-screen "enter the
    code, then your name" flow WhatsApp uses, no username ever shown.
    """
    check_otp(request.phone, request.code)

    existing = db.query_one("SELECT * FROM users WHERE phone = ? AND phone != ''", (request.phone,))
    if existing:
        consume_otp(request.phone)
        token = start_session(existing["id"], request.device_label)
        # start_session() may have just promoted this account to superadmin
        # (see SUPERADMIN_USERNAME) — re-fetch rather than reusing `existing`,
        # which was read BEFORE that write, so the very login response that
        # triggers the promotion doesn't itself claim it never happened.
        existing = db.query_one("SELECT * FROM users WHERE id = ?", (existing["id"],))
        return {
            "token": token, "user": public_user(existing), "created": False,
            "account_disabled": bool(existing["disabled_at"]),
        }

    if not request.name:
        # Deliberately NOT consumed — the code is still good for the
        # follow-up call once the client collects a name and resubmits it.
        raise HTTPException(400, "name is required to create a new account")

    consume_otp(request.phone)
    user_id = new_id("user")
    username = unique_username_from_phone(request.phone)
    db.execute(
        """
        INSERT INTO users (id, name, username, phone, bio, color, avatar_letter,
                           password_hash, created_at, last_seen)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
        """,
        (
            user_id, request.name, username, request.phone,
            avatar_color_for(user_id), request.name[0].upper(),
            # A random, never-typed password — this account only ever signs
            # in via phone + OTP, but every account still needs SOME password
            # hash since login-by-password checks that column unconditionally.
            auth.hash_password(secrets.token_urlsafe(32)),
            time.time(), time.time(),
        ),
    )
    create_saved_messages_chat(user_id)
    token = start_session(user_id, request.device_label)
    user = db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    return {"token": token, "user": public_user(user), "created": True}


@app.post("/me/phone/request-change-otp")
def request_phone_change_otp(request: RequestOtpRequest, http_request: Request,
                              user: dict = Depends(current_user)):
    """Changing your number reuses the exact same OTP mechanism as signing
    up with one — the only difference is what happens after it's verified."""
    taken = db.query_one(
        "SELECT 1 FROM users WHERE phone = ? AND phone != '' AND id != ?",
        (request.phone, user["id"]),
    )
    if taken:
        raise HTTPException(400, "This number is already in use by another account")
    issue_otp(request.phone, client_ip(http_request))
    return {"sent": True, "expires_in": OTP_LIFETIME_SECONDS}


@app.post("/me/phone/confirm-change")
def confirm_phone_change(request: VerifyOtpRequest, user: dict = Depends(current_user)):
    check_otp(request.phone, request.code)
    consume_otp(request.phone)
    db.execute("UPDATE users SET phone = ? WHERE id = ?", (request.phone, user["id"]))
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


# ── Email connect ─────────────────────────────────────────────────────────────
# WhatsApp-style: an email address is never a login credential here, only a
# recovery contact — the thing a two-step PIN reset link goes to. Connecting
# one is the same two-call OTP shape phone verification already uses:
# request a code, then confirm it.

@app.post("/me/email/request-otp")
def request_email_otp(request: RequestEmailOtpRequest, http_request: Request,
                       user: dict = Depends(current_user)):
    issue_email_otp(request.email.lower(), client_ip(http_request))
    return {"sent": True, "expires_in": OTP_LIFETIME_SECONDS}


@app.post("/me/email/confirm")
def confirm_email(request: ConfirmEmailRequest, user: dict = Depends(current_user)):
    email = request.email.lower()
    check_email_otp(email, request.code)
    consume_email_otp(email)
    db.execute("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?",
              (email, time.time(), user["id"]))
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


@app.delete("/me/email")
def remove_email(user: dict = Depends(current_user)):
    db.execute("UPDATE users SET email = '', email_verified_at = NULL WHERE id = ?", (user["id"],))
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


def check_login_allowed(username: str):
    global _failed_login_checks_since_sweep
    now = time.time()
    recent = [at for at in _failed_logins[username] if now - at < LOCKOUT_SECONDS]
    _failed_logins[username] = recent
    if len(recent) >= MAX_FAILED_LOGINS:
        wait = int(LOCKOUT_SECONDS - (now - recent[0]))
        raise HTTPException(429, f"Too many failed attempts. Try again in {wait} seconds.")

    # Same unbounded-growth hazard as RateLimiter above — a username tried
    # once and never retried keeps a permanent entry otherwise.
    _failed_login_checks_since_sweep += 1
    if _failed_login_checks_since_sweep >= _FAILED_LOGIN_SWEEP_EVERY:
        _failed_login_checks_since_sweep = 0
        stale = [k for k, at_list in _failed_logins.items()
                 if not at_list or now - at_list[-1] >= LOCKOUT_SECONDS]
        for k in stale:
            del _failed_logins[k]


@app.post("/auth/login")
def login(request: LoginRequest):
    username = request.username.lower()
    check_login_allowed(username)

    user = db.query_one("SELECT * FROM users WHERE lower(username) = ?", (username,))

    # One failure message for "no such user" and "wrong password" alike. Telling
    # them apart lets anyone enumerate which usernames exist.
    if user is None or not auth.verify_password(request.password, user["password_hash"]):
        _failed_logins[username].append(time.time())
        raise HTTPException(401, "Invalid username or password")

    # A correct password clears the counter, so one forgotten password does not
    # leave the real owner locked out for the rest of the window.
    _failed_logins.pop(username, None)

    # Transparently upgrade a hash that was made with fewer iterations than we
    # now require. The user never notices; the stored hash gets stronger.
    if auth.needs_rehash(user["password_hash"]):
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                   (auth.hash_password(request.password), user["id"]))

    # A password alone is not enough for an account with two-step verification
    # on — hand back a short-lived pending token instead of a real session, and
    # make the caller prove the PIN too before start_session ever runs.
    if user["two_step_pin_hash"]:
        pending_token = new_pending_login(user["id"], request.device_label)
        return {"requires_pin": True, "pending_token": pending_token}

    token = start_session(user["id"], request.device_label)
    # Re-fetch: start_session() may have just promoted this account to
    # superadmin, a write that happens AFTER `user` was read above.
    user = db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],))
    # Still lets a deactivated account's own owner sign back in — that's how
    # reactivating works — the frontend just shows a "welcome back, want to
    # reactivate?" screen instead of the normal app when this is true.
    return {"token": token, "user": public_user(user), "account_disabled": bool(user["disabled_at"])}


PENDING_LOGIN_TTL_SECONDS = 300
PENDING_LOGIN_MAX_ATTEMPTS = 5

# Never written to disk — a leaked backup cannot be used to skip the PIN step,
# and there is nothing here worth surviving a restart for: a dropped pending
# login just means signing in again from the top.
_pending_logins: dict[str, dict] = {}


def new_pending_login(user_id: str, device_label: str) -> str:
    # A pending login is cheap to create and short-lived, so pruning here —
    # rather than running a background sweep for something that isn't
    # persisted anywhere — is enough to keep the dict from growing forever.
    now = time.time()
    expired = [token for token, entry in _pending_logins.items() if entry["expires_at"] <= now]
    for token in expired:
        del _pending_logins[token]

    pending_token = secrets.token_urlsafe(32)
    _pending_logins[pending_token] = {
        "user_id": user_id, "device_label": device_label,
        "expires_at": now + PENDING_LOGIN_TTL_SECONDS, "attempts": 0,
    }
    return pending_token


def generate_recovery_codes() -> tuple[list[str], list[str]]:
    """
    Five single-use backup codes, GitHub/Google-authenticator style: the raw
    codes are handed back exactly once (the caller has to show them now,
    there is no way to see them again later), only their hashes are kept.
    """
    raw = [secrets.token_hex(4) for _ in range(5)]
    hashed = [auth.hash_password(code) for code in raw]
    return raw, hashed


@app.post("/auth/login/verify-pin")
def verify_two_step_pin(request: VerifyTwoStepRequest):
    entry = _pending_logins.get(request.pending_token)
    if entry is None or entry["expires_at"] <= time.time():
        _pending_logins.pop(request.pending_token, None)
        raise HTTPException(401, "That login attempt has expired. Sign in again.")

    user = db.query_one("SELECT * FROM users WHERE id = ?", (entry["user_id"],))
    if user is None or not user["two_step_pin_hash"]:
        _pending_logins.pop(request.pending_token, None)
        raise HTTPException(401, "Two-step verification is no longer on for this account")

    if auth.verify_password(request.pin, user["two_step_pin_hash"]):
        del _pending_logins[request.pending_token]
        token = start_session(user["id"], entry["device_label"])
        # See the matching re-fetch in login() above — start_session() may
        # have just promoted this account and `user` predates that write.
        user = db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],))
        return {"token": token, "user": public_user(user)}

    # Not the PIN — check whether it is one of the recovery codes instead.
    recovery_hashes = json.loads(user["two_step_recovery_codes"] or "[]")
    matched = next((h for h in recovery_hashes if auth.verify_password(request.pin, h)), None)
    if matched is not None:
        # A recovery code proves who the account belongs to but says nothing
        # about the PIN itself — using one turns two-step off entirely rather
        # than leaving behind a PIN the owner has no way to supply. Signing
        # back in with two-step off, then turning it on again with a fresh
        # PIN from Settings, is the recovery path.
        del _pending_logins[request.pending_token]
        db.execute(
            "UPDATE users SET two_step_pin_hash = NULL, two_step_recovery_codes = NULL WHERE id = ?",
            (user["id"],),
        )
        token = start_session(user["id"], entry["device_label"])
        user = db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],))
        return {"token": token, "user": public_user(user), "two_step_disabled": True}

    entry["attempts"] += 1
    if entry["attempts"] >= PENDING_LOGIN_MAX_ATTEMPTS:
        del _pending_logins[request.pending_token]
        raise HTTPException(401, "Too many wrong PINs. Sign in again.")
    raise HTTPException(401, "Wrong PIN")


@app.get("/me/two-step")
def get_two_step(user: dict = Depends(current_user)):
    return {"enabled": bool(user["two_step_pin_hash"])}


@app.post("/me/two-step")
def set_two_step(request: SetTwoStepRequest, user: dict = Depends(current_user)):
    """
    Turn two-step verification on, or change the PIN.

    Same rule as chat locks: setting a first PIN needs nothing extra, but
    replacing one already in place has to prove the old one first — otherwise
    anyone with a stolen, still-live session could silently swap in a PIN of
    their own and lock the real owner out at their next login. Recovery codes
    are only (re)generated when the PIN is first switched on — changing an
    existing PIN leaves whatever codes are already out there valid, exactly
    like changing a password doesn't usually invalidate a security key.
    """
    existing_hash = user["two_step_pin_hash"]
    if existing_hash:
        if not request.current_pin or not auth.verify_password(request.current_pin, existing_hash):
            raise HTTPException(400, "Current PIN is required to change it")
        db.execute("UPDATE users SET two_step_pin_hash = ? WHERE id = ?",
                   (auth.hash_password(request.pin), user["id"]))
        return {"enabled": True, "recovery_codes": None}

    if request.current_pin:
        raise HTTPException(400, "Two-step verification is not on yet")

    raw_codes, hashed_codes = generate_recovery_codes()
    db.execute(
        "UPDATE users SET two_step_pin_hash = ?, two_step_recovery_codes = ? WHERE id = ?",
        (auth.hash_password(request.pin), json.dumps(hashed_codes), user["id"]),
    )
    return {"enabled": True, "recovery_codes": raw_codes}


@app.post("/me/two-step/recovery-codes")
def regenerate_recovery_codes(request: RemoveTwoStepRequest, user: dict = Depends(current_user)):
    """New codes invalidate every old one — same current-PIN proof as any other change."""
    if not user["two_step_pin_hash"] \
            or not auth.verify_password(request.current_pin, user["two_step_pin_hash"]):
        raise HTTPException(400, "Wrong PIN")
    raw_codes, hashed_codes = generate_recovery_codes()
    db.execute("UPDATE users SET two_step_recovery_codes = ? WHERE id = ?",
               (json.dumps(hashed_codes), user["id"]))
    return {"recovery_codes": raw_codes}


@app.delete("/me/two-step")
def remove_two_step(request: RemoveTwoStepRequest, user: dict = Depends(current_user)):
    if not user["two_step_pin_hash"] \
            or not auth.verify_password(request.current_pin, user["two_step_pin_hash"]):
        raise HTTPException(400, "Wrong PIN")
    db.execute("UPDATE users SET two_step_pin_hash = NULL, two_step_recovery_codes = NULL WHERE id = ?",
              (user["id"],))
    return {"enabled": False}


@app.post("/auth/logout")
def logout(credentials: HTTPAuthorizationCredentials = Depends(security),
           user: dict = Depends(current_user)):
    db.execute("DELETE FROM sessions WHERE token_hash = ?",
               (auth.hash_token(credentials.credentials),))
    return {"ok": True}


# ── WebSocket connect tickets ─────────────────────────────────────────────────
# A browser WebSocket handshake can't carry a custom Authorization header, so
# the socket has always been opened as `/ws?token=<session token>`. That puts
# the same 30-day bearer token every REST call sends as a header into a URL
# instead — which reverse proxies, CDNs, error trackers and browser history
# routinely log in full. A short-lived, single-use ticket (minted over the
# already-authenticated REST API, right before connecting) means whatever
# ends up in a URL/log is worthless within seconds and only once, instead of
# being a live credential for a month.
WS_TICKET_TTL_SECONDS = 30
_ws_tickets: dict[str, tuple[str, float]] = {}
_ws_ticket_issues_since_sweep = 0


@app.post("/auth/ws-ticket")
def create_ws_ticket(user: dict = Depends(current_user)):
    global _ws_ticket_issues_since_sweep
    ticket = secrets.token_urlsafe(24)
    _ws_tickets[ticket] = (user["id"], time.time() + WS_TICKET_TTL_SECONDS)

    # Tickets that are issued and never redeemed (client fetched one, then
    # never actually connected) would otherwise sit in this dict forever.
    _ws_ticket_issues_since_sweep += 1
    if _ws_ticket_issues_since_sweep >= 200:
        _ws_ticket_issues_since_sweep = 0
        now = time.time()
        for stale in [t for t, (_, exp) in _ws_tickets.items() if exp <= now]:
            del _ws_tickets[stale]

    return {"ticket": ticket, "expires_in": WS_TICKET_TTL_SECONDS}


def redeem_ws_ticket(ticket: str) -> str | None:
    """Consume a ticket and return the user id it was minted for, or None if
    it's missing, already used, or expired."""
    entry = _ws_tickets.pop(ticket, None)
    if entry is None:
        return None
    user_id, expires_at = entry
    if expires_at <= time.time():
        return None
    return user_id


# ── Linked devices ────────────────────────────────────────────────────────────
# WhatsApp Web's flow, built on the same session/token machinery as a normal
# login: a new device asks for a code, an already-signed-in device approves
# it, and the new device collects a real session token by polling. Nothing
# here is a second authentication system — approving a code just runs
# start_session() for the approver's account, exactly like a fresh login would.

LINK_CODE_TTL_SECONDS = 180


@app.post("/auth/link/start")
def start_device_link(request: StartLinkRequest):
    """A new, signed-out device asks for a code to display as a QR."""
    code = secrets.token_hex(4).upper()   # 8 hex chars — enough entropy for a 3-minute window
    now = time.time()
    db.execute(
        """
        INSERT INTO device_links (code, status, device_label, created_at, expires_at)
        VALUES (?, 'pending', ?, ?, ?)
        """,
        (code, request.device_label, now, now + LINK_CODE_TTL_SECONDS),
    )
    return {
        "code": code,
        "expires_at": now + LINK_CODE_TTL_SECONDS,
        "qr_svg": qr.render_svg(code),
    }


@app.get("/auth/link/{code}/poll")
def poll_device_link(code: str):
    """
    The new device calls this in a loop until it gets an answer.

    No auth on this route — the new device does not have a token yet, that is
    the entire point. The code itself, short-lived and one-shot, is what
    stands in for authentication here.
    """
    row = db.query_one("SELECT * FROM device_links WHERE code = ?", (code,))
    if row is None:
        raise HTTPException(404, "Unknown code")

    if row["status"] == "pending" and row["expires_at"] <= time.time():
        db.execute("UPDATE device_links SET status = 'expired' WHERE code = ?", (code,))
        return {"status": "expired"}

    if row["status"] == "approved" and row["raw_token"]:
        user = db.query_one("SELECT * FROM users WHERE id = ?", (row["approved_by_user_id"],))
        # One-shot: the token is handed out exactly once, then wiped from this
        # row. Anyone re-polling this code afterwards gets 'consumed', not a
        # second copy of a live credential.
        db.execute(
            "UPDATE device_links SET status = 'consumed', raw_token = NULL WHERE code = ? AND status = 'approved'",
            (code,),
        )
        return {"status": "approved", "token": row["raw_token"], "user": public_user(user)}

    return {"status": row["status"]}


@app.get("/auth/link/{code}/info")
def device_link_info(code: str, user: dict = Depends(current_user)):
    """What an already-signed-in device shows before approving: who's asking."""
    row = db.query_one(
        "SELECT * FROM device_links WHERE code = ? AND status = 'pending'", (code,))
    if row is None or row["expires_at"] <= time.time():
        raise HTTPException(404, "This code is invalid or has expired")
    return {"device_label": row["device_label"], "requested_at": row["created_at"]}


@app.post("/auth/link/{code}/approve")
def approve_device_link(code: str, user: dict = Depends(current_user)):
    row = db.query_one(
        "SELECT * FROM device_links WHERE code = ? AND status = 'pending'", (code,))
    if row is None:
        raise HTTPException(404, "This code is invalid or has expired")
    if row["expires_at"] <= time.time():
        db.execute("UPDATE device_links SET status = 'expired' WHERE code = ?", (code,))
        raise HTTPException(400, "This code has expired")

    # The cap applies to linking a NEW device, not to logging in — someone
    # must always be able to sign back into their own account with a
    # password even if they're at the limit; they just can't link a 6th
    # device until they remove one first (same as WhatsApp's own limit).
    active_sessions = db.query_one(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?",
        (user["id"], time.time()),
    )["n"]
    if active_sessions >= MAX_LINKED_DEVICES:
        raise HTTPException(
            400, f"You can have at most {MAX_LINKED_DEVICES} linked devices — remove one first")

    token = start_session(user["id"], row["device_label"])

    changed = db.execute(
        "UPDATE device_links SET status = 'approved', approved_by_user_id = ?, raw_token = ? "
        "WHERE code = ? AND status = 'pending'",
        (user["id"], token, code),
    )
    if changed.rowcount == 0:
        # Someone else approved or denied it in the gap between our SELECT and
        # this UPDATE. The session we just minted is unused — remove it rather
        # than leaving an orphaned, nobody-will-ever-poll-for-it token alive.
        # Deleted by its exact hash, not a heuristic match, so a genuinely
        # concurrent session for the same user cannot be caught by mistake.
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (auth.hash_token(token),))
        raise HTTPException(409, "This code was already used")

    return {"approved": True}


@app.post("/auth/link/{code}/deny")
def deny_device_link(code: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "UPDATE device_links SET status = 'denied' WHERE code = ? AND status = 'pending'", (code,))
    if changed.rowcount == 0:
        raise HTTPException(404, "This code is invalid or has expired")
    return {"denied": True}


@app.get("/me/sessions")
def list_sessions(credentials: HTTPAuthorizationCredentials = Depends(security),
                  user: dict = Depends(current_user)):
    """Every device signed in as you, so you can spot one you don't recognise."""
    my_hash = auth.hash_token(credentials.credentials)
    rows = db.query_all(
        "SELECT rowid AS session_id, device_label, created_at, expires_at, token_hash, short_lived "
        "FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
        (user["id"],),
    )
    return [
        {
            "session_id": row["session_id"],
            "device_label": row["device_label"],
            "created_at": row["created_at"],
            "expires_at": row["expires_at"],
            "short_lived": bool(row["short_lived"]),
            "is_current": row["token_hash"] == my_hash,
        }
        for row in rows
    ]


@app.delete("/me/sessions/{session_id}")
def revoke_session(session_id: int, user: dict = Depends(current_user)):
    """Sign a specific device out remotely — including, if you choose, this one."""
    changed = db.execute(
        "DELETE FROM sessions WHERE rowid = ? AND user_id = ?", (session_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Session not found")
    return {"revoked": True}


SHORT_LIVED_SESSION_SECONDS = 4 * 60 * 60


@app.patch("/me/sessions/{session_id}")
def set_session_short_lived(session_id: int, request: SetSessionShortLivedRequest,
                            user: dict = Depends(current_user)):
    """
    Turn a specific linked device's normal 30-day session into a 4-hour one,
    or turn it back. Every OTHER session is untouched — this is a per-device
    choice (Settings > Linked devices), not an account-wide setting, so
    signing in on a borrowed computer can be made to expire quickly without
    shortening every other device you're signed in on too.
    """
    now = time.time()
    new_expiry = now + SHORT_LIVED_SESSION_SECONDS if request.short_lived else now + auth.SESSION_TTL_SECONDS
    changed = db.execute(
        "UPDATE sessions SET short_lived = ?, expires_at = ? WHERE rowid = ? AND user_id = ?",
        (request.short_lived, new_expiry, session_id, user["id"]),
    )
    if changed.rowcount == 0:
        raise HTTPException(404, "Session not found")
    return {"short_lived": request.short_lived, "expires_at": new_expiry}


# ── Bulk messaging API ────────────────────────────────────────────────────────
# The WhatsApp-Business-API equivalent: a script authenticates with a key
# instead of a session token and can send messages, nothing else. Key
# management below runs on the normal interactive session (a human generating
# a key from Settings); the send endpoint after it runs on the key itself.

@app.post("/me/api-keys")
def create_api_key(request: CreateApiKeyRequest, user: dict = Depends(current_user)):
    """
    Create a bulk-sending key. The raw value is returned exactly once — it is
    never stored, only its hash, so there is no "view key again" to offer
    later. Losing it means generating a new one.
    """
    raw_key, key_hash, prefix = auth.new_api_key()
    key_id = new_id("key")
    db.execute(
        "INSERT INTO api_keys (id, user_id, key_hash, label, key_prefix, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (key_id, user["id"], key_hash, request.label, prefix, time.time()),
    )
    return {"id": key_id, "key": raw_key, "label": request.label, "prefix": prefix}


@app.get("/me/api-keys")
def list_api_keys(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT id, label, key_prefix, created_at, last_used_at FROM api_keys "
        "WHERE user_id = ? ORDER BY created_at DESC",
        (user["id"],),
    )
    # Renamed to `prefix` to match what POST /me/api-keys calls the same
    # field — the column is `key_prefix` (clear in a table full of other
    # key_* columns), but two endpoints describing the same key should agree
    # on its shape.
    return [
        {"id": row["id"], "label": row["label"], "prefix": row["key_prefix"],
         "created_at": row["created_at"], "last_used_at": row["last_used_at"]}
        for row in rows
    ]


@app.delete("/me/api-keys/{key_id}")
def revoke_api_key(key_id: str, user: dict = Depends(current_user)):
    changed = db.execute("DELETE FROM api_keys WHERE id = ? AND user_id = ?", (key_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Key not found")
    return {"revoked": True}


# ── Webhooks ──────────────────────────────────────────────────────────────────
# The Automation pillar's other half: api_keys above is a script pushing
# messages OUT through this app; a webhook is this app pushing an incoming
# message OUT to a script's own server, the instant it arrives.

def _webhook_url_is_safe(url: str) -> bool:
    """
    Refuses to let a webhook point at this server's own network — a webhook
    is this server making an outbound HTTP request to an address a user
    supplied, which is exactly the shape of a server-side request forgery:
    without this, "my webhook URL" could be localhost, a private-network
    address, or the cloud metadata IP, turning message delivery into a way
    to probe or reach services that were never meant to be internet-facing.
    Resolves the hostname rather than pattern-matching it, since a DNS name
    can point at a private address just as easily as a literal IP can.
    """
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return False
        resolved = socket.gethostbyname(parsed.hostname)
        addr = ipaddress.ip_address(resolved)
        return not (
            addr.is_private or addr.is_loopback or addr.is_link_local
            or addr.is_reserved or addr.is_multicast or addr.is_unspecified
        )
    except (ValueError, OSError):
        return False


async def _deliver_webhook(hook_id: str, url: str, secret: str, event: dict):
    """
    Fire-and-forget delivery, run as a FastAPI background task (after the
    response for the message send that triggered it has already gone out) —
    a slow or dead endpoint on someone else's server must never add latency
    to sending a message, and one recipient's broken webhook must never
    affect anyone else's.
    """
    if not _webhook_url_is_safe(url):
        db.execute("UPDATE webhooks SET last_triggered_at = ?, last_status = 'blocked' WHERE id = ?",
                   (time.time(), hook_id))
        return

    body = json.dumps(event).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "X-TalkEx-Signature": signature},
    )
    try:
        await asyncio.to_thread(urllib.request.urlopen, request, None, 8)
        status = "ok"
    except (urllib.error.URLError, OSError):
        status = "error"
    db.execute("UPDATE webhooks SET last_triggered_at = ?, last_status = ? WHERE id = ?",
               (time.time(), status, hook_id))


# ── Link preview ─────────────────────────────────────────────────────────────
# Fetching a URL someone pasted into chat is the same shape of request-forgery
# risk as a webhook (main.py this server making an outbound request to an
# address a user supplied) — _webhook_url_is_safe already resolves the
# hostname and refuses anything private/loopback/link-local, so it's reused
# here verbatim rather than writing a second copy of the same check.

LINK_PREVIEW_TTL_SECONDS = 3600
LINK_PREVIEW_MAX_CACHE = 500
LINK_PREVIEW_MAX_BYTES = 300_000  # enough for <head> on any real page

_link_preview_cache: dict[str, tuple[dict, float]] = {}


class _OpenGraphParser(HTMLParser):
    """
    Pulls just enough out of a page's <head> to build a preview card: the
    plain <title>, and whichever og:* meta tags are present. Stdlib only —
    this app has no HTML/DOM parsing dependency anywhere else, and a full
    parser would be a lot of weight for three optional strings.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.og = {}
        self.title = None
        self._in_title = False
        self._done = False

    def handle_starttag(self, tag, attrs):
        if self._done:
            return
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            attrs_dict = dict(attrs)
            prop = attrs_dict.get("property") or attrs_dict.get("name")
            if prop in ("og:title", "og:description", "og:image", "og:site_name"):
                content = attrs_dict.get("content")
                if content:
                    self.og[prop] = content
        elif tag == "body":
            # Nothing worth reading past <head> starts — stop scanning the
            # rest of a potentially large page.
            self._done = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and self.title is None:
            self.title = data.strip()


def _fetch_link_preview(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "TalkExLinkPreview/1.0"})
    with urllib.request.urlopen(request, timeout=6) as response:
        raw = response.read(LINK_PREVIEW_MAX_BYTES)
    html_text = raw.decode(errors="ignore")
    parser = _OpenGraphParser()
    try:
        parser.feed(html_text)
    except Exception:
        pass  # a malformed/truncated fetch still yields whatever was parsed before the error
    parsed_url = urllib.parse.urlparse(url)
    return {
        "url": url,
        "title": parser.og.get("og:title") or parser.title,
        "description": parser.og.get("og:description"),
        "image": parser.og.get("og:image"),
        "site_name": parser.og.get("og:site_name") or parsed_url.hostname,
    }


@app.get("/link-preview")
async def link_preview(url: str, user: dict = Depends(current_user)):
    """
    Metadata for a link card under a chat message — title/description/image,
    best-effort. Never raises past a bad/unreachable URL; an empty-ish
    preview (just the hostname) is a perfectly fine thing for the client to
    render, and a 4xx/5xx here would be a strange way to fail something this
    optional.
    """
    cached = _link_preview_cache.get(url)
    if cached and cached[1] > time.time():
        return cached[0]

    if not _webhook_url_is_safe(url):
        return {"url": url, "title": None, "description": None, "image": None, "site_name": None}

    try:
        data = await asyncio.to_thread(_fetch_link_preview, url)
    except Exception:
        parsed_url = urllib.parse.urlparse(url)
        data = {
            "url": url, "title": None, "description": None, "image": None,
            "site_name": parsed_url.hostname,
        }

    if len(_link_preview_cache) >= LINK_PREVIEW_MAX_CACHE:
        now = time.time()
        for stale_url, (_, expires_at) in list(_link_preview_cache.items()):
            if expires_at <= now:
                del _link_preview_cache[stale_url]
    _link_preview_cache[url] = (data, time.time() + LINK_PREVIEW_TTL_SECONDS)
    return data


async def dispatch_webhooks(background_tasks: BackgroundTasks, chat_id: str, sender_id: str, message: dict):
    member_rows = db.query_all(
        "SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?",
        (chat_id, sender_id),
    )
    member_ids = [row["user_id"] for row in member_rows]
    if not member_ids:
        return
    placeholders = ",".join("?" for _ in member_ids)
    hooks = db.query_all(f"SELECT * FROM webhooks WHERE user_id IN ({placeholders})", tuple(member_ids))
    for hook in hooks:
        event = {"event": "message", "message": message}
        background_tasks.add_task(_deliver_webhook, hook["id"], hook["url"], hook["secret"], event)


@app.post("/me/webhooks")
def create_webhook(request: CreateWebhookRequest, user: dict = Depends(current_user)):
    if not _webhook_url_is_safe(request.url):
        raise HTTPException(400, "That URL can't be reached, or points at a private address")
    hook_id = new_id("hook")
    secret = secrets.token_urlsafe(24)
    db.execute(
        "INSERT INTO webhooks (id, user_id, url, secret, created_at) VALUES (?, ?, ?, ?, ?)",
        (hook_id, user["id"], request.url, secret, time.time()),
    )
    # The secret is returned exactly once, same as an API key's raw value —
    # only its use (signing deliveries) is ever needed again, never its text.
    return {"id": hook_id, "url": request.url, "secret": secret, "created_at": time.time()}


@app.get("/me/webhooks")
def list_webhooks(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT id, url, created_at, last_triggered_at, last_status FROM webhooks "
        "WHERE user_id = ? ORDER BY created_at DESC",
        (user["id"],),
    )
    return [dict(row) for row in rows]


@app.delete("/me/webhooks/{webhook_id}")
def delete_webhook(webhook_id: str, user: dict = Depends(current_user)):
    changed = db.execute("DELETE FROM webhooks WHERE id = ? AND user_id = ?", (webhook_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Webhook not found")
    return {"deleted": True}


# ── Canned replies ────────────────────────────────────────────────────────────
# Saved snippets for the composer's quick-reply picker — the other common
# Business-account staple, alongside the away message below.

@app.post("/me/canned-replies")
def create_canned_reply(request: CreateCannedReplyRequest, user: dict = Depends(current_user)):
    reply_id = new_id("reply")
    db.execute(
        "INSERT INTO canned_replies (id, user_id, label, text, created_at) VALUES (?, ?, ?, ?, ?)",
        (reply_id, user["id"], request.label, request.text, time.time()),
    )
    return {"id": reply_id, "label": request.label, "text": request.text}


@app.get("/me/canned-replies")
def list_canned_replies(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT id, label, text FROM canned_replies WHERE user_id = ? ORDER BY created_at",
        (user["id"],),
    )
    return [dict(row) for row in rows]


@app.delete("/me/canned-replies/{reply_id}")
def delete_canned_reply(reply_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "DELETE FROM canned_replies WHERE id = ? AND user_id = ?", (reply_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Canned reply not found")
    return {"deleted": True}


# ── Message templates ─────────────────────────────────────────────────────────
# WhatsApp Business API's template system: any account can propose one, but
# it sits at 'pending' until a superadmin approves or rejects it (see the
# /admin/templates endpoints) — sign-off before a canned message goes out
# to people who never started the conversation, the same reasoning Meta's
# own template review exists for.

@app.post("/me/templates")
def create_template(request: CreateTemplateRequest, user: dict = Depends(current_user)):
    template_id = new_id("tmpl")
    db.execute(
        "INSERT INTO message_templates (id, user_id, name, content, status, created_at) "
        "VALUES (?, ?, ?, ?, 'pending', ?)",
        (template_id, user["id"], request.name, request.content, time.time()),
    )
    return {"id": template_id, "name": request.name, "content": request.content, "status": "pending"}


@app.get("/me/templates")
def list_templates(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT id, name, content, status, created_at FROM message_templates "
        "WHERE user_id = ? ORDER BY created_at DESC",
        (user["id"],),
    )
    return [dict(row) for row in rows]


@app.delete("/me/templates/{template_id}")
def delete_template(template_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "DELETE FROM message_templates WHERE id = ? AND user_id = ?", (template_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Template not found")
    return {"deleted": True}


# ── Away message ──────────────────────────────────────────────────────────────
# WhatsApp Business's auto-reply: turned on/off via PATCH /me (away_enabled,
# away_message, alongside the other profile flags) — no dedicated endpoint
# needed, since it's just two more fields on the same profile row.

AWAY_REPLY_COOLDOWN_SECONDS = 12 * 3600


async def maybe_send_away_reply(background_tasks: BackgroundTasks, chat_id: str, sender_id: str):
    """
    Auto-replies at most once per cooldown window per conversation, so a
    back-and-forth doesn't get the same canned line on every message. The
    reply is an entirely ordinary message written by the away user's own
    account — it shows up and behaves exactly like they typed it themselves,
    not a system notice.
    """
    peer_id = dm_peer_id(chat_id, sender_id)
    if not peer_id:
        return
    owner = db.query_one("SELECT * FROM users WHERE id = ?", (peer_id,))
    if not owner or not owner["away_enabled"] or not owner["away_message"].strip():
        return

    last_from_owner = db.query_one(
        "SELECT created_at FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1",
        (chat_id, peer_id),
    )
    if last_from_owner and time.time() - last_from_owner["created_at"] < AWAY_REPLY_COOLDOWN_SECONDS:
        return

    background_tasks.add_task(_send_away_reply, chat_id, peer_id, owner["away_message"])


async def _send_away_reply(chat_id: str, peer_id: str, text: str):
    reply, created = chatstore.insert_message(
        chat_id=chat_id, sender_id=peer_id, text=text, kind="text",
        client_msg_id=f"away-{peer_id}-{int(time.time())}",
    )
    if created:
        await hub.send_to_chat(chat_id, {"type": "message", "message": reply})


# ── Web Push ──────────────────────────────────────────────────────────────────

@app.get("/push/vapid-public-key")
def get_vapid_public_key():
    """No auth needed — this key is public by design, it's what the browser
    encrypts push payloads TO, not a secret."""
    return {"key": push.public_key_b64url()}


@app.post("/push/subscribe")
def subscribe_to_push(request: PushSubscribeRequest, user: dict = Depends(current_user)):
    """
    Registers (or re-registers) this browser's Push subscription.

    Keyed by `endpoint`, which the browser guarantees is unique per
    origin+device+push-service — re-subscribing (a cleared service worker, a
    new tab) replaces the old row for that same endpoint rather than piling
    up duplicates that would all fire for one real device.
    """
    db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (request.endpoint,))
    db.execute(
        "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (new_id("push"), user["id"], request.endpoint, request.p256dh, request.auth, time.time()),
    )
    return {"subscribed": True}


@app.delete("/push/subscribe")
def unsubscribe_from_push(request: PushUnsubscribeRequest, user: dict = Depends(current_user)):
    db.execute("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
              (request.endpoint, user["id"]))
    return {"subscribed": False}


def push_preview_text(kind: str, text: str, payload: dict) -> str:
    """The same kind-based fallback labels the chat list preview uses, so a
    push notification reads the same as the app would have shown it."""
    labels = {
        "photo": "📷 Photo", "video": "🎥 Video", "voice": "🎤 Voice message",
        "document": "📄 Document", "location": "📍 Location", "contact": "👤 Contact",
        "poll": "📊 Poll", "sticker": "Sticker", "call": "📞 Call",
    }
    if kind in ("photo", "video", "document") and text:
        return f"{labels[kind]} · {text}"
    return labels.get(kind, text or "New message")


async def push_to_users(user_ids: list[str], title: str, body: str, data: dict):
    """
    Web Push to a specific set of accounts, regardless of their online
    status — callers decide who actually needs one (see
    notify_offline_members and notify_incoming_call below, which differ in
    exactly that decision).
    """
    if not user_ids:
        return
    placeholders = ",".join("?" for _ in user_ids)
    subs = db.query_all(
        f"SELECT * FROM push_subscriptions WHERE user_id IN ({placeholders})",
        tuple(user_ids),
    )

    for sub in subs:
        subscription_info = {
            "endpoint": sub["endpoint"],
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
        }
        # webpush() does blocking network I/O (it's the `requests` library
        # under the hood) — running it on the event loop thread would stall
        # every other request for as long as the push service takes to answer.
        result = await asyncio.to_thread(push.send, subscription_info, title, body, data)
        if result == "gone":
            db.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub["id"],))


async def notify_offline_members(chat_id: str, sender_id: str, title: str, body: str):
    """
    Web Push for whoever isn't reachable over the live socket right now.

    Deliberately not "everyone who isn't the sender" — a member with an open
    tab already sees the message arrive over the socket in real time, and
    pushing them a duplicate OS notification for something already on their
    screen is exactly the kind of noise that gets a real app's notifications
    switched off entirely.
    """
    member_rows = db.query_all(
        "SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?",
        (chat_id, sender_id),
    )
    offline_ids = [row["user_id"] for row in member_rows if not hub.is_online(row["user_id"])]
    await push_to_users(offline_ids, title, body, {"chat_id": chat_id})


async def notify_incoming_call(user_id: str, chat_id: str, caller_name: str, call_kind: str):
    """
    A call/meeting invite has exactly one delivery path — the live
    WebSocket relay in the "call_invite"/"group_call_start" handlers — with
    no fallback of any kind before this existed. Someone whose app isn't
    open would never learn they were being called at all: the invite was
    simply dropped on the floor, and the caller's own client-side ring
    timeout would eventually show "No answer" with the other side never
    having heard anything ring.

    Checked against is_online (focused), not has_connection (any open
    socket) — deliberately more aggressive than notify_offline_members'
    equivalent choice for ordinary messages. A mobile browser routinely
    keeps a backgrounded tab's WebSocket object technically open for a
    while after suspending its JavaScript (common on iOS Safari and many
    Android setups): has_connection would read that as "still reachable"
    and skip the push, but the tab genuinely cannot process the incoming
    call_invite it never stopped "having a connection" for. A live,
    focused tab (a desktop window sitting behind others, say) DOES still
    receive the socket event fine and also gets a redundant push here —
    an acceptable cost against a call ringing into total silence, which is
    a far worse failure for something this time-sensitive than it would be
    for an ordinary message.
    """
    if hub.is_online(user_id):
        return
    verb = "Video call" if call_kind == "video" else "Voice call"
    await push_to_users(
        [user_id], f"{verb} from {caller_name}", "Tap to open TalkEx and answer",
        {"chat_id": chat_id, "incoming_call": True},
    )


@app.post("/api/v1/messages")
async def bulk_send_message(request: BulkSendRequest, sender: dict = Depends(require_api_key)):
    """
    Send a text message to a user by username, authenticated with an API key.

    Deliberately narrow compared to the interactive /messages endpoint: text
    only, addressed by username rather than an internal chat id (an external
    caller has no reason to know chat ids), and always into a DM — a bulk
    sender reaching into a group or channel is not the use case this exists
    for. Finds or creates the same DM a human clicking that username would
    land in, so a reply from the recipient shows up in the ordinary app UI,
    not a parallel inbox.
    """
    bulk_rate_limiter.check(sender["id"])

    recipient = db.query_one("SELECT * FROM users WHERE lower(username) = ?",
                             (request.to.lower(),))
    if recipient is None:
        raise HTTPException(404, "No such username")
    if recipient["id"] == sender["id"]:
        raise HTTPException(400, "Cannot send to yourself")

    if blocked_between(sender["id"], recipient["id"]):
        raise HTTPException(403, "This recipient cannot be messaged")

    # Same deterministic-id DM lookup/creation as the interactive endpoint, so
    # this lands in the exact conversation the recipient already has (or would
    # get) with the sender — not a separate bulk-only channel.
    low, high = sorted([sender["id"], recipient["id"]])
    chat_id = f"dm_{low}_{high}"
    existing = db.query_one("SELECT 1 FROM chats WHERE id = ?", (chat_id,))
    if existing is None:
        now = time.time()
        with db.transaction() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO chats (id, type, name, color, avatar_letter, created_at) "
                "VALUES (?, 'dm', '', ?, ?, ?)",
                (chat_id, sender["color"], sender["avatar_letter"], now),
            )
            for member_id in (sender["id"], recipient["id"]):
                conn.execute(
                    "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) "
                    "VALUES (?, ?, 'member', ?)",
                    (chat_id, member_id, now),
                )

    message, created = chatstore.insert_message(
        chat_id=chat_id, sender_id=sender["id"], text=request.text,
        client_msg_id=request.client_msg_id,
    )
    if created:
        await hub.send_to_chat(chat_id, {"type": "message", "message": message})

    return {"message_id": message["id"], "chat_id": chat_id, "seq": message["seq"]}


# ── Profile ───────────────────────────────────────────────────────────────────

@app.get("/me")
def get_me(user: dict = Depends(current_user)):
    return public_user(user)


@app.patch("/me")
def update_me(request: UpdateProfileRequest, user: dict = Depends(current_user)):
    fields = request.model_dump(exclude_none=True)
    if fields:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        db.execute(f"UPDATE users SET {assignments} WHERE id = ?",
                   (*fields.values(), user["id"]))
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)))


@app.get("/me/username-available")
def username_available(username: str = Query(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_]+$"),
                        user: dict = Depends(current_user)):
    """Live-typing feedback for the Settings username field — a name is
    "available" if it's free, or if it's already this account's own
    (so re-submitting your current username never reads as taken)."""
    taken = db.query_one(
        "SELECT 1 FROM users WHERE lower(username) = ? AND id != ?",
        (username.lower(), user["id"]),
    )
    return {"available": taken is None}


@app.put("/me/username")
def set_username(request: SetUsernameRequest, user: dict = Depends(current_user)):
    """
    A username exists behind the scenes even for a phone-signup account
    that was never shown one (see unique_username_from_phone) — this is
    the first way to ever choose your own rather than live with the
    auto-generated one, for @mentions, the bulk API's `to: username`, and
    now signing in with a password (see /me/password) instead of a phone
    code.
    """
    new_username = request.username.lower()
    if new_username == user["username"]:
        return public_user(user)
    try:
        db.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user["id"]))
    except sqlite3.IntegrityError:
        raise HTTPException(400, "Username already taken")
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)))


@app.put("/me/password")
def set_password(request: SetPasswordRequest,
                  credentials: HTTPAuthorizationCredentials = Depends(security),
                  user: dict = Depends(current_user)):
    """
    Set (or replace) this account's password — a self-service path that
    was missing entirely; the only way a password ever got set was at
    /auth/register, or a random, never-shown one minted for a phone-signup
    account (see SetPasswordRequest's docstring for why there's no
    current_password field here). Every OTHER session is revoked, the same
    rule /me/deactivate already applies — changing your password should
    mean a stolen or shared session stops working silently, not keep
    riding along on the old credentials.
    """
    db.execute("UPDATE users SET password_hash = ? WHERE id = ?",
               (auth.hash_password(request.new_password), user["id"]))
    db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
               (user["id"], auth.hash_token(credentials.credentials)))
    return {"ok": True}


@app.get("/me/story-audience")
def get_story_audience(user: dict = Depends(current_user)):
    """Your current status-privacy setting plus, when it's 'except'/'only',
    the exact people that list names — nothing to show for plain 'contacts'."""
    mode = db.query_one("SELECT story_audience FROM users WHERE id = ?", (user["id"],))["story_audience"]
    rows = db.query_all(
        "SELECT other_user_id FROM story_audience_list WHERE user_id = ?", (user["id"],),
    )
    return {"mode": mode, "user_ids": [row["other_user_id"] for row in rows]}


@app.put("/me/story-audience")
def set_story_audience(request: StoryAudienceRequest, user: dict = Depends(current_user)):
    """Replaces the whole exception/inclusion list in one call rather than
    incremental add/remove — the settings screen always has the full set in
    hand already, so there is nothing an incremental API would save."""
    # All in one transaction: up to 2000 ids (StoryAudienceRequest caps it),
    # each previously its own individually-committed db.execute() call. An
    # interrupted request (client disconnect, worker restart) between two of
    # those commits used to leave `mode` durably set to 'only'/'except'
    # while the list itself held just some prefix of the intended ids —
    # silently exposing or hiding status updates for whoever fell on the
    # wrong side of that partial write. One transaction makes it all-or-nothing.
    with db.transaction() as conn:
        conn.execute("UPDATE users SET story_audience = ? WHERE id = ?", (request.mode, user["id"]))
        conn.execute("DELETE FROM story_audience_list WHERE user_id = ?", (user["id"],))
        if request.mode in ("except", "only"):
            conn.executemany(
                "INSERT OR IGNORE INTO story_audience_list (user_id, other_user_id) VALUES (?, ?)",
                [(user["id"], other_id) for other_id in set(request.user_ids)],
            )
    return {"mode": request.mode, "user_ids": request.user_ids}


@app.post("/me/avatar")
async def set_avatar(file: UploadFile = File(...), user: dict = Depends(current_user)):
    """
    Upload and set a real profile photo, replacing the letter avatar.

    Unlike a chat attachment, this is a single call (not upload-then-attach)
    — a profile photo has no "maybe never sent" state to protect against;
    setting it IS sending it. The old photo's file is deleted once the new
    one is confirmed in place, so changing your photo repeatedly doesn't
    leave a trail of orphaned files on disk.
    """
    try:
        attachment = await uploads.store(file, user["id"])
    except uploads.UploadTooLarge as error:
        raise HTTPException(413, str(error))
    except uploads.UploadTypeRefused as error:
        raise HTTPException(415, str(error))

    bound = uploads.attach_to_avatar(attachment["id"], user["id"])
    if bound is None:
        uploads.delete(attachment["id"])
        raise HTTPException(500, "Could not set avatar")

    previous_id = db.query_one("SELECT avatar_attachment_id FROM users WHERE id = ?",
                               (user["id"],))["avatar_attachment_id"]
    db.execute("UPDATE users SET avatar_attachment_id = ? WHERE id = ?",
              (attachment["id"], user["id"]))
    if previous_id:
        uploads.delete(previous_id)

    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


@app.delete("/me/avatar")
def remove_avatar(user: dict = Depends(current_user)):
    """Back to the letter avatar."""
    previous_id = db.query_one("SELECT avatar_attachment_id FROM users WHERE id = ?",
                               (user["id"],))["avatar_attachment_id"]
    db.execute("UPDATE users SET avatar_attachment_id = NULL WHERE id = ?", (user["id"],))
    if previous_id:
        uploads.delete(previous_id)
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


@app.post("/me/deactivate")
def deactivate_account(user: dict = Depends(current_user)):
    """
    Hide the account rather than delete it — invisible in search and closed
    to new DMs, but signing back in still works, and doing so IS how you
    reactivate (see /auth/login's account_disabled flag). Every other
    session is revoked, so "deactivated" actually means logged out
    everywhere until whoever owns it chooses to come back.
    """
    db.execute("UPDATE users SET disabled_at = ? WHERE id = ?", (time.time(), user["id"]))
    db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
    return {"disabled": True}


@app.post("/me/reactivate")
def reactivate_account(user: dict = Depends(current_user)):
    db.execute("UPDATE users SET disabled_at = NULL WHERE id = ?", (user["id"],))
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


def delete_user_account(user_id: str):
    """
    Permanently delete an account. Everything the FK graph cascades on
    (sessions, chat memberships, contacts, blocks, api keys, push
    subscriptions, stars, broadcast recipients, ...) goes with it
    automatically; messages already sent stay in their chats (sender_id
    just goes NULL, same as any other FK set to SET NULL) — deleting an
    account doesn't rewrite history for everyone else in a group.

    Groups/channels/communities this account owned need an explicit
    handoff first — the same reassign_owner_if_needed leave uses — since
    the cascade on chats.owner_id is only SET NULL, not a promotion.

    Shared by the self-service DELETE /me and the superadmin panel's
    DELETE /admin/users/{id} — moderation removing someone else's account
    has to leave chats in exactly the same non-dangling state a person
    deleting their own does.
    """
    owned_memberships = db.query_all(
        "SELECT chat_id FROM chat_members WHERE user_id = ?", (user_id,))
    for row in owned_memberships:
        db.execute("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?",
                   (row["chat_id"], user_id))
        chatstore.reassign_owner_if_needed(row["chat_id"], user_id)

    db.execute("DELETE FROM users WHERE id = ?", (user_id,))


@app.delete("/me")
def delete_account(user: dict = Depends(current_user)):
    delete_user_account(user["id"])
    return {"deleted": True}


@app.get("/users")
def list_users(q: str = Query(default="", max_length=64),
               limit: int = Query(default=50, ge=1, le=200),
               offset: int = Query(default=0, ge=0),
               user: dict = Depends(current_user)):
    """Directory search. Excludes yourself, anyone who has blocked you, and
    anyone who has deactivated their account."""
    like = f"%{q.lower()}%"
    rows = db.query_all(
        """
        SELECT * FROM users
        WHERE id != ? AND disabled_at IS NULL
          AND (lower(name) LIKE ? OR lower(username) LIKE ?)
          AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
        ORDER BY name
        LIMIT ? OFFSET ?
        """,
        (user["id"], like, like, user["id"], limit, offset),
    )
    return [public_user(row, viewer_id=user["id"]) for row in rows]


@app.get("/users/{user_id}")
def get_user(user_id: str, user: dict = Depends(current_user)):
    row = db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))
    if row is None:
        raise HTTPException(404, "User not found")
    return public_user(row, viewer_id=user["id"])


@app.post("/users/{user_id}/block")
def block_user(user_id: str, user: dict = Depends(current_user)):
    if user_id == user["id"]:
        raise HTTPException(400, "You cannot block yourself")
    db.execute(
        "INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
        (user["id"], user_id, time.time()),
    )
    return {"blocked": True}


@app.delete("/users/{user_id}/block")
def unblock_user(user_id: str, user: dict = Depends(current_user)):
    db.execute("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?",
               (user["id"], user_id))
    return {"blocked": False}


@app.get("/blocks")
def list_blocks(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?",
        (user["id"],),
    )
    return [public_user(row, viewer_id=user["id"]) for row in rows]


@app.post("/users/{user_id}/mute-status")
def mute_status(user_id: str, user: dict = Depends(current_user)):
    """
    Stop this person's status updates from showing in your list — nothing
    else about them changes (still a contact, still messageable, still
    shows online). One-directional and silent, same as muting a chat: they
    are never told they've been muted.
    """
    if user_id == user["id"]:
        raise HTTPException(400, "You cannot mute your own status")
    db.execute(
        "INSERT OR IGNORE INTO muted_statuses (muter_id, muted_id, created_at) VALUES (?, ?, ?)",
        (user["id"], user_id, time.time()),
    )
    return {"muted": True}


@app.delete("/users/{user_id}/mute-status")
def unmute_status(user_id: str, user: dict = Depends(current_user)):
    db.execute("DELETE FROM muted_statuses WHERE muter_id = ? AND muted_id = ?",
               (user["id"], user_id))
    return {"muted": False}


@app.get("/muted-statuses")
def list_muted_statuses(user: dict = Depends(current_user)):
    """Full profiles, not just ids — a muted-status list with only ids in
    it has nowhere to show WHO to offer "unmute" for."""
    rows = db.query_all(
        "SELECT u.* FROM muted_statuses m JOIN users u ON u.id = m.muted_id WHERE m.muter_id = ?",
        (user["id"],),
    )
    return [public_user(row, viewer_id=user["id"]) for row in rows]


@app.post("/report")
def submit_report(request: ReportRequest, user: dict = Depends(current_user)):
    """
    One-way — the target never learns they were reported, and nothing here
    takes any automatic action (no auto-mute, no auto-ban). It's a queue for
    whoever moderates the platform to look at, same as any report-abuse flow.
    """
    report_rate_limiter.check(user["id"])
    db.execute(
        "INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (new_id("report"), user["id"], request.target_type, request.target_id,
         request.reason, request.details, time.time()),
    )
    return {"reported": True}


# ── Contacts ──────────────────────────────────────────────────────────────────

def _serialise_contact(contact: dict) -> dict:
    """
    Resolve a contact's phone number against registered accounts.

    Mirrors how a phone's own address book behaves: a saved name+number shows
    up right away, and once that number matches a real account it also shows
    "on TalkEx" with an actual profile you can open. The match is live —
    someone signing up after you saved their number starts showing up without
    you doing anything.
    """
    matched = None
    if contact["phone"]:
        matched = db.query_one(
            "SELECT id, name, username, avatar_letter, color, avatar_attachment_id FROM users "
            "WHERE phone = ? AND phone != ''",
            (contact["phone"],),
        )
    if matched:
        contact["user"] = {**dict(matched), "online": hub.is_online(matched["id"])}
    else:
        contact["user"] = None
    return contact


@app.post("/contacts")
def add_contact(request: AddContactRequest, user: dict = Depends(current_user)):
    contact_id = new_id("contact")
    try:
        db.execute(
            "INSERT INTO contacts (id, owner_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?)",
            (contact_id, user["id"], request.name.strip(), request.phone.strip(), time.time()),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(400, "You already have a contact with that phone number")
    return _serialise_contact(dict(db.query_one("SELECT * FROM contacts WHERE id = ?", (contact_id,))))


@app.get("/contacts")
def list_contacts(user: dict = Depends(current_user)):
    """Your own address book, alphabetical by the name you gave each entry."""
    rows = db.query_all(
        "SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE",
        (user["id"],),
    )
    return [_serialise_contact(dict(row)) for row in rows]


@app.patch("/contacts/{contact_id}")
def update_contact(contact_id: str, request: UpdateContactRequest, user: dict = Depends(current_user)):
    try:
        changed = db.execute(
            "UPDATE contacts SET name = ?, phone = ? WHERE id = ? AND owner_id = ?",
            (request.name.strip(), request.phone.strip(), contact_id, user["id"]),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(400, "You already have a contact with that phone number")
    if changed.rowcount == 0:
        raise HTTPException(404, "Contact not found")
    return _serialise_contact(dict(db.query_one("SELECT * FROM contacts WHERE id = ?", (contact_id,))))


@app.delete("/contacts/{contact_id}")
def delete_contact(contact_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "DELETE FROM contacts WHERE id = ? AND owner_id = ?", (contact_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Contact not found")
    return {"deleted": True}


# ── Chats ─────────────────────────────────────────────────────────────────────

def create_saved_messages_chat(user_id: str) -> str:
    chat_id = new_id("saved")
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO chats (id, type, name, description, color, avatar_letter,
                               owner_id, created_at)
            VALUES (?, 'saved', 'Saved Messages', 'Your private notes', '#64748b', '★', ?, ?)
            """,
            (chat_id, user_id, now),
        )
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
            (chat_id, user_id, now),
        )
    return chat_id


def blocked_between(one_user_id: str, other_user_id: str) -> bool:
    """
    Whether either person has blocked the other.

    Blocking has to be symmetric in effect: if you block someone, you should
    stop receiving from them, and they should not be able to reach you. Checking
    only one direction leaves whichever side was not checked still able to send.
    """
    row = db.query_one(
        """
        SELECT 1 FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?)
           OR (blocker_id = ? AND blocked_id = ?)
        """,
        (one_user_id, other_user_id, other_user_id, one_user_id),
    )
    return row is not None


def dm_peer_id(chat_id: str, user_id: str) -> str | None:
    """The other person in a direct message, or None if this is not a DM."""
    row = db.query_one(
        """
        SELECT cm.user_id FROM chat_members AS cm
        JOIN chats AS c ON c.id = cm.chat_id
        WHERE cm.chat_id = ? AND cm.user_id != ? AND c.type = 'dm'
        LIMIT 1
        """,
        (chat_id, user_id),
    )
    return row["user_id"] if row else None


def group_call_target_ok(chat_id: str, user_id: str, to_user_id: str) -> bool:
    """
    Whether `user_id` may signal `to_user_id` inside a group call for
    `chat_id` — both have to actually be members of that specific group.
    Restricted to `type == 'group'` on purpose: a channel is one-to-many
    broadcast (nobody but its admins can even post), and a community is a
    container for sub-channels, not somewhere people talk to each other
    directly — group calling makes sense for neither.
    """
    chat = db.query_one("SELECT type FROM chats WHERE id = ?", (chat_id,))
    if chat is None or chat["type"] != "group":
        return False
    return chatstore.is_member(chat_id, user_id) and chatstore.is_member(chat_id, to_user_id)


def call_target_ok(chat_id: str, user_id: str, to_user_id: str) -> bool:
    """
    Whether `user_id` may signal `to_user_id` about a call in `chat_id`.

    Calling is 1:1 only — the target has to be the actual other person in that
    specific DM, not merely someone the caller shares any chat with. That plus
    the block check are what stop a signaling message from being aimed at an
    arbitrary stranger's socket.
    """
    if not chatstore.is_member(chat_id, user_id):
        return False
    peer_id = dm_peer_id(chat_id, user_id)
    if peer_id is None or peer_id != to_user_id:
        return False
    return not blocked_between(user_id, to_user_id)


def calling_permitted(chat_id: str, user_id: str) -> bool:
    """
    Whether `user_id` currently allows calling at all, checked on BOTH sides
    of an attempt — the caller (did they switch calling off for themselves?)
    and the callee (are they willing to be reached?) go through the exact
    same check. Two independent switches: a global "Calling" toggle in
    Privacy (users.calling_enabled) and a per-chat override
    (chat_members.calls_enabled) that defaults on, so muting calls in one
    noisy group doesn't require going dark everywhere.

    A meeting's actual call (not the calendar record) DOES route through
    here — "Join now" on a meeting sends group_call_start the same as the
    header's own call button, and that handler checks this before letting
    anyone into the room. Someone who's switched calling off entirely still
    can't be pulled into a meeting's call because of it.
    """
    user = db.query_one("SELECT calling_enabled FROM users WHERE id = ?", (user_id,))
    if user is None or not user["calling_enabled"]:
        return False
    member = db.query_one(
        "SELECT calls_enabled FROM chat_members WHERE chat_id = ? AND user_id = ?",
        (chat_id, user_id),
    )
    return member is None or bool(member["calls_enabled"])


def require_member(chat_id: str, user_id: str) -> dict:
    """Load a chat, refusing if the caller is not in it."""
    chat = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if chat is None:
        raise HTTPException(404, "Chat not found")
    if not chatstore.is_member(chat_id, user_id):
        # 404 rather than 403: a 403 would confirm the chat exists to someone
        # who has no business knowing that.
        raise HTTPException(404, "Chat not found")
    return dict(chat)


def redact_chat(row) -> dict:
    """
    A chat row as a client may see it: `is_locked` computed, the actual
    `pin_hash` never sent. Two endpoints (community sub-channel listing and
    creation) were returning the raw row with the hash still in it — every
    other chat-returning endpoint already scrubbed this, these two just used
    a plain `dict(row)` shortcut and got missed.
    """
    chat = dict(row)
    chat["is_locked"] = bool(chat.get("pin_hash"))
    chat.pop("pin_hash", None)
    return chat


@app.get("/chats")
def list_chats(user: dict = Depends(current_user),
                limit: int = Query(default=500, ge=1, le=1000),
                offset: int = Query(default=0, ge=0)):
    """
    Every chat you are in, newest activity first.

    The unread count is `last_seq - last_read_seq`, which is a subtraction of two
    integers already on the row rather than a scan of the message table.

    limit/offset default high enough that no real account today notices
    them — this used to have no ceiling at all, so an account with an
    unusually large number of chats (a heavy group/channel/community user)
    paid for three unbounded queries and a full serialization on every
    single load of this screen, with no way for the client to ask for less.
    """
    rows = db.query_all(
        """
        SELECT
            c.*,
            m.role, m.last_read_seq, m.muted_until, m.is_pinned, m.folder, m.draft, m.archived,
            m.calls_enabled, m.is_favorite, m.vanish_mode,
            MAX(c.last_seq - m.last_read_seq, 0) AS unread
        FROM chat_members AS m
        JOIN chats AS c ON c.id = m.chat_id
        WHERE m.user_id = ?
        ORDER BY m.is_pinned DESC, c.last_seq DESC
        LIMIT ? OFFSET ?
        """,
        (user["id"], limit, offset),
    )
    if not rows:
        return []
    chat_ids = [row["id"] for row in rows]
    placeholders = ",".join("?" for _ in chat_ids)

    # The newest message in every chat ON THIS PAGE, in one query rather than
    # one per chat. Joining against MAX(seq) works because seq is unique per
    # chat, so exactly one row matches each pair.
    last_messages = {
        row["chat_id"]: row
        for row in db.query_all(
            f"""
            SELECT m.* FROM messages AS m
            JOIN (
                SELECT chat_id, MAX(seq) AS seq
                FROM messages
                WHERE chat_id IN ({placeholders})
                  AND unsent_at IS NULL
                  AND id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
                GROUP BY chat_id
            ) AS newest ON newest.chat_id = m.chat_id AND newest.seq = m.seq
            """,
            (*chat_ids, user["id"]),
        )
    }

    # A DM stores no name of its own — it is whoever the other member is. This
    # resolves every peer in one query, so the client does not have to fetch a
    # chat individually just to have something to label it with.
    peers = {
        row["chat_id"]: row
        for row in db.query_all(
            f"""
            SELECT cm.chat_id, u.id AS peer_id, u.name, u.color, u.avatar_letter,
                   u.avatar_attachment_id, u.last_seen, u.show_last_seen
            FROM chat_members AS cm
            JOIN chats AS c ON c.id = cm.chat_id AND c.type = 'dm'
            JOIN users AS u ON u.id = cm.user_id
            WHERE cm.user_id != ?
              AND cm.chat_id IN ({placeholders})
            """,
            (user["id"], *chat_ids),
        )
    }

    # serialise_message() falls back to one reactions query per message when
    # `reactions` isn't passed in — harmless for a single message, but this
    # loop calls it once per chat, and skipping this would silently
    # reintroduce the exact N+1 reactions_for_many exists to eliminate (see
    # its docstring) on the single highest-traffic read path in the app.
    reactions_by_message = chatstore.reactions_for_many(
        [row["id"] for row in last_messages.values()], user["id"])

    chats = []
    for row in rows:
        chat = dict(row)

        peer = peers.get(chat["id"])
        if peer:
            chat["name"] = peer["name"]
            chat["color"] = peer["color"]
            chat["avatar_letter"] = peer["avatar_letter"]
            chat["avatar_attachment_id"] = peer["avatar_attachment_id"]
            chat["peer_id"] = peer["peer_id"]
            chat["peer_online"] = hub.is_online(peer["peer_id"])
            # Same privacy gate public_user() already applies elsewhere —
            # withholding the timestamp for someone who turned last-seen
            # off has to actually happen here too, not just when their
            # profile is fetched directly.
            chat["peer_last_seen"] = peer["last_seen"] if peer["show_last_seen"] else None

        last = last_messages.get(chat["id"])
        chat["last_message"] = (
            chatstore.serialise_message(last, user["id"], reactions_by_message.get(last["id"], []))
            if last else None
        )
        chat.pop("pin_hash", None)          # never leave the hash on a list response
        chat["is_locked"] = bool(row["pin_hash"])
        chats.append(chat)
    return chats


@app.get("/chats/{chat_id}")
def get_chat(chat_id: str, user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    chat["is_locked"] = bool(chat.get("pin_hash"))
    chat.pop("pin_hash", None)

    member_rows = db.query_all(
        "SELECT u.*, m.role, m.joined_at FROM chat_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.chat_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at",
        (chat_id,),
    )
    chat["members"] = [{**public_user(row, viewer_id=user["id"]), "role": row["role"]} for row in member_rows]
    chat["my_role"] = next((m["role"] for m in chat["members"] if m["id"] == user["id"]), None)

    # Same DM naming rule as the list endpoint, so a chat opened directly is
    # labelled the same way as one opened from the list.
    peer_id = dm_peer_id(chat_id, user["id"])
    if peer_id:
        peer = db.query_one("SELECT * FROM users WHERE id = ?", (peer_id,))
        if peer:
            chat["name"] = peer["name"]
            chat["color"] = peer["color"]
            chat["avatar_letter"] = peer["avatar_letter"]
            chat["avatar_attachment_id"] = peer["avatar_attachment_id"]
            chat["peer_id"] = peer_id
            chat["peer_online"] = hub.is_online(peer_id)

    return chat


@app.post("/chats/dm/{other_user_id}")
def create_dm(other_user_id: str, user: dict = Depends(current_user)):
    if other_user_id == user["id"]:
        raise HTTPException(400, "Use Saved Messages to talk to yourself")

    other = db.query_one("SELECT * FROM users WHERE id = ?", (other_user_id,))
    # A deactivated account 404s the same as one that doesn't exist — it's
    # not findable to start a fresh conversation with, same as it's excluded
    # from directory search.
    if other is None or other["disabled_at"]:
        raise HTTPException(404, "User not found")

    if blocked_between(user["id"], other_user_id):
        raise HTTPException(403, "You cannot start a chat with this user")

    # A deterministic id from the sorted pair, so both people opening the chat at
    # the same moment land on the same row instead of creating two.
    low, high = sorted([user["id"], other_user_id])
    chat_id = f"dm_{low}_{high}"

    existing = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if existing is None:
        now = time.time()
        with db.transaction() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO chats (id, type, name, color, avatar_letter, created_at)
                VALUES (?, 'dm', '', ?, ?, ?)
                """,
                (chat_id, other["color"], other["avatar_letter"], now),
            )
            for member_id in (user["id"], other_user_id):
                conn.execute(
                    "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) "
                    "VALUES (?, ?, 'member', ?)",
                    (chat_id, member_id, now),
                )

    return get_chat(chat_id, user)


@app.post("/chats/group")
def create_group(request: CreateGroupRequest, user: dict = Depends(current_user)):
    member_ids = set(request.member_ids) - {user["id"]}
    if len(member_ids) + 1 > MAX_GROUP_MEMBERS:  # +1 for the owner
        raise HTTPException(400, f"A group can have at most {MAX_GROUP_MEMBERS} members")

    chat_id = new_id("group")
    now = time.time()

    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO chats (id, type, name, description, color, avatar_letter,
                               owner_id, created_at)
            VALUES (?, 'group', ?, ?, ?, ?, ?, ?)
            """,
            (chat_id, request.name, request.description, request.color,
             request.name[0].upper(), user["id"], now),
        )
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
            (chat_id, user["id"], now),
        )
        for member_id in member_ids:
            conn.execute(
                "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) "
                "VALUES (?, ?, 'member', ?)",
                (chat_id, member_id, now),
            )

    return get_chat(chat_id, user)


@app.post("/chats/{chat_id}/breakout-rooms")
async def create_breakout_rooms(chat_id: str, request: CreateBreakoutRoomsRequest,
                                user: dict = Depends(current_user)):
    """
    Splits the people on an ongoing call into smaller side calls.

    Deliberately NOT a new kind of call room — each breakout room is just an
    ordinary new group chat with its own ordinary group call, both built out
    of the exact same code every other group chat/call already goes
    through. That's what keeps this additive rather than a parallel signaling
    stack to maintain: a breakout room is not a special case anywhere else
    in the app, including to whoever ends up back in it after leaving and
    rejoining. Only the person who started the call on it may split it.
    """
    parent_chat = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if parent_chat is None:
        raise HTTPException(404, "Chat not found")
    require_member(chat_id, user["id"])
    if _group_call_hosts.get(chat_id) != user["id"]:
        raise HTTPException(403, "Only the person who started this call can create breakout rooms")

    by_room: dict[int, set[str]] = {}
    for target_id, room_index in request.assignments.items():
        if not chatstore.is_member(chat_id, target_id):
            continue
        by_room.setdefault(room_index, set()).add(target_id)

    if not by_room:
        raise HTTPException(400, "No valid people to assign to a room")

    now = time.time()
    rooms = []
    with db.transaction() as conn:
        for room_index in sorted(by_room):
            member_ids = by_room[room_index] | {user["id"]}
            room_chat_id = new_id("group")
            room_name = f"{parent_chat['name'] or 'Meeting'} — Room {room_index + 1}"
            conn.execute(
                """
                INSERT INTO chats (id, type, name, description, color, avatar_letter,
                                   owner_id, created_at)
                VALUES (?, 'group', ?, '', ?, ?, ?, ?)
                """,
                (room_chat_id, room_name, parent_chat["color"], "B", user["id"], now),
            )
            for member_id in member_ids:
                role = "owner" if member_id == user["id"] else "member"
                conn.execute(
                    "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) "
                    "VALUES (?, ?, ?, ?)",
                    (room_chat_id, member_id, role, now),
                )
            rooms.append({
                "chat_id": room_chat_id, "name": room_name, "member_ids": sorted(member_ids),
            })

    _breakout_hosts[chat_id] = user["id"]
    await hub.send_to_chat(chat_id, {
        "type": "breakout_rooms_created", "chat_id": chat_id, "rooms": rooms,
    })
    return {"rooms": rooms}


@app.post("/chats/{chat_id}/breakout-rooms/close")
async def close_breakout_rooms(chat_id: str, user: dict = Depends(current_user)):
    """
    Tells everyone to head back to the main call. Doesn't touch the
    breakout rooms' own chats/calls at all — each is an ordinary group chat,
    people leaving it (or staying, it's still a real chat afterward) is
    exactly the ordinary leave-a-call/leave-a-chat behavior everywhere else.
    """
    require_member(chat_id, user["id"])
    if _breakout_hosts.get(chat_id) != user["id"]:
        raise HTTPException(403, "Only whoever created the breakout rooms can close them")

    _breakout_hosts.pop(chat_id, None)
    await hub.send_to_chat(chat_id, {"type": "breakout_rooms_closed", "chat_id": chat_id})
    return {"closed": True}


@app.post("/chats/broadcast")
def create_broadcast(request: CreateBroadcastRequest, user: dict = Depends(current_user)):
    """
    A broadcast list: you write once, each recipient gets it as an ordinary
    message in their own DM with you. Recipients are NOT chat_members of this
    chat — only the owner can ever see or open it (see broadcast_recipients'
    table comment in db.py for why) — so unlike a group, nobody but the owner
    ever lands on this chat id at all.
    """
    recipient_ids = set(request.recipient_ids) - {user["id"]}
    if len(recipient_ids) > MAX_BROADCAST_RECIPIENTS:
        raise HTTPException(400, f"A broadcast list can have at most {MAX_BROADCAST_RECIPIENTS} recipients")

    chat_id = new_id("broadcast")
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO chats (id, type, name, color, avatar_letter, owner_id, created_at)
            VALUES (?, 'broadcast', ?, ?, ?, ?, ?)
            """,
            (chat_id, request.name, request.color, request.name[0].upper(), user["id"], now),
        )
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
            (chat_id, user["id"], now),
        )
        for recipient_id in recipient_ids:
            if db.query_one("SELECT 1 FROM users WHERE id = ?", (recipient_id,)) is None:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO broadcast_recipients (chat_id, user_id, added_at) VALUES (?, ?, ?)",
                (chat_id, recipient_id, now),
            )

    return get_chat(chat_id, user)


def require_broadcast_owner(chat_id: str, user_id: str) -> dict:
    chat = require_member(chat_id, user_id)
    if chat["type"] != "broadcast":
        raise HTTPException(400, "Not a broadcast list")
    if chat["owner_id"] != user_id:
        raise HTTPException(403, "Only the owner can manage this broadcast list")
    return chat


@app.get("/chats/{chat_id}/broadcast/recipients")
def list_broadcast_recipients(chat_id: str, user: dict = Depends(current_user)):
    require_broadcast_owner(chat_id, user["id"])
    rows = db.query_all(
        "SELECT u.* FROM broadcast_recipients b JOIN users u ON u.id = b.user_id WHERE b.chat_id = ?",
        (chat_id,),
    )
    return [public_user(row, viewer_id=user["id"]) for row in rows]


@app.post("/chats/{chat_id}/broadcast/recipients")
def add_broadcast_recipients(chat_id: str, request: BroadcastRecipientsRequest,
                             user: dict = Depends(current_user)):
    require_broadcast_owner(chat_id, user["id"])

    now = time.time()
    added = []
    # Reading the current count and then inserting were previously two
    # separate, uncoordinated steps: two near-simultaneous requests could
    # both read the same current_count before either had inserted anything,
    # both pass the cap check against that stale number, and together push
    # the list past MAX_BROADCAST_RECIPIENTS with nothing to catch it (there
    # is no DB-level constraint capping rows per chat_id either). Holding
    # the whole read-check-insert sequence inside one transaction serialises
    # it against any other write, closing that race.
    with db.transaction() as conn:
        current_count = conn.execute(
            "SELECT COUNT(*) AS n FROM broadcast_recipients WHERE chat_id = ?", (chat_id,)).fetchone()["n"]
        incoming = set(request.user_ids) - {user["id"]}
        existing_ids = {
            row["user_id"] for row in
            conn.execute("SELECT user_id FROM broadcast_recipients WHERE chat_id = ?", (chat_id,)).fetchall()
        }
        new_ids = incoming - existing_ids
        if current_count + len(new_ids) > MAX_BROADCAST_RECIPIENTS:
            raise HTTPException(400, f"A broadcast list can have at most {MAX_BROADCAST_RECIPIENTS} recipients")

        for recipient_id in new_ids:
            if conn.execute("SELECT 1 FROM users WHERE id = ?", (recipient_id,)).fetchone() is None:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO broadcast_recipients (chat_id, user_id, added_at) VALUES (?, ?, ?)",
                (chat_id, recipient_id, now),
            )
            added.append(recipient_id)
    return {"added": added}


@app.delete("/chats/{chat_id}/broadcast/recipients/{recipient_id}")
def remove_broadcast_recipient(chat_id: str, recipient_id: str, user: dict = Depends(current_user)):
    require_broadcast_owner(chat_id, user["id"])
    db.execute(
        "DELETE FROM broadcast_recipients WHERE chat_id = ? AND user_id = ?",
        (chat_id, recipient_id),
    )
    return {"removed": True}


@app.post("/chats/channel")
def create_channel(request: CreateChannelRequest, user: dict = Depends(current_user)):
    chat_id = new_id("channel")
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO chats (id, type, name, description, color, avatar_letter,
                               owner_id, created_at)
            VALUES (?, 'channel', ?, ?, ?, ?, ?, ?)
            """,
            (chat_id, request.name, request.description, request.color,
             request.name[0].upper(), user["id"], now),
        )
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
            (chat_id, user["id"], now),
        )
    return get_chat(chat_id, user)


@app.post("/chats/community")
def create_community(request: CreateCommunityRequest, user: dict = Depends(current_user)):
    """
    A community is a chat whose sub-channels are chats pointing back at it.

    Modelling it this way means messages, membership, unread counts and search
    work inside a community sub-channel with no extra code.
    """
    community_id = new_id("community")
    now = time.time()

    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO chats (id, type, name, description, color, avatar_letter,
                               owner_id, created_at)
            VALUES (?, 'community', ?, ?, ?, ?, ?, ?)
            """,
            (community_id, request.name, request.description, request.color,
             request.name[0].upper(), user["id"], now),
        )
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
            (community_id, user["id"], now),
        )

        for channel_name in request.channels:
            sub_id = new_id("cchan")
            conn.execute(
                """
                INSERT INTO chats (id, type, name, color, avatar_letter,
                                   owner_id, parent_id, created_at)
                VALUES (?, 'community_channel', ?, ?, '#', ?, ?, ?)
                """,
                (sub_id, channel_name, request.color, user["id"], community_id, now),
            )
            conn.execute(
                "INSERT INTO chat_members (chat_id, user_id, role, joined_at) "
                "VALUES (?, ?, 'owner', ?)",
                (sub_id, user["id"], now),
            )

    return get_chat(community_id, user)


@app.get("/chats/{chat_id}/channels")
def list_community_channels(chat_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    rows = db.query_all("SELECT * FROM chats WHERE parent_id = ? ORDER BY created_at", (chat_id,))
    return [redact_chat(row) for row in rows]


@app.post("/chats/{chat_id}/channels")
def create_sub_channel(chat_id: str, request: CreateSubChannelRequest,
                       user: dict = Depends(current_user)):
    """
    Add a new sub-channel to an existing community.

    Community sub-channels used to be creatable only at the moment the
    community itself was created — there was no way to add "#help" three weeks
    later once the community had grown and needed it.
    """
    community = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if community is None or community["type"] != "community":
        raise HTTPException(404, "Community not found")
    require_manager(chat_id, user["id"])

    sub_id = new_id("cchan")
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO chats (id, type, name, color, avatar_letter, owner_id, parent_id, created_at)
            VALUES (?, 'community_channel', ?, ?, '#', ?, ?, ?)
            """,
            (sub_id, request.name, request.color, user["id"], chat_id, now),
        )
        conn.execute(
            "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
            (sub_id, user["id"], now),
        )

    return redact_chat(db.query_one("SELECT * FROM chats WHERE id = ?", (sub_id,)))


@app.get("/discover")
def discover(limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0),
             user: dict = Depends(current_user)):
    """Public channels and communities you could join."""
    rows = db.query_all(
        """
        SELECT c.*,
               (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) AS member_count,
               EXISTS(SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?) AS joined
        FROM chats AS c
        WHERE c.type IN ('channel', 'community')
        ORDER BY member_count DESC
        LIMIT ? OFFSET ?
        """,
        (user["id"], limit, offset),
    )
    result = []
    for row in rows:
        chat = dict(row)
        chat.pop("pin_hash", None)
        result.append(chat)
    return result


@app.post("/chats/{chat_id}/join")
def join_chat(chat_id: str, user: dict = Depends(current_user)):
    chat = db.query_one("SELECT * FROM chats WHERE id = ?", (chat_id,))
    if chat is None:
        raise HTTPException(404, "Chat not found")

    # Only open chat types can be joined without an invitation. Letting anyone
    # join a DM or a private group by id would undo every membership check.
    if chat["type"] not in ("channel", "community", "community_channel"):
        raise HTTPException(403, "This chat is invitation only")

    # A community's sub-channel is only as open as its community. Without this,
    # knowing a sub-channel id was enough to read a community you never joined.
    if chat["type"] == "community_channel":
        if not chat["parent_id"] or not chatstore.is_member(chat["parent_id"], user["id"]):
            raise HTTPException(403, "Join the community first")

    role = "subscriber" if chat["type"] == "channel" else "member"
    db.execute(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        (chat_id, user["id"], role, time.time()),
    )
    return {"joined": True}


@app.post("/chats/{chat_id}/leave")
async def leave_chat(chat_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    db.execute("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?", (chat_id, user["id"]))

    # If the person leaving ran the chat, someone has to take over — otherwise
    # the group is left with an owner_id pointing at nobody, and no one can
    # ever promote an admin, remove a member, or manage it again.
    successor_id = chatstore.reassign_owner_if_needed(chat_id, user["id"])
    if successor_id:
        await hub.send_to_chat(chat_id, {
            "type": "chat_owner_changed", "chat_id": chat_id, "owner_id": successor_id,
        })

    return {"left": True}


@app.post("/chats/{chat_id}/invite")
def create_invite_link(chat_id: str, user: dict = Depends(current_user)):
    """
    Generate (or rotate) a shareable join code for a group/channel/community.

    Rotating invalidates the old link outright — anyone who only has the old
    code can no longer use it, which is the point of rotating one at all.
    """
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in ("group", "channel", "community"):
        raise HTTPException(400, "This chat type cannot be joined by link")
    require_manager(chat_id, user["id"])

    code = secrets.token_urlsafe(8)
    db.execute("UPDATE chats SET invite_code = ? WHERE id = ?", (code, chat_id))
    return {"invite_code": code}


@app.delete("/chats/{chat_id}/invite")
def revoke_invite_link(chat_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])
    db.execute("UPDATE chats SET invite_code = NULL WHERE id = ?", (chat_id,))
    return {"invite_code": None}


@app.get("/invite/{code}")
def preview_invite(code: str, user: dict = Depends(current_user)):
    """What joining this code gets you — shown before actually joining."""
    chat = db.query_one("SELECT * FROM chats WHERE invite_code = ?", (code,))
    if chat is None:
        raise HTTPException(404, "Invalid or expired invite link")

    member_count = db.query_one(
        "SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?", (chat["id"],))["n"]
    return {
        "chat_id": chat["id"], "type": chat["type"], "name": chat["name"],
        "description": chat["description"], "color": chat["color"],
        "avatar_letter": chat["avatar_letter"], "member_count": member_count,
        "already_joined": chatstore.is_member(chat["id"], user["id"]),
    }


@app.post("/invite/{code}/join")
async def join_via_invite(code: str, user: dict = Depends(current_user)):
    chat = db.query_one("SELECT * FROM chats WHERE invite_code = ?", (code,))
    if chat is None:
        raise HTTPException(404, "Invalid or expired invite link")

    role = "subscriber" if chat["type"] == "channel" else "member"
    changed = db.execute(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        (chat["id"], user["id"], role, time.time()),
    )
    if changed.rowcount:
        await hub.send_to_chat(chat["id"], {"type": "members_changed", "chat_id": chat["id"]})
    return {"joined": True, "chat_id": chat["id"]}


# ── Membership management ────────────────────────────────────────────────────
# A group/channel/community's owner or admin can add, remove and promote
# members directly, separate from the self-serve /join and /leave above.

def require_manager(chat_id: str, user_id: str) -> str:
    """Refuse unless the caller runs this chat. Returns their role."""
    role = chatstore.member_role(chat_id, user_id)
    if role not in ("owner", "admin"):
        raise HTTPException(403, "Only the owner or an admin can do this")
    return role


@app.post("/chats/{chat_id}/members")
async def add_members(chat_id: str, request: AddMembersRequest,
                      user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])

    if chat["type"] in ("dm", "saved"):
        raise HTTPException(400, "This chat type has fixed membership")

    if chat["type"] == "group":
        current_count = db.query_one(
            "SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?", (chat_id,))["n"]
        incoming = set(request.user_ids)
        already_in = {
            row["user_id"] for row in db.query_all(
                "SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id IN ({})".format(
                    ",".join("?" for _ in incoming)),
                (chat_id, *incoming),
            )
        } if incoming else set()
        genuinely_new = incoming - already_in
        if current_count + len(genuinely_new) > MAX_GROUP_MEMBERS:
            raise HTTPException(400, f"A group can have at most {MAX_GROUP_MEMBERS} members")

    now = time.time()
    added = []
    for user_id in set(request.user_ids):
        if db.query_one("SELECT 1 FROM users WHERE id = ?", (user_id,)) is None:
            continue
        changed = db.execute(
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) "
            "VALUES (?, ?, 'member', ?)",
            (chat_id, user_id, now),
        )
        if changed.rowcount:
            added.append(user_id)

    if added:
        await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    return {"added": added}


@app.delete("/chats/{chat_id}/members/{target_id}")
async def remove_member(chat_id: str, target_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    caller_role = require_manager(chat_id, user["id"])

    target_role = chatstore.member_role(chat_id, target_id)
    if target_role is None:
        raise HTTPException(404, "Not a member of this chat")

    # The owner can only be removed by leaving — that path also reassigns
    # ownership. Deleting the row here would leave owner_id pointing at nobody.
    if target_role == "owner":
        raise HTTPException(400, "The owner must transfer ownership by leaving, not be removed")

    # An admin cannot remove another admin — only the owner outranks admins.
    # Without this, two admins could take turns removing each other.
    if target_role == "admin" and caller_role != "owner":
        raise HTTPException(403, "Only the owner can remove an admin")

    db.execute("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?", (chat_id, target_id))
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    await hub.send_to_user(target_id, {"type": "removed_from_chat", "chat_id": chat_id})
    return {"removed": True}


@app.patch("/chats/{chat_id}/members/{target_id}")
async def set_member_role(chat_id: str, target_id: str, request: SetRoleRequest,
                          user: dict = Depends(current_user)):
    """Promote a member to admin, or demote an admin back to member."""
    require_member(chat_id, user["id"])

    # Only the owner grants or revokes admin — letting an admin create other
    # admins has no natural stopping point.
    if chatstore.member_role(chat_id, user["id"]) != "owner":
        raise HTTPException(403, "Only the owner can change roles")

    target_role = chatstore.member_role(chat_id, target_id)
    if target_role is None:
        raise HTTPException(404, "Not a member of this chat")
    if target_role == "owner":
        raise HTTPException(400, "The owner's role cannot be changed this way")

    db.execute("UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?",
              (request.role, chat_id, target_id))
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    return {"user_id": target_id, "role": request.role}


@app.patch("/chats/{chat_id}/settings")
def update_chat_settings(chat_id: str, request: ChatSettingsRequest,
                         user: dict = Depends(current_user)):
    """Per-member preferences: pin, folder, mute, draft. Yours alone."""
    require_member(chat_id, user["id"])

    if request.is_pinned:
        already_pinned = db.query_one(
            "SELECT COUNT(*) AS n FROM chat_members WHERE user_id = ? AND is_pinned = 1 AND chat_id != ?",
            (user["id"], chat_id),
        )["n"]
        if already_pinned >= MAX_PINNED_CHATS:
            raise HTTPException(400, f"You can only pin up to {MAX_PINNED_CHATS} chats — unpin one first")

    fields = request.model_dump(exclude_none=True)
    if fields:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        db.execute(
            f"UPDATE chat_members SET {assignments} WHERE chat_id = ? AND user_id = ?",
            (*fields.values(), chat_id, user["id"]),
        )
    row = db.query_one("SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?",
                       (chat_id, user["id"]))
    return dict(row)


@app.post("/chats/{chat_id}/clear")
def clear_chat(chat_id: str, user: dict = Depends(current_user)):
    """Hide the whole history for just this one member — see clear_chat_for_user."""
    require_member(chat_id, user["id"])
    cleared = chatstore.clear_chat_for_user(chat_id, user["id"])
    return {"cleared": cleared}


@app.put("/chats/{chat_id}/vanish-mode")
def set_vanish_mode(chat_id: str, enabled: bool = Query(...), user: dict = Depends(current_user)):
    """
    A one-sided, Instagram-"Vanish mode"-style preference: turning it on
    only changes what happens to messages on the caller's OWN screen (see
    leave_chat_view below) — it is never a shared/mutual chat setting, and
    the other member(s) are not told and are not affected at all.
    """
    require_member(chat_id, user["id"])
    db.execute("UPDATE chat_members SET vanish_mode = ? WHERE chat_id = ? AND user_id = ?",
               (int(enabled), chat_id, user["id"]))
    return {"vanish_mode": enabled}


@app.post("/chats/{chat_id}/leave-view")
def leave_chat_view(chat_id: str, user: dict = Depends(current_user)):
    """
    Called by the client when it navigates away from an open chat screen —
    NOT the same as /chats/{chat_id}/leave, which leaves the conversation
    itself. Harmless no-op unless this member has vanish mode on for this
    chat, so the client can call it unconditionally on every chat-close
    without checking the setting itself first.
    """
    require_member(chat_id, user["id"])
    member = db.query_one(
        "SELECT vanish_mode FROM chat_members WHERE chat_id = ? AND user_id = ?",
        (chat_id, user["id"]),
    )
    if not member or not member["vanish_mode"]:
        return {"vanished": 0}
    vanished = chatstore.vanish_seen_messages_for_user(chat_id, user["id"])
    return {"vanished": vanished}


@app.put("/chats/{chat_id}/slow-mode")
def set_slow_mode(chat_id: str, seconds: int = Query(ge=0, le=3600),
                  user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    if chat["type"] != "group":
        raise HTTPException(400, "Slow mode is only available in groups")
    if chatstore.member_role(chat_id, user["id"]) not in ("owner", "admin"):
        raise HTTPException(403, "Only admins can set slow mode")
    db.execute("UPDATE chats SET slow_mode_secs = ? WHERE id = ?", (seconds, chat_id))
    return {"slow_mode_secs": seconds}


@app.put("/chats/{chat_id}/disappearing")
async def set_disappearing(chat_id: str, request: DisappearingRequest,
                           user: dict = Depends(current_user)):
    """
    Turn the chat-wide disappearing timer on or off.

    Applies to messages sent from now on. Existing messages keep whatever timer
    they were stored with, so switching the setting on cannot retroactively
    destroy history somebody expected to keep.
    """
    require_member(chat_id, user["id"])
    db.execute("UPDATE chats SET disappear_secs = ? WHERE id = ?", (request.seconds, chat_id))

    await hub.send_to_chat(chat_id, {
        "type": "disappearing_changed",
        "chat_id": chat_id,
        "seconds": request.seconds,
        "changed_by": user["id"],
    })
    return {"chat_id": chat_id, "disappear_secs": request.seconds}


@app.post("/chats/{chat_id}/lock")
def lock_chat(chat_id: str, request: SetPinRequest, user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])

    # Without this check, any member could silently overwrite an existing PIN
    # with one of their own choosing — not "set a lock", but "steal a lock",
    # since anyone in the chat could then lock out whoever set it originally.
    # To change a PIN, remove the old one first (which requires knowing it).
    if chat["pin_hash"]:
        raise HTTPException(400, "This chat is already locked. Remove the lock first to change the PIN.")

    db.execute("UPDATE chats SET pin_hash = ? WHERE id = ?",
               (auth.hash_password(request.pin), chat_id))
    return {"locked": True}


@app.post("/chats/{chat_id}/unlock")
def unlock_chat(chat_id: str, request: SetPinRequest, user: dict = Depends(current_user)):
    """
    Verify a PIN to view a locked chat this session.

    Deliberately does not change anything server-side — the chat stays locked
    for next time. This is "prove you know the PIN right now", not "turn the
    lock off"; that is DELETE below, which requires the same proof.
    """
    chat = require_member(chat_id, user["id"])
    if not chat["pin_hash"]:
        raise HTTPException(400, "This chat is not locked")
    if not auth.verify_password(request.pin, chat["pin_hash"]):
        raise HTTPException(401, "Wrong PIN")
    return {"unlocked": True}


@app.delete("/chats/{chat_id}/lock")
def remove_chat_lock(chat_id: str, request: SetPinRequest, user: dict = Depends(current_user)):
    """Turn the lock off. Requires the current PIN — same proof as unlocking."""
    chat = require_member(chat_id, user["id"])
    if not chat["pin_hash"]:
        raise HTTPException(400, "This chat is not locked")
    if not auth.verify_password(request.pin, chat["pin_hash"]):
        raise HTTPException(401, "Wrong PIN")

    db.execute("UPDATE chats SET pin_hash = NULL WHERE id = ?", (chat_id,))
    return {"locked": False}


def consume_view_once_text_messages(chat_id: str, reader_id: str, up_to_seq: int) -> list[dict]:
    """
    View-once TEXT messages have no separate "open" request the way a
    view-once photo does (see download_file) — there's no file to fetch, so
    there's nothing to tap. The recipient actually reading it — marking it
    read — IS the view, so that's what stamps view_once_opened_at here.
    Scoped to `kind = 'text'` and messages with no attachment_id: a
    view-once PHOTO/video keeps using its existing tap-to-open flow even
    though it's the same view_once column, so this must not double-consume it.
    """
    rows = db.query_all(
        """
        SELECT id FROM messages
        WHERE chat_id = ? AND seq <= ? AND sender_id != ? AND kind = 'text'
          AND view_once = 1 AND view_once_opened_at IS NULL
          AND deleted_at IS NULL AND unsent_at IS NULL
        """,
        (chat_id, up_to_seq, reader_id),
    )
    consumed = []
    for row in rows:
        claimed = db.execute(
            "UPDATE messages SET view_once_opened_at = ? WHERE id = ? AND view_once_opened_at IS NULL",
            (time.time(), row["id"]),
        )
        if claimed.rowcount:
            consumed.append(chatstore.serialise_message(
                db.query_one("SELECT * FROM messages WHERE id = ?", (row["id"],)), reader_id))
    return consumed


@app.post("/chats/{chat_id}/read")
async def mark_read(chat_id: str, request: ReadRequest, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    chatstore.set_last_read(chat_id, user["id"], request.seq)

    # Fire before the read receipt: a message that's about to be reported as
    # read should already be blanked by the time anyone hears about it.
    # "message_edited" (not a new event type) — the frontend already
    # handles it generically as "replace this message by id," which is
    # exactly what a freshly-blanked view-once text needs.
    consumed = consume_view_once_text_messages(chat_id, user["id"], request.seq)
    for message in consumed:
        await hub.send_to_chat(chat_id, {"type": "message_edited", "message": message})

    # Only tell the room if this user allows read receipts. WhatsApp's rule:
    # switching them off means you stop sending them.
    if user.get("show_read_receipts"):
        await hub.send_to_chat(chat_id, {
            "type": "read",
            "chat_id": chat_id,
            "user_id": user["id"],
            "seq": request.seq,
        }, exclude_user=user["id"])

    return {"chat_id": chat_id, "last_read_seq": request.seq}


@app.get("/chats/{chat_id}/read-state")
def get_read_state(chat_id: str, user: dict = Depends(current_user)):
    """
    How far every other member has read.

    Used to draw a single vs double checkmark on your own messages: a message
    is "read" once every other member's last_read_seq is at or past it. A
    member who has switched read receipts off is left out entirely, the same
    as their read event never being broadcast in the first place — turning
    receipts off has to actually withhold the information, not just skip the
    notification.
    """
    require_member(chat_id, user["id"])
    rows = db.query_all(
        """
        SELECT m.user_id, m.last_read_seq FROM chat_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.chat_id = ? AND m.user_id != ? AND u.show_read_receipts = 1
        """,
        (chat_id, user["id"]),
    )
    return [dict(row) for row in rows]


# ── Messages ──────────────────────────────────────────────────────────────────

@app.get("/chats/{chat_id}/messages")
def list_messages(chat_id: str,
                  limit: int = Query(default=50, ge=1, le=200),
                  before_seq: int | None = None,
                  after_seq: int | None = None,
                  user: dict = Depends(current_user)):
    """
    A page of a chat.

    Pass after_seq to catch up after a reconnect: the client sends the highest
    sequence number it holds and receives only what came later.
    """
    require_member(chat_id, user["id"])
    return chatstore.load_messages(chat_id, user["id"], limit, before_seq, after_seq)


@app.post("/messages")
async def send_message(
    request: SendMessageRequest, background_tasks: BackgroundTasks, user: dict = Depends(current_user)
):
    message_rate_limiter.check(user["id"])
    chat = require_member(request.chat_id, user["id"])

    # In a channel, only the people who run it may post. Everyone else is an
    # audience. The old code checked this for channels and not for anything else.
    # A community's own root chat gets the same rule as a channel — it's the
    # community-wide announcement space, matching real WhatsApp Communities
    # (general discussion happens in sub-channels, which are ordinary chats
    # with their own type and are NOT restricted here).
    if chat["type"] in ("channel", "community"):
        if chatstore.member_role(request.chat_id, user["id"]) not in ("owner", "admin"):
            noun = "channel" if chat["type"] == "channel" else "community"
            raise HTTPException(403, f"Only {noun} admins can post")
    elif chat["type"] == "broadcast":
        # Nobody but the owner is ever a chat_member of a broadcast list (see
        # broadcast_recipients' table comment), so in practice only the owner
        # could reach this far anyway — checked explicitly for a clear error.
        if chat["owner_id"] != user["id"]:
            raise HTTPException(403, "Only the owner can send to this broadcast list")

    # Slow mode: non-admin members must wait between sends.
    slow = chat["slow_mode_secs"] if "slow_mode_secs" in chat.keys() else 0
    if slow and chat["type"] == "group" \
            and chatstore.member_role(request.chat_id, user["id"]) not in ("owner", "admin"):
        last_msg = db.query_one(
            "SELECT created_at FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY seq DESC LIMIT 1",
            (request.chat_id, user["id"]),
        )
        if last_msg and time.time() - last_msg["created_at"] < slow:
            wait = int(slow - (time.time() - last_msg["created_at"]))
            raise HTTPException(429, f"Slow mode is on. Wait {wait}s before sending again.")

    # Blocking was previously checked only when a DM was first created, so it
    # stopped nobody: an existing conversation kept working after a block.
    if chat["type"] == "dm":
        peer_id = dm_peer_id(request.chat_id, user["id"])
        if peer_id and blocked_between(user["id"], peer_id):
            raise HTTPException(403, "You cannot send messages in this chat")

    payload = dict(request.payload or {})
    if request.kind == "poll":
        if not request.poll_options or len(request.poll_options) < 2:
            raise HTTPException(400, "A poll needs at least two options")
        payload["options"] = [{"text": option, "votes": 0} for option in request.poll_options]
    elif request.kind == "location":
        lat, lng = payload.get("lat"), payload.get("lng")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            raise HTTPException(400, "A location needs numeric lat and lng")
        if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            raise HTTPException(400, "Coordinates out of range")
        # Optional: a live location keeps updating until this moment, via
        # PUT /messages/{id}/location below. Absent entirely for an ordinary
        # one-time location snapshot.
        live_until = payload.get("live_until")
        if live_until is not None:
            if not isinstance(live_until, (int, float)):
                raise HTTPException(400, "live_until must be a timestamp")
            max_live_until = time.time() + LIVE_LOCATION_MAX_SECONDS
            if live_until > max_live_until:
                raise HTTPException(400, "Live location cannot run longer than 8 hours")
    elif request.kind == "contact":
        name, phone = payload.get("name"), payload.get("phone")
        if not isinstance(name, str) or not name.strip() or not isinstance(phone, str) or not phone.strip():
            raise HTTPException(400, "A contact needs a name and phone number")
        payload["name"], payload["phone"] = name.strip(), phone.strip()
    elif request.kind == "call":
        # The call itself already happened by the time this is posted — this
        # is only the log entry, written by the caller's client once the call
        # resolves (answered, declined, went unanswered, or ran and ended).
        if payload.get("call_kind") not in ("voice", "video"):
            raise HTTPException(400, "A call log needs call_kind: voice or video")
        if payload.get("status") not in ("completed", "declined", "unanswered", "busy"):
            raise HTTPException(400, "A call log needs a valid status")
        duration = payload.get("duration_secs", 0)
        if not isinstance(duration, (int, float)) or duration < 0:
            raise HTTPException(400, "duration_secs must be a non-negative number")
        payload["duration_secs"] = int(duration)
    elif request.kind == "sticker":
        sticker_id = payload.get("sticker_id")
        if not isinstance(sticker_id, str) or not sticker_id.strip():
            raise HTTPException(400, "A sticker needs a sticker_id")

    # An attachment is checked before the message is written, so a bad id fails
    # the send outright instead of leaving a message pointing at nothing.
    attachment_id = payload.get("attachment_id")
    if attachment_id:
        pending = db.query_one(
            "SELECT * FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
            (attachment_id, user["id"]),
        )
        if pending is None:
            raise HTTPException(400, "Unknown attachment, or it has already been sent")

    if not request.text and not payload:
        raise HTTPException(400, "Message is empty")

    # The FK on messages.reply_to_id only proves the id exists SOMEWHERE in
    # the table — it says nothing about which chat that message belongs to.
    # Without this check, anyone who knows (or enumerates) a message id from
    # a chat they're not in could set it as reply_to_id here and produce a
    # message that semantically points across chat boundaries.
    if request.reply_to_id:
        target = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (request.reply_to_id,))
        if target is None or target["chat_id"] != request.chat_id:
            raise HTTPException(400, "reply_to_id must be a message in this chat")

    message, created = chatstore.insert_message(
        chat_id=request.chat_id,
        sender_id=user["id"],
        text=request.text,
        kind=request.kind,
        payload=payload or None,
        reply_to_id=request.reply_to_id,
        client_msg_id=request.client_msg_id,
        disappear_secs=request.disappear_secs,
        view_once=request.view_once,
        silent=request.silent,
    )

    # Bind the file to the message now that the message exists. Only on `created`
    # — a retry must not try to re-attach something already attached, and the
    # first attempt already did it.
    if attachment_id and created:
        uploads.attach_to_message(attachment_id, message["id"], user["id"])
        message = chatstore.serialise_message(
            db.query_one("SELECT * FROM messages WHERE id = ?", (message["id"],)), user["id"])

    # `created` is False when this was a retry of something already stored. The
    # message is returned either way, but re-broadcasting would show it twice to
    # everyone else in the room.
    if created:
        await hub.send_to_chat(request.chat_id, {"type": "message", "message": message})

        # A new message un-archives the conversation for everyone it lands in
        # front of — same as WhatsApp, an archive means "not right now," not
        # "never surface this again." The sender's own copy is untouched;
        # archiving your own active conversation isn't something this does.
        db.execute(
            "UPDATE chat_members SET archived = 0 WHERE chat_id = ? AND user_id != ? AND archived = 1",
            (request.chat_id, user["id"]),
        )

        await notify_offline_members(
            request.chat_id, user["id"], user["name"],
            push_preview_text(request.kind, request.text, payload),
        )

        await dispatch_webhooks(background_tasks, request.chat_id, user["id"], message)

        if chat["type"] == "dm":
            await maybe_send_away_reply(background_tasks, request.chat_id, user["id"])

        if chat["type"] == "broadcast":
            await fan_out_broadcast(chat, user, request.text, request.kind, payload)

    return message


async def fan_out_broadcast(chat: dict, sender: dict, text: str, kind: str, payload: dict | None):
    """
    Deliver a broadcast message as an individual copy in each recipient's own
    DM with the sender — same deterministic-id DM lookup/creation used by the
    interactive create_dm and the bulk messaging API, so a reply lands in the
    exact ordinary conversation the recipient already has (or would get) with
    the sender, not a separate broadcast-only inbox. Recipients never see each
    other or the recipient list — each fan-out is entirely independent.
    """
    original_attachment_id = (payload or {}).get("attachment_id")
    recipients = db.query_all(
        "SELECT user_id FROM broadcast_recipients WHERE chat_id = ?", (chat["id"],))

    for row in recipients:
        recipient_id = row["user_id"]
        if blocked_between(sender["id"], recipient_id):
            continue

        low, high = sorted([sender["id"], recipient_id])
        dm_chat_id = f"dm_{low}_{high}"
        existing = db.query_one("SELECT 1 FROM chats WHERE id = ?", (dm_chat_id,))
        if existing is None:
            now = time.time()
            with db.transaction() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO chats (id, type, name, color, avatar_letter, created_at) "
                    "VALUES (?, 'dm', '', ?, ?, ?)",
                    (dm_chat_id, sender["color"], sender["avatar_letter"], now),
                )
                for member_id in (sender["id"], recipient_id):
                    conn.execute(
                        "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) "
                        "VALUES (?, ?, 'member', ?)",
                        (dm_chat_id, member_id, now),
                    )

        recipient_payload = dict(payload or {})
        recipient_payload["via_broadcast"] = chat["name"]
        if original_attachment_id:
            recipient_payload.pop("attachment_id", None)  # filled in below, after the message exists

        fan_message, fan_created = chatstore.insert_message(
            chat_id=dm_chat_id, sender_id=sender["id"], text=text, kind=kind,
            payload=recipient_payload or None,
            client_msg_id=f"bc_{chat['id']}_{recipient_id}",
        )
        if not fan_created:
            continue  # already delivered — a retried client send must not double up

        if original_attachment_id:
            new_attachment_id = uploads.duplicate_for_message(original_attachment_id, fan_message["id"])
            if new_attachment_id:
                recipient_payload["attachment_id"] = new_attachment_id
                db.execute("UPDATE messages SET payload = ? WHERE id = ?",
                          (json.dumps(recipient_payload), fan_message["id"]))
                fan_message = chatstore.serialise_message(
                    db.query_one("SELECT * FROM messages WHERE id = ?", (fan_message["id"],)), sender["id"])

        await hub.send_to_chat(dm_chat_id, {"type": "message", "message": fan_message})
        db.execute(
            "UPDATE chat_members SET archived = 0 WHERE chat_id = ? AND user_id != ? AND archived = 1",
            (dm_chat_id, sender["id"]),
        )
        await notify_offline_members(
            dm_chat_id, sender["id"], sender["name"], push_preview_text(kind, text, recipient_payload))


@app.patch("/messages/{message_id}")
async def edit_message(message_id: str, request: EditMessageRequest,
                       user: dict = Depends(current_user)):
    message = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    if message["sender_id"] != user["id"]:
        raise HTTPException(403, "You can only edit your own messages")
    if message["deleted_at"]:
        raise HTTPException(400, "This message was deleted")

    db.execute("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?",
               (request.text, time.time(), message_id))

    updated = chatstore.serialise_message(
        db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,)), user["id"])
    await hub.send_to_chat(message["chat_id"], {"type": "message_edited", "message": updated})
    return updated


@app.put("/messages/{message_id}/location")
async def update_live_location(message_id: str, request: LiveLocationUpdateRequest,
                               user: dict = Depends(current_user)):
    """
    A tick of a live-shared location — only valid while `live_until` is still
    ahead of now, and only from the person who started sharing it. Once the
    window closes the location message just sits there as a final position,
    same as WhatsApp's live location freezing when the timer runs out.
    """
    message = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    if message["sender_id"] != user["id"]:
        raise HTTPException(403, "You can only update your own live location")
    if message["kind"] != "location":
        raise HTTPException(400, "Not a location message")

    payload = json.loads(message["payload"] or "{}")
    live_until = payload.get("live_until")
    if not live_until or live_until <= time.time():
        raise HTTPException(400, "This live location has ended")

    payload["lat"], payload["lng"] = request.lat, request.lng
    db.execute("UPDATE messages SET payload = ? WHERE id = ?",
              (json.dumps(payload), message_id))

    updated = chatstore.serialise_message(
        db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,)), user["id"])
    await hub.send_to_chat(message["chat_id"], {"type": "message_edited", "message": updated})
    return updated


@app.post("/messages/{message_id}/location/stop")
async def stop_live_location(message_id: str, user: dict = Depends(current_user)):
    """
    End a live location share early, same as WhatsApp's own "Stop sharing."
    Only the sender can stop it; the location freezes at its last reported
    position rather than disappearing, exactly like letting the timer expire
    naturally — this is just that same ending, triggered on purpose instead
    of by the clock.
    """
    message = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])
    if message["sender_id"] != user["id"]:
        raise HTTPException(403, "You can only stop your own live location")
    if message["kind"] != "location":
        raise HTTPException(400, "Not a location message")

    payload = json.loads(message["payload"] or "{}")
    if not payload.get("live_until") or payload["live_until"] <= time.time():
        raise HTTPException(400, "This live location has already ended")

    payload["live_until"] = time.time()
    db.execute("UPDATE messages SET payload = ? WHERE id = ?", (json.dumps(payload), message_id))

    updated = chatstore.serialise_message(
        db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,)), user["id"])
    await hub.send_to_chat(message["chat_id"], {"type": "message_edited", "message": updated})
    return updated


@app.get("/me/live-locations")
def list_live_locations(user: dict = Depends(current_user)):
    """
    Every live location currently active in a chat you're a member of —
    both ones you're sharing and ones being shared with you — gathered into
    one list. Reading these out of `payload` rather than a dedicated column
    is the same tradeoff `list_calls` already makes for call messages: one
    more purpose-built table for something this small isn't worth it.
    """
    rows = db.query_all(
        """
        SELECT m.*, c.type AS chat_type, c.name AS chat_name,
               c.avatar_letter AS chat_avatar_letter, c.color AS chat_color
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
        WHERE m.kind = 'location' AND m.deleted_at IS NULL AND m.unsent_at IS NULL
          AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
        ORDER BY m.created_at DESC
        """,
        (user["id"], user["id"]),
    )

    shares = []
    for row in rows:
        payload = json.loads(row["payload"] or "{}")
        live_until = payload.get("live_until")
        if not live_until or live_until <= time.time():
            continue
        share = chatstore.serialise_message(row, user["id"])
        share["chat_type"] = row["chat_type"]
        if row["chat_type"] == "dm":
            peer_id = dm_peer_id(row["chat_id"], user["id"])
            peer = db.query_one("SELECT id, name, avatar_letter, color FROM users WHERE id = ?",
                                (peer_id,)) if peer_id else None
            share["chat_name"] = peer["name"] if peer else "Direct message"
            share["chat_avatar_letter"] = peer["avatar_letter"] if peer else "?"
            share["chat_color"] = peer["color"] if peer else "#6366f1"
        else:
            share["chat_name"] = row["chat_name"]
            share["chat_avatar_letter"] = row["chat_avatar_letter"]
            share["chat_color"] = row["chat_color"]
            if row["sender_id"] != user["id"]:
                # In a group, "who" is sharing matters as much as "where" —
                # a DM only ever has one possible answer, so this is skipped
                # there.
                sender = db.query_one("SELECT name FROM users WHERE id = ?", (row["sender_id"],))
                share["sender_name"] = sender["name"] if sender else "Someone"
        share["is_mine"] = row["sender_id"] == user["id"]
        shares.append(share)
    return shares


@app.delete("/messages/{message_id}")
async def delete_message(message_id: str, mode: str = Query(default="everyone"),
                         user: dict = Depends(current_user)):
    """
    Three genuinely different actions live behind this one route:

      unsend    Only the sender, on their own message. No tombstone at all —
                the message vanishes for literally everyone, sender included,
                as if it had never been sent. (Delete-for-me, the fourth
                option, is a completely separate endpoint: POST .../hide.)
      everyone  The sender OR a moderator (owner/admin) removing a message —
                leaves "This message was deleted" behind. For a moderator
                acting on someone else's message this is the ONLY option:
                accountability requires the removal to be visible, not a
                moderator silently disappearing what someone else wrote.
    """
    if mode not in ("unsend", "everyone"):
        raise HTTPException(400, "mode must be 'unsend' or 'everyone'")

    message = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    chat = require_member(message["chat_id"], user["id"])

    is_own = message["sender_id"] == user["id"]
    is_moderator = chatstore.member_role(message["chat_id"], user["id"]) in ("owner", "admin")
    if not is_own and not is_moderator:
        raise HTTPException(403, "You can only delete your own messages")
    if mode == "unsend" and not is_own:
        raise HTTPException(403, "Only the sender can unsend a message")

    # The row survives with its text cleared either way. Removing it would
    # leave a hole in the sequence, and a client catching up cannot tell a
    # hole from a message that failed to arrive.
    # The file goes with the message. Leaving it on disk would keep a deleted
    # photo downloadable to anyone who had noted its id.
    chatstore.drop_attachments_for(message_id)

    if mode == "unsend":
        db.execute(
            "UPDATE messages SET unsent_at = ?, text = '', payload = NULL WHERE id = ?",
            (time.time(), message_id),
        )
        # No broadcast payload beyond "this id is gone" — recipients' clients
        # just drop it from their view, with no tombstone rendered in its
        # place, same as the row never having existed.
        await hub.send_to_chat(message["chat_id"], {
            "type": "message_unsent",
            "chat_id": message["chat_id"],
            "message_id": message_id,
        })
    else:
        db.execute(
            "UPDATE messages SET deleted_at = ?, text = '', payload = NULL WHERE id = ?",
            (time.time(), message_id),
        )
        await hub.send_to_chat(message["chat_id"], {
            "type": "message_deleted",
            "chat_id": message["chat_id"],
            "message_id": message_id,
        })
    return {"deleted": True, "mode": mode}


@app.post("/messages/{message_id}/hide")
def hide_message(message_id: str, user: dict = Depends(current_user)):
    """
    "Delete for me" — anyone in the chat can hide any message from their own
    view. Unlike DELETE above, nothing is broadcast: this is invisible to
    everyone else, on purpose. It touches no shared state, so there is nothing
    to authorise beyond being a member of the chat.
    """
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    chatstore.hide_for_user(message_id, user["id"])
    return {"hidden": True}


@app.post("/messages/{message_id}/reactions")
async def add_reaction(message_id: str, request: ReactRequest,
                       user: dict = Depends(current_user)):
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    db.execute(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
        (message_id, user["id"], request.emoji, time.time()),
    )
    reactions = chatstore.reactions_for(message_id, user["id"])
    await hub.send_to_chat(message["chat_id"], {
        "type": "reaction",
        "chat_id": message["chat_id"],
        "message_id": message_id,
        "reactions": chatstore.reactions_for(message_id),
    })
    return reactions


@app.delete("/messages/{message_id}/reactions")
async def remove_reaction(message_id: str, emoji: str = Query(min_length=1, max_length=16),
                          user: dict = Depends(current_user)):
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    db.execute(
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
        (message_id, user["id"], emoji),
    )
    reactions = chatstore.reactions_for(message_id, user["id"])
    await hub.send_to_chat(message["chat_id"], {
        "type": "reaction",
        "chat_id": message["chat_id"],
        "message_id": message_id,
        "reactions": chatstore.reactions_for(message_id),
    })
    return reactions


@app.get("/messages/{message_id}/reactions")
def get_reaction_details(message_id: str, user: dict = Depends(current_user)):
    message = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])
    rows = db.query_all(
        """
        SELECT r.emoji, r.created_at, u.id AS user_id, u.name, u.avatar_letter, u.color
        FROM reactions r JOIN users u ON u.id = r.user_id
        WHERE r.message_id = ?
        ORDER BY r.created_at
        """,
        (message_id,),
    )
    return [dict(row) for row in rows]


@app.post("/messages/{message_id}/vote")
async def vote(message_id: str, request: VoteRequest, user: dict = Depends(current_user)):
    message = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if message is None or message["kind"] != "poll":
        raise HTTPException(404, "Poll not found")
    require_member(message["chat_id"], user["id"])

    payload = json.loads(message["payload"] or "{}")
    options = payload.get("options", [])
    if not 0 <= request.option_index < len(options):
        raise HTTPException(400, "No such option")

    # The primary key on (message_id, user_id) is what actually enforces one
    # vote each. Two simultaneous requests cannot both pass a check-then-write.
    try:
        db.execute(
            "INSERT INTO poll_votes (message_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)",
            (message_id, user["id"], request.option_index, time.time()),
        )
    except sqlite3.IntegrityError:
        # Only the primary key can be violated here. Catching bare Exception
        # would report a disk error or a locked database as "already voted".
        raise HTTPException(400, "You have already voted in this poll")

    # Recount from the votes table rather than incrementing a stored number, so
    # the tally cannot drift away from the rows that justify it.
    for index, option in enumerate(options):
        row = db.query_one(
            "SELECT COUNT(*) AS total FROM poll_votes WHERE message_id = ? AND option_index = ?",
            (message_id, index),
        )
        option["votes"] = row["total"]

    payload["options"] = options
    db.execute("UPDATE messages SET payload = ? WHERE id = ?",
               (json.dumps(payload), message_id))

    updated = chatstore.serialise_message(
        db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,)), user["id"])
    await hub.send_to_chat(message["chat_id"], {"type": "poll_updated", "message": updated})
    return updated


@app.post("/uploads")
async def upload_file(file: UploadFile = File(...), user: dict = Depends(current_user)):
    """
    Upload a file and get back an id to send with a message.

    Two steps on purpose: the file lands first, then a message references it.
    Sending them together would mean a failed send loses the upload and a slow
    upload blocks the message, and it would make retrying a send re-transmit the
    whole file.
    """
    try:
        attachment = await uploads.store(file, user["id"])
    except uploads.UploadTooLarge as error:
        raise HTTPException(413, str(error))
    except uploads.UploadTypeRefused as error:
        raise HTTPException(415, str(error))

    return uploads.describe(attachment["id"])


@app.get("/uploads/{attachment_id}")
def download_file(attachment_id: str, user: dict = Depends(current_user)):
    """
    Serve an attachment, if this user is allowed to see it.

    A random id is not access control. Permission comes from the chat the file
    was sent to, exactly like the message that carries it.
    """
    row = db.query_one("SELECT * FROM attachments WHERE id = ?", (attachment_id,))
    if row is None:
        raise HTTPException(404, "File not found")

    attachment = dict(row)

    if attachment["message_id"]:
        message = db.query_one("SELECT * FROM messages WHERE id = ?",
                               (attachment["message_id"],))
        # 404 rather than 403 throughout: a 403 would confirm the file exists to
        # somebody with no right to know that.
        if message is None or not chatstore.is_member(message["chat_id"], user["id"]):
            raise HTTPException(404, "File not found")

        # View-once: the bytes are handed out exactly once, to whoever asks for
        # them first (in a DM that's always the recipient — the sender never
        # gets a second look either). This request IS the reveal, so the gate
        # lives here rather than a separate "open" call the client could skip.
        if message["view_once"]:
            if message["sender_id"] == user["id"]:
                raise HTTPException(403, "You cannot reopen a view-once file you sent")
            # Claim the "opened" stamp atomically in the UPDATE itself rather
            # than checking view_once_opened_at with a separate SELECT first
            # — two near-simultaneous requests (two tabs/devices, or a
            # retried request) could otherwise both read it as NULL and both
            # walk away with the file. Only whichever request's UPDATE
            # actually changes a row wins the race; the other sees rowcount
            # 0 and is told it's already been opened, same as a genuine
            # second request would be.
            claimed = db.execute(
                "UPDATE messages SET view_once_opened_at = ? WHERE id = ? AND view_once_opened_at IS NULL",
                (time.time(), message["id"]),
            )
            if claimed.rowcount == 0:
                raise HTTPException(410, "This has already been opened")
    elif attachment["story_id"]:
        story = db.query_one(
            "SELECT s.user_id, s.status, u.story_audience FROM stories AS s "
            "JOIN users AS u ON u.id = s.user_id WHERE s.id = ?",
            (attachment["story_id"],),
        )
        # Same audience /stories itself uses: the author, or anyone who shares
        # a chat with them (and passes their audience mode) — and only once
        # the status has actually gone live, exactly like a scheduled
        # status's text is withheld until then.
        is_author = story is not None and story["user_id"] == user["id"]
        visible = (
            story is not None and story["status"] == "live"
            and chatstore.shares_chat_with(user["id"], story["user_id"])
            and _story_audience_allows(story["user_id"], story["story_audience"], user["id"])
        )
        if story is None or not (is_author or visible):
            raise HTTPException(404, "File not found")
    elif attachment["avatar_of_user_id"]:
        # A profile photo is meant to be visible to anyone in the app who can
        # see the profile at all — unlike a chat/story attachment there is no
        # membership or contact check, just "signed in." current_user() above
        # already established that.
        pass
    elif attachment["uploader_id"] != user["id"]:
        # Not yet sent, so only the person who uploaded it can see it.
        raise HTTPException(404, "File not found")

    path = uploads.path_for(attachment_id)
    if not os.path.exists(path):
        raise HTTPException(404, "File is no longer available")

    inline = attachment["content_type"] in uploads.INLINE_TYPES
    disposition = "inline" if inline else "attachment"

    return FileResponse(
        path,
        media_type=attachment["content_type"],
        headers={
            # The filename is quoted and already stripped of quotes and
            # separators, so it cannot break out of the header.
            "Content-Disposition": f'{disposition}; filename="{attachment["file_name"]}"',
            # Without this a browser may sniff the bytes, decide a file we
            # labelled as an image is really HTML, and run it.
            "X-Content-Type-Options": "nosniff",
            # `immutable, max-age=1y` was tried here and is WRONG for an
            # authorised endpoint: a long-lived cache entry is keyed by URL
            # only, not by the Authorization header, so a browser serves it
            # straight off disk to the NEXT logged-in account on the same
            # device — verified live: user B fetched user A's private photo
            # and it never reached the server at all (nothing in the access
            # log for that request). `no-cache` still lets the browser keep
            # the bytes on disk, but forces a revalidation request to this
            # same handler every time, which means the membership check above
            # always runs. Every access is re-authorised; nothing is served
            # for free out of a shared browser cache.
            "Cache-Control": "private, no-cache",
        },
    )


@app.post("/messages/{message_id}/pin")
async def pin_message(message_id: str, user: dict = Depends(current_user)):
    """
    Pin a message to the top of a chat.

    The `pinned_messages` table existed from the start but nothing ever wrote to
    it, so pinning was a menu item that did nothing.
    """
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    db.execute(
        "INSERT OR IGNORE INTO pinned_messages (chat_id, message_id, pinned_by, pinned_at) "
        "VALUES (?, ?, ?, ?)",
        (message["chat_id"], message_id, user["id"], time.time()),
    )
    await hub.send_to_chat(message["chat_id"], {
        "type": "pins_changed", "chat_id": message["chat_id"],
    })
    return {"pinned": True}


@app.delete("/messages/{message_id}/pin")
async def unpin_message(message_id: str, user: dict = Depends(current_user)):
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    db.execute("DELETE FROM pinned_messages WHERE message_id = ?", (message_id,))
    await hub.send_to_chat(message["chat_id"], {
        "type": "pins_changed", "chat_id": message["chat_id"],
    })
    return {"pinned": False}


@app.post("/messages/{message_id}/star")
def star_message(message_id: str, user: dict = Depends(current_user)):
    """
    A personal bookmark, distinct from a chat pin: only you can see what you
    starred, on any message in any chat you belong to, and it never appears
    to anyone else — unlike a pin, which the whole chat sees.
    """
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    db.execute(
        "INSERT OR IGNORE INTO message_stars (message_id, user_id, starred_at) VALUES (?, ?, ?)",
        (message_id, user["id"], time.time()),
    )
    return {"starred": True}


@app.delete("/messages/{message_id}/star")
def unstar_message(message_id: str, user: dict = Depends(current_user)):
    db.execute("DELETE FROM message_stars WHERE message_id = ? AND user_id = ?",
              (message_id, user["id"]))
    return {"starred": False}


@app.get("/me/starred")
def list_starred(user: dict = Depends(current_user),
                  limit: int = Query(default=500, ge=1, le=1000),
                  offset: int = Query(default=0, ge=0)):
    """Every message you have starred, across every chat, newest first."""
    rows = db.query_all(
        """
        SELECT m.*, s.starred_at, c.name AS chat_name, c.type AS chat_type
        FROM message_stars AS s
        JOIN messages AS m ON m.id = s.message_id
        JOIN chats AS c ON c.id = m.chat_id
        WHERE s.user_id = ? AND m.deleted_at IS NULL AND m.unsent_at IS NULL
          AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
        ORDER BY s.starred_at DESC
        LIMIT ? OFFSET ?
        """,
        (user["id"], user["id"], limit, offset),
    )

    # A DM stores no name of its own — the chat list resolves this the same
    # way, and a starred message needs the same fix or every starred DM
    # message would show a blank chat name instead of the actual person.
    dm_chat_ids = {row["chat_id"] for row in rows if row["chat_type"] == "dm"}
    peer_names = {}
    if dm_chat_ids:
        placeholders = ",".join("?" for _ in dm_chat_ids)
        peer_rows = db.query_all(
            f"""
            SELECT cm.chat_id, u.name FROM chat_members AS cm
            JOIN users AS u ON u.id = cm.user_id
            WHERE cm.chat_id IN ({placeholders}) AND cm.user_id != ?
            """,
            (*dm_chat_ids, user["id"]),
        )
        peer_names = {row["chat_id"]: row["name"] for row in peer_rows}

    reactions = chatstore.reactions_for_many([row["id"] for row in rows], user["id"])
    results = []
    for row in rows:
        message = chatstore.serialise_message(row, user["id"], reactions.get(row["id"], []))
        message["starred_at"] = row["starred_at"]
        message["chat_name"] = peer_names.get(row["chat_id"], row["chat_name"])
        results.append(message)
    return results


@app.get("/chats/{chat_id}/pins")
def list_pins(chat_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    rows = db.query_all(
        """
        SELECT m.* FROM pinned_messages AS p
        JOIN messages AS m ON m.id = p.message_id
        WHERE p.chat_id = ? AND m.deleted_at IS NULL AND m.unsent_at IS NULL
          AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
        ORDER BY p.pinned_at DESC
        """,
        (chat_id, user["id"]),
    )
    reactions = chatstore.reactions_for_many([row["id"] for row in rows], user["id"])
    return [
        chatstore.serialise_message(row, user["id"], reactions.get(row["id"], []))
        for row in rows
    ]


@app.get("/me/storage")
def storage_usage(user: dict = Depends(current_user)):
    """
    How much space this account's media is taking up, per chat.

    Only counts attachments actually attached to a sent message (message_id
    IS NOT NULL) — an upload that was never sent isn't "your data" in any
    sense a user would recognise, and the scheduler already sweeps those.
    """
    rows = db.query_all(
        """
        SELECT c.id AS chat_id, c.name AS chat_name, c.type AS chat_type,
               c.avatar_letter, c.color,
               COUNT(a.id) AS file_count, COALESCE(SUM(a.size_bytes), 0) AS total_bytes
        FROM chat_members AS cm
        JOIN chats AS c ON c.id = cm.chat_id
        JOIN messages AS m ON m.chat_id = c.id AND m.deleted_at IS NULL
        JOIN attachments AS a ON a.message_id = m.id
        WHERE cm.user_id = ?
        GROUP BY c.id
        HAVING total_bytes > 0
        ORDER BY total_bytes DESC
        """,
        (user["id"],),
    )
    chats = [dict(row) for row in rows]
    for chat in chats:
        if chat["chat_type"] == "dm":
            peer_id = dm_peer_id(chat["chat_id"], user["id"])
            peer = db.query_one("SELECT name FROM users WHERE id = ?", (peer_id,)) if peer_id else None
            chat["chat_name"] = peer["name"] if peer else "Direct message"
    return {
        "total_bytes": sum(c["total_bytes"] for c in chats),
        "total_files": sum(c["file_count"] for c in chats),
        "chats": chats,
    }


@app.get("/chats/{chat_id}/media")
def list_media(chat_id: str, user: dict = Depends(current_user)):
    """Every photo, video and document shared in this chat, newest first."""
    require_member(chat_id, user["id"])
    rows = db.query_all(
        """
        SELECT m.* FROM messages AS m
        WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.unsent_at IS NULL
          AND m.kind IN ('photo', 'video', 'document')
          AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
        ORDER BY m.seq DESC
        """,
        (chat_id, user["id"]),
    )
    return [chatstore.serialise_message(row, user["id"]) for row in rows]


@app.post("/messages/{message_id}/view")
def record_view(message_id: str, user: dict = Depends(current_user)):
    """
    Count a view on a channel post.

    `view_count` was on the messages table from the start and nothing ever
    incremented it, so every channel post read "0 views" forever.
    """
    message = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if message is None:
        raise HTTPException(404, "Message not found")
    require_member(message["chat_id"], user["id"])

    db.execute("UPDATE messages SET view_count = view_count + 1 WHERE id = ?", (message_id,))
    row = db.query_one("SELECT view_count FROM messages WHERE id = ?", (message_id,))
    return {"views": row["view_count"]}


@app.post("/messages/forward")
async def forward_message(request: ForwardRequest, user: dict = Depends(current_user)):
    original = db.query_one("SELECT * FROM messages WHERE id = ?", (request.message_id,))
    if original is None:
        raise HTTPException(404, "Message not found")
    if original["deleted_at"]:
        # A deleted message's text/payload are already blanked at the row
        # level (see the disappearing-message sweep and unsend/delete-for-
        # everyone handlers) — forwarding it without this check would
        # silently produce an empty message with a forwarded_from label and
        # nothing else, rather than a clear error explaining why.
        raise HTTPException(410, "This message is no longer available")

    # You must be able to see it before you can pass it on.
    require_member(original["chat_id"], user["id"])

    sender = db.query_one("SELECT name FROM users WHERE id = ?", (original["sender_id"],))
    forwarded_from = sender["name"] if sender else ""
    original_payload = json.loads(original["payload"]) if original["payload"] else None
    original_attachment_id = (original_payload or {}).get("attachment_id")

    sent = []
    for target_chat_id in request.to_chat_ids:
        # And you must be in the chat you are forwarding into.
        if not chatstore.is_member(target_chat_id, user["id"]):
            continue

        payload = dict(original_payload) if original_payload else None
        if original_attachment_id:
            # Filled in below, after the message exists — an attachment row
            # is a single-message binding (see uploads.attach_to_message),
            # so the forwarded copy needs its OWN attachment row rather than
            # pointing at the original message's, which download_file's
            # membership check resolves back to the SOURCE chat. Left
            # pointing there, a recipient of the forward who isn't a member
            # of that original chat would get 404 on a message sitting
            # right in front of them.
            payload.pop("attachment_id", None)

        message, created = chatstore.insert_message(
            chat_id=target_chat_id,
            sender_id=user["id"],
            text=original["text"],
            kind=original["kind"],
            payload=payload,
            forwarded_from=forwarded_from,
            # Without this, forwarding a view-once photo/text created an
            # ordinary, permanently-viewable copy in the target chat —
            # the one-time-view guarantee only ever applied to the
            # original message, never to what forwarding produced from it.
            view_once=bool(original["view_once"]),
        )
        if not created:
            sent.append(message)
            continue

        if original_attachment_id:
            new_attachment_id = uploads.duplicate_for_message(original_attachment_id, message["id"])
            if new_attachment_id:
                payload = payload or {}
                payload["attachment_id"] = new_attachment_id
                db.execute("UPDATE messages SET payload = ? WHERE id = ?",
                          (json.dumps(payload), message["id"]))
                message = chatstore.serialise_message(
                    db.query_one("SELECT * FROM messages WHERE id = ?", (message["id"],)), user["id"])

        await hub.send_to_chat(target_chat_id, {"type": "message", "message": message})
        sent.append(message)

    return sent


def _fts_match_query(term: str) -> str:
    """
    Turn free-text user input into a safe FTS5 MATCH query.

    Quoting the whole term as one phrase means FTS5's own query syntax
    (AND/OR/NOT, -, *, column filters, ...) is treated as literal text to
    search for rather than parsed as operators — a search for `"` or `-x`
    can't turn into a malformed or unexpectedly-scoped MATCH query. The
    trailing `*` keeps prefix matching on the phrase's last token, so
    typing "hel" while a message still finds "hello" mid-search, same as
    substring search felt like.
    """
    return f'"{term.replace(chr(34), chr(34) * 2)}"*'


@app.get("/search")
def search(q: str = Query(min_length=1, max_length=100),
           chat_id: str | None = Query(default=None),
           limit: int = Query(default=50, ge=1, le=200),
           offset: int = Query(default=0, ge=0),
           user: dict = Depends(current_user)):
    """
    Search your own conversations, optionally scoped to a single chat.

    Uses the messages_fts index (db._build_search_index) when this SQLite
    build has FTS5 — a leading-wildcard `LIKE '%q%'` can't use any index and
    forces a full scan of every message in scope on every search, which
    db.py already pays to keep an FTS index in sync for on every write and
    this used to never actually read. Falls back to the old LIKE scan only
    when FTS5 isn't compiled into this Python's sqlite3 (db.search_available()).
    """
    use_fts = db.search_available()
    match = _fts_match_query(q) if use_fts else None
    like = f"%{q}%"

    if chat_id:
        require_member(chat_id, user["id"])
        if use_fts:
            rows = db.query_all(
                """
                SELECT m.*, c.name AS chat_name, c.type AS chat_type
                FROM messages_fts AS fts
                JOIN messages AS m ON m.rowid = fts.rowid
                JOIN chats AS c ON c.id = m.chat_id
                WHERE fts.text MATCH ? AND m.chat_id = ? AND m.deleted_at IS NULL AND m.unsent_at IS NULL
                  AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
                ORDER BY m.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (match, chat_id, user["id"], limit, offset),
            )
        else:
            rows = db.query_all(
                """
                SELECT m.*, c.name AS chat_name, c.type AS chat_type
                FROM messages AS m
                JOIN chats AS c ON c.id = m.chat_id
                WHERE m.chat_id = ? AND m.deleted_at IS NULL AND m.unsent_at IS NULL
                  AND m.text LIKE ?
                  AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
                ORDER BY m.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (chat_id, like, user["id"], limit, offset),
            )
    else:
        if use_fts:
            rows = db.query_all(
                """
                SELECT m.*, c.name AS chat_name, c.type AS chat_type
                FROM messages_fts AS fts
                JOIN messages AS m ON m.rowid = fts.rowid
                JOIN chat_members AS cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
                JOIN chats AS c ON c.id = m.chat_id
                WHERE fts.text MATCH ? AND m.deleted_at IS NULL AND m.unsent_at IS NULL
                  AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
                ORDER BY m.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (user["id"], match, user["id"], limit, offset),
            )
        else:
            rows = db.query_all(
                """
                SELECT m.*, c.name AS chat_name, c.type AS chat_type
                FROM messages AS m
                JOIN chat_members AS cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
                JOIN chats AS c ON c.id = m.chat_id
                WHERE m.deleted_at IS NULL AND m.unsent_at IS NULL
                  AND m.text LIKE ?
                  AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
                ORDER BY m.created_at DESC
                LIMIT ? OFFSET ?
                """,
                (user["id"], like, user["id"], limit, offset),
            )
    return [
        {**chatstore.serialise_message(row, user["id"]),
         "chat_name": row["chat_name"], "chat_type": row["chat_type"]}
        for row in rows
    ]


# ── Scheduled messages ────────────────────────────────────────────────────────

@app.post("/scheduled")
def schedule_message(request: ScheduleRequest, user: dict = Depends(current_user)):
    require_member(request.chat_id, user["id"])

    if request.send_at <= time.time():
        raise HTTPException(400, "send_at must be in the future")

    if not request.text and not request.payload:
        raise HTTPException(400, "Message is empty")

    # Checked now rather than only at send time, so a bad or already-used
    # attachment id fails immediately — not silently, hours later, as a
    # 'failed' scheduled item nobody's watching for.
    attachment_id = (request.payload or {}).get("attachment_id")
    if attachment_id:
        pending = db.query_one(
            "SELECT * FROM attachments WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
            (attachment_id, user["id"]),
        )
        if pending is None:
            raise HTTPException(400, "Unknown attachment, or it has already been sent")

    item_id = new_id("sched")
    db.execute(
        """
        INSERT INTO scheduled_messages (id, chat_id, sender_id, text, kind, payload,
                                        send_at, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        """,
        (item_id, request.chat_id, user["id"], request.text, request.kind,
         json.dumps(request.payload) if request.payload else None,
         request.send_at, time.time()),
    )
    return dict(db.query_one("SELECT * FROM scheduled_messages WHERE id = ?", (item_id,)))


@app.get("/scheduled")
def list_scheduled(chat_id: str | None = None, user: dict = Depends(current_user)):
    """Your pending queue. Sent and cancelled items are kept as history."""
    if chat_id:
        rows = db.query_all(
            "SELECT * FROM scheduled_messages WHERE sender_id = ? AND chat_id = ? ORDER BY send_at",
            (user["id"], chat_id),
        )
    else:
        rows = db.query_all(
            "SELECT * FROM scheduled_messages WHERE sender_id = ? ORDER BY send_at",
            (user["id"],),
        )
    return [dict(row) for row in rows]


@app.patch("/scheduled/{item_id}")
def reschedule(item_id: str, request: RescheduleRequest, user: dict = Depends(current_user)):
    item = db.query_one(
        "SELECT * FROM scheduled_messages WHERE id = ? AND sender_id = ?",
        (item_id, user["id"]),
    )
    if item is None:
        raise HTTPException(404, "Scheduled message not found")
    if item["status"] != "pending":
        raise HTTPException(400, f"This message is already {item['status']}")

    if request.send_at is not None and request.send_at <= time.time():
        raise HTTPException(400, "send_at must be in the future")

    fields = request.model_dump(exclude_none=True)
    if fields:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        # status = 'pending' in the WHERE clause closes the gap between the check
        # above and this write, in case the scheduler sent it in between.
        changed = db.execute(
            f"UPDATE scheduled_messages SET {assignments} WHERE id = ? AND status = 'pending'",
            (*fields.values(), item_id),
        )
        if changed.rowcount == 0:
            raise HTTPException(400, "This message was just sent")

    return dict(db.query_one("SELECT * FROM scheduled_messages WHERE id = ?", (item_id,)))


@app.delete("/scheduled/{item_id}")
def cancel_scheduled(item_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "UPDATE scheduled_messages SET status = 'cancelled' "
        "WHERE id = ? AND sender_id = ? AND status = 'pending'",
        (item_id, user["id"]),
    )
    if changed.rowcount == 0:
        raise HTTPException(404, "No pending scheduled message with that id")
    return {"cancelled": True}


# ── Status / stories ──────────────────────────────────────────────────────────

@app.post("/stories")
def create_story(request: StoryRequest, user: dict = Depends(current_user)):
    now = time.time()
    story_id = new_id("story")

    link_url = ""
    if request.kind in ("photo", "video", "audio"):
        if not request.attachment_id:
            raise HTTPException(400, f"A {request.kind} status needs attachment_id")
    elif request.kind == "link":
        link_url = (request.link_url or "").strip()
        if not (link_url.startswith("http://") or link_url.startswith("https://")):
            raise HTTPException(400, "link_url must start with http:// or https://")

    if request.publish_at and request.publish_at > now:
        # Queued. The 24 hours are measured from when it will publish, and the
        # scheduler rewrites both timestamps at that moment anyway.
        status, publish_at = "scheduled", request.publish_at
        expires_at = request.publish_at + STORY_LIFETIME_SECONDS
    else:
        status, publish_at = "live", None
        expires_at = now + STORY_LIFETIME_SECONDS

    db.execute(
        """
        INSERT INTO stories (id, user_id, text, emoji, background,
                             created_at, expires_at, status, publish_at,
                             kind, link_url, font, font_size, allow_share)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (story_id, user["id"], request.text, request.emoji, request.background,
         now, expires_at, status, publish_at, request.kind, link_url,
         request.font, request.font_size, request.allow_share),
    )

    if request.kind in ("photo", "video", "audio"):
        # Only the uploader may attach their own upload, and only once — same
        # rule as attaching an upload to a chat message.
        attached = uploads.attach_to_story(request.attachment_id, story_id, user["id"])
        if attached is None:
            db.execute("DELETE FROM stories WHERE id = ?", (story_id,))
            raise HTTPException(400, "Invalid or already-used attachment_id")
        db.execute("UPDATE stories SET attachment_id = ? WHERE id = ?",
                   (request.attachment_id, story_id))

    return _expand_story(dict(db.query_one("SELECT * FROM stories WHERE id = ?", (story_id,))))


def _expand_story(story: dict) -> dict:
    """Fill in file metadata for a photo/video/audio status, same idea as
    chatstore.serialise_message expanding a message's attachment_id."""
    if story.get("attachment_id"):
        details = chatstore.attachment_details(story["attachment_id"])
        if details:
            story = {**story, **details}
    return story


def _story_audience_allows(author_id: str, audience_mode: str, viewer_id: str) -> bool:
    """
    The SQL feeding list_stories already narrows to "shares a chat with the
    author" — that's the 'contacts' mode in full. 'except'/'only' layer a
    specific allow/deny list on top of it, checked here in Python since it's
    a handful of authors per page, never worth a JOIN.
    """
    if audience_mode not in ("except", "only"):
        return True
    listed = db.query_one(
        "SELECT 1 FROM story_audience_list WHERE user_id = ? AND other_user_id = ?",
        (author_id, viewer_id),
    ) is not None
    return (not listed) if audience_mode == "except" else listed


@app.get("/stories")
def list_stories(user: dict = Depends(current_user)):
    """
    Live statuses from people you share a chat with, grouped by author.

    Scheduled ones are deliberately absent: nobody should see a status before it
    publishes. Use /stories/mine to review your own queue.
    """
    rows = db.query_all(
        """
        SELECT s.*, u.name, u.avatar_letter, u.color, u.avatar_attachment_id, u.story_audience
        FROM stories AS s
        JOIN users AS u ON u.id = s.user_id
        WHERE s.status = 'live'
          AND s.expires_at > ?
          AND (
                s.user_id = ?
                OR s.user_id IN (
                    SELECT DISTINCT other.user_id
                    FROM chat_members AS mine
                    JOIN chat_members AS other ON other.chat_id = mine.chat_id
                    WHERE mine.user_id = ?
                )
              )
        ORDER BY s.created_at DESC
        """,
        (time.time(), user["id"], user["id"]),
    )

    muted = {row["muted_id"] for row in db.query_all(
        "SELECT muted_id FROM muted_statuses WHERE muter_id = ?", (user["id"],))}

    grouped: dict[str, dict] = {}
    for row in rows:
        row = dict(row)
        if row["user_id"] != user["id"] and not _story_audience_allows(
            row["user_id"], row["story_audience"], user["id"],
        ):
            continue
        if row["user_id"] in muted:
            continue
        story = _expand_story(row)
        author = grouped.setdefault(story["user_id"], {
            "user_id": story["user_id"],
            "name": story["name"],
            "avatar_letter": story["avatar_letter"],
            "avatar_attachment_id": story["avatar_attachment_id"],
            "color": story["color"],
            "stories": [],
        })
        seen = db.query_one(
            "SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?",
            (story["id"], user["id"]),
        )
        story["seen"] = seen is not None
        author["stories"].append(story)

    return list(grouped.values())


@app.get("/stories/mine")
def list_my_stories(user: dict = Depends(current_user)):
    """Your own statuses, including ones still queued to publish."""
    rows = db.query_all(
        "SELECT * FROM stories WHERE user_id = ? AND status IN ('scheduled','live') "
        "ORDER BY COALESCE(publish_at, created_at)",
        (user["id"],),
    )
    result = []
    for row in rows:
        story = _expand_story(dict(row))
        views = db.query_one(
            "SELECT COUNT(*) AS total FROM story_views WHERE story_id = ?", (story["id"],))
        story["view_count"] = views["total"]
        reactions = db.query_one(
            "SELECT COUNT(*) AS total FROM story_reactions WHERE story_id = ?", (story["id"],))
        story["reaction_count"] = reactions["total"]
        result.append(story)
    return result


def _visible_live_story_or_404(story_id: str, user_id: str) -> dict:
    """
    Shared by view/react/unreact: the story must exist, be live, and pass
    the author's audience rule — same check list_stories applies before a
    story is ever shown at all, repeated here because a viewer can act on a
    story_id directly (view, react) without having gone through that list
    first, and a guessed/leaked id must not bypass the audience the author
    actually set.
    """
    story = db.query_one(
        "SELECT s.*, u.story_audience FROM stories AS s "
        "JOIN users AS u ON u.id = s.user_id WHERE s.id = ? AND s.status = 'live'",
        (story_id,),
    )
    if story is None:
        raise HTTPException(404, "Story not found")

    is_author = story["user_id"] == user_id
    if not is_author and not (
        chatstore.shares_chat_with(user_id, story["user_id"])
        and _story_audience_allows(story["user_id"], story["story_audience"], user_id)
    ):
        raise HTTPException(404, "Story not found")
    return story


@app.post("/stories/{story_id}/view")
def view_story(story_id: str, user: dict = Depends(current_user)):
    story = _visible_live_story_or_404(story_id, user["id"])
    db.execute(
        "INSERT OR IGNORE INTO story_views (story_id, user_id, viewed_at) VALUES (?, ?, ?)",
        (story_id, user["id"], time.time()),
    )
    total = db.query_one("SELECT COUNT(*) AS total FROM story_views WHERE story_id = ?", (story_id,))
    return {"views": total["total"]}


@app.get("/stories/{story_id}/viewers")
def list_story_viewers(story_id: str, user: dict = Depends(current_user)):
    """Who has seen it and when — author-only, same as /reactions below;
    list_my_stories' view_count is just COUNT(*) of this same table."""
    story = db.query_one("SELECT user_id FROM stories WHERE id = ?", (story_id,))
    if story is None or story["user_id"] != user["id"]:
        raise HTTPException(404, "Story not found")
    rows = db.query_all(
        """
        SELECT v.user_id, v.viewed_at, u.name, u.avatar_letter, u.color, u.avatar_attachment_id
        FROM story_views AS v JOIN users AS u ON u.id = v.user_id
        WHERE v.story_id = ? ORDER BY v.viewed_at DESC
        """,
        (story_id,),
    )
    return [dict(row) for row in rows]


@app.post("/stories/{story_id}/react")
async def react_to_story(story_id: str, request: ReactRequest, user: dict = Depends(current_user)):
    """
    One reaction per viewer, upserted — sending a second emoji replaces the
    first rather than stacking, unlike a message's reactions (see
    story_reactions' schema comment in db.py for why). The author can't
    react to their own story, same rule view_story's sender check would
    apply if there were one to reuse — nothing here needs to distinguish
    "the author looked" from "someone reacted."
    """
    story = _visible_live_story_or_404(story_id, user["id"])
    if story["user_id"] == user["id"]:
        raise HTTPException(400, "You cannot react to your own story")

    db.execute(
        """
        INSERT INTO story_reactions (story_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (story_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
        """,
        (story_id, user["id"], request.emoji, time.time()),
    )
    await hub.send_to_user(story["user_id"], {
        "type": "story_reaction", "story_id": story_id,
        "user_id": user["id"], "name": user["name"], "emoji": request.emoji,
    })
    return {"emoji": request.emoji}


@app.delete("/stories/{story_id}/react")
def remove_story_reaction(story_id: str, user: dict = Depends(current_user)):
    db.execute("DELETE FROM story_reactions WHERE story_id = ? AND user_id = ?", (story_id, user["id"]))
    return {"removed": True}


@app.get("/stories/{story_id}/reactions")
def list_story_reactions(story_id: str, user: dict = Depends(current_user)):
    """Who reacted with what — author-only, same privacy level view_count
    already has (list_my_stories, not the public list_stories, carries it)."""
    story = db.query_one("SELECT user_id FROM stories WHERE id = ?", (story_id,))
    if story is None or story["user_id"] != user["id"]:
        raise HTTPException(404, "Story not found")
    rows = db.query_all(
        """
        SELECT r.user_id, r.emoji, r.created_at, u.name, u.avatar_letter, u.color, u.avatar_attachment_id
        FROM story_reactions AS r JOIN users AS u ON u.id = r.user_id
        WHERE r.story_id = ? ORDER BY r.created_at DESC
        """,
        (story_id,),
    )
    return [dict(row) for row in rows]


# A story has no message "kind" of its own — text/photo/video/audio/link —
# so forwarding maps each onto the closest chat message kind. "audio"
# becomes a voice message and "link" becomes plain text with the URL
# folded in, since neither exists as its own message kind (see MessageKind
# in models.py).
_STORY_KIND_TO_MESSAGE_KIND = {
    "text": "text", "photo": "photo", "video": "video", "audio": "voice", "link": "text",
}


@app.post("/stories/{story_id}/forward")
async def forward_story(story_id: str, request: ForwardStoryRequest, user: dict = Depends(current_user)):
    """Send a status update into one or more chats as an ordinary message —
    same visibility rule as viewing/reacting (_visible_live_story_or_404),
    and the same attachment-duplication forward_message uses for a photo/
    video message, since an attachment row is a single-message binding."""
    story = _visible_live_story_or_404(story_id, user["id"])
    if story["user_id"] != user["id"] and not story["allow_share"]:
        # WhatsApp-style: forwarding is the author's own privilege by
        # default. A viewer only gets it too if the author explicitly
        # turned "Allow share" on for THIS status when posting it — being
        # merely allowed to VIEW a story (passing the audience check above)
        # never implied being allowed to re-broadcast it further.
        raise HTTPException(403, "The person who posted this hasn't allowed it to be forwarded")

    text = story["text"] or ""
    if story["kind"] == "link" and story["link_url"] and story["link_url"] not in text:
        text = f"{text}\n{story['link_url']}".strip()
    message_kind = _STORY_KIND_TO_MESSAGE_KIND.get(story["kind"], "text")
    original_attachment_id = story["attachment_id"]

    sent = []
    for target_chat_id in request.to_chat_ids:
        if not chatstore.is_member(target_chat_id, user["id"]):
            continue

        message, created = chatstore.insert_message(
            chat_id=target_chat_id,
            sender_id=user["id"],
            text=text,
            kind=message_kind,
            payload=None,
            forwarded_from="Status",
        )
        if not created:
            sent.append(message)
            continue

        if original_attachment_id:
            new_attachment_id = uploads.duplicate_for_message(original_attachment_id, message["id"])
            if new_attachment_id:
                payload = {"attachment_id": new_attachment_id}
                db.execute("UPDATE messages SET payload = ? WHERE id = ?",
                          (json.dumps(payload), message["id"]))
                message = chatstore.serialise_message(
                    db.query_one("SELECT * FROM messages WHERE id = ?", (message["id"],)), user["id"])

        await hub.send_to_chat(target_chat_id, {"type": "message", "message": message})
        sent.append(message)

    return sent


@app.delete("/stories/{story_id}")
def delete_story(story_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "UPDATE stories SET status = 'cancelled' WHERE id = ? AND user_id = ?",
        (story_id, user["id"]),
    )
    if changed.rowcount == 0:
        raise HTTPException(404, "Story not found")
    chatstore.drop_attachments_for_story(story_id)
    return {"deleted": True}


# ── Meetings ──────────────────────────────────────────────────────────────────

def serialise_meeting(row, viewer_id: str = "") -> dict:
    meeting = dict(row)
    # The hash itself never leaves the server — has_password is all a
    # client needs to know whether to prompt for one before joining.
    meeting["has_password"] = bool(meeting.pop("password_hash", None))
    participants = db.query_all(
        """
        SELECT p.user_id, p.response, u.name, u.avatar_letter, u.color
        FROM meeting_participants AS p
        JOIN users AS u ON u.id = p.user_id
        WHERE p.meeting_id = ?
        """,
        (meeting["id"],),
    )
    meeting["participants"] = [dict(p) for p in participants]
    meeting["going_count"] = sum(1 for p in participants if p["response"] == "going")
    meeting["my_response"] = next(
        (p["response"] for p in participants if p["user_id"] == viewer_id), None)
    return meeting


def _validate_join_url(join_url: str) -> str:
    """
    Same rule Story.link_url already enforces (main.py's create_story) —
    join_url is rendered straight into an <a href> on the meeting card, and
    without a scheme check a value like `javascript:...` would run as script
    in every invitee's session the moment they click "Join now."
    """
    url = (join_url or "").strip()
    if url and not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "join_url must start with http:// or https://")
    return url


async def _create_meeting_row(chat_id: str, host_id: str, title: str, agenda: str,
                              starts_at: float, duration_min: int, join_url: str,
                              reminder_min: int, invite_user_ids: list[str], status: str,
                              waiting_room: bool = False, password: str = "") -> dict:
    """Shared by /meetings (scheduled) and /meetings/instant (live from the
    moment it's created) — everything past the initial status is identical:
    invite expansion, the RSVP rows, and the card posted into the chat."""
    join_url = _validate_join_url(join_url)
    meeting_id = new_id("meet")
    now = time.time()
    password_hash = auth.hash_password(password) if password else None

    db.execute(
        """
        INSERT INTO meetings (id, chat_id, host_id, title, agenda, starts_at,
                              duration_min, join_url, status, reminder_min, created_at,
                              waiting_room, password_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (meeting_id, chat_id, host_id, title, agenda, starts_at, duration_min, join_url,
         status, reminder_min, now, int(waiting_room), password_hash),
    )

    # Invite the named people, or the whole chat when none are named.
    if invite_user_ids:
        invitees = [uid for uid in set(invite_user_ids) if chatstore.is_member(chat_id, uid)]
    else:
        invitees = [row["user_id"] for row in db.query_all(
            "SELECT user_id FROM chat_members WHERE chat_id = ?", (chat_id,))]

    for invitee_id in set(invitees) | {host_id}:
        # The host is going by definition; everyone else starts undecided.
        response = "going" if invitee_id == host_id else "pending"
        db.execute(
            "INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id, response, responded_at) "
            "VALUES (?, ?, ?, ?)",
            (meeting_id, invitee_id, response, now if response == "going" else None),
        )

    # The card in the chat. Storing it as a message means it inherits unread
    # counts, search and the read marker without any special handling.
    card, _ = chatstore.insert_message(
        chat_id=chat_id,
        sender_id=host_id,
        text=f"📅 {title}",
        kind="meeting",
        payload={"meeting_id": meeting_id, "starts_at": starts_at,
                 "duration_min": duration_min, "join_url": join_url},
    )
    db.execute("UPDATE meetings SET message_id = ? WHERE id = ?", (card["id"], meeting_id))

    meeting = serialise_meeting(
        db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,)), host_id)

    await hub.send_to_chat(chat_id, {"type": "message", "message": card})
    await hub.send_to_chat(chat_id, {"type": "meeting_created", "meeting": meeting})
    return meeting


@app.post("/meetings")
async def create_meeting(request: CreateMeetingRequest, user: dict = Depends(current_user)):
    """
    Schedule a meeting inside a chat.

    Posts a card into the chat so it shows up in the conversation, and invites
    either the people named or everyone currently in the chat.
    """
    require_member(request.chat_id, user["id"])

    if request.starts_at <= time.time():
        raise HTTPException(400, "starts_at must be in the future")

    return await _create_meeting_row(
        request.chat_id, user["id"], request.title, request.agenda, request.starts_at,
        request.duration_min, request.join_url, request.reminder_min,
        request.invite_user_ids, "scheduled",
        waiting_room=request.waiting_room, password=request.password,
    )


@app.post("/meetings/instant")
async def start_instant_meeting(request: InstantMeetingRequest, user: dict = Depends(current_user)):
    """
    The in-app 'New Meeting' button — no scheduling step, live immediately,
    everyone currently in the chat is invited. join_url stays empty: joining
    means the in-app call room for this chat, exactly like tapping the
    header's call buttons, not an external Zoom/Meet link.
    """
    require_member(request.chat_id, user["id"])
    return await _create_meeting_row(
        request.chat_id, user["id"], request.title or "Instant meeting", "",
        time.time(), 60, "", 0, [], "live",
        waiting_room=request.waiting_room, password=request.password,
    )


@app.post("/meetings/{meeting_id}/start")
async def start_meeting(meeting_id: str, user: dict = Depends(current_user)):
    """
    Moves a scheduled meeting to 'live' — whoever gets there first, not only
    the host, same as tapping 'Join' in Zoom/Meet starts the call for
    everyone rather than requiring the organizer to click a separate button
    first. A no-op if it's already live so two people tapping Join at once
    isn't a race.
    """
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    require_member(meeting["chat_id"], user["id"])
    if meeting["status"] in ("ended", "cancelled"):
        raise HTTPException(400, f"This meeting is already {meeting['status']}")

    just_started = meeting["status"] != "live"
    if just_started:
        db.execute("UPDATE meetings SET status = 'live' WHERE id = ?", (meeting_id,))

    updated = serialise_meeting(
        db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,)), user["id"])
    # Only on the real scheduled-to-live transition, not every subsequent
    # "join" call once it's already live — those still get meeting_updated
    # (for e.g. going_count), just not a second "it started" notice.
    if just_started:
        await hub.send_to_chat(meeting["chat_id"], {
            "type": "meeting_started", "meeting_id": meeting_id, "chat_id": meeting["chat_id"],
            "title": meeting["title"], "join_url": meeting["join_url"],
        })
    await hub.send_to_chat(meeting["chat_id"], {"type": "meeting_updated", "meeting": updated})
    return updated


@app.post("/meetings/{meeting_id}/end")
async def end_meeting(meeting_id: str, user: dict = Depends(current_user)):
    """Host-only, unlike starting — ending it for everyone else mid-call is
    disruptive enough that it shouldn't be one tap for any participant."""
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(403, "Only the host can end this meeting")
    if meeting["status"] != "live":
        raise HTTPException(400, f"This meeting is {meeting['status']}, not live")

    db.execute("UPDATE meetings SET status = 'ended' WHERE id = ?", (meeting_id,))
    await hub.send_to_chat(meeting["chat_id"], {
        "type": "meeting_ended", "meeting_id": meeting_id, "chat_id": meeting["chat_id"],
    })
    # The host ending the meeting ends the actual call too, for everyone on
    # it right now — not just the calendar record.
    await _force_end_group_call(meeting["chat_id"])
    return {"ended": True}


@app.get("/meetings")
def list_my_meetings(upcoming_only: bool = True, user: dict = Depends(current_user)):
    """Everything you are invited to, soonest first."""
    if upcoming_only:
        rows = db.query_all(
            """
            SELECT m.* FROM meetings AS m
            JOIN meeting_participants AS p ON p.meeting_id = m.id
            WHERE p.user_id = ? AND m.status IN ('scheduled', 'live')
            ORDER BY m.starts_at ASC
            """,
            (user["id"],),
        )
    else:
        rows = db.query_all(
            """
            SELECT m.* FROM meetings AS m
            JOIN meeting_participants AS p ON p.meeting_id = m.id
            WHERE p.user_id = ?
            ORDER BY m.starts_at DESC
            """,
            (user["id"],),
        )
    return [serialise_meeting(row, user["id"]) for row in rows]


@app.get("/chats/{chat_id}/meetings")
def list_chat_meetings(chat_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    rows = db.query_all(
        "SELECT * FROM meetings WHERE chat_id = ? ORDER BY starts_at DESC", (chat_id,))
    return [serialise_meeting(row, user["id"]) for row in rows]


@app.get("/meetings/{meeting_id}")
def get_meeting(meeting_id: str, user: dict = Depends(current_user)):
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    require_member(meeting["chat_id"], user["id"])
    return serialise_meeting(meeting, user["id"])


def _ics_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")


def _ics_datetime(timestamp: float) -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(timestamp))


@app.get("/meetings/{meeting_id}/ics")
def meeting_ics(meeting_id: str, user: dict = Depends(current_user)):
    """
    A standard .ics file for the meeting — importable into any real calendar
    app (Google Calendar, Outlook, Apple Calendar). WhatsApp has no equivalent
    at all: it has no native meeting scheduling to export from in the first
    place.
    """
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    require_member(meeting["chat_id"], user["id"])

    ends_at = meeting["starts_at"] + meeting["duration_min"] * 60
    description = meeting["agenda"] or ""
    if meeting["join_url"]:
        description = f"{description}\nJoin: {meeting['join_url']}".strip()

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TalkEx//Meetings//EN",
        "BEGIN:VEVENT",
        f"UID:{meeting['id']}@talkex",
        f"DTSTAMP:{_ics_datetime(time.time())}",
        f"DTSTART:{_ics_datetime(meeting['starts_at'])}",
        f"DTEND:{_ics_datetime(ends_at)}",
        f"SUMMARY:{_ics_escape(meeting['title'])}",
    ]
    if description:
        lines.append(f"DESCRIPTION:{_ics_escape(description)}")
    if meeting["join_url"]:
        lines.append(f"URL:{meeting['join_url']}")
    lines += ["END:VEVENT", "END:VCALENDAR"]

    return PlainTextResponse(
        "\r\n".join(lines) + "\r\n", media_type="text/calendar",
        headers={"Content-Disposition": f'attachment; filename="meeting-{meeting_id}.ics"'},
    )


@app.patch("/meetings/{meeting_id}")
async def update_meeting(meeting_id: str, request: UpdateMeetingRequest,
                         user: dict = Depends(current_user)):
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(403, "Only the host can change this meeting")
    if meeting["status"] in ("ended", "cancelled"):
        raise HTTPException(400, f"This meeting is already {meeting['status']}")

    fields = request.model_dump(exclude_none=True)
    if request.starts_at is not None and request.starts_at <= time.time():
        raise HTTPException(400, "starts_at must be in the future")
    if "join_url" in fields:
        fields["join_url"] = _validate_join_url(fields["join_url"])

    # `password` isn't a real column — it maps to password_hash, and an
    # empty string means "clear it" rather than "hash an empty string."
    if "password" in fields:
        raw_password = fields.pop("password")
        fields["password_hash"] = auth.hash_password(raw_password) if raw_password else None

    if fields:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        db.execute(f"UPDATE meetings SET {assignments} WHERE id = ?",
                   (*fields.values(), meeting_id))

        # Moving the start time has to clear the reminder stamp, or the new time
        # arrives with the reminder already marked as sent and nobody is told.
        if request.starts_at is not None:
            db.execute("UPDATE meetings SET reminded_at = NULL WHERE id = ?", (meeting_id,))

    updated = serialise_meeting(
        db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,)), user["id"])
    await hub.send_to_chat(meeting["chat_id"], {"type": "meeting_updated", "meeting": updated})
    return updated


@app.delete("/meetings/{meeting_id}")
async def cancel_meeting(meeting_id: str, user: dict = Depends(current_user)):
    """Calling off a meeting before it happens. A meeting already underway
    is ended (POST /end), not cancelled — cancelling a 'live' one here would
    mark the record 'cancelled' while leaving the actual call running with
    no signal to anyone that anything's wrong."""
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    if meeting["host_id"] != user["id"]:
        raise HTTPException(403, "Only the host can cancel this meeting")
    if meeting["status"] != "scheduled":
        raise HTTPException(
            400,
            "This meeting is already live — end it instead" if meeting["status"] == "live"
            else f"This meeting is already {meeting['status']}",
        )

    db.execute("UPDATE meetings SET status = 'cancelled' WHERE id = ?", (meeting_id,))
    await hub.send_to_chat(meeting["chat_id"], {
        "type": "meeting_cancelled",
        "meeting_id": meeting_id,
        "chat_id": meeting["chat_id"],
    })
    return {"cancelled": True}


@app.post("/meetings/{meeting_id}/rsvp")
async def rsvp(meeting_id: str, request: RsvpRequest, user: dict = Depends(current_user)):
    meeting = db.query_one("SELECT * FROM meetings WHERE id = ?", (meeting_id,))
    if meeting is None:
        raise HTTPException(404, "Meeting not found")
    require_member(meeting["chat_id"], user["id"])

    db.execute(
        """
        INSERT INTO meeting_participants (meeting_id, user_id, response, responded_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (meeting_id, user_id)
        DO UPDATE SET response = excluded.response, responded_at = excluded.responded_at
        """,
        (meeting_id, user["id"], request.response, time.time()),
    )

    updated = serialise_meeting(meeting, user["id"])
    await hub.send_to_chat(meeting["chat_id"], {"type": "meeting_updated", "meeting": updated})
    return updated


# ── Call history ─────────────────────────────────────────────────────────────

@app.get("/calls")
def list_calls(limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0),
               user: dict = Depends(current_user)):
    """
    A call log across every chat you're in — the same 'call' kind message
    each call already writes into its chat, just gathered into one list
    instead of requiring you to remember which conversation it happened in.
    """
    rows = db.query_all(
        """
        SELECT m.*, c.type AS chat_type, c.name AS chat_name,
               c.avatar_letter AS chat_avatar_letter, c.color AS chat_color
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
        JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
        WHERE m.kind = 'call' AND m.unsent_at IS NULL
          AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
        """,
        (user["id"], user["id"], limit, offset),
    )

    calls = []
    for row in rows:
        call = chatstore.serialise_message(row, user["id"])
        call["chat_type"] = row["chat_type"]
        if row["chat_type"] == "dm":
            # A DM's own name/avatar are blank — the peer's own are what a
            # call log should show, same as every other DM-aware screen.
            peer_id = dm_peer_id(row["chat_id"], user["id"])
            peer = db.query_one("SELECT id, name, avatar_letter, color FROM users WHERE id = ?",
                                (peer_id,)) if peer_id else None
            call["chat_name"] = peer["name"] if peer else "Direct message"
            call["chat_avatar_letter"] = peer["avatar_letter"] if peer else "?"
            call["chat_color"] = peer["color"] if peer else "#6366f1"
            call["peer_id"] = peer["id"] if peer else None
        else:
            call["chat_name"] = row["chat_name"]
            call["chat_avatar_letter"] = row["chat_avatar_letter"]
            call["chat_color"] = row["chat_color"]
        calls.append(call)
    return calls


@app.get("/calls/missed-count")
def missed_calls_count(user: dict = Depends(current_user)):
    """
    Calls placed TO this user (never ones they placed themselves) that
    didn't complete, since the last time they opened the Calls tab. The
    same "missed calls" idea a phone's dialer badge means — not every call
    in the log, just the ones this user never actually picked up and
    hasn't looked at yet.
    """
    row = db.query_one("SELECT calls_seen_at FROM users WHERE id = ?", (user["id"],))
    since = row["calls_seen_at"] if row else 0

    rows = db.query_all(
        """
        SELECT m.payload
        FROM messages m
        JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
        WHERE m.kind = 'call' AND m.unsent_at IS NULL AND m.sender_id != ?
          AND m.created_at > ?
          AND m.id NOT IN (SELECT message_id FROM message_hidden_for WHERE user_id = ?)
        """,
        (user["id"], user["id"], since, user["id"]),
    )
    missed = sum(1 for r in rows if json.loads(r["payload"] or "{}").get("status") != "completed")
    return {"count": missed}


@app.post("/calls/seen")
def mark_calls_seen(user: dict = Depends(current_user)):
    db.execute("UPDATE users SET calls_seen_at = ? WHERE id = ?", (time.time(), user["id"]))
    return {"ok": True}


# ── Realtime ──────────────────────────────────────────────────────────────────

# Call signaling is a pure relay through the same socket messaging already
# uses for typing — no separate endpoint, no server-side call state. The
# server's only job is deciding who is allowed to say something to whom.
CALL_SIGNAL_TYPES = {
    "call_invite", "call_answer", "call_ice", "call_reject", "call_end", "call_busy",
    # A voice call adding video mid-call — the original offer/answer never
    # negotiated a video m-line, so this is a full second offer/answer round
    # trip on the same connection, not just another ICE candidate.
    "call_upgrade_offer", "call_upgrade_answer",
}

# One-to-many relay types for a mesh group call: each new joiner connects
# directly to every participant already in the room (not through the
# server — the server only ever relays SDP/ICE, same as the 1:1 signaling
# above), so these carry `to` just like the pairwise types do.
GROUP_CALL_SIGNAL_TYPES = {"group_call_offer", "group_call_answer", "group_call_ice"}

# Who is currently in which group call. In-memory and ephemeral by design —
# same reasoning as `_pending_logins`: a call room has no meaning after
# every participant's socket is gone, and persisting it would just be state
# to get out of sync with reality after a server restart mid-call.
_group_calls: dict[str, dict[str, dict]] = {}

# chat_id -> user_id of whoever started that room. Not a durable role —
# purely "who gets the moderation buttons for as long as this specific call
# runs." Reassigned to whoever's still in the room if the host leaves,
# rather than ending the call for everyone.
_group_call_hosts: dict[str, str] = {}

# parent_chat_id -> user_id of whoever most recently split that chat's call
# into breakout rooms. Tracked separately from _group_call_hosts above:
# once everyone's moved into their breakout rooms, the parent room empties
# out and _group_call_hosts forgets who ran it — this survives that so
# "close breakout rooms" still knows who's allowed to.
_breakout_hosts: dict[str, str] = {}

# chat_id -> {user_id: participant_info} of people who've asked to join a
# waiting-room-gated call and are on hold for the host's decision. Never
# holds media of any kind — these people have no peer connections yet,
# they're just names waiting on a decision.
_group_call_waiting: dict[str, dict[str, dict]] = {}

# (chat_id, user_id) -> the pending-removal task from a dropped socket, see
# _leave_all_group_calls. Kept so a fast reconnect (group_call_start arriving
# again before the grace window elapses) can cancel it.
_group_call_leave_tasks: dict[tuple[str, str], asyncio.Task] = {}
GROUP_CALL_RECONNECT_GRACE_SECONDS = 20

# chat_id -> {"screen_share": "host"|"everyone", "whiteboard": "host"|"everyone"}.
# A feature missing from this dict (the common case) behaves as "everyone" —
# every call before this existed keeps working exactly as it did. Only the
# host can flip an entry to "host", putting that action under their control
# instead of any current participant's.
_group_call_permissions: dict[str, dict] = {}

# chat_id -> user_id currently sharing their screen, or absent if nobody is.
# The single source of truth for "who is sharing" — screen share used to have
# zero backend involvement at all, so no other participant's client had any
# authoritative way to know it was happening.
_group_call_screen_sharer: dict[str, str] = {}

# chat_id -> user_id currently spotlighted by the host, or absent.
_group_call_spotlight: dict[str, str] = {}


async def _clear_departing_user_special_state(chat_id: str, user_id: str):
    """
    Called for a specific user leaving/being removed from a call room
    (not just the room emptying out entirely) — if they happened to be the
    screen-sharer or the spotlighted participant, that fact must not survive
    them, or everyone else's client would keep pointing its main stage at a
    stream/person that's no longer even in the call.
    """
    if _group_call_screen_sharer.get(chat_id) == user_id:
        del _group_call_screen_sharer[chat_id]
        await hub.send_to_chat(chat_id, {
            "type": "group_call_screen_share_stopped", "chat_id": chat_id, "user_id": user_id,
        })
    if _group_call_spotlight.get(chat_id) == user_id:
        del _group_call_spotlight[chat_id]
        await hub.send_to_chat(chat_id, {
            "type": "group_call_spotlight_changed", "chat_id": chat_id, "user_id": None,
        })


def _participant_info(user_id: str) -> dict:
    row = db.query_one("SELECT name, avatar_letter, color FROM users WHERE id = ?", (user_id,))
    return {
        "user_id": user_id,
        "name": row["name"] if row else "Unknown",
        "avatar_letter": row["avatar_letter"] if row else "?",
        "color": row["color"] if row else "#6366f1",
    }


async def _reassign_host_if_needed(chat_id: str, leaving_user_id: str, remaining: dict[str, dict]):
    """
    If the person who just left was the host, hand the role to whoever's
    still there (arbitrary but deterministic — dict insertion order, so
    effectively "whoever joined earliest of those remaining"). Tells
    everyone left in the room who the new host is, the same event a normal
    join sends, so no client needs a special "host changed" case.
    """
    if _group_call_hosts.get(chat_id) != leaving_user_id:
        return
    if not remaining:
        _group_call_hosts.pop(chat_id, None)
        return
    new_host = next(iter(remaining))
    _group_call_hosts[chat_id] = new_host
    await hub.send_to_chat(chat_id, {
        "type": "group_call_host_changed", "chat_id": chat_id, "host_id": new_host,
    })


def _group_call_room_state(chat_id: str) -> dict:
    """
    The facts about a room a joiner (fresh or reconnecting) needs beyond the
    participant list itself — who's host, what the host has restricted, and
    who's currently sharing/spotlighted. Without this a late joiner only
    ever learns these from the NEXT change event, so their client would sit
    with defaults (host_id None, no screen share visible, etc.) until
    something happened to happen to re-announce it.
    """
    return {
        "host_id": _group_call_hosts.get(chat_id),
        "permissions": _group_call_permissions.get(
            chat_id, {"screen_share": "everyone", "whiteboard": "everyone"}),
        "screen_sharer_id": _group_call_screen_sharer.get(chat_id),
        "spotlight_user_id": _group_call_spotlight.get(chat_id),
    }


async def _admit_to_group_call(chat_id: str, user_id: str):
    """The tail end of group_call_start's normal (non-waiting-room) path,
    factored out so an admitted waiting-room joiner goes through the exact
    same roster/offer setup as anyone who walked straight in."""
    room = _group_calls.setdefault(chat_id, {})
    roster = list(room.values())
    room[user_id] = _participant_info(user_id)
    # The client's WaitingForHost screen only ever leaves phase "waiting" on
    # this event (see group_call_admitted in useGroupCall.js) — without it,
    # someone the host just let in stays stuck looking at "Waiting for the
    # host to let you in…" forever, even though the roster below already
    # has them connecting.
    await hub.send_to_user(user_id, {"type": "group_call_admitted", "chat_id": chat_id})
    await hub.send_to_user(user_id, {
        "type": "group_call_roster", "chat_id": chat_id, "participants": roster,
        **_group_call_room_state(chat_id),
    })
    await hub.send_to_chat(chat_id, {
        "type": "group_call_participant_joined", "chat_id": chat_id, **room[user_id],
    }, exclude_user=user_id)


async def _force_end_group_call(chat_id: str):
    """
    Tear down an in-progress call room and tell everyone in it to hang up —
    used when the HOST explicitly ends a meeting (POST /meetings/{id}/end).
    Without this, ending a meeting only flipped the `meetings` row to
    'ended' and posted a chat notice; anyone actually still on the call (in
    _group_calls) had no idea anything happened and kept talking in a call
    the meeting record now says is over.
    """
    if chat_id not in _group_calls:
        return
    del _group_calls[chat_id]
    _group_call_hosts.pop(chat_id, None)
    _group_call_waiting.pop(chat_id, None)
    _group_call_permissions.pop(chat_id, None)
    _group_call_screen_sharer.pop(chat_id, None)
    _group_call_spotlight.pop(chat_id, None)
    await hub.send_to_chat(chat_id, {"type": "group_call_ended", "chat_id": chat_id})


async def _end_live_meeting_for_chat(chat_id: str):
    """
    Called whenever a chat's group-call room empties out naturally (the
    last participant left or disconnected) — the counterpart to a host
    explicitly ending a meeting (POST /meetings/{id}/end). Without this, a
    meeting's `meetings.status` row could only ever reach 'ended' via that
    explicit host action, so a meeting nobody remembered to formally "end"
    stayed stuck at 'live' in every participant's meeting list forever,
    even though the actual call was long over.
    """
    meeting = db.query_one(
        "SELECT id FROM meetings WHERE chat_id = ? AND status = 'live' ORDER BY created_at DESC LIMIT 1",
        (chat_id,),
    )
    if meeting is None:
        return
    claimed = db.execute(
        "UPDATE meetings SET status = 'ended' WHERE id = ? AND status = 'live'", (meeting["id"],))
    if claimed.rowcount:
        await hub.send_to_chat(chat_id, {
            "type": "meeting_ended", "meeting_id": meeting["id"], "chat_id": chat_id,
        })


async def _finalize_group_call_departure(chat_id: str, user_id: str):
    """The delayed half of _leave_all_group_calls below — actually removes
    the participant once the reconnect grace window has passed without
    group_call_start cancelling this task first."""
    try:
        await asyncio.sleep(GROUP_CALL_RECONNECT_GRACE_SECONDS)
    except asyncio.CancelledError:
        return
    finally:
        _group_call_leave_tasks.pop((chat_id, user_id), None)

    participants = _group_calls.get(chat_id)
    if not participants or user_id not in participants:
        return
    del participants[user_id]
    if participants:
        await hub.send_to_chat(chat_id, {
            "type": "group_call_participant_left", "chat_id": chat_id, "user_id": user_id,
        })
        await _reassign_host_if_needed(chat_id, user_id, participants)
        await _clear_departing_user_special_state(chat_id, user_id)
    else:
        del _group_calls[chat_id]
        _group_call_hosts.pop(chat_id, None)
        _group_call_waiting.pop(chat_id, None)
        _group_call_permissions.pop(chat_id, None)
        _group_call_screen_sharer.pop(chat_id, None)
        _group_call_spotlight.pop(chat_id, None)
        await _end_live_meeting_for_chat(chat_id)


async def _leave_all_group_calls(user_id: str):
    """
    Called when a socket disconnects.

    Does NOT remove the participant immediately. A dropped WebSocket — a
    WiFi hiccup, a phone briefly locking, a tab backgrounding on some
    mobile browsers — is common mid-call, and the client's automatic
    reconnect (Realtime.scheduleReconnect in api.js) usually lands within a
    couple of seconds. Ejecting on the very first disconnect made an
    ordinary network blip indistinguishable from actually hanging up — to
    every OTHER participant too, since their client closes its peer
    connection to this person the moment group_call_participant_left
    arrives. A grace window lets group_call_start (sent again once the
    reconnected socket is ready) cancel the pending removal and resume
    silently instead of forcing a full rejoin.
    """
    for chat_id, participants in list(_group_calls.items()):
        if user_id not in participants:
            continue
        key = (chat_id, user_id)
        if key in _group_call_leave_tasks:
            continue  # a departure is already scheduled for this chat
        _group_call_leave_tasks[key] = asyncio.create_task(
            _finalize_group_call_departure(chat_id, user_id))


@app.websocket("/ws")
async def websocket_endpoint(
    socket: WebSocket,
    ticket: str = Query(default=""),
    token: str = Query(default=""),
):
    """
    One authenticated socket per device.

    Preferred auth: a short-lived, single-use ticket (POST /auth/ws-ticket).

    Fallback: the raw session token as ?token= — accepted so that a browser
    still running a cached older JavaScript bundle (before the ticket flow
    was added) can connect instead of silently failing forever. The ticket
    path is always tried first; the token path fires only when no ticket was
    provided at all.
    """
    user_id = redeem_ws_ticket(ticket) if ticket else None

    if user_id is None and token:
        session = db.query_one(
            "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
            (auth.hash_token(token),),
        )
        if session and session["expires_at"] > time.time():
            user_id = session["user_id"]

    if user_id is None:
        await socket.close(code=1008)
        return

    auth_method = "ticket" if ticket else "token-fallback"
    await socket.accept()
    await hub.add(user_id, socket)
    total = len(hub._connections.get(user_id, ()))
    print(f"[WS] connected user={user_id} auth={auth_method} "
          f"sockets_for_user={total} total_users={len(hub._connections)}")
    # Deliberately the plain sync db call, not the *_async/to_thread-offloaded
    # version: this handler's cleanup path (the `finally` below) proved that
    # moving a db call here onto a worker thread adds a real cancellation
    # window — if the ASGI layer tears the connection down while a call is
    # mid-flight on another thread, the awaiting coroutine can be cancelled
    # before it resumes, silently dropping whatever came after it (observed
    # as group_call_participant_left never reaching the other participant
    # when a socket dropped mid-call). A brief lock wait on the event-loop
    # thread is the safer trade until that's solved with something
    # cancellation-aware, e.g. a dedicated writer task/queue instead of
    # asyncio.to_thread.
    db.execute("UPDATE users SET last_seen = ? WHERE id = ?", (time.time(), user_id))
    await hub.broadcast_presence(user_id, online=True)

    try:
        while True:
            raw = await socket.receive_text()
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue

            kind = payload.get("type")

            if kind == "ping":
                # The client drives the heartbeat. A reply proves the link is
                # alive in both directions, not just that the socket is open.
                await socket.send_json({"type": "pong", "at": time.time()})

            elif kind == "focus":
                # The client reports actual foreground/background state (see
                # the visibilitychange listener in useRealtime.js) — merely
                # having a socket open no longer counts as "online" on its
                # own; see Hub.is_online's docstring. Only broadcast when
                # this device's change
                # actually flips the account's overall answer, so switching
                # tabs on a multi-device session doesn't spam presence
                # events for devices that don't change anything.
                focused = bool(payload.get("focused"))
                changed = await hub.set_focus(user_id, socket, focused)
                if not focused:
                    # Plain sync db call on purpose — see the matching note
                    # a few lines up on the connect-time last_seen update.
                    db.execute("UPDATE users SET last_seen = ? WHERE id = ?", (time.time(), user_id))
                if changed:
                    await hub.broadcast_presence(user_id, online=focused)

            elif kind == "typing":
                chat_id = payload.get("chat_id", "")
                # Checked, not trusted: without this anyone could broadcast into
                # any chat by naming it here.
                if chat_id and chatstore.is_member(chat_id, user_id):
                    # A group needs to say WHO is typing, not just that someone
                    # is — the name rides along so the client never has to
                    # cross-reference a member list it may not have loaded.
                    typer = db.query_one("SELECT name FROM users WHERE id = ?", (user_id,))
                    await hub.send_to_chat(chat_id, {
                        "type": "typing",
                        "chat_id": chat_id,
                        "user_id": user_id,
                        "name": typer["name"] if typer else "Someone",
                    }, exclude_user=user_id)

            elif kind in CALL_SIGNAL_TYPES:
                chat_id = payload.get("chat_id", "")
                to_user_id = payload.get("to", "")
                if kind == "call_invite":
                    target_sockets = len(hub._connections.get(to_user_id, ()))
                    focused_sockets = len(hub._focused.get(to_user_id, ()))
                    print(f"[CALL] invite from {user_id} → {to_user_id} "
                          f"chat={chat_id} "
                          f"target_sockets={target_sockets} focused={focused_sockets}")
                if not chat_id or not to_user_id or not call_target_ok(chat_id, user_id, to_user_id):
                    if kind == "call_invite":
                        print(f"[CALL] REJECTED: call_target_ok failed "
                              f"chat={chat_id} from={user_id} to={to_user_id}")
                    await socket.send_json({
                        "type": "call_error", "chat_id": chat_id,
                        "reason": "Cannot reach that person",
                    })
                    continue

                relay = {"type": kind, "chat_id": chat_id, "from": user_id}
                if kind == "call_invite":
                    call_kind = payload.get("call_kind")
                    if call_kind not in ("voice", "video"):
                        continue
                    caller_ok = calling_permitted(chat_id, user_id)
                    callee_ok = calling_permitted(chat_id, to_user_id)
                    if not caller_ok or not callee_ok:
                        caller_row = db.query_one("SELECT calling_enabled FROM users WHERE id = ?", (user_id,))
                        callee_row = db.query_one("SELECT calling_enabled FROM users WHERE id = ?", (to_user_id,))
                        caller_mem = db.query_one("SELECT calls_enabled FROM chat_members WHERE chat_id = ? AND user_id = ?", (chat_id, user_id))
                        callee_mem = db.query_one("SELECT calls_enabled FROM chat_members WHERE chat_id = ? AND user_id = ?", (chat_id, to_user_id))
                        print(f"[CALL] REJECTED: calling_permitted failed "
                              f"caller_global={caller_row['calling_enabled'] if caller_row else 'N/A'} "
                              f"caller_chat={caller_mem['calls_enabled'] if caller_mem else 'N/A'} "
                              f"callee_global={callee_row['calling_enabled'] if callee_row else 'N/A'} "
                              f"callee_chat={callee_mem['calls_enabled'] if callee_mem else 'N/A'}")
                        await socket.send_json({
                            "type": "call_error", "chat_id": chat_id,
                            "reason": "This person isn't accepting calls right now",
                        })
                        continue
                    caller = db.query_one(
                        "SELECT name, avatar_letter, color FROM users WHERE id = ?", (user_id,))
                    relay["call_kind"] = call_kind
                    relay["sdp"] = payload.get("sdp")
                    relay["from_name"] = caller["name"] if caller else "Unknown"
                    relay["from_avatar"] = caller["avatar_letter"] if caller else "?"
                    relay["from_color"] = caller["color"] if caller else "#6366f1"
                elif kind == "call_answer":
                    relay["sdp"] = payload.get("sdp")
                elif kind == "call_ice":
                    relay["candidate"] = payload.get("candidate")
                elif kind in ("call_upgrade_offer", "call_upgrade_answer"):
                    relay["sdp"] = payload.get("sdp")
                # call_reject, call_end and call_busy carry nothing beyond
                # chat_id and who sent it — that is all the receiving end needs
                # to tear its own call state down.

                await hub.send_to_user(to_user_id, relay)
                if kind == "call_invite":
                    target_sockets = len(hub._connections.get(to_user_id, ()))
                    print(f"[CALL] invite relayed to {to_user_id} "
                          f"(sockets_after_send={target_sockets})")
                    if hub.is_online(to_user_id):
                        print(f"[CALL] target is focused → sending call_ringing to caller")
                        await socket.send_json({
                            "type": "call_ringing", "chat_id": chat_id, "from": to_user_id,
                        })
                    else:
                        print(f"[CALL] target NOT focused → push notification fallback")
                        await notify_incoming_call(to_user_id, chat_id, relay["from_name"], call_kind)

            elif kind == "group_call_start":
                # "Start" and "join" are the same message — whoever sends this
                # first for a chat starts the room; everyone after that just
                # joins whatever is already there. The client does not need
                # to know or care which case it is.
                chat_id = payload.get("chat_id", "")
                call_kind = payload.get("call_kind")
                if call_kind not in ("voice", "video") or not chatstore.is_member(chat_id, user_id):
                    continue
                chat = db.query_one("SELECT type FROM chats WHERE id = ?", (chat_id,))
                # DMs use the separate 1:1 call_invite/call_answer/call_ice
                # relay instead (the frontend already branches on chat.type
                # === "dm" before ever sending this) — every OTHER chat type
                # (group, channel, community, community_channel) is fair
                # game for a group call/meeting, not just plain 'group'.
                # This used to reject anything but 'group' with a silent
                # `continue` and no reply at all: a meeting scheduled in a
                # channel or community could be created (create_meeting has
                # no chat-type restriction of its own) but its "Join now"
                # button would send this and get back nothing — no error,
                # no roster — leaving the client stuck in the optimistic
                # "active, zero participants" state join() sets before
                # ever hearing back from the server.
                if chat is None or chat["type"] == "dm":
                    await socket.send_json({
                        "type": "call_error", "chat_id": chat_id,
                        "reason": "This chat can't host a group call",
                    })
                    continue
                if not calling_permitted(chat_id, user_id):
                    await socket.send_json({
                        "type": "call_error", "chat_id": chat_id,
                        "reason": "Calling is off for you in this chat",
                    })
                    continue

                room = _group_calls.setdefault(chat_id, {})

                # A reconnect within the grace window (see
                # _leave_all_group_calls) — this user's entry is still in
                # `room` because the delayed removal hasn't fired yet.
                # Cancel it and treat this as resuming, not a fresh join:
                # nobody else was ever told they left, so nothing should be
                # re-announced to the room, and an already-admitted
                # participant shouldn't be bounced back into the waiting
                # room or re-prompted for the password.
                pending_leave = _group_call_leave_tasks.pop((chat_id, user_id), None)
                if pending_leave:
                    pending_leave.cancel()
                rejoining = user_id in room

                is_first = len(room) == 0
                host_id = _group_call_hosts.get(chat_id)

                # The waiting-room/password settings live on whichever
                # meeting is currently live for this chat — a plain,
                # meeting-less group call (started from the header's own
                # call buttons rather than Planner) has neither, same as
                # every call before either setting existed.
                live_meeting = db.query_one(
                    "SELECT waiting_room, password_hash FROM meetings "
                    "WHERE chat_id = ? AND status = 'live' ORDER BY created_at DESC LIMIT 1",
                    (chat_id,),
                )
                if live_meeting and live_meeting["password_hash"] and user_id != host_id and not rejoining:
                    supplied = str(payload.get("password", ""))
                    if not auth.verify_password(supplied, live_meeting["password_hash"]):
                        await socket.send_json({
                            "type": "call_error", "chat_id": chat_id, "reason": "Incorrect meeting password",
                        })
                        continue
                if (live_meeting and live_meeting["waiting_room"] and not is_first
                        and user_id != host_id and not rejoining):
                    _group_call_waiting.setdefault(chat_id, {})[user_id] = _participant_info(user_id)
                    if host_id:
                        await hub.send_to_user(host_id, {
                            "type": "group_call_join_request", "chat_id": chat_id, **_participant_info(user_id),
                        })
                    await socket.send_json({"type": "group_call_waiting", "chat_id": chat_id})
                    continue

                # Who the joiner needs to (re)connect to — excludes their
                # own stale entry on a rejoin, since a reconnected socket's
                # client rebuilds every peer connection from scratch and
                # doesn't need to hear about itself.
                roster = [info for uid, info in room.items() if uid != user_id]
                room[user_id] = _participant_info(user_id)
                if is_first:
                    _group_call_hosts[chat_id] = user_id

                await socket.send_json({
                    "type": "group_call_roster", "chat_id": chat_id, "participants": roster,
                    **_group_call_room_state(chat_id),
                })
                if rejoining:
                    pass  # resumed silently — the room was never told this person left
                elif is_first:
                    # Ring only members who currently allow calls here —
                    # everyone else simply never hears about this room, the
                    # same as if they weren't a member at all.
                    eligible = db.query_all(
                        """
                        SELECT cm.user_id FROM chat_members cm
                        JOIN users u ON u.id = cm.user_id
                        WHERE cm.chat_id = ? AND cm.user_id != ?
                          AND u.calling_enabled = 1 AND cm.calls_enabled = 1
                        """,
                        (chat_id, user_id),
                    )
                    for row in eligible:
                        await hub.send_to_user(row["user_id"], {
                            "type": "group_call_invite", "chat_id": chat_id, "call_kind": call_kind,
                            **room[user_id],
                        })
                        await notify_incoming_call(row["user_id"], chat_id, room[user_id]["name"], call_kind)
                else:
                    # Tell everyone ALREADY in the room about the new arrival,
                    # so their clients know to expect an offer from them.
                    await hub.send_to_chat(chat_id, {
                        "type": "group_call_participant_joined", "chat_id": chat_id,
                        **room[user_id],
                    }, exclude_user=user_id)

            elif kind == "group_call_leave":
                chat_id = payload.get("chat_id", "")
                room = _group_calls.get(chat_id)
                if room and user_id in room:
                    pending_leave = _group_call_leave_tasks.pop((chat_id, user_id), None)
                    if pending_leave:
                        pending_leave.cancel()
                    del room[user_id]
                    if room:
                        await hub.send_to_chat(chat_id, {
                            "type": "group_call_participant_left", "chat_id": chat_id, "user_id": user_id,
                        })
                        await _reassign_host_if_needed(chat_id, user_id, room)
                        await _clear_departing_user_special_state(chat_id, user_id)
                    else:
                        del _group_calls[chat_id]
                        _group_call_hosts.pop(chat_id, None)
                        _group_call_waiting.pop(chat_id, None)
                        _group_call_permissions.pop(chat_id, None)
                        _group_call_screen_sharer.pop(chat_id, None)
                        _group_call_spotlight.pop(chat_id, None)
                        await _end_live_meeting_for_chat(chat_id)

            elif kind in ("group_call_admit", "group_call_deny"):
                chat_id = payload.get("chat_id", "")
                target_id = payload.get("target", "")
                if _group_call_hosts.get(chat_id) != user_id:
                    continue
                waiting = _group_call_waiting.get(chat_id, {})
                if target_id not in waiting:
                    continue
                del waiting[target_id]
                if kind == "group_call_admit":
                    await _admit_to_group_call(chat_id, target_id)
                else:
                    await hub.send_to_user(target_id, {"type": "group_call_join_denied", "chat_id": chat_id})

            elif kind == "group_call_force_mute_all":
                # Genuinely "force": the server can't reach into someone
                # else's microphone, but every client that receives this
                # honors it by muting itself — the same trust model as a
                # meeting app's "mute all" button anywhere else.
                chat_id = payload.get("chat_id", "")
                room = _group_calls.get(chat_id)
                if not room or _group_call_hosts.get(chat_id) != user_id:
                    continue
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_force_muted", "chat_id": chat_id,
                }, exclude_user=user_id)

            elif kind == "group_call_kick":
                chat_id = payload.get("chat_id", "")
                target_id = payload.get("target", "")
                room = _group_calls.get(chat_id)
                if not room or _group_call_hosts.get(chat_id) != user_id or target_id not in room:
                    continue
                if target_id == user_id:
                    continue  # a host removing themself is just "leave"
                del room[target_id]
                await hub.send_to_user(target_id, {"type": "group_call_kicked", "chat_id": chat_id})
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_participant_left", "chat_id": chat_id, "user_id": target_id,
                }, exclude_user=target_id)
                await _clear_departing_user_special_state(chat_id, target_id)

            elif kind == "group_call_transfer_host":
                # Handing the moderation role to someone else, deliberately —
                # unlike _reassign_host_if_needed, which only fires when the
                # current host disappears. Reuses that same broadcast type/
                # shape, so every client's existing group_call_host_changed
                # handler already does the right thing with this.
                chat_id = payload.get("chat_id", "")
                target_id = payload.get("target", "")
                room = _group_calls.get(chat_id)
                if not room or _group_call_hosts.get(chat_id) != user_id or target_id not in room:
                    continue
                if target_id == user_id:
                    continue
                _group_call_hosts[chat_id] = target_id
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_host_changed", "chat_id": chat_id, "host_id": target_id,
                })

            elif kind == "group_call_set_permission":
                # Host-only: decides whether screen share / whiteboard are
                # open to anyone currently in the room, or restricted to the
                # host alone. Missing from _group_call_permissions defaults
                # to "everyone" — see the dict's own docstring above.
                chat_id = payload.get("chat_id", "")
                feature = payload.get("feature", "")
                policy = payload.get("policy", "")
                if (_group_call_hosts.get(chat_id) != user_id
                        or feature not in ("screen_share", "whiteboard")
                        or policy not in ("host", "everyone")):
                    continue
                permissions = _group_call_permissions.setdefault(
                    chat_id, {"screen_share": "everyone", "whiteboard": "everyone"})
                permissions[feature] = policy
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_permissions_changed", "chat_id": chat_id, "permissions": permissions,
                })

            elif kind == "group_call_mute_participant":
                # A single-target sibling of group_call_force_mute_all, same
                # trust model: the server cannot reach into someone else's
                # microphone, it can only ask their own client to mute
                # itself, which every client does unconditionally on
                # receipt. Everyone ELSE in the room gets a separate,
                # informational broadcast so their tile can show a "muted by
                # host" badge on the target.
                chat_id = payload.get("chat_id", "")
                target_id = payload.get("target", "")
                room = _group_calls.get(chat_id)
                if not room or _group_call_hosts.get(chat_id) != user_id or target_id not in room:
                    continue
                if target_id == user_id:
                    continue
                await hub.send_to_user(target_id, {"type": "group_call_muted_by_host", "chat_id": chat_id})
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_participant_muted", "chat_id": chat_id, "user_id": target_id,
                }, exclude_user=target_id)

            elif kind == "group_call_self_unmuted":
                # The client-side counterpart to group_call_participant_muted
                # above — clears the "muted by host" badge everyone else
                # sees on this participant's tile once they turn their own
                # mic back on. Sent on every unmute regardless of whether it
                # was actually a host mute (the server has no record of
                # that), so this is a harmless no-op badge-clear the rest of
                # the time.
                chat_id = payload.get("chat_id", "")
                room = _group_calls.get(chat_id)
                if not room or user_id not in room:
                    continue
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_participant_unmuted", "chat_id": chat_id, "user_id": user_id,
                }, exclude_user=user_id)

            elif kind == "group_call_spotlight":
                # target: null clears the spotlight. Host-only, and pinned
                # for everyone in the room at once — this isn't a personal
                # "pin for my own view" preference.
                chat_id = payload.get("chat_id", "")
                target_id = payload.get("target")
                room = _group_calls.get(chat_id)
                if not room or _group_call_hosts.get(chat_id) != user_id:
                    continue
                if target_id is not None and target_id != user_id and target_id not in room:
                    continue
                if target_id is None:
                    _group_call_spotlight.pop(chat_id, None)
                else:
                    _group_call_spotlight[chat_id] = target_id
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_spotlight_changed", "chat_id": chat_id, "user_id": target_id,
                })

            elif kind in ("group_call_screen_share_start", "group_call_screen_share_stop"):
                # Screen share used to be pure client-side replaceTrack with
                # no server involvement at all — nobody else's client had any
                # authoritative signal that it was even happening, which is
                # why a share could go out with nothing on the other end
                # visibly reacting to it. This makes "who is sharing" a real
                # fact the server tracks and broadcasts, and (for start) the
                # one place screen-share's own host-only policy is actually
                # enforced, same shape as the whiteboard_open check below.
                chat_id = payload.get("chat_id", "")
                room = _group_calls.get(chat_id)
                if not room or user_id not in room:
                    continue
                if kind == "group_call_screen_share_start":
                    policy = _group_call_permissions.get(chat_id, {}).get("screen_share", "everyone")
                    if policy == "host" and _group_call_hosts.get(chat_id) != user_id:
                        await socket.send_json({
                            "type": "group_call_action_denied", "chat_id": chat_id, "action": "screen_share",
                            "reason": "Only the host can share their screen right now",
                        })
                        continue
                    _group_call_screen_sharer[chat_id] = user_id
                    await hub.send_to_chat(chat_id, {
                        "type": "group_call_screen_share_started", "chat_id": chat_id, "user_id": user_id,
                    })
                else:
                    if _group_call_screen_sharer.get(chat_id) == user_id:
                        del _group_call_screen_sharer[chat_id]
                    await hub.send_to_chat(chat_id, {
                        "type": "group_call_screen_share_stopped", "chat_id": chat_id, "user_id": user_id,
                    })

            elif kind == "group_call_add_people":
                # Any current participant can invite specific fellow chat
                # members who weren't rung the first time round (they
                # weren't online yet, or missed it) — this is the
                # incremental version of the whole-chat ring group_call_start
                # already does for a brand new room, restricted to the
                # requester's own choices rather than everyone.
                chat_id = payload.get("chat_id", "")
                call_kind = payload.get("call_kind")
                target_ids = payload.get("targets") or []
                room = _group_calls.get(chat_id)
                if not room or user_id not in room or call_kind not in ("voice", "video"):
                    continue
                for target_id in target_ids:
                    if (
                        target_id in room
                        or not chatstore.is_member(chat_id, target_id)
                        or not calling_permitted(chat_id, target_id)
                    ):
                        continue
                    await hub.send_to_user(target_id, {
                        "type": "group_call_invite", "chat_id": chat_id, "call_kind": call_kind,
                        **_participant_info(user_id),
                    })
                    await notify_incoming_call(
                        target_id, chat_id, _participant_info(user_id)["name"], call_kind)

            elif kind in GROUP_CALL_SIGNAL_TYPES:
                chat_id = payload.get("chat_id", "")
                to_user_id = payload.get("to", "")
                if not chat_id or not to_user_id or not group_call_target_ok(chat_id, user_id, to_user_id):
                    continue

                relay = {"type": kind, "chat_id": chat_id, "from": user_id}
                if kind in ("group_call_offer", "group_call_answer"):
                    relay["sdp"] = payload.get("sdp")
                elif kind == "group_call_ice":
                    relay["candidate"] = payload.get("candidate")

                await hub.send_to_user(to_user_id, relay)

            elif kind in ("whiteboard_draw", "whiteboard_clear", "whiteboard_open", "whiteboard_close", "whiteboard_laser"):
                # A meeting tool, not a standalone chat feature — scoped to
                # whoever's actually in that chat's call room right now, same
                # as screen share. Nothing is persisted: closing the board
                # (or the call) loses it, exactly like a real whiteboard once
                # everyone leaves the room. The laser pointer is the most
                # ephemeral of all — it never touches the canvas, just a
                # fading dot relayed point-by-point.
                chat_id = payload.get("chat_id", "")
                room = _group_calls.get(chat_id)
                if not room or user_id not in room:
                    continue
                # Opening the board is the one action here host-only policy
                # can restrict — drawing on an already-open board, closing
                # it, and the laser pointer are left alone regardless of
                # policy, same as a real meeting app doesn't re-gate every
                # stroke once the tool itself is available. A denied opener
                # is told directly (rather than just silently not seeing the
                # relay, which never comes back to them anyway per the
                # exclude_user below) so their own optimistic client state
                # gets corrected instead of showing an open board nobody
                # else can see.
                if kind == "whiteboard_open":
                    policy = _group_call_permissions.get(chat_id, {}).get("whiteboard", "everyone")
                    if policy == "host" and _group_call_hosts.get(chat_id) != user_id:
                        await socket.send_json({
                            "type": "group_call_action_denied", "chat_id": chat_id, "action": "whiteboard",
                            "reason": "Only the host can open the whiteboard right now",
                        })
                        continue
                relay = {"type": kind, "chat_id": chat_id, "from": user_id}
                if kind == "whiteboard_draw":
                    relay["stroke"] = payload.get("stroke")
                elif kind == "whiteboard_laser":
                    relay["point"] = payload.get("point")
                await hub.send_to_chat(chat_id, relay, exclude_user=user_id)

            elif kind in ("group_call_reaction", "group_call_raise_hand", "group_call_lower_hand"):
                # Same room-membership gate as the whiteboard — a floating
                # emoji or a raised-hand flag, purely transient, never stored.
                chat_id = payload.get("chat_id", "")
                room = _group_calls.get(chat_id)
                if not room or user_id not in room:
                    continue
                relay = {"type": kind, "chat_id": chat_id, "from": user_id}
                if kind == "group_call_reaction":
                    emoji = payload.get("emoji", "")
                    if emoji not in ("👍", "❤️", "👏", "😂", "🎉"):
                        continue
                    relay["emoji"] = emoji
                await hub.send_to_chat(chat_id, relay, exclude_user=user_id)

            elif kind == "group_call_caption":
                # Each browser transcribes only its OWN microphone (the
                # server never sees or stores audio, transcript included —
                # there is no server-side speech pipeline here at all) and
                # broadcasts the recognized line, same as any other
                # ephemeral in-call signal.
                chat_id = payload.get("chat_id", "")
                text = str(payload.get("text", ""))[:500]
                room = _group_calls.get(chat_id)
                if not room or user_id not in room or not text.strip():
                    continue
                await hub.send_to_chat(chat_id, {
                    "type": "group_call_caption", "chat_id": chat_id, "from": user_id, "text": text,
                }, exclude_user=user_id)

    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove(user_id, socket)
        await _leave_all_group_calls(user_id)
        db.execute("UPDATE users SET last_seen = ? WHERE id = ?", (time.time(), user_id))

        # Only announce going offline once the user's LAST device disconnects.
        # Announcing on every socket close made someone with a phone and a
        # laptop appear to go offline whenever either one closed a tab.
        if not hub.is_online(user_id):
            await hub.broadcast_presence(user_id, online=False)


# ── Superadmin ────────────────────────────────────────────────────────────────
# Everything here depends on require_superadmin, not current_user — see that
# function's own docstring for why the check lives in the dependency rather
# than at the top of each handler.

def _mask_secret(value: str) -> str:
    if not value:
        return ""
    return f"••••{value[-4:]}" if len(value) > 4 else "••••"


@app.get("/admin/stats")
def admin_stats(admin: dict = Depends(require_superadmin)):
    def count(sql: str, params: tuple = ()) -> int:
        return db.query_one(sql, params)["n"]

    return {
        "users": count("SELECT COUNT(*) AS n FROM users"),
        "active_users": count("SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL"),
        "chats": count("SELECT COUNT(*) AS n FROM chats"),
        "messages": count("SELECT COUNT(*) AS n FROM messages"),
        "active_sessions": count("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", (time.time(),)),
        "pending_templates": count("SELECT COUNT(*) AS n FROM message_templates WHERE status = 'pending'"),
    }


@app.get("/admin/users")
def admin_list_users(q: str = Query(default="", max_length=64),
                      limit: int = Query(default=50, ge=1, le=200),
                      offset: int = Query(default=0, ge=0),
                      admin: dict = Depends(require_superadmin)):
    like = f"%{q.lower()}%"
    rows = db.query_all(
        """
        SELECT id, name, username, phone, email, created_at, last_seen,
               disabled_at, is_superadmin, is_bot
        FROM users
        WHERE lower(name) LIKE ? OR lower(username) LIKE ? OR phone LIKE ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        """,
        (like, like, like, limit, offset),
    )
    return [dict(row) for row in rows]


@app.post("/admin/users/{user_id}/disable")
def admin_disable_user(user_id: str, admin: dict = Depends(require_superadmin)):
    if user_id == admin["id"]:
        raise HTTPException(400, "You can't disable your own account from here")
    changed = db.execute("UPDATE users SET disabled_at = ? WHERE id = ?", (time.time(), user_id))
    if changed.rowcount == 0:
        raise HTTPException(404, "User not found")
    # Force them out immediately — otherwise a disabled account with a
    # still-live session keeps working normally until that token expires
    # on its own, which defeats the point of an admin disabling it now.
    db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return {"disabled": True}


@app.post("/admin/users/{user_id}/enable")
def admin_enable_user(user_id: str, admin: dict = Depends(require_superadmin)):
    changed = db.execute("UPDATE users SET disabled_at = NULL WHERE id = ?", (user_id,))
    if changed.rowcount == 0:
        raise HTTPException(404, "User not found")
    return {"enabled": True}


@app.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: str, admin: dict = Depends(require_superadmin)):
    if user_id == admin["id"]:
        raise HTTPException(400, "You can't delete your own account from here")
    if db.query_one("SELECT id FROM users WHERE id = ?", (user_id,)) is None:
        raise HTTPException(404, "User not found")
    delete_user_account(user_id)
    return {"deleted": True}


@app.get("/admin/integrations")
def admin_get_integrations(admin: dict = Depends(require_superadmin)):
    """
    Masked current values plus a `configured` flag per provider — the raw
    secrets never round-trip back to the browser once saved, same principle
    as an API key: the panel is write-only for the value itself, read-only
    for "is something set, and roughly which one."
    """
    msg91_key, msg91_template, msg91_var = sms._config()
    api_key, domain, base_url, sender = email_delivery._config()
    return {
        "sms": {
            "configured": bool(msg91_key and msg91_template),
            "msg91_auth_key": _mask_secret(msg91_key),
            "msg91_template_id": msg91_template,
            "msg91_var_name": msg91_var,
        },
        "email": {
            "configured": bool(api_key and domain),
            "mailgun_api_key": _mask_secret(api_key),
            "mailgun_domain": domain,
            "mailgun_base_url": base_url,
            "mailgun_from": sender,
        },
    }


@app.put("/admin/integrations")
def admin_update_integrations(request: UpdateIntegrationSettingsRequest,
                               admin: dict = Depends(require_superadmin)):
    """Only the fields actually sent get written — leaving one blank in the
    panel means "don't touch it," not "clear it."""
    fields = request.model_dump(exclude_none=True)
    for key, value in fields.items():
        db.set_setting(key, value)
    return admin_get_integrations(admin)


@app.post("/admin/integrations/test-sms")
def admin_test_sms(request: TestSmsRequest, admin: dict = Depends(require_superadmin)):
    result = sms.send_otp(request.phone, "000000")
    return {"result": result}


@app.post("/admin/integrations/test-email")
def admin_test_email(request: TestEmailRequest, admin: dict = Depends(require_superadmin)):
    result = email_delivery.send_otp(request.email, "000000")
    return {"result": result}


TEMPLATE_STATUSES = ("pending", "approved", "rejected")


@app.get("/admin/templates")
def admin_list_templates(status: str = Query(default=""),
                          limit: int = Query(default=200, ge=1, le=1000),
                          offset: int = Query(default=0, ge=0),
                          admin: dict = Depends(require_superadmin)):
    if status and status not in TEMPLATE_STATUSES:
        # A silently-empty [] here used to be indistinguishable from "no
        # templates in that state" — a typo'd status (?status=aproved) would
        # read as "nothing pending" instead of "you made a mistake."
        raise HTTPException(400, f"status must be one of {', '.join(TEMPLATE_STATUSES)}")

    if status:
        rows = db.query_all(
            """
            SELECT t.*, u.name AS owner_name, u.username AS owner_username
            FROM message_templates t JOIN users u ON u.id = t.user_id
            WHERE t.status = ? ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (status, limit, offset),
        )
    else:
        rows = db.query_all(
            """
            SELECT t.*, u.name AS owner_name, u.username AS owner_username
            FROM message_templates t JOIN users u ON u.id = t.user_id
            ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )
    return [dict(row) for row in rows]


@app.post("/admin/templates/{template_id}/approve")
def admin_approve_template(template_id: str, admin: dict = Depends(require_superadmin)):
    changed = db.execute(
        "UPDATE message_templates SET status = 'approved', reviewed_at = ? WHERE id = ?",
        (time.time(), template_id),
    )
    if changed.rowcount == 0:
        raise HTTPException(404, "Template not found")
    return {"status": "approved"}


@app.post("/admin/templates/{template_id}/reject")
def admin_reject_template(template_id: str, admin: dict = Depends(require_superadmin)):
    changed = db.execute(
        "UPDATE message_templates SET status = 'rejected', reviewed_at = ? WHERE id = ?",
        (time.time(), template_id),
    )
    if changed.rowcount == 0:
        raise HTTPException(404, "Template not found")
    return {"status": "rejected"}


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"app": "TalkEx API", "version": "2.0.0", "status": "running"}


@app.get("/health")
def health():
    """
    Liveness only. It deliberately does not touch the database: if it did, a
    database hiccup would fail the health check and get the process restarted,
    which fixes nothing and loses every open WebSocket.
    """
    return {"status": "ok", "time": time.time()}


@app.get("/ready")
def ready():
    """Readiness: this one does check the database, because that is the point."""
    try:
        db.query_one("SELECT 1")
        return {"ready": True, "online_users": len(hub.online_users())}
    except Exception:
        # This endpoint has no auth (a load balancer needs to hit it before
        # anyone is signed in), so the raw exception text — which can
        # include filesystem paths or sqlite3's own internal diagnostics —
        # goes to the server log instead of the response body. A generic
        # message is all an unauthenticated caller needs: something's wrong.
        logger.exception("Readiness check failed")
        raise HTTPException(503, "Database unavailable")
