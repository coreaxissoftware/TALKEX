"""
Passwords and session tokens.

The first version stored `sha256(password)` with no salt. Two users who picked
the same password got the same hash, and the whole table could be cracked
against a rainbow table in seconds. It also had a branch that let anyone log in
as the demo account with any password at all.

Both are fixed here. No third-party dependency is used: PBKDF2 ships in the
standard library, so `pip install` stays a four-line file.
"""

import hashlib
import hmac
import secrets
import time

# OWASP's floor for PBKDF2-HMAC-SHA256 is 600,000 iterations. Raising this later
# is safe: the number is stored inside each hash, so old passwords keep working
# and get upgraded the next time their owner logs in.
PBKDF2_ITERATIONS = 600_000

# How long a login lasts before the user has to sign in again.
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days


def hash_password(password: str) -> str:
    """
    Return a self-describing hash: algorithm, iterations, salt and digest in one
    string. Everything needed to verify it later travels with it.
    """
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Check a password against a stored hash. Returns False on anything malformed."""
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False

    if algorithm != "pbkdf2_sha256":
        return False

    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        iterations = int(iterations)
    except ValueError:
        return False

    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)

    # compare_digest and not `==`: a plain comparison returns as soon as two
    # bytes differ, and the time it took leaks how much of the digest matched.
    return hmac.compare_digest(actual, expected)


def needs_rehash(stored: str) -> bool:
    """True when a stored hash uses fewer iterations than we now require."""
    try:
        algorithm, iterations, _, _ = stored.split("$")
        return algorithm != "pbkdf2_sha256" or int(iterations) < PBKDF2_ITERATIONS
    except ValueError:
        return True


def new_session_token() -> tuple[str, str, float]:
    """
    Mint a session token.

    Returns the token to hand to the client, the hash to store, and the moment
    it expires. Only the hash is written to the database, so a leaked backup
    cannot be replayed as a login.
    """
    token = secrets.token_urlsafe(32)
    return token, hash_token(token), time.time() + SESSION_TTL_SECONDS


def hash_token(token: str) -> str:
    """
    Hash a bearer token for storage and lookup.

    Plain SHA-256 is correct here, unlike for passwords: the token is 32 bytes of
    real randomness, so there is nothing to brute-force and no reason to pay for
    a slow KDF on every single authenticated request.
    """
    return hashlib.sha256(token.encode()).hexdigest()


def hash_otp(code: str) -> str:
    """
    Hash a short-lived OTP code for storage.

    Deliberately NOT hash_password's PBKDF2: a 6-digit OTP's brute-force
    risk is already covered by a 5-minute expiry, a capped attempt count and
    a rate limiter, so 600,000 KDF iterations buy no extra security — only
    ~100-300ms of wasted CPU per OTP issued, which on FastAPI's sync-route
    thread pool is throughput an attacker can burn through by requesting
    many codes. Plain SHA-256 (like hash_token) is the right cost here.
    """
    return "sha256$" + hashlib.sha256(code.encode()).hexdigest()


def verify_otp(code: str, stored: str) -> bool:
    """Check an OTP code against a hash produced by hash_otp(). Returns False
    on anything malformed, same convention as verify_password."""
    try:
        algorithm, digest_hex = stored.split("$")
    except ValueError:
        return False
    if algorithm != "sha256":
        return False
    actual = hashlib.sha256(code.encode()).hexdigest()
    return hmac.compare_digest(actual, digest_hex)


def new_api_key() -> tuple[str, str, str]:
    """
    Mint a bulk-sending API key.

    Returns (raw_key, key_hash, prefix). The `hk_` prefix is not decorative —
    it is what lets a leaked-secret scanner (or a human skimming a log file)
    recognise this as a TalkEx credential at all, the same convention
    Stripe/GitHub/OpenAI keys use. Hashed the same way as a session token: the
    key itself has 32 bytes of real randomness, so a slow password KDF would
    only cost latency for no security benefit.
    """
    raw = "hk_" + secrets.token_urlsafe(32)
    return raw, hash_token(raw), raw[:10]
