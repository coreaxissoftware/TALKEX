// Runtime-permission bridge (native Android). Triggers the OS permission
// popups for camera, microphone, photos/videos, location, contacts and
// notifications so features never silently no-op for a permission the user
// would have granted. See PermissionsPlugin.java.
//
// The important case: getUserMedia() inside a Capacitor WebView can reject
// without ever showing a dialog when CAMERA/RECORD_AUDIO aren't granted yet —
// so callers request those here FIRST, then open the camera.
//
// No-op on web/PWA/iOS (returns {}), where the browser/OS shows its own
// prompts at the point of use; callers must not depend on the result there.

import { Capacitor, registerPlugin } from "@capacitor/core";

function isNativeAndroid() {
  try { return Capacitor?.isNativePlatform?.() && Capacitor.getPlatform?.() === "android"; }
  catch { return false; }
}

let AppPermissions = null;
function plugin() {
  if (!isNativeAndroid()) return null;
  if (!AppPermissions) {
    try { AppPermissions = registerPlugin("AppPermissions"); } catch { AppPermissions = null; }
  }
  return AppPermissions;
}

/**
 * Ask for one or more permissions (shows the OS popup for any not yet granted).
 * @param {string[]} list e.g. ["camera","microphone"]. Valid aliases:
 *   camera | microphone | photos | location | contacts | notifications
 * @returns {Promise<Object>} alias -> "granted" | "denied" | "prompt" ({} on web)
 */
export async function ensurePermissions(list) {
  const p = plugin();
  if (!p) return {};
  try { return (await p.request({ permissions: list })) || {}; }
  catch { return {}; }
}

/** Current states without prompting ({} on web). */
export async function checkPermissions() {
  const p = plugin();
  if (!p) return {};
  try { return (await p.check()) || {}; }
  catch { return {}; }
}
