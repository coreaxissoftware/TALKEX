// Auto-download preference for chat media (photos/videos/voice/documents).
//
// This is a purely local, per-device choice — same as WhatsApp's own
// version of this setting — so it lives in localStorage, not the server.
// A device on a bad connection shouldn't have its bandwidth choice fight
// with what some other signed-in device decided.

const KEY = "ht_auto_download";

// "always" | "wifi" | "never"
export function getAutoDownload() {
  return localStorage.getItem(KEY) || "always";
}

export function setAutoDownload(value) {
  localStorage.setItem(KEY, value);
}

function isOnWifi() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  // The Network Information API is inconsistently supported (Chrome/Android
  // only, no Safari/Firefox) and even where present, `type` is often not
  // reported for privacy reasons. When we genuinely can't tell, defaulting
  // to "yes, download" is the safer failure mode — a wrongly-blocked photo
  // is a worse experience than an occasional download over mobile data.
  if (!conn) return true;
  if (typeof conn.type === "string" && conn.type !== "unknown") {
    return conn.type === "wifi" || conn.type === "ethernet";
  }
  return true;
}

export function shouldAutoDownload() {
  const pref = getAutoDownload();
  if (pref === "always") return true;
  if (pref === "never") return false;
  return isOnWifi();
}
