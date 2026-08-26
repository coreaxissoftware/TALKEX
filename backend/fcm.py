"""
Firebase Cloud Messaging (FCM) sender — the push path for NATIVE devices.

The Capacitor Android app runs in a WebView that can't receive the browser
Web Push we use for the web/PWA (see push.py); it registers an FCM device
token instead, and this module delivers to it via the FCM HTTP v1 API.

Auth is a short-lived OAuth token minted from a service-account key, supplied
at runtime as the FCM_SERVICE_ACCOUNT_JSON environment variable (the whole
service-account JSON as a string). No key ever lives in the repo. If the env
var is absent, is_configured() is False and send() is a no-op, so the app runs
perfectly fine without FCM configured — the web push path is unaffected.
"""

import json
import logging
import os

logger = logging.getLogger("talkex.fcm")
_warned_not_configured = False

try:
    import requests  # brought in transitively by pywebpush / google-auth
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request
    _IMPORTS_OK = True
except Exception:  # pragma: no cover - only if deps missing
    _IMPORTS_OK = False

_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

_creds = None
_project_id = None


def is_configured() -> bool:
    """True when a service-account key is available to send with."""
    return bool(_IMPORTS_OK and os.environ.get("FCM_SERVICE_ACCOUNT_JSON"))


def _load_credentials():
    """Cached service-account credentials, or None if not configured."""
    global _creds, _project_id
    if _creds is not None:
        return _creds
    raw = os.environ.get("FCM_SERVICE_ACCOUNT_JSON")
    if not raw or not _IMPORTS_OK:
        if not _IMPORTS_OK:
            logger.warning("fcm: google-auth/requests import failed — FCM disabled")
        return None
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error("fcm: FCM_SERVICE_ACCOUNT_JSON is not valid JSON: %s", e)
        return None
    _project_id = info.get("project_id")
    if not _project_id:
        logger.error("fcm: FCM_SERVICE_ACCOUNT_JSON has no project_id field")
        return None
    logger.info("fcm: credentials loaded for project %s", _project_id)
    _creds = service_account.Credentials.from_service_account_info(info, scopes=[_SCOPE])
    return _creds


def send(token: str, title: str, body: str, data: dict | None = None) -> str:
    """
    Deliver one notification to a single FCM device token.

    Returns:
      "ok"    - accepted by FCM
      "gone"  - the token is no longer valid; the caller should delete it
      "error" - transient/other failure (not configured, network, etc.)
    """
    creds = _load_credentials()
    if creds is None:
        # Logged once per process, not once per notification — this fires
        # on EVERY native push attempt when unconfigured, which without a
        # cap would flood the log on every message sent to an Android user
        # while staying completely silent about why they never get pushes.
        global _warned_not_configured
        if not _warned_not_configured:
            _warned_not_configured = True
            logger.warning(
                "fcm.send: FCM_SERVICE_ACCOUNT_JSON is not set (or google-auth/"
                "requests failed to import) — native Android push notifications "
                "are a silent no-op until this is configured."
            )
        return "error"
    try:
        if not creds.valid:
            creds.refresh(Request())
        access = creds.token
    except Exception:
        logger.exception("fcm.send: failed to refresh the FCM OAuth token")
        return "error"
    if not access or not _project_id:
        logger.error("fcm.send: refreshed credentials but got no access token or project_id")
        return "error"

    # Every value in an FCM `data` payload must be a string.
    str_data = {str(k): str(v) for k, v in (data or {}).items()}
    is_call = str(str_data.get("incoming_call", "")).lower() == "true"

    if is_call:
        str_data.setdefault("title", title)
        str_data.setdefault("body", body)
        message = {
            "message": {
                "token": token,
                "data": str_data,
                "android": {
                    "priority": "high",
                    "notification": {
                        "sound": "default",
                        "channel_id": "talkex_calls",
                    },
                },
                "notification": {"title": title, "body": body},
            }
        }
    else:
        str_data["title"] = title
        str_data["body"] = body
        message = {
            "message": {
                "token": token,
                "data": str_data,
                "android": {"priority": "high"},
            }
        }
    url = f"https://fcm.googleapis.com/v1/projects/{_project_id}/messages:send"
    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
            json=message,
            timeout=10,
        )
    except Exception:
        logger.exception("fcm.send: request to FCM failed (network/timeout)")
        return "error"

    if resp.status_code == 200:
        return "ok"
    # 404 NOT_FOUND / UNREGISTERED, or a 400 naming the token as unregistered,
    # means the app was uninstalled or the token rotated — drop it.
    text = resp.text or ""
    if resp.status_code == 404 or ("UNREGISTERED" in text or "registration-token-not-registered" in text):
        return "gone"
    logger.error("fcm.send: FCM rejected the message — status=%s body=%s", resp.status_code, text[:500])
    return "error"
