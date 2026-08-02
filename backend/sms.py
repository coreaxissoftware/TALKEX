"""
SMS delivery for phone number verification (signup and number-change OTPs).

Sends via MSG91's Flow API (stdlib urllib + json — no extra dependency).
Credentials come from the `settings` table first — set from the superadmin
panel's Integrations tab, no redeploy needed — falling back to
MSG91_AUTH_KEY/MSG91_TEMPLATE_ID/MSG91_VAR_NAME env vars if the panel has
never been used. Until either is configured, an OTP is logged to the
server console instead, exactly like before.

The message text itself is registered separately on India's DLT platform
under the CoreAxis entity (approved header "COREAX"), then wired into an
MSG91 "Flow" — MSG91_TEMPLATE_ID is that flow's id, not the raw DLT
template id, and MSG91_VAR_NAME is whatever the flow's single variable was
named when it was created in the MSG91 dashboard (MSG91 lets you pick the
name; there's no fixed convention, "var" is just the common default).

Everything else — generating the code, hashing it at rest, expiry, rate
limiting, retry counting — is already provider-agnostic (see phone_otps in
db.py and the /auth/phone/* routes in main.py). Swapping MSG91 for a
different provider later means only replacing the body of send_otp();
nothing else in the OTP flow needs to change.
"""

import json
import logging
import os
import re
import urllib.error
import urllib.request

import db

logger = logging.getLogger("talkex.sms")


def _config():
    return (
        db.get_setting("msg91_auth_key", os.environ.get("MSG91_AUTH_KEY", "")),
        db.get_setting("msg91_template_id", os.environ.get("MSG91_TEMPLATE_ID", "")),
        db.get_setting("msg91_var_name", os.environ.get("MSG91_VAR_NAME", "var")),
    )


def send_otp(phone: str, code: str) -> str:
    """
    Send a one-time code to a phone number. Returns 'sent' or 'error'.

    Falls back to logging the code to the server console when MSG91 isn't
    configured — the same dev-mode behavior this always had, just now the
    honest fallback rather than the only path.
    """
    auth_key, template_id, var_name = _config()
    if not (auth_key and template_id):
        logger.warning("[DEV SMS — no provider configured] OTP for %s: %s", phone, code)
        print(f"[DEV SMS — no provider configured] OTP for {phone}: {code}")
        return "sent"

    # MSG91 wants a bare country-code-prefixed number — no "+", no spaces.
    mobile = re.sub(r"[^0-9]", "", phone)

    body = json.dumps({
        "template_id": template_id,
        "recipients": [{"mobiles": mobile, var_name: code}],
    }).encode()
    request = urllib.request.Request(
        "https://control.msg91.com/api/v5/flow/", data=body, method="POST",
        headers={
            "authkey": auth_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        # MSG91 puts the actual reason (bad template id, unapproved DLT
        # header, insufficient balance, etc.) in the body even on a 4xx —
        # log it, since "SMS request failed" alone gives no way to diagnose
        # a silently-undelivered OTP.
        logger.error("MSG91 SMS request failed for %s: HTTP %s %s",
                     phone, exc.code, _safe_body(exc))
        return "error"
    except urllib.error.URLError:
        logger.exception("MSG91 SMS request failed for %s", phone)
        return "error"

    # MSG91's Flow API returns HTTP 200 for both success AND rejection
    # (invalid template variable, unapproved DLT entity, etc.) — the only
    # way to tell them apart is the "type" field in the body, so a 200
    # alone is not enough to call this "sent".
    try:
        parsed = json.loads(raw)
    except ValueError:
        logger.error("MSG91 SMS response for %s was not JSON: %r", phone, raw[:300])
        return "error"

    if str(parsed.get("type", "")).lower() == "success":
        return "sent"
    logger.error("MSG91 rejected the SMS for %s: %s", phone, parsed.get("message", parsed))
    return "error"


def _safe_body(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode(errors="replace")[:300]
    except Exception:
        return "<no body>"
