// Device-local app lock — a PIN that guards the UI itself, separate from
// account sign-in. Same idea as WhatsApp/Telegram's "app lock": the PIN
// never leaves this device and the server never sees it, so it can't gate
// anything the account itself needs (that's what two-step verification is
// for). Forgetting it only ever costs a sign-out, never a lockout.

const HASH_KEY = "ht_applock_hash";
const ENABLED_KEY = "ht_applock_enabled";
const TIMEOUT_KEY = "ht_applock_timeout"; // seconds of backgrounding before re-lock

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
