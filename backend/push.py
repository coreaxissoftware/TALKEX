"""
Web Push notifications: VAPID identity + sending.

The private key is generated once and saved to disk (in the same DATA_DIR the
database lives in, so both survive a restart together) rather than minted
fresh on every boot — every subscription a browser holds is tied to the
public half of this key. Rotating it would silently invalidate every
existing subscription, and there would be no way to tell a user "you need to
re-enable notifications" since the very channel that would tell them is what
just broke.
"""

import base64
import json
import logging
import os

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

import db

logger = logging.getLogger("talkex.push")

VAPID_KEY_PATH = os.path.join(db.DATA_DIR, "vapid_private_key.pem")

# Required by the Push spec as a way for a push service to contact the
# sender if it's misbehaving. Not a real mailbox — this only ever runs on
# localhost/self-hosted deployments, there is no support inbox to give it.
VAPID_CLAIMS_SUB = "mailto:admin@talkex.local"

_vapid = None


def _load_vapid() -> Vapid:
    global _vapid
    if _vapid is not None:
        return _vapid
    if os.path.exists(VAPID_KEY_PATH):
        _vapid = Vapid.from_file(VAPID_KEY_PATH)
    else:
        _vapid = Vapid()
        _vapid.generate_keys()
        os.makedirs(db.DATA_DIR, exist_ok=True)
        _vapid.save_key(VAPID_KEY_PATH)
    return _vapid


def public_key_b64url() -> str:
    """
    The public key in the raw, URL-safe-base64 form the browser's
    `PushManager.subscribe({applicationServerKey})` expects — an uncompressed
    EC point, not the PEM/DER shape `cryptography` normally hands back.
    """
    vapid = _load_vapid()
    raw = vapid.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def send(subscription: dict, title: str, body: str, data: dict | None = None) -> str:
    """
    Push one notification to one subscription.

    Never raises — a dead subscription (the browser revoked it, the user
    uninstalled, the endpoint expired) is routine, not exceptional, and a
    message send must not fail just because one recipient's push target
    went stale. Returns "ok", "gone" (caller should delete the subscription
    row), or "error" (transient — leave the row, it may work next time).
    """
    _load_vapid()
    is_call = str((data or {}).get("incoming_call", "")).lower() == "true"
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "data": data or {}}),
            vapid_private_key=VAPID_KEY_PATH,
            vapid_claims={"sub": VAPID_CLAIMS_SUB},
            content_encoding="aes128gcm",
            ttl=86400 if not is_call else 60,
            headers={
                "Urgency": "high" if is_call else "normal",
                "Topic": (data or {}).get("chat_id", "talkex"),
            },
        )
        return "ok"
    except WebPushException as error:
        status = getattr(error.response, "status_code", None)
        if status in (404, 410):
            return "gone"
        logger.error("push.send: web push rejected — status=%s body=%s", status,
                     str(getattr(error.response, "text", ""))[:500])
        return "error"
    except Exception:
        # A subscription's endpoint is a URL on someone else's server (a real
        # push service in production, whatever a test hands in), and that
        # request can fail in ways the webpush library itself doesn't wrap in
        # WebPushException — DNS failure, connection refused, timeout. None
        # of those are this send's fault, and none should be this send's
        # problem: one bad subscription must never take the whole message
        # send down with it. Still worth a log line — a systemic issue (bad
        # VAPID key, outbound network blocked) would otherwise be invisible.
        logger.exception("push.send: unexpected failure sending web push")
        return "error"
