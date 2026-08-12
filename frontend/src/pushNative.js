// Native (FCM) push for the Capacitor Android app. On the web this is a no-op —
// the browser/PWA uses the standard Web Push path (push.js) instead, since a
// Capacitor WebView can't receive Web Push.
//
// Flow: ask permission -> register with FCM -> the "registration" event hands
// back a device token, which we send to the backend (/push/fcm-token) so it can
// push to this device. Tapping a notification opens the right chat.

import { Capacitor } from "@capacitor/core";
import { Push } from "./api.js";

let started = false;
let lastToken = null;

function isNative() {
  try { return Capacitor?.isNativePlatform?.(); } catch { return false; }
}

/**
 * Wire up native push once, after sign-in. `onOpenChat(chatId)` is called when
 * the user taps a notification. Safe to call on web (does nothing there).
 */
export async function initNativePush(onOpenChat) {
  if (!isNative() || started) return;
  started = true;

  // Loaded lazily so the web bundle never pulls the native plugin.
  const { PushNotifications } = await import("@capacitor/push-notifications");

  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== "granted") { started = false; return; }

  // A HIGH-importance channel (id matches the backend's fcm.py channel_id) so
  // notifications — especially calls — show as heads-up with sound on Android 8+.
  if (Capacitor.getPlatform?.() === "android") {
    try {
      await PushNotifications.createChannel({
        id: "talkex_default", name: "TalkEx", importance: 5, visibility: 1, sound: "default",
      });
    } catch { /* older Android / already exists */ }
  }

  await PushNotifications.addListener("registration", async (token) => {
    lastToken = token.value;
    try { await Push.registerFcmToken(token.value); } catch { /* retried on next launch */ }
  });
  await PushNotifications.addListener("registrationError", () => { started = false; });

  // Tap on a notification (app in background/closed) -> open that chat.
  await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const chatId = action?.notification?.data?.chat_id;
    if (chatId && onOpenChat) onOpenChat(chatId);
  });

  await PushNotifications.register();
}

/** Best-effort: stop this device receiving push (on sign-out). */
export async function stopNativePush() {
  if (!isNative()) return;
  if (lastToken) {
    try { await Push.unregisterFcmToken(lastToken); } catch { /* ignore */ }
  }
}
