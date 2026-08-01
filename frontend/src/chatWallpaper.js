// Chat background preference — same purely-local, per-device pattern as
// mediaPrefs.js's auto-download setting. Defaults to the animated particle
// network everywhere, but is a real per-user choice: change it once in
// Settings → Appearance and every chat (mobile and desktop) picks it up.

const KEY = "ht_chat_wallpaper";
const EVENT = "ht-wallpaper-change";

// "particles" | "none"
export function getWallpaper() {
  return localStorage.getItem(KEY) || "particles";
}

export function setWallpaper(value) {
  localStorage.setItem(KEY, value);
  // ChatView may already be mounted (e.g. desktop split-view) when this
  // changes in Settings — a plain localStorage write doesn't trigger a
  // re-render on its own, so broadcast it to whoever's listening.
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

export function onWallpaperChange(callback) {
  const handler = (event) => callback(event.detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
