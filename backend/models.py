"""
Request bodies.

Several of the old endpoints took their input as query strings — posting to a
channel was `POST /channels/{id}/post?text=...`. That put message text in the
URL, where it lands in access logs and browser history. Everything that carries
user content is a JSON body here.
"""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# ── Auth ──────────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")
    phone: str = Field(default="", max_length=20)
    password: str = Field(min_length=8, max_length=128)
    bio: str = Field(default="", max_length=200)
    device_label: str = Field(default="Unknown device", max_length=80)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)
    device_label: str = Field(default="Unknown device", max_length=80)


class SetUsernameRequest(BaseModel):
    # Same shape register() already enforces (models.py's RegisterRequest) —
    # a changed username has to satisfy the identical rules a brand new
    # account's does, not a looser one.
    username: str = Field(min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_]+$")


class SetPasswordRequest(BaseModel):
    """
    No current_password field, unlike a typical "change password" form —
    and deliberately so. A phone-signup account's password is a random
    token nobody, including its owner, ever saw (see verify_phone_otp in
    main.py, which mints one with secrets.token_urlsafe), so there is no
    "current password" a legitimate owner could ever prove they know. The
    signed-in session itself is the proof of identity here, same trust
    level main.py's DELETE /me (account deletion) already relies on for an
    even more destructive action.
    """
    new_password: str = Field(min_length=8, max_length=128)


class SetSessionShortLivedRequest(BaseModel):
    """Per-device toggle (Settings > Linked devices): on pulls that one
    session's expiry in to 4 hours out; off restores the normal 30-day TTL."""
    short_lived: bool


class VerifyTwoStepRequest(BaseModel):
    """The second step of login when the account has a PIN set."""
    pending_token: str = Field(min_length=1, max_length=128)
    pin: str = Field(min_length=1, max_length=8)


# ── Phone number sign-in (WhatsApp-style) ────────────────────────────────────

class RequestOtpRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=20)


class VerifyOtpRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=20)
    code: str = Field(min_length=4, max_length=8)
    # Only used the moment a brand new phone number first verifies — ignored
    # (and not required) for an existing account signing back in.
    name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    device_label: str = Field(default="Unknown device", max_length=80)


# ── Email connect (WhatsApp-style two-step recovery address) ────────────────

_EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class RequestEmailOtpRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254, pattern=_EMAIL_PATTERN)


class ConfirmEmailRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254, pattern=_EMAIL_PATTERN)
    code: str = Field(min_length=4, max_length=8)


# ── Two-step verification ────────────────────────────────────────────────────

class SetTwoStepRequest(BaseModel):
    pin: str = Field(min_length=4, max_length=8, pattern=r"^\d+$")
    # Required to change an existing PIN, must be absent to set the first one —
    # same "prove you know the old one" rule chat-lock PINs already use.
    current_pin: Optional[str] = None


class RemoveTwoStepRequest(BaseModel):
    current_pin: str = Field(min_length=1, max_length=8)


# ── Linked devices ────────────────────────────────────────────────────────────

class StartLinkRequest(BaseModel):
    device_label: str = Field(default="New device", max_length=80)


# ── Bulk messaging API ────────────────────────────────────────────────────────

class CreateApiKeyRequest(BaseModel):
    label: str = Field(default="API key", max_length=80)


class BulkSendRequest(BaseModel):
    to: str = Field(min_length=1, max_length=32, description="Recipient's username")
    text: str = Field(min_length=1, max_length=8000)
    client_msg_id: Optional[str] = Field(default=None, max_length=64)


# ── Profile ───────────────────────────────────────────────────────────────────

class UpdateProfileRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    bio: Optional[str] = Field(default=None, max_length=200)
    color: Optional[str] = Field(default=None, max_length=32)
    show_last_seen: Optional[bool] = None
    show_read_receipts: Optional[bool] = None
    show_phone_number: Optional[bool] = None
    away_enabled: Optional[bool] = None
    away_message: Optional[str] = Field(default=None, max_length=500)
    calling_enabled: Optional[bool] = None


class StoryAudienceRequest(BaseModel):
    """Who gets to see status updates you post from now on. 'except' pairs
    with user_ids naming who is EXCLUDED from your full contact list;
    'only' pairs with user_ids naming the sole people who can see it."""
    mode: str = Field(pattern="^(contacts|except|only)$")
    user_ids: list[str] = Field(default_factory=list, max_length=2000)


class ReportRequest(BaseModel):
    target_type: str = Field(pattern="^(user|chat|message)$")
    target_id: str = Field(min_length=1, max_length=64)
    reason: str = Field(min_length=1, max_length=100)
    details: str = Field(default="", max_length=1000)


# ── Automation: webhooks and canned replies ─────────────────────────────────

class CreateWebhookRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2000)


class CreateCannedReplyRequest(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=2000)


class CreateTemplateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=2000)


# ── Superadmin ────────────────────────────────────────────────────────────────

class UpdateIntegrationSettingsRequest(BaseModel):
    msg91_auth_key: Optional[str] = Field(default=None, max_length=200)
    msg91_template_id: Optional[str] = Field(default=None, max_length=200)
    msg91_var_name: Optional[str] = Field(default=None, max_length=64)
    mailgun_api_key: Optional[str] = Field(default=None, max_length=200)
    mailgun_domain: Optional[str] = Field(default=None, max_length=200)
    mailgun_base_url: Optional[str] = Field(default=None, max_length=200)
    mailgun_from: Optional[str] = Field(default=None, max_length=200)


class TestSmsRequest(BaseModel):
    phone: str = Field(min_length=1, max_length=20)


class TestEmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200)


# ── Contacts ──────────────────────────────────────────────────────────────────

class AddContactRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    phone: str = Field(min_length=1, max_length=20)


class UpdateContactRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    phone: str = Field(min_length=1, max_length=20)


# ── Chats ─────────────────────────────────────────────────────────────────────

class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    # Bounded well above the real 1024-member cap (enforced in main.py) so an
    # over-the-cap request reaches that check and gets a clear 400, rather
    # than a generic 422 from this field limit firing first.
    member_ids: list[str] = Field(default_factory=list, max_length=1100)
    description: str = Field(default="", max_length=500)
    color: str = Field(default="#6366f1", max_length=32)


class CreateChannelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    color: str = Field(default="#3b82f6", max_length=32)


class CreateCommunityRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    color: str = Field(default="#06b6d4", max_length=32)
    channels: list[str] = Field(default=["general", "random"], max_length=32)


class AddMembersRequest(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=100)


class CreateBroadcastRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    # Same reasoning as CreateGroupRequest.member_ids: bounded above the real
    # 512-recipient cap so an over-the-cap request reaches that check.
    recipient_ids: list[str] = Field(default_factory=list, max_length=550)
    color: str = Field(default="#6366f1", max_length=32)


class BroadcastRecipientsRequest(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=550)


class SetRoleRequest(BaseModel):
    role: Literal["admin", "member"]


class CreateSubChannelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    color: str = Field(default="#6366f1", max_length=32)


class ChatSettingsRequest(BaseModel):
    """Per-member settings: how *you* filed a chat, not how it is for everyone."""
    is_pinned: Optional[bool] = None
    is_favorite: Optional[bool] = None
    folder: Optional[str] = Field(default=None, max_length=32)
    muted_until: Optional[float] = None
    draft: Optional[str] = Field(default=None, max_length=4000)
    archived: Optional[bool] = None
    calls_enabled: Optional[bool] = None


class DisappearingRequest(BaseModel):
    """Chat-wide timer. None switches it off."""
    seconds: Optional[int] = Field(default=None, ge=1, le=90 * 24 * 3600)


class SetPinRequest(BaseModel):
    pin: str = Field(min_length=4, max_length=32)


# ── Messages ──────────────────────────────────────────────────────────────────

MessageKind = Literal[
    "text", "photo", "video", "voice", "document", "location", "contact",
    "poll", "call", "sticker",
]


class SendMessageRequest(BaseModel):
    chat_id: str
    text: str = Field(default="", max_length=8000)
    kind: MessageKind = "text"

    # Kind-specific extras: file name and size, coordinates, poll options.
    payload: Optional[dict[str, Any]] = None

    reply_to_id: Optional[str] = None

    # Generated by the sender before the first attempt and reused on every retry.
    # Two requests carrying the same value produce one message, so a dropped
    # response cannot turn into a duplicate.
    client_msg_id: Optional[str] = Field(default=None, max_length=64)

    # Overrides the chat-wide disappearing timer for this one message.
    disappear_secs: Optional[int] = Field(default=None, ge=1, le=90 * 24 * 3600)

    # Poll messages only.
    poll_options: Optional[list[str]] = Field(default=None, max_length=12)

    view_once: bool = False
    silent: bool = False


class EditMessageRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class LiveLocationUpdateRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


# ── Web Push ──────────────────────────────────────────────────────────────────

class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
    p256dh: str = Field(min_length=1, max_length=512)
    auth: str = Field(min_length=1, max_length=512)


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)


class ReactRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=16)


class ForwardRequest(BaseModel):
    message_id: str
    to_chat_ids: list[str] = Field(min_length=1, max_length=32)


class ForwardStoryRequest(BaseModel):
    to_chat_ids: list[str] = Field(min_length=1, max_length=32)


class ReadRequest(BaseModel):
    """Mark everything up to and including this sequence number as read."""
    seq: int = Field(ge=0)


class VoteRequest(BaseModel):
    option_index: int = Field(ge=0, le=11)


# ── Scheduled messages ────────────────────────────────────────────────────────

class ScheduleRequest(BaseModel):
    chat_id: str
    # Empty is allowed when payload carries an attachment — a scheduled photo
    # doesn't need a caption any more than a normal one does. The route
    # itself rejects the case where both are empty.
    text: str = Field(default="", max_length=8000)

    # Unix timestamp. Validated against the clock in the route, not here: a
    # model cannot say "in the future" without reading the current time, and
    # doing that at import time would bake in the moment the process started.
    send_at: float

    kind: MessageKind = "text"
    payload: Optional[dict[str, Any]] = None


class RescheduleRequest(BaseModel):
    """Move a pending scheduled message, or change what it will say."""
    send_at: Optional[float] = None
    text: Optional[str] = Field(default=None, min_length=1, max_length=8000)


# ── Stories / status ──────────────────────────────────────────────────────────

class StoryRequest(BaseModel):
    text: str = Field(default="", max_length=500)
    emoji: str = Field(default="", max_length=16)
    background: str = Field(default="linear-gradient(135deg,#6366f1,#4f46e5)", max_length=200)

    # Text-status styling. Kept as free strings rather than an enum so the
    # frontend's font/size choices can grow without a backend change — the
    # server never interprets these beyond storing and echoing them back.
    font: str = Field(default="system", max_length=40)
    font_size: str = Field(default="medium", max_length=20)

    # 'text' is the original shape (caption only). The other four carry an
    # uploaded file (attachment_id, from POST /uploads) or a URL (link_url) —
    # text/emoji/background still apply to all of them as the caption/style.
    kind: Literal["text", "photo", "video", "audio", "link"] = "text"
    attachment_id: Optional[str] = None
    link_url: Optional[str] = Field(default=None, max_length=2000)

    # Leave unset to post immediately. Set it to queue the status for later —
    # the 24-hour lifetime then starts when it publishes, not when you wrote it.
    publish_at: Optional[float] = None

    # Off by default: only the author can forward/share this status. Turning
    # it on lets anyone who's allowed to view it also forward/share it —
    # same WhatsApp-style opt-in shape as a group's "allow members to send
    # messages" toggle, decided per-post rather than once for the account.
    allow_share: bool = False


# ── Meetings ──────────────────────────────────────────────────────────────────

class CreateMeetingRequest(BaseModel):
    chat_id: str
    title: str = Field(min_length=1, max_length=120)
    agenda: str = Field(default="", max_length=2000)

    starts_at: float                                    # Unix timestamp
    duration_min: int = Field(default=30, ge=5, le=24 * 60)

    join_url: str = Field(default="", max_length=500)

    # How long before the start everyone gets pinged.
    reminder_min: int = Field(default=10, ge=0, le=24 * 60)

    # Who to invite. Empty means everyone currently in the chat, which is the
    # common case for a team group.
    invite_user_ids: list[str] = Field(default_factory=list, max_length=256)

    # Off by default — "auto join" for everyone permitted to call in this
    # chat, same as every meeting before this setting existed.
    waiting_room: bool = False
    # Blank means no password. Checked only against people who aren't
    # already the host — see group_call_start in main.py.
    password: str = Field(default="", max_length=64)


class UpdateMeetingRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    agenda: Optional[str] = Field(default=None, max_length=2000)
    starts_at: Optional[float] = None
    duration_min: Optional[int] = Field(default=None, ge=5, le=24 * 60)
    join_url: Optional[str] = Field(default=None, max_length=500)
    reminder_min: Optional[int] = Field(default=None, ge=0, le=24 * 60)
    waiting_room: Optional[bool] = None
    # Empty string clears the password; None leaves it untouched — the same
    # "absent means don't touch" convention every other partial update here
    # uses, just needing an explicit way to say "clear it" too.
    password: Optional[str] = Field(default=None, max_length=64)


class InstantMeetingRequest(BaseModel):
    """Start-right-now, no scheduling step — the in-app equivalent of hitting
    'New Meeting' in Zoom/Meet instead of picking a future time."""
    chat_id: str
    title: str = Field(default="Instant meeting", max_length=120)
    waiting_room: bool = False
    password: str = Field(default="", max_length=64)


class CreateBreakoutRoomsRequest(BaseModel):
    """assignments maps user_id -> which room (0-based) they land in — the
    caller decides the grouping (manually or by spreading people evenly
    client-side); the server doesn't have an opinion about how to split
    people up, only about creating the rooms and moving them there."""
    assignments: dict[str, int] = Field(min_length=1, max_length=500)


class RsvpRequest(BaseModel):
    response: Literal["going", "maybe", "declined"]
