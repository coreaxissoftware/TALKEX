// Device address-book access. The browser-only Contact Picker API
// (navigator.contacts.select) is not reliably exposed inside a Capacitor
// WebView the way it is in the actual Chrome browser — on the real Android
// app this silently left "Import from phone" doing nothing, since
// "contacts" in navigator often reads false there too. On native Android
// this instead calls a real plugin (ContactsPlugin.java) backed by
// Android's own READ_CONTACTS runtime permission. Everywhere else (web,
// iOS) keeps using the browser API directly — this file is a no-op there.

import { Capacitor, registerPlugin } from "@capacitor/core";

function isNativeAndroid() {
  try { return Capacitor?.isNativePlatform?.() && Capacitor.getPlatform?.() === "android"; }
  catch { return false; }
}

let NativeContacts = null;
function plugin() {
  if (!isNativeAndroid()) return null;
  if (!NativeContacts) {
    try { NativeContacts = registerPlugin("NativeContacts"); } catch { NativeContacts = null; }
  }
  return NativeContacts;
}

/** Whether picking device contacts is possible at all on this platform/browser. */
export function contactsAvailable() {
  if (isNativeAndroid()) return true;
  return typeof navigator !== "undefined" && "contacts" in navigator && "ContactsManager" in window;
}

/**
 * Same return shape navigator.contacts.select() produces:
 * [{name: [string], tel: [string]}, ...]. On native Android this prompts
 * Android's own permission dialog the first time (via the plugin's
 * @Permission annotation) rather than anything this function has to manage.
 */
export async function pickContacts() {
  const p = plugin();
  if (p) {
    const { contacts } = await p.pickContacts();
    return contacts;
  }
  return navigator.contacts.select(["name", "tel"], { multiple: true });
}

/**
 * Read ALL device contacts silently (no picker UI). On native Android this
 * works without a user gesture once READ_CONTACTS has been granted; on web
 * the Contact Picker API always requires a gesture, so this returns null
 * there — auto-sync is Android-only for now.
 */
export async function getAllContacts() {
  const p = plugin();
  if (!p) return null;
  try {
    const { contacts } = await p.pickContacts();
    return contacts;
  } catch {
    return null;
  }
}
