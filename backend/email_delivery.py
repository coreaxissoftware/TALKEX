"""
Email delivery for connecting and verifying an account's email address.

Named email_delivery.py rather than email.py deliberately — Python ships a
stdlib package literally called `email`, and this file's own directory is on
sys.path, so a same-named module here would shadow it for every other file
in the project that imports the real one.

Sends via Mailgun's HTTP API (stdlib urllib, no extra dependency) — set
MAILGUN_API_KEY and MAILGUN_DOMAIN from the superadmin panel's Integrations
tab (no redeploy needed), falling back to the matching env vars if the
panel has never been used; until either is configured, a code is logged to
the server console instead of actually mailed anywhere.
"""

import base64
import logging
import os
import urllib.error
import urllib.parse
import urllib.request

import db

logger = logging.getLogger("talkex.email")


def _config():
    # `or`, not get_setting's own `default` param — see sms.py's _config
    # for why: get_setting only falls back to a default when the row is
    # entirely ABSENT, so a setting saved once and later cleared to '' from
    # the superadmin panel would otherwise silently shadow a real env var
    # instead of falling through to it.
    api_key = db.get_setting("mailgun_api_key") or os.environ.get("MAILGUN_API_KEY", "")
    domain = db.get_setting("mailgun_domain") or os.environ.get("MAILGUN_DOMAIN", "")
    base_url = db.get_setting("mailgun_base_url") or os.environ.get("MAILGUN_BASE_URL", "https://api.mailgun.net")
    default_sender = f"TalkEx <noreply@{domain}>" if domain else ""
    sender = db.get_setting("mailgun_from") or os.environ.get("MAILGUN_FROM", default_sender)
    return api_key, domain, base_url, sender


def send_otp(email: str, code: str, expires_in_seconds: int = 300) -> str:
    """
    Send a verification code to an email address. Returns 'sent' or 'error'.

    Falls back to logging the code to the server console when Mailgun isn't
    configured — the same dev-mode behavior this always had, just now the
    honest fallback rather than the only path. The caller passes its own
    OTP_LIFETIME_SECONDS rather than this module importing main.py's, which
    would be circular (main.py is what imports this file).
    """
    api_key, domain, base_url, sender = _config()
    if not (api_key and domain):
        logger.warning("[DEV EMAIL — Mailgun not configured] Verification code for %s: %s", email, code)
        print(f"[DEV EMAIL — Mailgun not configured] Verification code for {email}: {code}")
        return "sent"

    minutes = max(1, expires_in_seconds // 60)
    body = urllib.parse.urlencode({
        "from": sender,
        "to": email,
        "subject": "Your TalkEx verification code",
        "text": (
            f"Your TalkEx verification code is {code}. It expires in {minutes} minutes.\n\n"
            "If you didn't request this, you can ignore this email."
        ),
    }).encode()

    url = f"{base_url.rstrip('/')}/v3/{domain}/messages"
    auth = base64.b64encode(f"api:{api_key}".encode()).decode()
    request = urllib.request.Request(
        url, data=body, method="POST", headers={"Authorization": f"Basic {auth}"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return "sent" if response.status < 300 else "error"
    except urllib.error.URLError:
        logger.exception("Mailgun request failed for %s", email)
        return "error"
