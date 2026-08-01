// Chat background preference — same purely-local, per-device pattern as
// mediaPrefs.js's auto-download setting. Defaults to the animated particle
// network everywhere, but is a real per-user choice: change it once in
// Settings > Appearance and every chat (mobile and desktop) picks it up.
//
// Stored shape is one of:
//   { type: "particles" }
//   { type: "none" }
//   { type: "texture", id: "texture1".."texture6" }
//   { type: "canvas", id: "bokeh" | "flowlines" }
//   { type: "custom", dataUrl: "data:image/jpeg;base64,..." }
//
// Blur intensity is a separate preference (its own key/event) rather than a
// field on the object above — it applies uniformly across every wallpaper
// type, so keeping it independent means picking a new wallpaper never
// accidentally resets the blur the person already dialed in, and vice versa.

const KEY = "ht_chat_wallpaper";
const EVENT = "ht-wallpaper-change";
const BLUR_KEY = "ht_wallpaper_blur";
const BLUR_EVENT = "ht-wallpaper-blur-change";

// Two more canvas-drawn wallpapers alongside the particle network — always
// dark (not theme-adaptive like the CSS textures above), same idea as
// WhatsApp's own fixed-dark wallpaper gallery.
export const CANVAS_WALLPAPERS = [
  { id: "bokeh", label: "Bokeh" },
  { id: "flowlines", label: "Flow Lines" },
];

// Pure CSS patterns, no image assets — each `css()` takes the live `G`
// palette object (from ui.jsx) and builds its pattern out of G.text at low
// opacity, so it re-themes for free: dark specks on a light background in
// light mode, light specks on dark in dark mode, no separate light/dark
// asset pair to keep in sync.
export const TEXTURES = [
  { id: "texture1", label: "Dots", size: "22px 22px",
    css: (G) => `radial-gradient(circle, ${G.text}26 1.6px, transparent 1.6px)` },
  { id: "texture2", label: "Diagonal", size: "20px 20px",
    css: (G) => `repeating-linear-gradient(45deg, ${G.text}1c, ${G.text}1c 1px, transparent 1px, transparent 14px)` },
  { id: "texture3", label: "Grid", size: "26px 26px",
    css: (G) => `linear-gradient(${G.text}1c 1px, transparent 1px), linear-gradient(90deg, ${G.text}1c 1px, transparent 1px)` },
  { id: "texture4", label: "Herringbone", size: "36px 36px",
    css: (G) => `repeating-linear-gradient(135deg, ${G.text}1c 0 2px, transparent 2px 18px), repeating-linear-gradient(45deg, ${G.text}1c 0 2px, transparent 2px 18px)` },
  { id: "texture5", label: "Bubbles", size: "48px 48px",
    css: (G) => `radial-gradient(circle at 25% 25%, ${G.text}22 6px, transparent 7px), radial-gradient(circle at 75% 75%, ${G.text}18 8px, transparent 9px)` },
  { id: "texture6", label: "Waves", size: "26px 26px",
    css: (G) => `repeating-radial-gradient(circle at 0 0, transparent 0, ${G.text}12 12px, transparent 13px, transparent 24px)` },
];

export function getWallpaper() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt/old value — fall through to the default */ }
  return { type: "particles" };
}

export function setWallpaper(value) {
  localStorage.setItem(KEY, JSON.stringify(value));
  // ChatView may already be mounted (desktop split-view keeps it alive
  // underneath the Settings tab in a way mobile's single-screen navigation
  // never does) — a plain localStorage write doesn't trigger a re-render on
  // its own, so broadcast it to whoever's listening.
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

export function onWallpaperChange(callback) {
  const handler = (event) => callback(event.detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

// 0-20px. Applies as a CSS filter over whichever wallpaper is active.
export function getWallpaperBlur() {
  const n = parseInt(localStorage.getItem(BLUR_KEY), 10);
  return Number.isFinite(n) ? Math.min(20, Math.max(0, n)) : 0;
}

export function setWallpaperBlur(px) {
  localStorage.setItem(BLUR_KEY, String(px));
  window.dispatchEvent(new CustomEvent(BLUR_EVENT, { detail: px }));
}

export function onWallpaperBlurChange(callback) {
  const handler = (event) => callback(event.detail);
  window.addEventListener(BLUR_EVENT, handler);
  return () => window.removeEventListener(BLUR_EVENT, handler);
}

/**
 * Downscales and re-encodes an uploaded photo before it goes into
 * localStorage as a data URL — a phone camera photo saved as-is would blow
 * well past the ~5MB/origin quota almost immediately, taking every other
 * local preference down with it.
 */
export function readImageAsWallpaper(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 1600;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = MAX / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
