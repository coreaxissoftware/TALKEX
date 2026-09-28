import { useEffect, useRef, useState, useCallback } from "react";
import { listMedia, mediaSrc, itemToFile } from "./nativeGallery.js";

/**
 * WhatsApp-style in-app gallery grid: the device's own photos/videos in a
 * multi-select grid, so picking media never leaves the app for the system file
 * chooser. Backed by the native MediaLibrary plugin (Android). If that's
 * unavailable or permission is denied, it calls onFallback() so the caller can
 * open the ordinary OS picker instead — the gallery button is never a dead end.
 *
 * Selecting shows a numbered badge (send order). Confirm reads the chosen
 * items' bytes into real File objects and hands them to onPick(), which feeds
 * the same caption/preview/send sheet as every other media path.
 */
const PAGE = 120;

export default function GalleryPicker({ onClose, onPick, onFallback }) {
  const [items, setItems] = useState(null); // null = loading
  const [selected, setSelected] = useState([]); // ordered array of ids
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false); // no more pages
  const offsetRef = useRef(0);
  const loadingMore = useRef(false);
  const scrollRef = useRef(null);

  const loadPage = useCallback(async () => {
    if (loadingMore.current || done) return;
    loadingMore.current = true;
    const batch = await listMedia({ limit: PAGE, offset: offsetRef.current });
    loadingMore.current = false;
    if (batch === null) {
      // Not available / denied → let the caller open the OS picker.
      onFallback?.();
      onClose?.();
      return;
    }
    offsetRef.current += batch.length;
    if (batch.length < PAGE) setDone(true);
    setItems((prev) => (prev ? [...prev, ...batch] : batch));
  }, [done, onFallback, onClose]);

  useEffect(() => { loadPage(); /* first page */ // eslint-disable-next-line
  }, []);

  function onScroll(e) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadPage();
  }

  function toggle(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function confirm() {
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      const byId = new Map((items || []).map((it) => [it.id, it]));
      const chosen = selected.map((id) => byId.get(id)).filter(Boolean);
      const files = [];
      for (const it of chosen) {
        try { files.push(await itemToFile(it)); } catch { /* skip unreadable item */ }
      }
      if (files.length) onPick?.(files);
      else onClose?.();
    } finally {
      setBusy(false);
    }
  }

  const selIndex = (id) => selected.indexOf(id);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b0b0d", zIndex: 88, display: "flex", flexDirection: "column", userSelect: "none" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "calc(10px + env(safe-area-inset-top)) 14px 10px",
        borderBottom: "0.5px solid #ffffff14",
      }}>
        <div onClick={onClose} style={{ cursor: "pointer", padding: 4 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </div>
        <div style={{ flex: 1, color: "#fff", fontSize: 16, fontWeight: 600 }}>
          {selected.length ? `${selected.length} selected` : "Gallery"}
        </div>
      </div>

      {/* Grid */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
        {items === null ? (
          <div style={{ color: "#ffffff88", textAlign: "center", padding: 40, fontSize: 14 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ color: "#ffffff88", textAlign: "center", padding: 40, fontSize: 14 }}>No photos or videos found</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2 }}>
            {items.map((it) => {
              const n = selIndex(it.id);
              const picked = n >= 0;
              const src = mediaSrc(it);
              return (
                <div key={it.id} onClick={() => toggle(it.id)} style={{
                  position: "relative", width: "100%", paddingTop: "100%", cursor: "pointer", background: "#17171b",
                }}>
                  <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
                    {it.isVideo ? (
                      <video src={src} muted playsInline preload="metadata"
                             style={{ width: "100%", height: "100%", objectFit: "cover", transform: picked ? "scale(0.9)" : "none", transition: "transform .12s" }}/>
                    ) : (
                      <img src={src} alt="" loading="lazy"
                           style={{ width: "100%", height: "100%", objectFit: "cover", transform: picked ? "scale(0.9)" : "none", transition: "transform .12s" }}/>
                    )}
                  </div>
                  {/* Video marker */}
                  {it.isVideo && (
                    <div style={{ position: "absolute", bottom: 5, left: 5, display: "flex", alignItems: "center", gap: 3 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                  )}
                  {/* Selection badge */}
                  <div style={{
                    position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%",
                    border: `2px solid #fff`, background: picked ? "#25d366" : "#00000040",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 12, fontWeight: 800,
                  }}>
                    {picked ? n + 1 : ""}
                  </div>
                  {picked && <div style={{ position: "absolute", inset: 0, border: "3px solid #25d366", pointerEvents: "none" }}/>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm bar */}
      {selected.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px calc(14px + env(safe-area-inset-bottom))",
          borderTop: "0.5px solid #ffffff14", background: "#101014",
        }}>
          <span style={{ color: "#fff", fontSize: 14 }}>{selected.length} selected</span>
          <button onClick={confirm} disabled={busy} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 24, border: "none",
            background: "#25d366", color: "#04180d", fontSize: 15, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1,
          }}>
            {busy ? "Preparing…" : "Next"}
            {!busy && <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#04180d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>}
          </button>
        </div>
      )}
    </div>
  );
}
