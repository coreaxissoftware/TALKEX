// Native Android media-library bridge — lets the app show its OWN gallery grid
// (WhatsApp-style) by listing the device's photos/videos from MediaStore,
// instead of bouncing out to the system file picker.
//
// Native-Android only (see MediaLibraryPlugin.java). Everywhere else — web,
// PWA, iOS — isAvailable() returns false and callers fall back to the ordinary
// <input type="file"> picker, so the gallery button is never a dead end. Even
// on Android, if permission is denied or the query fails, listMedia() returns
// null and the caller falls back the same way.
//
// The plugin returns only lightweight metadata + each item's content:// URI.
// We turn those URIs into something the WebView can render and upload with
// Capacitor.convertFileSrc(), which routes content:// through Capacitor's local
// server — no heavy base64 of full-resolution media crosses the bridge.

import { Capacitor, registerPlugin } from "@capacitor/core";

function isNativeAndroid() {
  try { return Capacitor?.isNativePlatform?.() && Capacitor.getPlatform?.() === "android"; }
  catch { return false; }
}

let MediaLibrary = null;
function plugin() {
  if (!isNativeAndroid()) return null;
  if (!MediaLibrary) {
    try { MediaLibrary = registerPlugin("MediaLibrary"); } catch { MediaLibrary = null; }
  }
  return MediaLibrary;
}

/** True only where the in-app grid can actually work (native Android build). */
export function galleryAvailable() {
  return !!plugin();
}

/**
 * List device photos/videos, newest first. Returns an array of items
 * ({ id, uri, name, mime, size, dateAdded, isVideo }) or null if the in-app
 * gallery isn't available / permission was denied — the caller then falls back
 * to the OS file picker.
 */
export async function listMedia({ limit = 300, offset = 0 } = {}) {
  const p = plugin();
  if (!p) return null;
  try {
    const res = await p.getMedia({ limit, offset });
    return Array.isArray(res?.items) ? res.items : [];
  } catch {
    return null; // denied or failed → caller falls back to the OS picker
  }
}

/** A URL the WebView can use as an <img>/<video> src for a listed item. */
export function mediaSrc(item) {
  if (!item?.uri) return "";
  try { return Capacitor.convertFileSrc(item.uri); } catch { return item.uri; }
}

/** Read a listed item's full bytes into a real File, ready to send/preview. */
export async function itemToFile(item) {
  const url = mediaSrc(item);
  const res = await fetch(url);
  const blob = await res.blob();
  const type = item.mime || blob.type || (item.isVideo ? "video/mp4" : "image/jpeg");
  return new File([blob], item.name || `media-${item.id || Date.now()}`, { type });
}

// ── Native save / share (WebView can't do <a download> or navigator.share) ────

async function blobUrlToBase64(blobUrl) {
  const blob = await fetch(blobUrl).then((r) => r.blob());
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { base64: String(dataUrl).split(",")[1] || "", mime: blob.type };
}

/**
 * Save a blob-URL file to the device gallery/Downloads via the native plugin.
 * Returns true on success, false if unavailable (caller then does the web
 * fallback). Native Android only.
 */
export async function nativeSave(blobUrl, name, mime) {
  const p = plugin();
  if (!p || !blobUrl) return false;
  try {
    const { base64, mime: bmime } = await blobUrlToBase64(blobUrl);
    if (!base64) return false;
    await p.saveToGallery({ data: base64, name: name || `file-${Date.now()}`, mime: mime || bmime || "application/octet-stream" });
    return true;
  } catch { return false; }
}

/** Share a blob-URL file (and/or text) via the native system share sheet. */
export async function nativeShare(blobUrl, name, mime, text) {
  const p = plugin();
  if (!p) return false;
  try {
    let payload = { name: name || `file-${Date.now()}`, text: text || null };
    if (blobUrl) {
      const { base64, mime: bmime } = await blobUrlToBase64(blobUrl);
      payload.data = base64;
      payload.mime = mime || bmime || "*/*";
    }
    await p.shareMedia(payload);
    return true;
  } catch { return false; }
}

/**
 * Share several files at once via the native share sheet.
 * @param {Array<{blobUrl:string,name:string,mime?:string}>} items
 */
export async function nativeShareFiles(items, text) {
  const p = plugin();
  if (!p || !items?.length) return false;
  try {
    const files = [];
    for (const it of items) {
      const { base64, mime } = await blobUrlToBase64(it.blobUrl);
      if (base64) files.push({ data: base64, name: it.name || `file-${Date.now()}`, mime: it.mime || mime || "*/*" });
    }
    if (!files.length) return false;
    await p.shareFiles({ files, text: text || null });
    return true;
  } catch { return false; }
}
