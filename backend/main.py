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
import math
import os
import re
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
import fcm
import qr
import scheduler
import sms
import uploads
from chatstore import new_id
from models import (
    AddContactRequest, AddMembersRequest, BroadcastRecipientsRequest, BulkSendRequest,
    CreateAutoReplyRuleRequest, UpdateAutoReplyRuleRequest,
    ChatSettingsRequest, CommentRequest, ConfirmEmailRequest, CreateApiKeyRequest, CreateBroadcastRequest,
    CreateCannedReplyRequest, CreateChannelRequest, CreateCommunityRequest, CreateGroupRequest,
    CreateLabelRequest, CreateMeetingRequest, CreateProductRequest, CreateSubChannelRequest,
    CreateTemplateRequest, CreateTopicRequest, CreateWebhookRequest,
    CreateBreakoutRoomsRequest, DisappearingRequest, InstantMeetingRequest,
    EditMessageRequest, FeedbackRequest, ForwardRequest, ForwardStoryRequest, HighlightStoryRequest,
    LiveLocationUpdateRequest, LoginRequest,
    MatchContactsRequest,
    FcmTokenRequest, PushSubscribeRequest, PushUnsubscribeRequest, ReactRequest, ReadRequest,
    RegisterRequest, RemoveTwoStepRequest, RequestEmailOtpRequest, RequestOtpRequest,
    ReportRequest, RescheduleRequest, RsvpRequest,
    ScheduleRequest, SendMessageRequest, SetChatLabelsRequest, SetNearbyRequest, SetPasswordRequest,
    SetPinRequest, SetRoleRequest,
    SetSessionShortLivedRequest,
    SetTwoStepRequest, SetUsernameRequest, StartLinkRequest, StoryAudienceRequest, StoryRequest,
    TestEmailRequest, TestSmsRequest,
    UpdateChatInfoRequest, UpdateContactRequest, UpdateIntegrationSettingsRequest, UpdateMeetingRequest,
    UpdateProductRequest, UpdateProfileRequest, VerifyOtpRequest, VerifyTwoStepRequest, VoteRequest,
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

# https://localhost / capacitor://localhost / http://localhost are the origins
# the packaged Android app (Capacitor's androidScheme: "https") sends its
# requests from. They're merged in unconditionally — not just left in the
# default — so that setting CORS_ALLOWED_ORIGINS on Render (e.g. to the
# Hostinger domain) can't accidentally drop them and break login from the APK
# while the same code keeps working fine from a browser tab.
CAPACITOR_ORIGINS = ["https://localhost", "capacitor://localhost", "http://localhost"]

ALLOWED_ORIGINS = list(dict.fromkeys(
    [
        origin.strip()
        for origin in os.environ.get("CORS_ALLOWED_ORIGINS", DEFAULT_DEV_ORIGINS).split(",")
        if origin.strip()
    ]
    + CAPACITOR_ORIGINS
))

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
    # A badge, not a credential — shown to every viewer the same way
    # is_verified already is on a chat, so it's exposed as a plain bool here
    # rather than only surfacing on GET /me the way quality_flagged_at does.
    user["blue_tick"] = bool(user.pop("blue_tick_awarded_at", None))
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
        # Whether this account has been auto-flagged for abusive bulk
        # sending is moderation-internal, same as is_superadmin — a
        # recipient sees the effect (they stop getting cold-messaged) but
        # has no business reading the flag itself off someone else's profile.
        user.pop("quality_flagged_at", None)
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

    # If they arrived via someone's invite link, credit that referrer (and
    # maybe hand them their blue tick) — see apply_referral.
    apply_referral(user_id, request.ref)

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

# TalkEx's own equivalent of WhatsApp Business API's 24-hour customer
# service window: a bulk sender may free-form-reply this long after the
# recipient last messaged them first, without needing an explicit opt-in on
# file. See has_open_conversation_window() / bulk_send_message() below.
BUSINESS_WINDOW_SECONDS = 24 * 3600

# TalkEx's stand-in for WhatsApp's quality-rating system, since there is no
# per-number "tier" here to downgrade — enough blocks/reports against a bulk
# sender in this trailing window and their API access is auto-suspended
# (see sender_reputation_flagged()), rather than relying on a human
# moderator to notice the /report queue before real damage is done.
REPUTATION_WINDOW_SECONDS = 7 * 24 * 3600
ABUSE_SIGNAL_THRESHOLD = 5

# Activity-earned blue tick: send at least one message in this many distinct
# DMs and the badge is awarded automatically, no admin involved — unlike
# is_business (admin-granted) or a chat's own is_verified. Deliberately
# "distinct DMs I've sent INTO", not "distinct DMs I'm a member of" — a DM
# that only ever received messages from the other side shouldn't count
# toward "chatted with", and it's not group members either, so mass-adding
# someone to groups can't farm it.
BLUE_TICK_TARGET = 10

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
    apply_referral(user_id, request.ref)
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


# ── Chat labels ──────────────────────────────────────────────────────────────
# WhatsApp-Business-style tags — see chat_labels' own table comment for how
# these differ from the plain-text, one-per-chat chat_members.folder.

@app.post("/me/labels")
def create_label(request: CreateLabelRequest, user: dict = Depends(current_user)):
    label_id = new_id("label")
    db.execute(
        "INSERT INTO chat_labels (id, owner_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
        (label_id, user["id"], request.name.strip(), request.color, time.time()),
    )
    return {"id": label_id, "name": request.name.strip(), "color": request.color}


@app.get("/me/labels")
def list_labels(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT id, name, color FROM chat_labels WHERE owner_id = ? ORDER BY created_at",
        (user["id"],),
    )
    return [dict(row) for row in rows]


@app.delete("/me/labels/{label_id}")
def delete_label(label_id: str, user: dict = Depends(current_user)):
    """Deleting a label also drops it from every chat it was applied to —
    the assignments row has no meaning once the label itself is gone."""
    changed = db.execute(
        "DELETE FROM chat_labels WHERE id = ? AND owner_id = ?", (label_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Label not found")
    return {"deleted": True}


@app.put("/chats/{chat_id}/labels")
def set_chat_labels(chat_id: str, request: SetChatLabelsRequest, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    owned = {row["id"] for row in db.query_all(
        "SELECT id FROM chat_labels WHERE owner_id = ?", (user["id"],))}
    unknown = set(request.label_ids) - owned
    if unknown:
        raise HTTPException(400, "One or more label_ids don't belong to you")
    with db.transaction() as conn:
        conn.execute(
            "DELETE FROM chat_label_assignments WHERE chat_id = ? AND user_id = ?",
            (chat_id, user["id"]),
        )
        conn.executemany(
            "INSERT INTO chat_label_assignments (chat_id, label_id, user_id) VALUES (?, ?, ?)",
            [(chat_id, label_id, user["id"]) for label_id in set(request.label_ids)],
        )
    return {"label_ids": request.label_ids}


# ── Product catalog ───────────────────────────────────────────────────────────
# WhatsApp Business Catalog equivalent — a business lists items, then shares
# one into a chat (kind='product'); see send_message's payload snapshot for
# why an already-sent product card never changes if the listing does later.

def _serialise_product(row) -> dict:
    product = dict(row)
    if product.get("image_attachment_id"):
        details = chatstore.attachment_details(product["image_attachment_id"])
        if details:
            product["image"] = details
    return product


@app.post("/me/products")
def create_product(request: CreateProductRequest, user: dict = Depends(current_user)):
    product_id = new_id("product")
    if request.image_attachment_id:
        attached = uploads.attach_to_product(request.image_attachment_id, product_id, user["id"])
        if attached is None:
            raise HTTPException(400, "Invalid or already-used image_attachment_id")
    db.execute(
        """
        INSERT INTO products (id, owner_id, name, description, price_cents, currency,
                              image_attachment_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (product_id, user["id"], request.name.strip(), request.description.strip(),
         request.price_cents, request.currency.upper(), request.image_attachment_id, time.time()),
    )
    return _serialise_product(db.query_one("SELECT * FROM products WHERE id = ?", (product_id,)))


@app.get("/me/products")
def list_my_products(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT * FROM products WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at DESC",
        (user["id"],),
    )
    return [_serialise_product(row) for row in rows]


@app.patch("/me/products/{product_id}")
def update_product(product_id: str, request: UpdateProductRequest, user: dict = Depends(current_user)):
    product = db.query_one("SELECT * FROM products WHERE id = ? AND owner_id = ?",
                           (product_id, user["id"]))
    if product is None:
        raise HTTPException(404, "Product not found")

    fields = request.model_dump(exclude={"archived", "image_attachment_id"}, exclude_none=True)
    if "name" in fields:
        fields["name"] = fields["name"].strip()
    if "description" in fields:
        fields["description"] = fields["description"].strip()
    if "currency" in fields:
        fields["currency"] = fields["currency"].upper()
    if request.archived is not None:
        fields["archived_at"] = time.time() if request.archived else None
    if request.image_attachment_id:
        attached = uploads.attach_to_product(request.image_attachment_id, product_id, user["id"])
        if attached is None:
            raise HTTPException(400, "Invalid or already-used image_attachment_id")
        fields["image_attachment_id"] = request.image_attachment_id

    if fields:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        db.execute(f"UPDATE products SET {assignments} WHERE id = ?", (*fields.values(), product_id))
    return _serialise_product(db.query_one("SELECT * FROM products WHERE id = ?", (product_id,)))


@app.delete("/me/products/{product_id}")
def delete_product(product_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "DELETE FROM products WHERE id = ? AND owner_id = ?", (product_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Product not found")
    return {"deleted": True}


@app.get("/users/{user_id}/products")
def list_user_products(user_id: str, user: dict = Depends(current_user)):
    """Anyone can browse anyone's catalog — same "public unless you say
    otherwise" visibility a profile itself already has; there's no private
    content here, only what its owner chose to list for sale."""
    rows = db.query_all(
        "SELECT * FROM products WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at DESC",
        (user_id,),
    )
    return [_serialise_product(row) for row in rows]


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


# ── Away message + keyword auto-replies (the flow-builder) ─────────────────────
# Away message: WhatsApp Business's blanket auto-reply, on/off via PATCH /me
# (away_enabled, away_message, alongside the other profile flags) — no
# dedicated endpoint needed, since it's just two more fields on the profile
# row. auto_reply_rules layers keyword-triggered responses ("price", "hours")
# on top: checked first, away_message is only the fallback when nothing matches.

AWAY_REPLY_COOLDOWN_SECONDS = 12 * 3600


@app.post("/me/auto-reply-rules")
def create_auto_reply_rule(request: CreateAutoReplyRuleRequest, user: dict = Depends(current_user)):
    rule_id = new_id("rule")
    next_position = db.query_one(
        "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM auto_reply_rules WHERE owner_id = ?",
        (user["id"],),
    )["n"]
    db.execute(
        "INSERT INTO auto_reply_rules (id, owner_id, trigger_text, response_text, position, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (rule_id, user["id"], request.trigger_text.strip(), request.response_text.strip(),
         next_position, time.time()),
    )
    return dict(db.query_one("SELECT * FROM auto_reply_rules WHERE id = ?", (rule_id,)))


@app.get("/me/auto-reply-rules")
def list_auto_reply_rules(user: dict = Depends(current_user)):
    rows = db.query_all(
        "SELECT * FROM auto_reply_rules WHERE owner_id = ? ORDER BY position, created_at",
        (user["id"],),
    )
    return [dict(row) for row in rows]


@app.patch("/me/auto-reply-rules/{rule_id}")
def update_auto_reply_rule(rule_id: str, request: UpdateAutoReplyRuleRequest,
                           user: dict = Depends(current_user)):
    rule = db.query_one("SELECT * FROM auto_reply_rules WHERE id = ? AND owner_id = ?",
                        (rule_id, user["id"]))
    if rule is None:
        raise HTTPException(404, "Rule not found")
    fields = request.model_dump(exclude_none=True)
    if "trigger_text" in fields:
        fields["trigger_text"] = fields["trigger_text"].strip()
    if "response_text" in fields:
        fields["response_text"] = fields["response_text"].strip()
    if fields:
        assignments = ", ".join(f"{name} = ?" for name in fields)
        db.execute(f"UPDATE auto_reply_rules SET {assignments} WHERE id = ?",
                  (*fields.values(), rule_id))
    return dict(db.query_one("SELECT * FROM auto_reply_rules WHERE id = ?", (rule_id,)))


@app.delete("/me/auto-reply-rules/{rule_id}")
def delete_auto_reply_rule(rule_id: str, user: dict = Depends(current_user)):
    changed = db.execute(
        "DELETE FROM auto_reply_rules WHERE id = ? AND owner_id = ?", (rule_id, user["id"]))
    if changed.rowcount == 0:
        raise HTTPException(404, "Rule not found")
    return {"deleted": True}


async def maybe_send_away_reply(background_tasks: BackgroundTasks, chat_id: str, sender_id: str,
                                text: str = ""):
    """
    Auto-replies at most once per cooldown window per conversation, so a
    back-and-forth doesn't get the same canned line on every message. The
    reply is an entirely ordinary message written by the away user's own
    account — it shows up and behaves exactly like they typed it themselves,
    not a system notice.

    Keyword rules are checked first (first trigger, by position, that's a
    case-insensitive substring of the incoming text, wins); away_message is
    only ever the fallback when no rule matched. Both share the one cooldown
    gate below — a real chatbot answering the same question twice in one
    burst is exactly the noise the cooldown exists to prevent.
    """
    peer_id = dm_peer_id(chat_id, sender_id)
    if not peer_id:
        return
    owner = db.query_one("SELECT * FROM users WHERE id = ?", (peer_id,))
    if not owner:
        return

    reply_text = None
    lowered = text.lower()
    for rule in db.query_all(
        "SELECT * FROM auto_reply_rules WHERE owner_id = ? ORDER BY position, created_at",
        (peer_id,),
    ):
        if rule["trigger_text"].lower() in lowered:
            reply_text = rule["response_text"]
            break
    if reply_text is None:
        if not owner["away_enabled"] or not owner["away_message"].strip():
            return
        reply_text = owner["away_message"]

    last_from_owner = db.query_one(
        "SELECT created_at FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1",
        (chat_id, peer_id),
    )
    if last_from_owner and time.time() - last_from_owner["created_at"] < AWAY_REPLY_COOLDOWN_SECONDS:
        return

    background_tasks.add_task(_send_away_reply, chat_id, peer_id, reply_text)


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


@app.post("/push/fcm-token")
def register_fcm_token(request: FcmTokenRequest, user: dict = Depends(current_user)):
    """
    Register (or move) this native device's FCM token to the current account.

    Keyed by `token`, which is unique per app-install: re-registering the same
    token (app relaunch, or a different account signing in on the same device)
    just re-points it at whoever is signed in now, so a device never pushes to
    a stale account.
    """
    db.execute(
        "INSERT INTO device_tokens (token, user_id, platform, created_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, "
        "platform = excluded.platform, created_at = excluded.created_at",
        (request.token, user["id"], request.platform or "android", time.time()),
    )
    return {"registered": True}


@app.delete("/push/fcm-token")
def unregister_fcm_token(request: FcmTokenRequest, user: dict = Depends(current_user)):
    """Drop this device's token — e.g. on sign-out, so it stops receiving push."""
    db.execute("DELETE FROM device_tokens WHERE token = ? AND user_id = ?",
              (request.token, user["id"]))
    return {"registered": False}


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

    # Native (FCM) devices for the same set of users — the Android app can't
    # receive the Web Push above. No-op when FCM isn't configured.
    if fcm.is_configured():
        tokens = db.query_all(
            f"SELECT token FROM device_tokens WHERE user_id IN ({placeholders})",
            tuple(user_ids),
        )
        for row in tokens:
            result = await asyncio.to_thread(fcm.send, row["token"], title, body, data)
            if result == "gone":
                db.execute("DELETE FROM device_tokens WHERE token = ?", (row["token"],))


async def notify_offline_members(chat_id: str, sender_id: str, title: str, body: str,
                                  chat_type: str = "dm"):
    """
    Web Push for whoever isn't reachable over the live socket right now.

    Deliberately not "everyone who isn't the sender" — a member with an open
    tab already sees the message arrive over the socket in real time, and
    pushing them a duplicate OS notification for something already on their
    screen is exactly the kind of noise that gets a real app's notifications
    switched off entirely.

    `chat_type` picks which per-type toggle (Settings > Notifications) gates
    this push: a DM checks notif_dm, anything else (group/channel/community/
    broadcast fan-out) checks notif_groups. Someone who's turned a category
    off still sees the message the moment they open the app — this only
    skips the OS-level push for it.
    """
    pref_column = "notif_dm" if chat_type == "dm" else "notif_groups"
    member_rows = db.query_all(
        f"SELECT user_id FROM chat_members m JOIN users u ON u.id = m.user_id "
        f"WHERE m.chat_id = ? AND m.user_id != ? AND u.{pref_column} = 1",
        (chat_id, sender_id),
    )
    # has_connection (any open socket), not is_online (focused) — per its own
    # docstring, a backgrounded-but-connected tab already gets this message
    # over its live socket, so pushing it too was a redundant duplicate
    # notification on top of what the app already delivered silently.
    offline_ids = [row["user_id"] for row in member_rows if not hub.has_connection(row["user_id"])]
    await push_to_users(offline_ids, title, body, {"chat_id": chat_id})


async def notify_incoming_call(user_id: str, chat_id: str, caller_name: str, call_kind: str,
                               caller_id: str = ""):
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
    callee = db.query_one("SELECT notif_calls FROM users WHERE id = ?", (user_id,))
    if callee is not None and not callee["notif_calls"]:
        return
    verb = "Video call" if call_kind == "video" else "Voice call"
    await push_to_users(
        [user_id], f"{verb} from {caller_name}", "Tap to open TalkEx and answer",
        # `from`/`call_kind`/`caller_name` let the native Android service build a
        # full-screen incoming-call notification with Accept/Decline, and let the
        # app ask the caller to re-send the offer when answered from cold start.
        {"chat_id": chat_id, "incoming_call": True, "from": caller_id,
         "call_kind": call_kind, "caller_name": caller_name},
    )


def refresh_quality_flag(target_id: str) -> None:
    """
    Re-checks whether `target_id` has crossed ABUSE_SIGNAL_THRESHOLD blocks +
    reports in the trailing REPUTATION_WINDOW_SECONDS, and stamps
    users.quality_flagged_at the moment it first does — TalkEx's own
    equivalent of a WhatsApp number's quality rating dropping to Red. Called
    from block_user() and submit_report() (wherever a new signal is added),
    not from the bulk_send_message() hot path, so a flagged sender's gate
    check is a plain column read rather than re-aggregating both tables on
    every single send.

    Deliberately does nothing once quality_flagged_at is already set: an
    admin's admin_unflag_quality() override is meant to hold until fresh
    abuse re-trips it, not get silently re-flagged by a report filed the
    same week the moderator already reviewed and dismissed.
    """
    since = time.time() - REPUTATION_WINDOW_SECONDS
    already_flagged = db.query_one(
        "SELECT quality_flagged_at FROM users WHERE id = ?", (target_id,)
    )
    if already_flagged is None or already_flagged["quality_flagged_at"]:
        return
    block_count = db.query_one(
        "SELECT COUNT(*) AS n FROM blocks WHERE blocked_id = ? AND created_at > ?",
        (target_id, since),
    )["n"]
    report_count = db.query_one(
        "SELECT COUNT(*) AS n FROM reports "
        "WHERE target_type = 'user' AND target_id = ? AND created_at > ?",
        (target_id, since),
    )["n"]
    if (block_count + report_count) >= ABUSE_SIGNAL_THRESHOLD:
        db.execute("UPDATE users SET quality_flagged_at = ? WHERE id = ?",
                   (time.time(), target_id))


def count_referred_signups(user_id: str) -> int:
    """
    How many *new* accounts signed up through `user_id`'s invite link — the
    single number the invite-based blue tick is earned on. Backed by the
    idx_users_referred_by index, so this stays a cheap point lookup even as
    the users table grows.
    """
    return db.query_one(
        "SELECT COUNT(*) AS n FROM users WHERE referred_by = ?",
        (user_id,),
    )["n"]


def apply_referral(new_user_id: str, ref: str | None) -> None:
    """
    Records that `new_user_id` signed up through the invite link of the account
    whose username is `ref`, then re-checks that referrer's blue-tick progress.

    Called from the (synchronous) registration endpoints, so there's no live
    event loop to push a celebratory "blue_tick_awarded" event to the referrer
    from here — the badge is simply set in the DB and the referrer picks it up
    on their next /me refetch or app open (blue_tick_progress). Silently does
    nothing if `ref` is blank, unknown, or points at the new account itself, so
    a bad ?ref= in a link never blocks a signup.
    """
    if not ref:
        return
    referrer = db.query_one("SELECT id FROM users WHERE lower(username) = ?", (ref.lower(),))
    if referrer is None or referrer["id"] == new_user_id:
        return
    db.execute("UPDATE users SET referred_by = ? WHERE id = ?", (referrer["id"], new_user_id))
    maybe_award_blue_tick(referrer["id"])


def maybe_award_blue_tick(user_id: str) -> bool:
    """
    Called when a new account signs up through `user_id`'s invite link. Once
    blue_tick_awarded_at is set this returns false immediately without running
    the count at all, so the aggregate only ever runs for referrers still
    working toward the badge.

    The badge is earned by referring BLUE_TICK_TARGET new signups (people who
    registered via this user's invite link) — not by chatting with N people,
    which an account could rack up on its own. Returns True the moment the
    badge is newly awarded (not on later calls, and not if it was already
    earned before this call) — the one signal the caller needs to push a
    celebratory realtime event.
    """
    row = db.query_one("SELECT blue_tick_awarded_at FROM users WHERE id = ?", (user_id,))
    if row is None or row["blue_tick_awarded_at"]:
        return False
    if count_referred_signups(user_id) < BLUE_TICK_TARGET:
        return False
    db.execute("UPDATE users SET blue_tick_awarded_at = ? WHERE id = ?", (time.time(), user_id))
    return True


def has_business_optin(sender_id: str, recipient_id: str) -> bool:
    """Whether the recipient has an on-file opt-in for this specific sender —
    see the business_optins table comment in db.py for the full mechanic."""
    return db.query_one(
        "SELECT 1 FROM business_optins WHERE sender_id = ? AND recipient_id = ?",
        (sender_id, recipient_id),
    ) is not None


def has_open_conversation_window(sender_id: str, recipient_id: str) -> bool:
    """
    Whether the recipient messaged this sender first within the trailing
    BUSINESS_WINDOW_SECONDS — the same "customer service window" mechanic
    that lets a WhatsApp Business number free-form-reply without a template
    for 24 hours after the customer's last message. Checked against the same
    deterministic dm_<low>_<high> chat id the interactive and bulk send
    paths both already use, so it lines up with whatever chat the two of
    them actually share.
    """
    low, high = sorted([sender_id, recipient_id])
    chat_id = f"dm_{low}_{high}"
    since = time.time() - BUSINESS_WINDOW_SECONDS
    return db.query_one(
        "SELECT 1 FROM messages WHERE chat_id = ? AND sender_id = ? AND created_at > ? "
        "AND unsent_at IS NULL LIMIT 1",
        (chat_id, recipient_id, since),
    ) is not None


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

    Gated by the same two mechanics a WhatsApp Business number is: a
    consent/opt-in check (has_business_optin or an open
    has_open_conversation_window) before a single message goes out, and a
    reputation check (quality_flagged_at, stamped by refresh_quality_flag)
    that suspends the sender entirely once enough recipients have blocked or
    reported them. Without both of these, an API key was previously enough
    to cold-message any registered user with nothing but a reactive block
    able to stop it.
    """
    bulk_rate_limiter.check(sender["id"])

    if sender["quality_flagged_at"]:
        raise HTTPException(
            403,
            "This account's bulk-sending access is suspended due to recent blocks/reports "
            "against it — the same quality-rating mechanic WhatsApp Business enforces. "
            "Contact support for review.",
        )

    recipient = db.query_one("SELECT * FROM users WHERE lower(username) = ?",
                             (request.to.lower(),))
    if recipient is None:
        raise HTTPException(404, "No such username")
    if recipient["id"] == sender["id"]:
        raise HTTPException(400, "Cannot send to yourself")

    if blocked_between(sender["id"], recipient["id"]):
        raise HTTPException(403, "This recipient cannot be messaged")

    if not (has_business_optin(sender["id"], recipient["id"])
            or has_open_conversation_window(sender["id"], recipient["id"])):
        raise HTTPException(
            403,
            "This recipient hasn't opted in to receive messages from this account, and "
            "hasn't messaged first in the last 24 hours. Have them opt in via "
            "POST /business/optin/{your_username}, or wait for them to message you first.",
        )

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


feedback_rate_limiter = RateLimiter(max_events=5, window_seconds=3600)


@app.post("/feedback")
def submit_feedback(request: FeedbackRequest, user: dict = Depends(current_user)):
    """
    Store one in-app feedback submission (the multiple-choice answers plus an
    optional free-text comment). Rate-limited per account so the form can't be
    used to flood the table. Superadmins read it back via GET /admin/feedback.
    """
    feedback_rate_limiter.check(user["id"])
    if not request.answers and not request.comment.strip():
        raise HTTPException(400, "Nothing to submit")
    db.execute(
        "INSERT INTO feedback (id, user_id, answers, comment, created_at) VALUES (?, ?, ?, ?, ?)",
        (new_id("fb"), user["id"], json.dumps(request.answers), request.comment.strip(), time.time()),
    )
    return {"submitted": True}


@app.get("/me/blue-tick-progress")
def blue_tick_progress(user: dict = Depends(current_user)):
    """
    Powers the "invite N friends to earn the blue tick" nudge the client shows
    on every app open until the badge is earned. `earned` mirrors public_user's
    blue_tick field (same underlying column) so the client can trust this one
    response instead of cross-referencing GET /me too. `invited` is how many
    new signups have come in through this user's invite link so far.

    `chatted_with` is kept as an alias of `invited` for backward compatibility
    with any client build still reading the old field name.
    """
    if user.get("blue_tick_awarded_at"):
        return {"invited": BLUE_TICK_TARGET, "chatted_with": BLUE_TICK_TARGET,
                "target": BLUE_TICK_TARGET, "earned": True}
    invited = count_referred_signups(user["id"])
    capped = min(invited, BLUE_TICK_TARGET)
    return {
        "invited": capped,
        "chatted_with": capped,
        "target": BLUE_TICK_TARGET,
        "earned": invited >= BLUE_TICK_TARGET,
    }


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


NEARBY_VISIBILITY_SECONDS = 2 * 3600  # a shared location goes stale after this


@app.put("/me/nearby")
def set_nearby(request: SetNearbyRequest, user: dict = Depends(current_user)):
    """
    Telegram's "People Nearby" — entirely opt-in, and off again the moment
    the user leaves the screen or explicitly disables it (the client is
    expected to call this with enabled=False on unmount, same pattern as
    live location's own stop-sharing call).
    """
    if not request.enabled:
        db.execute(
            "UPDATE users SET nearby_enabled = 0, nearby_lat = NULL, nearby_lng = NULL, "
            "nearby_updated_at = NULL WHERE id = ?",
            (user["id"],),
        )
        return {"enabled": False}

    if request.lat is None or request.lng is None:
        raise HTTPException(400, "lat and lng are required to enable Nearby")

    # Rounded to ~1km (2 decimal places) before it's ever written to disk —
    # "which neighborhood" is enough for this feature; an exact coordinate
    # trail isn't something this needs to keep.
    db.execute(
        "UPDATE users SET nearby_enabled = 1, nearby_lat = ?, nearby_lng = ?, nearby_updated_at = ? "
        "WHERE id = ?",
        (round(request.lat, 2), round(request.lng, 2), time.time(), user["id"]),
    )
    return {"enabled": True}


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@app.get("/discover/nearby")
def list_nearby(radius_km: float = Query(default=50, gt=0, le=1000), user: dict = Depends(current_user)):
    """
    Other opted-in users within radius_km (default 50, capped at 1000) and
    NEARBY_VISIBILITY_SECONDS, nearest first. Requires the caller to have
    shared their own location too — you can't browse who's nearby without
    being findable yourself, the same reciprocity WhatsApp/Telegram's own
    nearby-style features use.
    """
    me = db.query_one(
        "SELECT nearby_enabled, nearby_lat, nearby_lng FROM users WHERE id = ?", (user["id"],))
    if not me or not me["nearby_enabled"]:
        raise HTTPException(400, "Turn on Nearby for yourself first")

    cutoff = time.time() - NEARBY_VISIBILITY_SECONDS
    candidates = db.query_all(
        """
        SELECT id, name, avatar_letter, color, avatar_attachment_id, nearby_lat, nearby_lng
        FROM users
        WHERE nearby_enabled = 1 AND nearby_updated_at > ? AND id != ? AND disabled_at IS NULL
        """,
        (cutoff, user["id"]),
    )
    results = []
    for row in candidates:
        if blocked_between(user["id"], row["id"]):
            continue
        distance_km = _haversine_km(me["nearby_lat"], me["nearby_lng"], row["nearby_lat"], row["nearby_lng"])
        if distance_km > radius_km:
            continue
        # public_user() only knows to scrub credential-shaped columns — the
        # raw coordinates behind this row's distance_km are nobody else's
        # business at all, so they're dropped explicitly rather than trusted
        # to that blocklist.
        person = public_user(row, viewer_id=user["id"])
        person.pop("nearby_lat", None)
        person.pop("nearby_lng", None)
        results.append({**person, "distance_km": round(distance_km, 1)})
    results.sort(key=lambda r: r["distance_km"])
    return results


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


@app.post("/me/cover")
async def set_cover(file: UploadFile = File(...), user: dict = Depends(current_user)):
    """Upload and set a profile cover/banner photo. Same single-call
    upload-and-set shape as /me/avatar."""
    try:
        attachment = await uploads.store(file, user["id"])
    except uploads.UploadTooLarge as error:
        raise HTTPException(413, str(error))
    except uploads.UploadTypeRefused as error:
        raise HTTPException(415, str(error))

    bound = uploads.attach_to_cover(attachment["id"], user["id"])
    if bound is None:
        uploads.delete(attachment["id"])
        raise HTTPException(500, "Could not set the cover photo")

    previous_id = db.query_one("SELECT cover_attachment_id FROM users WHERE id = ?",
                               (user["id"],))["cover_attachment_id"]
    db.execute("UPDATE users SET cover_attachment_id = ? WHERE id = ?", (attachment["id"], user["id"]))
    if previous_id:
        uploads.delete(previous_id)
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


@app.delete("/me/cover")
def remove_cover(user: dict = Depends(current_user)):
    """Remove the cover photo."""
    previous_id = db.query_one("SELECT cover_attachment_id FROM users WHERE id = ?",
                               (user["id"],))["cover_attachment_id"]
    db.execute("UPDATE users SET cover_attachment_id = NULL WHERE id = ?", (user["id"],))
    if previous_id:
        uploads.delete(previous_id)
    return public_user(db.query_one("SELECT * FROM users WHERE id = ?", (user["id"],)), viewer_id=user["id"])


@app.post("/chats/{chat_id}/avatar")
async def set_chat_avatar(chat_id: str, file: UploadFile = File(...),
                          user: dict = Depends(current_user)):
    """Upload and set a group/channel/community photo (admin only). Mirrors
    /me/avatar: a single upload-and-set call, old photo deleted once the new
    one is in place."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] in ("dm", "saved"):
        raise HTTPException(400, "This chat can't have a photo")
    require_manager(chat_id, user["id"])
    try:
        attachment = await uploads.store(file, user["id"])
    except uploads.UploadTooLarge as error:
        raise HTTPException(413, str(error))
    except uploads.UploadTypeRefused as error:
        raise HTTPException(415, str(error))

    bound = uploads.attach_to_chat_avatar(attachment["id"], chat_id, user["id"])
    if bound is None:
        uploads.delete(attachment["id"])
        raise HTTPException(500, "Could not set the chat photo")

    previous_id = db.query_one("SELECT avatar_attachment_id FROM chats WHERE id = ?",
                               (chat_id,))["avatar_attachment_id"]
    db.execute("UPDATE chats SET avatar_attachment_id = ? WHERE id = ?", (attachment["id"], chat_id))
    if previous_id:
        uploads.delete(previous_id)
    await hub.send_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    if not chat["ephemeral"]:
        await post_system_message(chat_id, user["id"], f"{user['name']} changed the group photo")
    return get_chat(chat_id, user)


@app.delete("/chats/{chat_id}/avatar")
async def remove_chat_avatar(chat_id: str, user: dict = Depends(current_user)):
    """Back to the coloured letter avatar (admin only)."""
    chat = require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])
    previous_id = db.query_one("SELECT avatar_attachment_id FROM chats WHERE id = ?",
                               (chat_id,))["avatar_attachment_id"]
    db.execute("UPDATE chats SET avatar_attachment_id = NULL WHERE id = ?", (chat_id,))
    if previous_id:
        uploads.delete(previous_id)
    await hub.send_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    return get_chat(chat_id, user)


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
    anyone who has deactivated their account.

    A blank (or single-character) q used to mean "match everything" — LIKE
    '%%' — so opening New Chat with nothing typed yet handed back the
    entire user base of the app, not just the people this account actually
    knows. Every other directory-style surface here (Contacts) is scoped to
    what the account chose to add; this is the one place that wasn't. Two
    characters is the same floor ChatSearchBar already uses for in-chat
    search, so the UX is consistent app-wide, not a new number invented here.
    """
    if len(q.strip()) < 2:
        return []
    like = f"%{q.lower()}%"
    # Also match by phone number so you can find a TalkEx account the WhatsApp
    # way — type the number and there they are. Digits are compared with the
    # separators stripped from BOTH sides, so "98765 43210" finds "+919876543210".
    phone_digits = "".join(ch for ch in q if ch.isdigit())
    phone_like = f"%{phone_digits}%" if len(phone_digits) >= 4 else None
    rows = db.query_all(
        """
        SELECT * FROM users
        WHERE id != ? AND disabled_at IS NULL
          AND (lower(name) LIKE ? OR lower(username) LIKE ?
               OR (? IS NOT NULL AND replace(replace(replace(phone, ' ', ''), '-', ''), '+', '') LIKE ?))
          AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
        ORDER BY name
        LIMIT ? OFFSET ?
        """,
        (user["id"], like, like, phone_like, phone_like, user["id"], limit, offset),
    )
    return [public_user(row, viewer_id=user["id"]) for row in rows]


@app.post("/users/match-contacts")
def match_contacts(request: MatchContactsRequest, user: dict = Depends(current_user)):
    """
    Given phone numbers from the device's address book, return the ones that
    already have a TalkEx account — WhatsApp's "who from your contacts is on
    here" suggestion list. Numbers are matched on their digits only (so
    formatting/country-code separators don't matter), and the caller is never
    told about numbers that DON'T match, only about accounts that do.
    """
    wanted: dict[str, str] = {}  # normalized digits -> original as sent
    for raw in (request.phones or [])[:2000]:
        digits = "".join(ch for ch in (raw or "") if ch.isdigit())
        if len(digits) >= 6:
            wanted[digits] = raw
    if not wanted:
        return []
    rows = db.query_all(
        """
        SELECT * FROM users
        WHERE id != ? AND disabled_at IS NULL
          AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
        """,
        (user["id"], user["id"]),
    )
    matched = []
    for row in rows:
        digits = "".join(ch for ch in (row["phone"] or "") if ch.isdigit())
        # Suffix match (last 10 digits) so a stored +91… lines up with a local
        # number saved without the country code, and vice-versa.
        if digits and (digits in wanted or digits[-10:] in wanted
                       or any(k.endswith(digits[-10:]) or digits.endswith(k[-10:]) for k in wanted)):
            matched.append(public_user(row, viewer_id=user["id"]))
    return matched


@app.get("/users/by-phone/{phone:path}")
def get_user_by_phone(phone: str, user: dict = Depends(current_user)):
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if len(digits) < 6:
        raise HTTPException(400, "Invalid phone number")
    suffix = digits[-10:]
    row = db.query_one(
        "SELECT * FROM users WHERE phone LIKE ? AND disabled_at IS NULL AND phone != ''",
        (f"%{suffix}",),
    )
    if not row and len(digits) > 10:
        row = db.query_one(
            "SELECT * FROM users WHERE phone LIKE ? AND disabled_at IS NULL AND phone != ''",
            (f"%{digits}",),
        )
    if not row:
        raise HTTPException(404, "No user with that phone number")
    return public_user(row, viewer_id=user["id"])


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
    # A block is the strongest "this sender is unwanted" signal there is —
    # feeds straight into the same reputation check a report does.
    refresh_quality_flag(user_id)
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
    if request.target_type == "user":
        refresh_quality_flag(request.target_id)
    return {"reported": True}


# ── Business messaging consent ──────────────────────────────────────────────
# The opt-in half of the mechanic bulk_send_message() enforces (see
# has_business_optin / has_open_conversation_window above): a recipient
# explicitly agreeing to receive business-initiated messages from a given
# sender, independent of — and outlasting — any single 24-hour conversation
# window. This is TalkEx's own version of a "click to message us on TalkEx"
# opt-in widget/checkbox.

@app.post("/business/optin/{sender_username}")
def optin_to_business(sender_username: str, user: dict = Depends(current_user)):
    sender_row = db.query_one("SELECT * FROM users WHERE lower(username) = ?",
                               (sender_username.lower(),))
    if sender_row is None:
        raise HTTPException(404, "No such username")
    if sender_row["id"] == user["id"]:
        raise HTTPException(400, "Cannot opt in to your own messages")
    db.execute(
        "INSERT OR IGNORE INTO business_optins (sender_id, recipient_id, created_at) "
        "VALUES (?, ?, ?)",
        (sender_row["id"], user["id"], time.time()),
    )
    return {"opted_in": True, "sender": public_user(sender_row, viewer_id=user["id"])}


@app.delete("/business/optin/{sender_username}")
def optout_of_business(sender_username: str, user: dict = Depends(current_user)):
    sender_row = db.query_one("SELECT id FROM users WHERE lower(username) = ?",
                               (sender_username.lower(),))
    if sender_row is None:
        raise HTTPException(404, "No such username")
    db.execute(
        "DELETE FROM business_optins WHERE sender_id = ? AND recipient_id = ?",
        (sender_row["id"], user["id"]),
    )
    return {"opted_in": False}


@app.get("/business/optins")
def list_business_optins(user: dict = Depends(current_user)):
    """Businesses this account has opted in to receive messages from — the
    Settings-screen list of who can message it cold, and the place each one
    would be revoked from."""
    rows = db.query_all(
        "SELECT u.* FROM business_optins b JOIN users u ON u.id = b.sender_id "
        "WHERE b.recipient_id = ? ORDER BY b.created_at DESC",
        (user["id"],),
    )
    return [public_user(row, viewer_id=user["id"]) for row in rows]


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
            m.calls_enabled, m.is_favorite, m.vanish_mode, m.notify_tone,
            MAX(c.last_seq - m.last_read_seq, 0) AS unread
        FROM chat_members AS m
        JOIN chats AS c ON c.id = m.chat_id
        WHERE m.user_id = ? AND COALESCE(c.ephemeral, 0) = 0
        -- Newest ACTIVITY first, not highest seq: last_seq is a per-chat
        -- counter, so ordering by it floated an old chat with many messages
        -- above a brand-new chat with only a couple. The last message's
        -- timestamp is the real "most recent" key; empty chats fall back to
        -- when the chat itself was created so they still sort sensibly.
        ORDER BY m.is_pinned DESC,
          COALESCE((SELECT MAX(msg.created_at) FROM messages AS msg WHERE msg.chat_id = c.id),
                   c.created_at) DESC
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
                   u.avatar_attachment_id, u.last_seen, u.show_last_seen, u.blue_tick_awarded_at
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

    # This caller's own labels on each chat on this page, batched the same
    # way peers/last_messages are above.
    labels_by_chat: dict[str, list[dict]] = defaultdict(list)
    for row in db.query_all(
        f"""
        SELECT a.chat_id, l.id, l.name, l.color FROM chat_label_assignments AS a
        JOIN chat_labels AS l ON l.id = a.label_id
        WHERE a.user_id = ? AND a.chat_id IN ({placeholders})
        """,
        (user["id"], *chat_ids),
    ):
        labels_by_chat[row["chat_id"]].append(
            {"id": row["id"], "name": row["name"], "color": row["color"]})

    chats = []
    for row in rows:
        chat = dict(row)
        chat["labels"] = labels_by_chat.get(chat["id"], [])

        peer = peers.get(chat["id"])
        if peer:
            chat["name"] = peer["name"]
            chat["color"] = peer["color"]
            chat["avatar_letter"] = peer["avatar_letter"]
            chat["avatar_attachment_id"] = peer["avatar_attachment_id"]
            chat["peer_id"] = peer["peer_id"]
            chat["peer_online"] = hub.is_online(peer["peer_id"])
            chat["peer_blue_tick"] = bool(peer["blue_tick_awarded_at"])
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
        "SELECT u.*, m.role, m.permissions, m.joined_at FROM chat_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.chat_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at",
        (chat_id,),
    )
    chat["members"] = [
        {**public_user(row, viewer_id=user["id"]), "role": row["role"],
         "permissions": sorted(chatstore.member_permissions(chat_id, row["id"]))}
        for row in member_rows
    ]
    chat["my_role"] = next((m["role"] for m in chat["members"] if m["id"] == user["id"]), None)
    chat["my_permissions"] = next((m["permissions"] for m in chat["members"] if m["id"] == user["id"]), [])

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
            chat["peer_blue_tick"] = bool(peer["blue_tick_awarded_at"])

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
async def create_group(request: CreateGroupRequest, user: dict = Depends(current_user)):
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

    await post_system_message(chat_id, user["id"], f"{user['name']} created this group")
    if member_ids:
        names = _display_names(list(member_ids))
        if names:
            await post_system_message(
                chat_id, user["id"], f"{user['name']} added {_join_names(names)}")
    return get_chat(chat_id, user)


@app.post("/call-rooms")
def create_call_room(request: CreateGroupRequest, user: dict = Depends(current_user)):
    """
    Create an EPHEMERAL group that only exists to host a multi-party call —
    what "add participant" during a 1:1 call lands in. It's an ordinary group
    under the hood (so the whole group-call mesh, ring/accept and overlay work
    unchanged) but flagged ephemeral, so it never shows up in anyone's chat
    list. The caller is the owner; the current call peer plus whoever they're
    adding come in as members and get rung by the usual group_call_invite.
    """
    member_ids = set(request.member_ids) - {user["id"]}
    if len(member_ids) < 1:
        raise HTTPException(400, "A call room needs at least one other person")
    if len(member_ids) + 1 > MAX_GROUP_MEMBERS:
        raise HTTPException(400, f"A call can have at most {MAX_GROUP_MEMBERS} people")

    chat_id = new_id("callroom")
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO chats (id, type, name, color, avatar_letter, owner_id, created_at, ephemeral) "
            "VALUES (?, 'group', ?, '#6366f1', ?, ?, ?, 1)",
            (chat_id, request.name or "Group call", (request.name or "C")[0].upper(), user["id"], now),
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
async def join_chat(chat_id: str, user: dict = Depends(current_user)):
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

    # Approval-gated: record a pending request and tell the admins, rather than
    # joining outright. Already-members short-circuit to a plain success.
    needs_approval = "require_approval" in chat.keys() and chat["require_approval"]
    if needs_approval and not chatstore.is_member(chat_id, user["id"]):
        db.execute(
            "INSERT OR IGNORE INTO join_requests (chat_id, user_id, created_at) VALUES (?, ?, ?)",
            (chat_id, user["id"], time.time()),
        )
        await hub.send_to_chat(chat_id, {
            "type": "join_request", "chat_id": chat_id, "user_id": user["id"],
        })
        return {"joined": False, "requested": True}

    role = "subscriber" if chat["type"] == "channel" else "member"
    db.execute(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        (chat_id, user["id"], role, time.time()),
    )
    return {"joined": True}


@app.put("/chats/{chat_id}/approval")
def set_join_approval(chat_id: str, enabled: bool = Query(...), user: dict = Depends(current_user)):
    """Admin switch: require approval before someone joining actually becomes a member."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in ("group", "channel", "community"):
        raise HTTPException(400, "Approval applies to groups and channels")
    require_manager(chat_id, user["id"])
    db.execute("UPDATE chats SET require_approval = ? WHERE id = ?", (int(enabled), chat_id))
    return {"require_approval": enabled}


@app.put("/chats/{chat_id}/signature")
def set_channel_signature(chat_id: str, enabled: bool = Query(...), user: dict = Depends(current_user)):
    """Channel 'sign posts': when on, each post shows the posting admin's name."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in ("channel", "community"):
        raise HTTPException(400, "Post signature applies to channels")
    require_manager(chat_id, user["id"])
    db.execute("UPDATE chats SET signature_enabled = ? WHERE id = ?", (int(enabled), chat_id))
    return {"signature_enabled": enabled}


@app.get("/chats/{chat_id}/join-requests")
def list_join_requests(chat_id: str, user: dict = Depends(current_user)):
    """Pending requests to join, for admins to approve/deny."""
    require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])
    rows = db.query_all(
        """
        SELECT u.*, j.created_at AS requested_at
        FROM join_requests j JOIN users u ON u.id = j.user_id
        WHERE j.chat_id = ? ORDER BY j.created_at
        """,
        (chat_id,),
    )
    return [{**public_user(row, viewer_id=user["id"]), "requested_at": row["requested_at"]} for row in rows]


@app.post("/chats/{chat_id}/join-requests/{req_user_id}/approve")
async def approve_join_request(chat_id: str, req_user_id: str, user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])
    pending = db.query_one(
        "SELECT 1 FROM join_requests WHERE chat_id = ? AND user_id = ?", (chat_id, req_user_id))
    if not pending:
        raise HTTPException(404, "No such pending request")
    role = "subscriber" if chat["type"] == "channel" else "member"
    db.execute(
        "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        (chat_id, req_user_id, role, time.time()),
    )
    db.execute("DELETE FROM join_requests WHERE chat_id = ? AND user_id = ?", (chat_id, req_user_id))
    await hub.send_to_user(req_user_id, {"type": "join_approved", "chat_id": chat_id})
    return {"approved": True}


@app.post("/chats/{chat_id}/join-requests/{req_user_id}/deny")
def deny_join_request(chat_id: str, req_user_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])
    db.execute("DELETE FROM join_requests WHERE chat_id = ? AND user_id = ?", (chat_id, req_user_id))
    return {"denied": True}


@app.post("/chats/{chat_id}/leave")
async def leave_chat(chat_id: str, user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    # Announce the departure BEFORE removing the row, so the leaver is still a
    # member the broadcast reaches and the note lands for everyone.
    if chat["type"] in ("group", "channel", "community") and not chat["ephemeral"]:
        await post_system_message(chat_id, user["id"], f"{user['name']} left")
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


def require_permission(chat_id: str, user_id: str, perm: str, message: str):
    """Refuse unless the caller holds a specific granular admin right in this
    chat. Owners and legacy full-power admins pass automatically (see
    chatstore.member_permissions); a narrowed admin only passes for the rights
    they were actually granted."""
    if not chatstore.has_permission(chat_id, user_id, perm):
        raise HTTPException(403, message)


async def post_system_message(chat_id: str, actor_id: str, text: str):
    """
    Write and broadcast an inline "activity" message — the centred grey notes
    WhatsApp/Telegram show for group events ("Alice added Bob", "Carol changed
    the group name", "Dan left"). Stored as an ordinary message with kind
    'system' and silent=True so it never triggers a push; the frozen text is
    computed at the moment of the event.
    """
    message, _ = chatstore.insert_message(
        chat_id=chat_id, sender_id=actor_id, kind="system", text=text, silent=True)
    await hub.send_to_chat(chat_id, {"type": "message", "message": message})
    return message


def _display_names(user_ids: list[str]) -> list[str]:
    """Names for a set of user ids, for composing an activity line."""
    if not user_ids:
        return []
    rows = db.query_all(
        "SELECT id, name FROM users WHERE id IN ({})".format(",".join("?" for _ in user_ids)),
        tuple(user_ids),
    )
    by_id = {row["id"]: row["name"] for row in rows}
    return [by_id[uid] for uid in user_ids if uid in by_id]


def _join_names(names: list[str]) -> str:
    """"Alice", "Alice and Bob", "Alice, Bob and Carol"."""
    if len(names) <= 1:
        return names[0] if names else ""
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return f"{', '.join(names[:-1])} and {names[-1]}"


@app.post("/chats/{chat_id}/members")
async def add_members(chat_id: str, request: AddMembersRequest,
                      user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    require_manager(chat_id, user["id"])
    require_permission(chat_id, user["id"], "invite",
                       "You don't have permission to add members to this chat")

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
        if chat["type"] in ("group", "channel", "community") and not chat["ephemeral"]:
            names = _display_names(added)
            if names:
                await post_system_message(
                    chat_id, user["id"], f"{user['name']} added {_join_names(names)}")
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
    chat = require_member(chat_id, user["id"])
    if chat["type"] in ("group", "channel", "community") and not chat["ephemeral"]:
        names = _display_names([target_id])
        if names:
            await post_system_message(chat_id, user["id"], f"{user['name']} removed {names[0]}")
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

    # Granular rights only apply to admins. When promoting, an explicit
    # `permissions` list narrows what this admin can do; omitting it keeps the
    # legacy "full-power admin" behaviour (empty string → all, see
    # chatstore.member_permissions). Demoting to member clears any grant.
    if request.role == "admin" and request.permissions is not None:
        granted = ",".join(p for p in request.permissions if p in chatstore.ADMIN_PERMISSIONS)
    else:
        granted = ""

    db.execute("UPDATE chat_members SET role = ?, permissions = ? WHERE chat_id = ? AND user_id = ?",
              (request.role, granted, chat_id, target_id))
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    return {"user_id": target_id, "role": request.role,
            "permissions": sorted(chatstore.member_permissions(chat_id, target_id))}


@app.post("/chats/{chat_id}/members/{target_id}/make-owner")
async def transfer_ownership(chat_id: str, target_id: str, user: dict = Depends(current_user)):
    """
    Deliberately hand the group over to another member — WhatsApp's "Make group
    admin" → transfer. Only the current owner may do it. The target becomes
    owner; the old owner steps down to admin (keeping full rights) rather than
    losing all control at once.
    """
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in ("group", "channel", "community"):
        raise HTTPException(400, "This chat type has no transferable ownership")
    if chat["owner_id"] != user["id"]:
        raise HTTPException(403, "Only the owner can transfer ownership")
    if target_id == user["id"]:
        raise HTTPException(400, "You already own this chat")
    if chatstore.member_role(chat_id, target_id) is None:
        raise HTTPException(404, "Not a member of this chat")

    with db.transaction() as conn:
        conn.execute("UPDATE chat_members SET role = 'owner', permissions = '' "
                     "WHERE chat_id = ? AND user_id = ?", (chat_id, target_id))
        conn.execute("UPDATE chat_members SET role = 'admin', permissions = '' "
                     "WHERE chat_id = ? AND user_id = ?", (chat_id, user["id"]))
        conn.execute("UPDATE chats SET owner_id = ? WHERE id = ?", (target_id, chat_id))

    await hub.send_to_chat(chat_id, {"type": "chat_owner_changed", "chat_id": chat_id, "owner_id": target_id})
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    if not chat["ephemeral"]:
        names = _display_names([target_id])
        if names:
            await post_system_message(chat_id, user["id"], f"{user['name']} made {names[0]} the group owner")
    return {"owner_id": target_id}


@app.get("/users/{other_id}/common-groups")
def common_groups(other_id: str, user: dict = Depends(current_user)):
    """Groups (and communities) that both you and `other_id` belong to — the
    "N groups in common" list WhatsApp shows on a contact's profile."""
    rows = db.query_all(
        """
        SELECT c.id, c.name, c.type, c.color, c.avatar_letter, c.avatar_attachment_id
        FROM chats c
        JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
        JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
        WHERE c.type IN ('group', 'community') AND COALESCE(c.ephemeral, 0) = 0
        ORDER BY c.name COLLATE NOCASE
        """,
        (user["id"], other_id),
    )
    return [dict(row) for row in rows]


@app.put("/chats/{chat_id}/info")
async def update_chat_info(chat_id: str, request: UpdateChatInfoRequest,
                          user: dict = Depends(current_user)):
    """
    Rename a group/channel/community or change its description — the edit path
    that simply didn't exist before, so a group's name and description were
    frozen at creation. Admin-only; DMs and Saved Messages have no editable
    info of this kind.
    """
    chat = require_member(chat_id, user["id"])
    if chat["type"] in ("dm", "saved"):
        raise HTTPException(400, "This chat has no editable name or description")
    require_manager(chat_id, user["id"])

    fields = {}
    if request.name is not None:
        fields["name"] = request.name.strip()
        if not fields["name"]:
            raise HTTPException(400, "Name cannot be empty")
        fields["avatar_letter"] = fields["name"][0].upper()
    if request.description is not None:
        fields["description"] = request.description.strip()
    if not fields:
        return get_chat(chat_id, user)

    assignments = ", ".join(f"{name} = ?" for name in fields)
    db.execute(f"UPDATE chats SET {assignments} WHERE id = ?", (*fields.values(), chat_id))
    # Everyone with the chat or its info sheet open refreshes to the new name.
    await hub.send_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    await hub.send_to_chat(chat_id, {"type": "members_changed", "chat_id": chat_id})
    if not chat["ephemeral"]:
        if "name" in fields:
            await post_system_message(
                chat_id, user["id"], f"{user['name']} changed the group name to \"{fields['name']}\"")
        elif "description" in fields:
            await post_system_message(
                chat_id, user["id"], f"{user['name']} changed the group description")
    return get_chat(chat_id, user)


@app.put("/chats/{chat_id}/send-policy")
async def set_send_policy(chat_id: str, admins_only: bool = Query(...),
                          user: dict = Depends(current_user)):
    """WhatsApp's "Only admins can send messages" switch for a group. Channels
    are already admin-post-only; this is the group-level knob."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] != "group":
        raise HTTPException(400, "Send policy only applies to groups")
    require_manager(chat_id, user["id"])
    db.execute("UPDATE chats SET send_policy = ? WHERE id = ?",
               ("admins" if admins_only else "all", chat_id))
    await hub.send_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    return {"send_policy": "admins" if admins_only else "all"}


@app.put("/chats/{chat_id}/topics-policy")
async def set_topics_policy(chat_id: str, enabled: bool = Query(...),
                            user: dict = Depends(current_user)):
    """Telegram's "Enable Topics" switch. Turning it off doesn't delete any
    topic or re-file any message — it just stops the client from showing the
    thread picker; every existing message keeps whatever topic_id it has,
    ready to reappear correctly if Topics is turned back on later."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] != "group":
        raise HTTPException(400, "Topics only apply to groups")
    require_manager(chat_id, user["id"])
    db.execute("UPDATE chats SET topics_enabled = ? WHERE id = ?", (1 if enabled else 0, chat_id))
    await hub.send_to_chat(chat_id, {"type": "chat_updated", "chat_id": chat_id})
    return {"topics_enabled": enabled}


@app.post("/chats/{chat_id}/topics")
async def create_topic(chat_id: str, request: CreateTopicRequest, user: dict = Depends(current_user)):
    chat = require_member(chat_id, user["id"])
    if not chat["topics_enabled"]:
        raise HTTPException(400, "Topics are not enabled for this chat")
    topic_id = new_id("topic")
    db.execute(
        "INSERT INTO topics (id, chat_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
        (topic_id, chat_id, request.name.strip(), user["id"], time.time()),
    )
    topic = dict(db.query_one("SELECT * FROM topics WHERE id = ?", (topic_id,)))
    await hub.send_to_chat(chat_id, {"type": "topic_created", "chat_id": chat_id, "topic": topic})
    return topic


@app.get("/chats/{chat_id}/topics")
def list_topics(chat_id: str, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    rows = db.query_all(
        "SELECT * FROM topics WHERE chat_id = ? ORDER BY created_at", (chat_id,))
    return [dict(row) for row in rows]


@app.delete("/chats/{chat_id}/topics/{topic_id}")
async def close_topic(chat_id: str, topic_id: str, user: dict = Depends(current_user)):
    """Closes a topic (no new posts) rather than deleting it — its messages
    stay exactly where they are, same "leave the history intact" choice
    archiving a chat makes. The creator or a manager may close it."""
    require_member(chat_id, user["id"])
    topic = db.query_one("SELECT * FROM topics WHERE id = ? AND chat_id = ?", (topic_id, chat_id))
    if topic is None:
        raise HTTPException(404, "Topic not found")
    if topic["created_by"] != user["id"]:
        require_manager(chat_id, user["id"])
    db.execute("UPDATE topics SET closed_at = ? WHERE id = ?", (time.time(), topic_id))
    await hub.send_to_chat(chat_id, {"type": "topic_closed", "chat_id": chat_id, "topic_id": topic_id})
    return {"closed": True}


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
async def set_vanish_mode(chat_id: str, enabled: bool = Query(...), user: dict = Depends(current_user)):
    """
    Vanish mode — only messages sent WHILE vanish mode is on get deleted
    when the user leaves the chat. We record the current max seq so
    leave-view can scope deletion to messages after that point.
    """
    require_member(chat_id, user["id"])
    if enabled:
        max_seq = db.query_one(
            "SELECT COALESCE(MAX(seq), 0) AS ms FROM messages WHERE chat_id = ?",
            (chat_id,),
        )["ms"]
        db.execute(
            "UPDATE chat_members SET vanish_mode = 1, vanish_mode_since_seq = ? WHERE chat_id = ?",
            (max_seq, chat_id))
    else:
        db.execute(
            "UPDATE chat_members SET vanish_mode = 0 WHERE chat_id = ?",
            (chat_id,))
    await post_system_message(
        chat_id, user["id"],
        f"🔒 {user['name']} turned vanish mode {'on' if enabled else 'off'}")
    await hub.send_to_chat(chat_id, {
        "type": "chat_updated", "chat_id": chat_id, "vanish_mode": enabled,
    })
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


@app.put("/chats/{chat_id}/reactions-policy")
def set_reactions_policy(chat_id: str, enabled: bool = Query(...), user: dict = Depends(current_user)):
    """Admin switch for whether posts/messages in a channel or group can be
    reacted to at all (Telegram lets a channel disable reactions)."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in ("channel", "community", "community_channel", "group"):
        raise HTTPException(400, "Reactions policy applies to channels and groups")
    if chatstore.member_role(chat_id, user["id"]) not in ("owner", "admin"):
        raise HTTPException(403, "Only admins can change the reactions policy")
    db.execute("UPDATE chats SET reactions_enabled = ? WHERE id = ?", (int(enabled), chat_id))
    return {"reactions_enabled": enabled}


@app.put("/chats/{chat_id}/username")
def set_channel_username(chat_id: str, username: str = Query(default=""), user: dict = Depends(current_user)):
    """Give a channel a public @handle so people can find and join it by name
    (Telegram-style). Passing an empty username clears it (makes it private)."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in ("channel", "community"):
        raise HTTPException(400, "Only channels have a public username")
    if chatstore.member_role(chat_id, user["id"]) not in ("owner", "admin"):
        raise HTTPException(403, "Only admins can set the channel username")
    handle = username.strip().lstrip("@").lower()
    if handle == "":
        db.execute("UPDATE chats SET public_username = '' WHERE id = ?", (chat_id,))
        return {"public_username": ""}
    if not re.fullmatch(r"[a-z0-9_]{3,32}", handle):
        raise HTTPException(400, "Username must be 3-32 characters: letters, numbers or underscore")
    taken = db.query_one(
        "SELECT 1 FROM chats WHERE lower(public_username) = ? AND id != ?", (handle, chat_id))
    if taken:
        raise HTTPException(409, "That username is already taken")
    db.execute("UPDATE chats SET public_username = ? WHERE id = ?", (handle, chat_id))
    return {"public_username": handle}


@app.get("/chats/by-username/{username}")
def get_channel_by_username(username: str, user: dict = Depends(current_user)):
    """Resolve a public @handle to a joinable channel preview."""
    handle = username.strip().lstrip("@").lower()
    chat = db.query_one("SELECT * FROM chats WHERE lower(public_username) = ?", (handle,))
    if chat is None:
        raise HTTPException(404, "No channel with that username")
    member_count = db.query_one(
        "SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?", (chat["id"],))["n"]
    return {
        "id": chat["id"], "type": chat["type"], "name": chat["name"],
        "description": chat["description"] if "description" in chat.keys() else "",
        "avatar_letter": chat["avatar_letter"], "color": chat["color"],
        "avatar_attachment_id": chat["avatar_attachment_id"] if "avatar_attachment_id" in chat.keys() else None,
        "public_username": chat["public_username"], "member_count": member_count,
        "is_member": chatstore.is_member(chat["id"], user["id"]),
    }


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


@app.post("/messages/{message_id}/view-once-open")
async def open_view_once_text(message_id: str, user: dict = Depends(current_user)):
    """
    Explicit "I opened this" gesture for a view-once TEXT message — the
    text equivalent of GET /uploads/{id}'s tap-to-reveal for a view-once
    photo/video. Only fires when the recipient actually taps the bubble,
    not merely because the chat's read watermark passed it (that used to be
    the trigger, via mark_read, and could blank a message before the
    recipient had even scrolled to it).
    """
    row = db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,))
    if row is None or not chatstore.is_member(row["chat_id"], user["id"]):
        raise HTTPException(404, "Message not found")
    message = dict(row)
    if message["kind"] != "text" or not message["view_once"]:
        raise HTTPException(400, "Not a view-once text message")
    if message["sender_id"] == user["id"]:
        raise HTTPException(403, "You cannot reopen a view-once message you sent")

    # Same atomic-claim race protection as download_file's view-once photo
    # gate: only whichever request's UPDATE actually changes a row wins.
    claimed = db.execute(
        "UPDATE messages SET view_once_opened_at = ? WHERE id = ? AND view_once_opened_at IS NULL",
        (time.time(), message_id),
    )
    if claimed.rowcount == 0:
        raise HTTPException(410, "This has already been opened")

    text = message["text"]  # captured before serialise_message blanks it below
    blanked = chatstore.serialise_message(
        db.query_one("SELECT * FROM messages WHERE id = ?", (message_id,)), user["id"])
    await hub.send_to_chat(message["chat_id"], {"type": "message_edited", "message": blanked})
    return {"text": text}


@app.post("/chats/{chat_id}/read")
async def mark_read(chat_id: str, request: ReadRequest, user: dict = Depends(current_user)):
    require_member(chat_id, user["id"])
    chatstore.set_last_read(chat_id, user["id"], request.seq)
    # Reading a message necessarily means it was delivered — keep the delivery
    # watermark at least as far along so a read tick never sits "behind" its
    # own delivery.
    chatstore.set_last_delivered(chat_id, user["id"], request.seq)

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


@app.post("/chats/{chat_id}/delivered")
async def mark_delivered(chat_id: str, request: ReadRequest, user: dict = Depends(current_user)):
    """
    A recipient's client acknowledging it has RECEIVED messages up to `seq`
    (one step before reading them). The client calls this whenever a live
    message arrives for a chat, whether or not that chat is open — that's what
    turns the sender's single tick into a double tick. Unlike read receipts,
    delivery is never withheld: there's no privacy setting for "received."
    """
    require_member(chat_id, user["id"])
    chatstore.set_last_delivered(chat_id, user["id"], request.seq)
    await hub.send_to_chat(chat_id, {
        "type": "delivered",
        "chat_id": chat_id,
        "user_id": user["id"],
        "seq": request.seq,
    }, exclude_user=user["id"])
    return {"chat_id": chat_id, "last_delivered_seq": request.seq}


@app.get("/chats/{chat_id}/read-state")
def get_read_state(chat_id: str, user: dict = Depends(current_user)):
    """
    How far every other member has read AND received a message.

    Drives the tick states on your own messages: single (sent) until every
    other member's last_delivered_seq reaches it → double (delivered), then
    blue once every receipt-enabled member's last_read_seq reaches it too.
    Delivery is reported for everyone; the read watermark is null for a member
    who has switched read receipts off, so turning receipts off withholds the
    blue tick without also hiding that the message was delivered — matching
    WhatsApp, where you still see two grey ticks.
    """
    require_member(chat_id, user["id"])
    rows = db.query_all(
        """
        SELECT m.user_id AS user_id,
               m.last_delivered_seq AS last_delivered_seq,
               m.last_delivered_at AS last_delivered_at,
               CASE WHEN u.show_read_receipts = 1 THEN m.last_read_seq ELSE NULL END AS last_read_seq,
               CASE WHEN u.show_read_receipts = 1 THEN m.last_read_at ELSE NULL END AS last_read_at
        FROM chat_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.chat_id = ? AND m.user_id != ?
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
                  topic_id: str | None = None,
                  only_general: bool = False,
                  user: dict = Depends(current_user)):
    """
    A page of a chat.

    Pass after_seq to catch up after a reconnect: the client sends the highest
    sequence number it holds and receives only what came later.

    topic_id/only_general narrow to one Topic thread — see load_messages.
    Both omitted (the default) returns every message regardless of topic,
    unchanged from before Topics existed.
    """
    require_member(chat_id, user["id"])
    return chatstore.load_messages(chat_id, user["id"], limit, before_seq, after_seq,
                                   topic_id, only_general)


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
        noun = "channel" if chat["type"] == "channel" else "community"
        if chatstore.member_role(request.chat_id, user["id"]) not in ("owner", "admin"):
            raise HTTPException(403, f"Only {noun} admins can post")
        require_permission(request.chat_id, user["id"], "post",
                           f"You don't have permission to post in this {noun}")
    elif chat["type"] == "broadcast":
        # Nobody but the owner is ever a chat_member of a broadcast list (see
        # broadcast_recipients' table comment), so in practice only the owner
        # could reach this far anyway — checked explicitly for a clear error.
        if chat["owner_id"] != user["id"]:
            raise HTTPException(403, "Only the owner can send to this broadcast list")
    elif chat["type"] == "group":
        # "Only admins can send messages" — WhatsApp's group lock. Off ('all')
        # by default, so ordinary groups are unaffected.
        send_policy = chat["send_policy"] if "send_policy" in chat.keys() else "all"
        if send_policy == "admins" \
                and chatstore.member_role(request.chat_id, user["id"]) not in ("owner", "admin"):
            raise HTTPException(403, "Only admins can send messages in this group")

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
    elif request.kind == "gif":
        # A GIF has no attachment_id of its own — same lightweight
        # external-URL-in-payload shape MusicPicker's music_url already
        # uses, rather than downloading and re-hosting Tenor's bytes.
        gif_url = payload.get("gif_url")
        if not isinstance(gif_url, str) or not gif_url.startswith("https://"):
            raise HTTPException(400, "A gif needs an https gif_url")
    elif request.kind == "product":
        # Sharing a product INTO a chat copies its current name/price/image
        # into this message's own payload rather than pointing at the
        # products row live — so editing or deleting the listing afterward
        # never rewrites (or blanks) a card someone already sent, same
        # "snapshot at send time" reasoning as stories.audience_mode.
        product_id = payload.get("product_id")
        product = db.query_one(
            "SELECT * FROM products WHERE id = ? AND owner_id = ?", (product_id, user["id"]))
        if product is None:
            raise HTTPException(400, "product_id must be one of your own products")
        payload = {
            "product_id": product["id"],
            "name": product["name"],
            "description": product["description"],
            "price_cents": product["price_cents"],
            "currency": product["currency"],
            "image_attachment_id": product["image_attachment_id"],
        }

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

    # Same cross-chat-id concern as reply_to_id above, plus a closed topic
    # refusing new posts (same idea as an archived folder) — but only in a
    # chat that actually turned Topics on; elsewhere topic_id is silently
    # meaningless rather than an error, since older/other clients never send it.
    topic_id = request.topic_id
    if topic_id and chat["topics_enabled"]:
        topic = db.query_one("SELECT chat_id, closed_at FROM topics WHERE id = ?", (topic_id,))
        if topic is None or topic["chat_id"] != request.chat_id:
            raise HTTPException(400, "topic_id must be a topic in this chat")
        if topic["closed_at"]:
            raise HTTPException(400, "This topic is closed")
    elif not chat["topics_enabled"]:
        topic_id = None

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
        topic_id=topic_id,
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

        # A silent send skips the push entirely (Telegram's "send without
        # sound" — the message still appears in-app, it just doesn't ping).
        if not request.silent:
            await notify_offline_members(
                request.chat_id, user["id"], user["name"],
                push_preview_text(request.kind, request.text, payload),
                chat_type=chat["type"],
            )

        await dispatch_webhooks(background_tasks, request.chat_id, user["id"], message)

        if chat["type"] == "dm":
            await maybe_send_away_reply(background_tasks, request.chat_id, user["id"], request.text)

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

    # Your own message always; someone else's only with the "edit" granular
    # admin right (Telegram lets a channel admin edit others' posts).
    if message["sender_id"] != user["id"] \
            and not chatstore.has_permission(message["chat_id"], user["id"], "edit"):
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
    # Deleting someone ELSE's message is the "delete" granular admin right —
    # owners and legacy full-power admins hold it automatically; a narrowed
    # admin only if it was granted.
    is_moderator = chatstore.has_permission(message["chat_id"], user["id"], "delete")
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

    policy = db.query_one("SELECT reactions_enabled FROM chats WHERE id = ?", (message["chat_id"],))
    if policy and "reactions_enabled" in policy.keys() and not policy["reactions_enabled"]:
        raise HTTPException(403, "Reactions are turned off in this chat")

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
            "SELECT user_id, status, audience_mode FROM stories WHERE id = ?",
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
            and _story_audience_allows(story["user_id"], story["audience_mode"], user["id"])
        )
        if story is None or not (is_author or visible):
            raise HTTPException(404, "File not found")
    elif attachment["avatar_of_user_id"] or attachment["avatar_of_chat_id"] or attachment["cover_of_user_id"]:
        # A profile / group photo or a cover banner is meant to be visible to
        # anyone in the app who can see the profile or chat at all — unlike a
        # chat/story attachment there is no membership check, just "signed in."
        # current_user() above already established that. (Attachment ids are
        # unguessable UUIDs, same as user avatars.)
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
    chat = require_member(message["chat_id"], user["id"])

    # In an admin-run space (channel/community) pinning is the "pin" granular
    # right. DMs and ordinary groups stay open — anyone in the conversation can
    # pin, same as before.
    if chat["type"] in ("channel", "community", "community_channel"):
        require_permission(message["chat_id"], user["id"], "pin",
                           "You don't have permission to pin messages here")

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


# ── Discussion comments on channel/community posts ──────────────────────────────

def serialise_comment(row: dict) -> dict:
    """One comment plus enough of its author for the client to render it — the
    author is joined in at query time, and goes to a deleted-account placeholder
    if the user_id was nulled by an account deletion."""
    return {
        "id": row["id"],
        "post_message_id": row["post_message_id"],
        "chat_id": row["chat_id"],
        "text": row["text"],
        "created_at": row["created_at"],
        "user_id": row["user_id"],
        "user_name": row["user_name"] or "Deleted account",
        "user_avatar_letter": row["user_avatar_letter"] or "?",
        "user_color": row["user_color"] or "#6366f1",
        "user_avatar_attachment_id": row["user_avatar_attachment_id"],
    }


COMMENTABLE_TYPES = ("channel", "community", "community_channel")


@app.get("/messages/{message_id}/comments")
def list_comments(message_id: str, limit: int = Query(default=200, ge=1, le=500),
                  offset: int = Query(default=0, ge=0), user: dict = Depends(current_user)):
    """Every comment on a post, oldest first (natural reading order for a
    thread). Only members/subscribers of the channel can read the discussion."""
    post = db.query_one("SELECT chat_id FROM messages WHERE id = ?", (message_id,))
    if post is None:
        raise HTTPException(404, "Post not found")
    require_member(post["chat_id"], user["id"])
    rows = db.query_all(
        """
        SELECT c.*, u.name AS user_name, u.avatar_letter AS user_avatar_letter,
               u.color AS user_color, u.avatar_attachment_id AS user_avatar_attachment_id
        FROM comments AS c
        LEFT JOIN users AS u ON u.id = c.user_id
        WHERE c.post_message_id = ?
        ORDER BY c.created_at ASC
        LIMIT ? OFFSET ?
        """,
        (message_id, limit, offset),
    )
    return [serialise_comment(dict(row)) for row in rows]


@app.post("/messages/{message_id}/comments")
async def add_comment(message_id: str, request: CommentRequest, user: dict = Depends(current_user)):
    """
    Post a discussion comment under a channel/community post. Any member/
    subscriber can comment (that's the whole point of a discussion), as long as
    the channel hasn't turned comments off. Bumps the post's comment_count and
    fans a realtime event out to everyone viewing the channel.
    """
    post = db.query_one("SELECT id, chat_id FROM messages WHERE id = ?", (message_id,))
    if post is None:
        raise HTTPException(404, "Post not found")
    chat = require_member(post["chat_id"], user["id"])
    if chat["type"] not in COMMENTABLE_TYPES:
        raise HTTPException(400, "Comments are only available on channel and community posts")
    if not chat["comments_enabled"]:
        raise HTTPException(403, "Comments are turned off for this channel")

    comment_id = new_id("cmt")
    now = time.time()
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO comments (id, chat_id, post_message_id, user_id, text, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (comment_id, post["chat_id"], message_id, user["id"], request.text, now),
        )
        conn.execute("UPDATE messages SET comment_count = comment_count + 1 WHERE id = ?", (message_id,))

    row = db.query_one(
        """
        SELECT c.*, u.name AS user_name, u.avatar_letter AS user_avatar_letter,
               u.color AS user_color, u.avatar_attachment_id AS user_avatar_attachment_id
        FROM comments AS c LEFT JOIN users AS u ON u.id = c.user_id WHERE c.id = ?
        """,
        (comment_id,),
    )
    comment = serialise_comment(dict(row))
    count = db.query_one("SELECT comment_count FROM messages WHERE id = ?", (message_id,))["comment_count"]
    await hub.send_to_chat(post["chat_id"], {
        "type": "comment_added", "chat_id": post["chat_id"],
        "post_message_id": message_id, "comment": comment, "comment_count": count,
    })
    return comment


@app.delete("/comments/{comment_id}")
async def delete_comment(comment_id: str, user: dict = Depends(current_user)):
    """Remove a comment — your own always, or anyone's with the channel's
    'delete' granular admin right. Decrements the post's comment_count and
    tells every viewer."""
    comment = db.query_one("SELECT * FROM comments WHERE id = ?", (comment_id,))
    if comment is None:
        raise HTTPException(404, "Comment not found")
    require_member(comment["chat_id"], user["id"])
    is_own = comment["user_id"] == user["id"]
    if not is_own and not chatstore.has_permission(comment["chat_id"], user["id"], "delete"):
        raise HTTPException(403, "You can only delete your own comments")

    with db.transaction() as conn:
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
        # Guard against ever going negative if a stale double-delete races.
        conn.execute(
            "UPDATE messages SET comment_count = MAX(comment_count - 1, 0) WHERE id = ?",
            (comment["post_message_id"],),
        )
    count_row = db.query_one("SELECT comment_count FROM messages WHERE id = ?", (comment["post_message_id"],))
    await hub.send_to_chat(comment["chat_id"], {
        "type": "comment_deleted", "chat_id": comment["chat_id"],
        "post_message_id": comment["post_message_id"], "comment_id": comment_id,
        "comment_count": count_row["comment_count"] if count_row else 0,
    })
    return {"deleted": True}


@app.put("/chats/{chat_id}/comments-policy")
def set_comments_policy(chat_id: str, enabled: bool = Query(...), user: dict = Depends(current_user)):
    """Admin switch for whether a channel/community allows discussion comments
    on its posts at all."""
    chat = require_member(chat_id, user["id"])
    if chat["type"] not in COMMENTABLE_TYPES:
        raise HTTPException(400, "Comments policy applies to channels and communities")
    if chatstore.member_role(chat_id, user["id"]) not in ("owner", "admin"):
        raise HTTPException(403, "Only admins can change the comments policy")
    db.execute("UPDATE chats SET comments_enabled = ? WHERE id = ?", (int(enabled), chat_id))
    return {"comments_enabled": enabled}


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
    # Attribution rules, Telegram-style:
    #  - a message that was ITSELF a forward keeps its original label (so the
    #    trail points at the true origin, not whoever last passed it on);
    #  - a channel/community post is attributed to the CHANNEL, not the admin
    #    who happened to post it;
    #  - everything else is attributed to the original sender.
    if original["forwarded_from"]:
        forwarded_from = original["forwarded_from"]
    else:
        src_chat = db.query_one("SELECT type, name FROM chats WHERE id = ?", (original["chat_id"],))
        if src_chat and src_chat["type"] in ("channel", "community", "community_channel") and src_chat["name"]:
            forwarded_from = src_chat["name"]
        else:
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
                             kind, link_url, font, font_size, allow_share,
                             music_url, music_title, music_artist, music_artwork,
                             audience_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (story_id, user["id"], request.text, request.emoji, request.background,
         now, expires_at, status, publish_at, request.kind, link_url,
         request.font, request.font_size, request.allow_share,
         (request.music_url or "").strip(), (request.music_title or "").strip(),
         (request.music_artist or "").strip(), (request.music_artwork or "").strip(),
         # Snapshotted now, not read live later — see the audience_mode
         # column's own migration comment in db.py.
         user["story_audience"]),
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
        SELECT s.*, u.name, u.avatar_letter, u.color, u.avatar_attachment_id
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
            row["user_id"], row["audience_mode"], user["id"],
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


@app.post("/stories/{story_id}/highlight")
def highlight_story(story_id: str, request: HighlightStoryRequest, user: dict = Depends(current_user)):
    """
    Pin one of your own stories past its normal 24-hour lifetime — see
    scheduler.py's expire_stories, which skips anything with highlighted_at
    set. Author-only, and only while the story is still live: a story that
    already expired had its attachment dropped by that same sweep, so
    there'd be nothing left to keep.
    """
    story = db.query_one("SELECT * FROM stories WHERE id = ? AND status = 'live'", (story_id,))
    if story is None or story["user_id"] != user["id"]:
        raise HTTPException(404, "Story not found")
    db.execute(
        "UPDATE stories SET highlighted_at = ?, highlight_label = ? WHERE id = ?",
        (time.time(), request.label.strip(), story_id),
    )
    return _expand_story(dict(db.query_one("SELECT * FROM stories WHERE id = ?", (story_id,))))


@app.delete("/stories/{story_id}/highlight")
def unhighlight_story(story_id: str, user: dict = Depends(current_user)):
    """Un-pin it — its already-past expires_at then lets the next sweep
    retire it normally, same as any other story whose 24 hours are up."""
    story = db.query_one("SELECT * FROM stories WHERE id = ?", (story_id,))
    if story is None or story["user_id"] != user["id"]:
        raise HTTPException(404, "Story not found")
    db.execute("UPDATE stories SET highlighted_at = NULL, highlight_label = '' WHERE id = ?", (story_id,))
    return {"highlighted": False}


@app.get("/users/{user_id}/highlights")
def list_highlights(user_id: str, user: dict = Depends(current_user)):
    """
    A profile's permanent story reel — same audience rule an ordinary story
    uses (shares a chat, plus the author's except/only list at the moment
    THAT story was posted — see stories.audience_mode), just without the
    24-hour status='live' cutoff that gates the ordinary /stories feed.

    Checked per-highlight rather than once for the whole reel: a highlight
    keeps whatever privacy it was posted under even if the author's default
    audience mode has since changed — the same way removing someone from
    Close Friends on Instagram cuts them off from Close-Friends highlights
    specifically, not every highlight regardless of how it was shared.
    """
    if db.query_one("SELECT 1 FROM users WHERE id = ?", (user_id,)) is None:
        raise HTTPException(404, "User not found")
    if user_id != user["id"] and not chatstore.shares_chat_with(user["id"], user_id):
        return []
    rows = db.query_all(
        "SELECT * FROM stories WHERE user_id = ? AND highlighted_at IS NOT NULL "
        "ORDER BY highlighted_at DESC",
        (user_id,),
    )
    return [
        _expand_story(dict(row)) for row in rows
        if row["user_id"] == user["id"]
        or _story_audience_allows(row["user_id"], row["audience_mode"], user["id"])
    ]


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
        "SELECT * FROM stories WHERE id = ? AND status = 'live'",
        (story_id,),
    )
    if story is None:
        raise HTTPException(404, "Story not found")

    is_author = story["user_id"] == user_id
    if not is_author and not (
        chatstore.shares_chat_with(user_id, story["user_id"])
        and _story_audience_allows(story["user_id"], story["audience_mode"], user_id)
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
    chat = require_member(request.chat_id, user["id"])
    if chat["type"] in ("dm", "saved"):
        raise HTTPException(400, "Meetings need a group, channel, or community — not a direct message")

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
    chat = require_member(request.chat_id, user["id"])
    if chat["type"] in ("dm", "saved"):
        raise HTTPException(400, "Meetings need a group, channel, or community — not a direct message")
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
    # A lightweight status ping so the other side can show "muted" / camera-off
    # on your tile — WhatsApp's in-call indicators. Carries no SDP/ICE, just
    # two booleans; it's a pure relay like the rest, gated the same way.
    "call_media_state",
    # Callee → caller: "I just opened the app from your call notification —
    # please re-send your offer." Needed because the original offer is only a
    # live WS relay; a callee whose app was killed never received it, so
    # answering from the notification requires the caller to offer again.
    "call_reoffer_request",
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

    # Coming online delivers everything that piled up while this account was
    # offline: advance its delivery watermark to the newest message in each of
    # its chats, and tell just the chats that actually moved so the other
    # side's single ticks flip to double without a manual refresh.
    for delivered_chat_id, delivered_seq in chatstore.mark_all_delivered(user_id):
        await hub.send_to_chat(delivered_chat_id, {
            "type": "delivered",
            "chat_id": delivered_chat_id,
            "user_id": user_id,
            "seq": delivered_seq,
        }, exclude_user=user_id)

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
                elif kind == "call_media_state":
                    relay["muted"] = bool(payload.get("muted"))
                    relay["camera_off"] = bool(payload.get("camera_off"))
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
                        await notify_incoming_call(to_user_id, chat_id, relay["from_name"], call_kind,
                                                   caller_id=user_id)

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
                elif is_first and not live_meeting:
                    # Ring only members who currently allow calls here —
                    # everyone else simply never hears about this room, the
                    # same as if they weren't a member at all.
                    #
                    # The `not live_meeting` half of this condition matters
                    # a lot: `_group_calls` is in-memory only (see its own
                    # docstring) and is wiped by every server restart/
                    # redeploy, while `meetings.status = 'live'` is
                    # persisted in the database and survives one. Without
                    # this check, the first person to open an
                    # already-announced meeting after a restart looked
                    # exactly like `is_first` for a brand new ad-hoc call —
                    # so joining a meeting everyone already knew was
                    # running instead rang the whole chat like a fresh
                    # incoming call, which the person on the other end
                    # never asked for and had every reason to just decline/
                    # let time out. A meeting already marked live has, by
                    # definition, already been announced once (the
                    # meeting_started broadcast in start_meeting) — nobody
                    # needs to be rung again just because they happen to be
                    # the first to reconnect the actual call room.
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


@app.get("/admin/feedback")
def admin_list_feedback(limit: int = Query(default=100, ge=1, le=500),
                        offset: int = Query(default=0, ge=0),
                        admin: dict = Depends(require_superadmin)):
    """Every feedback submission, newest first, with the submitter's name/
    username joined in (NULL for feedback whose account was later deleted)."""
    rows = db.query_all(
        """
        SELECT f.id, f.answers, f.comment, f.created_at,
               u.name AS user_name, u.username AS user_username
        FROM feedback AS f
        LEFT JOIN users AS u ON u.id = f.user_id
        ORDER BY f.created_at DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    )
    out = []
    for row in rows:
        item = dict(row)
        try:
            item["answers"] = json.loads(item["answers"] or "{}")
        except (ValueError, TypeError):
            item["answers"] = {}
        out.append(item)
    return out


@app.post("/admin/purge-guests")
def admin_purge_guests(admin: dict = Depends(require_superadmin)):
    """
    Permanently remove every throwaway guest account — the ones the "try it"
    button used to mint, whose usernames are all `guest<random>` (see Login's
    tryIt). Each goes through the same delete_user_account path a real deletion
    does, so ownership handoff and the FK cascade behave identically; the
    admin's own account is never a guest, but it's excluded explicitly anyway.
    """
    guests = db.query_all(
        "SELECT id FROM users WHERE username LIKE 'guest%' AND id != ?", (admin["id"],))
    for row in guests:
        delete_user_account(row["id"])
    return {"deleted": len(guests)}


@app.post("/admin/users/{user_id}/verify-business")
def admin_verify_business(user_id: str, admin: dict = Depends(require_superadmin)):
    """
    TalkEx's own Business Verification, mirroring Meta's for WhatsApp — a
    badge an admin grants after checking the account is who it claims to be,
    not something the account can flip on itself via PATCH /me.
    """
    changed = db.execute("UPDATE users SET is_business = 1 WHERE id = ?", (user_id,))
    if changed.rowcount == 0:
        raise HTTPException(404, "User not found")
    return {"is_business": True}


@app.post("/admin/users/{user_id}/unverify-business")
def admin_unverify_business(user_id: str, admin: dict = Depends(require_superadmin)):
    changed = db.execute("UPDATE users SET is_business = 0 WHERE id = ?", (user_id,))
    if changed.rowcount == 0:
        raise HTTPException(404, "User not found")
    return {"is_business": False}


@app.post("/admin/users/{user_id}/unflag-quality")
def admin_unflag_quality(user_id: str, admin: dict = Depends(require_superadmin)):
    """
    Manually clears a sender_reputation_flagged() suspension before it would
    otherwise age out on its own — the moderator override for a flag a
    human has reviewed and judged unfounded (e.g. a competitor mass-reporting
    a legitimate business), same purpose as admin_enable_user for a full
    account disable.
    """
    changed = db.execute("UPDATE users SET quality_flagged_at = NULL WHERE id = ?", (user_id,))
    if changed.rowcount == 0:
        raise HTTPException(404, "User not found")
    return {"unflagged": True}


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


# ── Music search (iTunes proxy) ──────────────────────────────────────────────

import httpx

_music_cache: dict[str, tuple] = {}
MUSIC_CACHE_TTL = 3600  # 1 hour

@app.get("/api/music/search")
async def music_search(q: str = "", limit: int = 25):
    """Proxy iTunes Search API — avoids CORS issues from frontend."""
    cache_key = f"{q}:{limit}"
    cached = _music_cache.get(cache_key)
    if cached and cached[1] > time.time():
        return cached[0]

    try:
        params = {"media": "music", "limit": min(limit, 50)}
        if q.strip():
            params["term"] = q
        else:
            # Default popular search when no query
            params["term"] = "top hits 2025"

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://itunes.apple.com/search", params=params)
            resp.raise_for_status()
            data = resp.json()

        results = []
        for item in data.get("results", []):
            if item.get("previewUrl"):
                results.append({
                    "id": item.get("trackId"),
                    "title": item.get("trackName", "Unknown"),
                    "artist": item.get("artistName", "Unknown"),
                    "album": item.get("collectionName", ""),
                    "artwork": item.get("artworkUrl100", ""),
                    "artworkLarge": (item.get("artworkUrl100", "")
                                     .replace("100x100bb", "300x300bb")),
                    "previewUrl": item.get("previewUrl", ""),
                    "duration": item.get("trackTimeMillis", 0),
                    "genre": item.get("primaryGenreName", ""),
                })
        result = {"results": results, "count": len(results)}
        _music_cache[cache_key] = (result, time.time() + MUSIC_CACHE_TTL)
        return result
    except Exception:
        return {"results": [], "count": 0}


@app.get("/api/music/trending")
async def music_trending():
    """Return a curated set of trending/popular music categories."""
    categories = [
        {"key": "bollywood", "label": "🇮🇳 Bollywood", "query": "bollywood hits"},
        {"key": "pop", "label": "🎵 Pop", "query": "pop hits 2025"},
        {"key": "hiphop", "label": "🎤 Hip Hop", "query": "hip hop trending"},
        {"key": "romantic", "label": "💕 Romantic", "query": "romantic songs"},
        {"key": "sad", "label": "😢 Sad", "query": "sad songs"},
        {"key": "party", "label": "🎉 Party", "query": "party dance songs"},
        {"key": "lofi", "label": "🌙 Lo-Fi", "query": "lofi beats"},
        {"key": "edm", "label": "⚡ EDM", "query": "edm electronic"},
        {"key": "classical", "label": "🎻 Classical", "query": "classical music"},
        {"key": "devotional", "label": "🙏 Devotional", "query": "devotional songs"},
    ]
    return {"categories": categories}


# ── GIF search (Tenor proxy) ─────────────────────────────────────────────────
# Same "proxy it server-side" reasoning as the music search above — plus this
# one actually needs a key (TENOR_API_KEY), so it also follows fcm.py's
# is_configured()-style pattern: absent the env var, the endpoints answer with
# a clear "not set up" instead of a confusing generic failure, and the rest
# of the app is completely unaffected either way.

_gif_cache: dict[str, tuple] = {}
GIF_CACHE_TTL = 3600


def gif_search_configured() -> bool:
    return bool(os.environ.get("TENOR_API_KEY"))


@app.get("/api/gifs/search")
async def gif_search(q: str = "", limit: int = 30):
    if not gif_search_configured():
        raise HTTPException(503, "GIF search isn't set up on this server yet")

    cache_key = f"{q}:{limit}"
    cached = _gif_cache.get(cache_key)
    if cached and cached[1] > time.time():
        return cached[0]

    try:
        params = {
            "key": os.environ["TENOR_API_KEY"],
            "q": q.strip() or "trending",
            "limit": min(limit, 50),
            "media_filter": "gif,tinygif",
            "contentfilter": "medium",
            "client_key": "talkex",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get("https://tenor.googleapis.com/v2/search", params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        logger.warning("Tenor search failed", exc_info=True)
        return {"results": []}

    results = []
    for item in data.get("results", []):
        media = item.get("media_formats", {})
        full = media.get("gif") or {}
        preview = media.get("tinygif") or full
        if not full.get("url"):
            continue
        results.append({
            "id": item.get("id"),
            "gif_url": full["url"],
            "preview_url": preview.get("url", full["url"]),
            "width": (full.get("dims") or [0, 0])[0],
            "height": (full.get("dims") or [0, 0])[1],
        })
    result = {"results": results}
    _gif_cache[cache_key] = (result, time.time() + GIF_CACHE_TTL)
    return result


# ── Inline message translation (Google Cloud Translate proxy) ───────────────
# Same is_configured()-gated shape as GIF search / FCM above: absent
# GOOGLE_TRANSLATE_API_KEY, the endpoint answers 503 and the client's
# "Translate" action shows a "not set up" message instead of a broken tap.

def translate_configured() -> bool:
    return bool(os.environ.get("GOOGLE_TRANSLATE_API_KEY"))


@app.get("/api/translate")
async def translate_text(text: str, target: str = "en"):
    if not translate_configured():
        raise HTTPException(503, "Translation isn't set up on this server yet")
    text = text.strip()
    if not text:
        raise HTTPException(400, "Nothing to translate")
    if len(text) > 4000:
        raise HTTPException(400, "Message is too long to translate")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://translation.googleapis.com/language/translate2",
                params={"key": os.environ["GOOGLE_TRANSLATE_API_KEY"]},
                json={"q": text, "target": target, "format": "text"},
            )
            resp.raise_for_status()
            data = resp.json()
        translation = data["data"]["translations"][0]
    except Exception:
        logger.warning("Translate request failed", exc_info=True)
        raise HTTPException(502, "Translation failed — try again")

    return {
        "translated_text": translation["translatedText"],
        "detected_source_lang": translation.get("detectedSourceLanguage", ""),
    }


# ── SFU (LiveKit) ───────────────────────────────────────────────────────────

def livekit_configured():
    return bool(os.environ.get("LIVEKIT_API_KEY") and os.environ.get("LIVEKIT_API_SECRET")
                and os.environ.get("LIVEKIT_URL"))


@app.get("/sfu/config")
async def sfu_config():
    return {"enabled": livekit_configured(), "url": os.environ.get("LIVEKIT_URL", "")}


@app.post("/sfu/token")
async def sfu_token(request: Request, user: dict = Depends(current_user)):
    if not livekit_configured():
        raise HTTPException(503, "SFU not configured — group calls use peer-to-peer mesh")
    body = await request.json()
    chat_id = body.get("chat_id", "")
    if not chat_id:
        raise HTTPException(400, "chat_id required")

    membership = db.query_one(
        "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?", (chat_id, user["id"]))
    if not membership:
        raise HTTPException(403, "Not a member of this chat")

    import jwt as pyjwt
    api_key = os.environ["LIVEKIT_API_KEY"]
    api_secret = os.environ["LIVEKIT_API_SECRET"]

    now = time.time()
    grant = {
        "sub": user["id"],
        "iss": api_key,
        "nbf": int(now),
        "exp": int(now + 86400),
        "name": user.get("name", ""),
        "video": {
            "roomJoin": True,
            "room": f"talkex_{chat_id}",
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        },
    }
    token = pyjwt.encode(grant, api_secret, algorithm="HS256")
    return {"token": token, "url": os.environ["LIVEKIT_URL"], "room": f"talkex_{chat_id}"}


# ── Payments (Razorpay) ─────────────────────────────────────────────────────

RAZORPAY_PLANS = {
    "business": {"amount_paise": 29900, "label": "TalkEx Business", "duration_days": 30},
    "business_yearly": {"amount_paise": 299900, "label": "TalkEx Business (Annual)", "duration_days": 365},
}

def razorpay_configured():
    return bool(os.environ.get("RAZORPAY_KEY_ID") and os.environ.get("RAZORPAY_KEY_SECRET"))


@app.get("/payments/config")
async def payments_config():
    return {"configured": razorpay_configured(), "key_id": os.environ.get("RAZORPAY_KEY_ID", ""),
            "plans": {k: {"amount_paise": v["amount_paise"], "label": v["label"]} for k, v in RAZORPAY_PLANS.items()}}


@app.post("/payments/create-order")
async def create_payment_order(request: Request, user: dict = Depends(current_user)):
    if not razorpay_configured():
        raise HTTPException(503, "Payments not configured on this server")
    body = await request.json()
    plan_key = body.get("plan", "business")
    plan = RAZORPAY_PLANS.get(plan_key)
    if not plan:
        raise HTTPException(400, f"Unknown plan: {plan_key}")

    import httpx, base64
    key_id = os.environ["RAZORPAY_KEY_ID"]
    key_secret = os.environ["RAZORPAY_KEY_SECRET"]
    auth_header = base64.b64encode(f"{key_id}:{key_secret}".encode()).decode()

    payment_id = secrets.token_hex(12)
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post("https://api.razorpay.com/v1/orders", headers={
            "Authorization": f"Basic {auth_header}", "Content-Type": "application/json",
        }, json={
            "amount": plan["amount_paise"], "currency": "INR",
            "receipt": payment_id, "notes": {"user_id": user["id"], "plan": plan_key},
        })
        if resp.status_code != 200:
            logger.error("Razorpay order creation failed: %s", resp.text)
            raise HTTPException(502, "Could not create payment order")
        order = resp.json()

    conn = db.get_connection()
    conn.execute(
        "INSERT INTO payments (id, user_id, razorpay_order_id, plan, amount_paise, currency, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (payment_id, user["id"], order["id"], plan_key, plan["amount_paise"], "INR", time.time()),
    )
    conn.commit()

    return {"order_id": order["id"], "amount": plan["amount_paise"], "currency": "INR",
            "key_id": key_id, "plan": plan_key, "payment_id": payment_id}


@app.post("/payments/verify")
async def verify_payment(request: Request, user: dict = Depends(current_user)):
    if not razorpay_configured():
        raise HTTPException(503, "Payments not configured on this server")
    body = await request.json()
    razorpay_order_id = body.get("razorpay_order_id", "")
    razorpay_payment_id = body.get("razorpay_payment_id", "")
    razorpay_signature = body.get("razorpay_signature", "")

    if not all([razorpay_order_id, razorpay_payment_id, razorpay_signature]):
        raise HTTPException(400, "Missing payment verification fields")

    key_secret = os.environ["RAZORPAY_KEY_SECRET"]
    msg = f"{razorpay_order_id}|{razorpay_payment_id}"
    expected_sig = hmac.new(key_secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected_sig, razorpay_signature):
        raise HTTPException(400, "Payment verification failed — signature mismatch")

    conn = db.get_connection()
    row = conn.execute(
        "SELECT id, plan FROM payments WHERE razorpay_order_id = ? AND user_id = ?",
        (razorpay_order_id, user["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Payment record not found")

    now = time.time()
    plan = RAZORPAY_PLANS.get(row["plan"], RAZORPAY_PLANS["business"])
    expires_at = now + plan["duration_days"] * 86400

    conn.execute(
        "UPDATE payments SET razorpay_payment_id = ?, razorpay_signature = ?, status = 'paid', verified_at = ? "
        "WHERE id = ?",
        (razorpay_payment_id, razorpay_signature, now, row["id"]),
    )
    conn.execute(
        "UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?",
        (row["plan"], expires_at, user["id"]),
    )
    conn.commit()

    return {"success": True, "plan": row["plan"], "expires_at": expires_at}


@app.get("/payments/history")
async def payment_history(user: dict = Depends(current_user)):
    conn = db.get_connection()
    rows = conn.execute(
        "SELECT id, plan, amount_paise, currency, status, created_at, verified_at "
        "FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
        (user["id"],),
    ).fetchall()
    return [dict(r) for r in rows]


# ── E2EE Key Management ─────────────────────────────────────────────────────

@app.post("/me/keys")
async def upload_keys(request: Request, user: dict = Depends(current_user)):
    """Store the user's public identity key and signed pre-key."""
    body = await request.json()
    identity_key = body.get("identity_key", "")
    signed_pre_key = body.get("signed_pre_key", "")
    one_time_keys = body.get("one_time_keys", [])

    if not identity_key or not signed_pre_key:
        raise HTTPException(400, "identity_key and signed_pre_key are required")

    db.execute(
        """UPDATE users SET e2ee_identity_key = ?, e2ee_signed_pre_key = ?
           WHERE id = ?""",
        (identity_key, signed_pre_key, user["id"]),
    )
    # Store one-time pre-keys
    for otk in one_time_keys[:100]:  # max 100 at a time
        db.execute(
            "INSERT OR IGNORE INTO e2ee_one_time_keys (id, user_id, key_data) VALUES (?, ?, ?)",
            (new_id(), user["id"], otk),
        )
    return {"status": "ok", "one_time_keys_stored": min(len(one_time_keys), 100)}


@app.get("/users/{user_id}/keys")
async def get_user_keys(user_id: str, user: dict = Depends(current_user)):
    """Fetch another user's public keys for establishing an E2EE session."""
    target = db.query_one("SELECT id, e2ee_identity_key, e2ee_signed_pre_key FROM users WHERE id = ?", (user_id,))
    if not target:
        raise HTTPException(404, "User not found")

    # Pop one one-time pre-key (consume it)
    otk_row = db.query_one(
        "SELECT id, key_data FROM e2ee_one_time_keys WHERE user_id = ? LIMIT 1",
        (user_id,),
    )
    one_time_key = None
    if otk_row:
        one_time_key = otk_row["key_data"]
        db.execute("DELETE FROM e2ee_one_time_keys WHERE id = ?", (otk_row["id"],))

    return {
        "user_id": user_id,
        "identity_key": target["e2ee_identity_key"] or "",
        "signed_pre_key": target["e2ee_signed_pre_key"] or "",
        "one_time_key": one_time_key,
    }


@app.get("/me/keys/count")
async def my_key_count(user: dict = Depends(current_user)):
    """How many one-time pre-keys the server still holds for this user."""
    row = db.query_one(
        "SELECT COUNT(*) as cnt FROM e2ee_one_time_keys WHERE user_id = ?",
        (user["id"],),
    )
    return {"count": row["cnt"] if row else 0}


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
