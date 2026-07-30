// Web Push subscription management — the browser side of push.py.
//
// A subscription is per-BROWSER, not per-account: it's tied to the service
// worker registration and the push service the browser itself picked, which
// is why this lives outside api.js's request wrappers — it talks to
// navigator.serviceWorker and PushManager first, and only touches the
// server to hand over (or withdraw) the resulting endpoint.

import { Push } from "./api.js";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getPushSubscription() {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export async function enablePush() {
  if (!isPushSupported()) {
    throw new Error("Push notifications aren't supported in this browser");
  }

  // Asked for here, not at page load — a permission prompt nobody asked for
  // yet is exactly the pattern that trains people to reflexively click
  // "Block" on every site's notification request.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was denied");
  }

  const registration = await navigator.serviceWorker.register("/service-worker.js");
  await navigator.serviceWorker.ready;

  const { key } = await Push.vapidPublicKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  const json = subscription.toJSON();
  await Push.subscribe({
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
  });
  return subscription;
}

export async function disablePush() {
  const subscription = await getPushSubscription();
  if (!subscription) return;
  // Tell the server first, while the endpoint still identifies a live
  // subscription — unsubscribing locally first and then failing to reach the
  // server would leave a dead row nobody ever cleans up.
  await Push.unsubscribe(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}
