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
import os

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
        return None
    info = json.loads(raw)
    _project_id = info.get("project_id")
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
        return "error"
    try:
        if not creds.valid:
            creds.refresh(Request())
        access = creds.token
    except Exception:
        return "error"
    if not access or not _project_id:
        return "error"

    # Every value in an FCM `data` payload must be a string.
    str_data = {str(k): str(v) for k, v in (data or {}).items()}
    message = {
        "message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": str_data,
            # High priority + a default sound/channel so it wakes a sleeping
            # device — important for calls, which are time-sensitive.
            "android": {
                "priority": "high",
                "notification": {"sound": "default", "channel_id": "talkex_default"},
            },
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
        return "error"

    if resp.status_code == 200:
        return "ok"
    # 404 NOT_FOUND / UNREGISTERED, or a 400 naming the token as unregistered,
    # means the app was uninstalled or the token rotated — drop it.
    text = resp.text or ""
    if resp.status_code == 404 or ("UNREGISTERED" in text or "registration-token-not-registered" in text):
        return "gone"
    return "error"
