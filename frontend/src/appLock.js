// Device-local app lock — a PIN that guards the UI itself, separate from
// account sign-in. Same idea as WhatsApp/Telegram's "app lock": the PIN
// never leaves this device and the server never sees it, so it can't gate
// anything the account itself needs (that's what two-step verification is
// for). Forgetting it only ever costs a sign-out, never a lockout.

const HASH_KEY = "ht_applock_hash";
const ENABLED_KEY = "ht_applock_enabled";
const TIMEOUT_KEY = "ht_applock_timeout"; // seconds of backgrounding before re-lock
const BIOMETRIC_CRED_KEY = "ht_applock_biometric_cred"; // base64 rawId of the local WebAuthn credential

async function hashPin(pin) {
  const bytes = new TextEncoder().encode(`talkex-applock:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function setAppLockPin(pin) {
  const hash = await hashPin(pin);
  localStorage.setItem(HASH_KEY, hash);
  localStorage.setItem(ENABLED_KEY, "1");
}

export function disableAppLock() {
  localStorage.removeItem(HASH_KEY);
  localStorage.removeItem(ENABLED_KEY);
}

export function isAppLockEnabled() {
  return localStorage.getItem(ENABLED_KEY) === "1" && Boolean(localStorage.getItem(HASH_KEY));
}

export async function verifyAppLockPin(pin) {
  const stored = localStorage.getItem(HASH_KEY);
  if (!stored) return false;
  return (await hashPin(pin)) === stored;
}

export function getAppLockTimeout() {
  const raw = localStorage.getItem(TIMEOUT_KEY);
  return raw ? Number(raw) : 0; // 0 = lock immediately on backgrounding
}

export function setAppLockTimeout(seconds) {
  localStorage.setItem(TIMEOUT_KEY, String(seconds));
}

// ── Biometric unlock (WebAuthn) ─────────────────────────────────────────────
//
// A second way to pass the same local gate the PIN guards, not a separate
// account credential — nothing here ever reaches the server, same as the PIN
// hash above. A WebAuthn platform authenticator (Face ID, Windows Hello, an
// Android fingerprint reader) is the standard browser API for "make the OS
// itself prove who's holding the device," so it's reused here purely for its
// user-verification prompt: since there is no server to check a signature
// against anyway, the credential's mere existence and a successful
// navigator.credentials.get() (which the browser only resolves after the
// platform authenticator itself verifies the biometric) IS the unlock.

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
function base64ToBuffer(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

export async function isBiometricAvailable() {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
  catch { return false; }
}

export function isBiometricEnabled() {
  return Boolean(localStorage.getItem(BIOMETRIC_CRED_KEY));
}

/** Prompts for a fingerprint/Face ID scan and stores the resulting credential locally. */
export async function enableBiometric() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge, rp: { name: "TalkEx app lock" },
      user: { id: userId, name: "talkex-local-lock", displayName: "App lock" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
      attestation: "none",
    },
  });
  if (!credential) throw new Error("Biometric setup was cancelled");
  localStorage.setItem(BIOMETRIC_CRED_KEY, bufferToBase64(credential.rawId));
}

export function disableBiometric() {
  localStorage.removeItem(BIOMETRIC_CRED_KEY);
}

/** Resolves true on a successful scan, false on a cancel/no-match — never throws. */
export async function verifyBiometric() {
  const stored = localStorage.getItem(BIOMETRIC_CRED_KEY);
  if (!stored) return false;
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: base64ToBuffer(stored), type: "public-key" }],
        userVerification: "required",
        timeout: 60000,
      },
    });
    return Boolean(assertion);
  } catch {
    return false;
  }
}
