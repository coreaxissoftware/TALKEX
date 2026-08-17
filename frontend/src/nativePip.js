// Native Android Picture-in-Picture bridge for calls. A no-op everywhere
// else (web/PWA, iOS) — real system PiP needs Activity-level native code
// (see MainActivity.java / CallStatePlugin.java) that only exists here.
//
// Flow: CallOverlay tells native "a call is on screen" via setCallActive(true)
// the moment it mounts an active call, and (false) the moment it ends.
// MainActivity.onUserLeaveHint() only ever enters PiP while that flag is set —
// backgrounding the app OUTSIDE a call behaves exactly as before. Once in PiP,
// MainActivity.onPictureInPictureModeChanged calls window.talkexOnPipModeChanged
// directly (same "native calls a global JS function" pattern already used for
// call notifications in MainActivity.java), which onPipModeChange below wires
// up to a React callback so the call UI can swap to a minimal, PiP-sized view.

import { Capacitor, registerPlugin } from "@capacitor/core";

function isNativeAndroid() {
  try { return Capacitor?.isNativePlatform?.() && Capacitor.getPlatform?.() === "android"; }
  catch { return false; }
}

let CallState = null;
function plugin() {
  if (!isNativeAndroid()) return null;
  if (!CallState) {
    try { CallState = registerPlugin("CallState"); } catch { CallState = null; }
  }
  return CallState;
}

/** Tell native whether a call is currently on screen. Safe to call on web. */
export function setCallActive(active) {
  plugin()?.setActive({ active }).catch(() => {});
}

/**
 * Subscribe to PiP enter/exit, called directly by MainActivity — not a
 * Capacitor plugin event, just a global function it invokes. Returns an
 * unsubscribe function. No-op (never fires) outside native Android.
 */
export function onPipModeChange(callback) {
  if (!isNativeAndroid()) return () => {};
  window.talkexOnPipModeChanged = (isInPip) => callback(Boolean(isInPip));
  return () => { delete window.talkexOnPipModeChanged; };
}
