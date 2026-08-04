import { useEffect, useMemo, useRef, useState } from "react";
import { Button, G, I } from "./ui.jsx";

const FILTERS = [
  { key: "none", label: "Normal", css: "none" },
  { key: "bw", label: "B&W", css: "grayscale(1) contrast(1.05)" },
  { key: "sepia", label: "Sepia", css: "sepia(0.65) saturate(1.1)" },
  { key: "vivid", label: "Vivid", css: "saturate(1.6) contrast(1.12)" },
  { key: "cool", label: "Cool", css: "saturate(1.1) hue-rotate(-8deg) brightness(1.04)" },
  { key: "warm", label: "Warm", css: "saturate(1.2) hue-rotate(8deg) sepia(0.18) brightness(1.02)" },
  { key: "fade", label: "Fade", css: "contrast(0.85) brightness(1.12) saturate(0.8)" },
];

const ASPECTS = [
  { key: "free", label: "Free", ratio: null },
  { key: "square", label: "1:1", ratio: 1 },
  { key: "portrait", label: "4:5", ratio: 4 / 5 },
  { key: "wide", label: "16:9", ratio: 16 / 9 },
];

const VIEWPORT_MAX_WIDTH = 340;
const OUTPUT_LONG_EDGE = 1600; // caps export size — a phone photo's native
// resolution is already far more than a chat bubble ever needs, and this
// keeps the exported file a sane size regardless of the source.

/**
 * Crop/rotate/filter a photo before it's sent — canvas-based, no server
 * round trip until the edited result is handed back as a File the same
 * shape a raw camera/gallery pick would be.
 *
 * Crop works Instagram-style rather than draggable corner handles: the
 * crop FRAME is fixed (sized by the chosen aspect ratio), and the photo
 * pans/zooms underneath it. That's a meaningfully smaller state space to
 * get right than freeform resize handles — pan is always clamped so the
 * photo fully covers the frame, so there's no "empty corner" case to
 * handle at all.
 *
 * Rotation is baked onto an offscreen canvas immediately on each rotate
 * tap, rather than combined into the same CSS transform as pan/zoom/crop —
 * treating "the rotated bitmap" as the working image from then on removes
 * rotation from every other transform's math entirely.
 */
export default function PhotoEditor({ file, onCancel, onDone }) {
  const [rotatedSrc, setRotatedSrc] = useState(null); // {canvas, w, h} — the working (rotated) bitmap
  const [rotation, setRotation] = useState(0);
  const [aspect, setAspect] = useState(ASPECTS[0]);
  const [filter, setFilter] = useState(FILTERS[0]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [processing, setProcessing] = useState(false);
  const dragRef = useRef(null);
  const viewportRef = useRef(null);

  // Load the source file once into a natural-size <img>, kept for re-rotation.
  const [sourceImg, setSourceImg] = useState(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setSourceImg(img);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Bake rotation onto an offscreen canvas whenever it changes.
  useEffect(() => {
    if (!sourceImg) return;
    const swapped = rotation === 90 || rotation === 270;
    const w = swapped ? sourceImg.naturalHeight : sourceImg.naturalWidth;
    const h = swapped ? sourceImg.naturalWidth : sourceImg.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(sourceImg, -sourceImg.naturalWidth / 2, -sourceImg.naturalHeight / 2);
    setRotatedSrc({ canvas, w, h });
    // Rotating resets any in-progress pan/zoom — the old offsets were
    // relative to a differently-shaped frame and no longer mean anything.
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [sourceImg, rotation]);

  const viewportW = VIEWPORT_MAX_WIDTH;
  const viewportH = aspect.ratio ? viewportW / aspect.ratio : (rotatedSrc ? (viewportW * rotatedSrc.h) / rotatedSrc.w : viewportW);

  // "Cover" scale: the smallest scale at which the rotated image fully
  // covers the viewport, same math object-fit: cover uses. Zoom multiplies
  // this rather than replacing it, so 1x always means "fills the frame,
  // nothing cut off unnecessarily."
  const coverScale = rotatedSrc ? Math.max(viewportW / rotatedSrc.w, viewportH / rotatedSrc.h) : 1;
  const effectiveScale = coverScale * zoom;
  const displayedW = rotatedSrc ? rotatedSrc.w * effectiveScale : 0;
  const displayedH = rotatedSrc ? rotatedSrc.h * effectiveScale : 0;
  const maxPanX = Math.max(0, (displayedW - viewportW) / 2);
  const maxPanY = Math.max(0, (displayedH - viewportH) / 2);

  function clampPan(next) {
    return {
      x: Math.min(maxPanX, Math.max(-maxPanX, next.x)),
      y: Math.min(maxPanY, Math.max(-maxPanY, next.y)),
    };
  }

  // Re-clamp whenever zoom/aspect change the bounds — otherwise a pan that
  // was valid at a higher zoom can leave a gap once zoom decreases.
  useEffect(() => { setPan((p) => clampPan(p)); }, [zoom, aspect, rotatedSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  function onPointerDown(event) {
    dragRef.current = {
      startX: event.clientX, startY: event.clientY,
      startPan: pan,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event) {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPan(clampPan({ x: dragRef.current.startPan.x + dx, y: dragRef.current.startPan.y + dy }));
  }
  function onPointerUp() { dragRef.current = null; }

  const rotatedUrl = useMemo(() => (rotatedSrc ? rotatedSrc.canvas.toDataURL() : null), [rotatedSrc]);

  async function done() {
    if (!rotatedSrc) return;
    setProcessing(true);
    try {
      const outW = aspect.ratio ? OUTPUT_LONG_EDGE : Math.min(OUTPUT_LONG_EDGE, rotatedSrc.w);
      const outH = aspect.ratio ? outW / aspect.ratio : (outW * rotatedSrc.h) / rotatedSrc.w;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(outW);
      canvas.height = Math.round(outH);
      const ctx = canvas.getContext("2d");
      ctx.filter = filter.css;
      // Same viewport-to-source mapping the preview uses, just scaled up
      // to the export resolution instead of VIEWPORT_MAX_WIDTH.
      const exportScale = canvas.width / viewportW;
      const scale = effectiveScale * exportScale;
      const dx = canvas.width / 2 - (rotatedSrc.w / 2) * scale + pan.x * exportScale;
      const dy = canvas.height / 2 - (rotatedSrc.h / 2) * scale + pan.y * exportScale;
      ctx.drawImage(rotatedSrc.canvas, dx, dy, rotatedSrc.w * scale, rotatedSrc.h * scale);
      canvas.toBlob((blob) => {
        setProcessing(false);
        if (!blob) { onCancel(); return; }
        onDone(new File([blob], file.name || `edited-${Date.now()}.jpg`, { type: "image/jpeg" }));
      }, "image/jpeg", 0.9);
    } catch {
      setProcessing(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 90,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
        <div onClick={onCancel} style={{ color: "#fff", fontSize: 14, cursor: "pointer" }}>Cancel</div>
        <div onClick={() => setRotation((r) => (r + 90) % 360)} title="Rotate" style={{ cursor: "pointer" }}>
          {I.rotateRight("#fff", 22)}
        </div>
      </div>

      <div ref={viewportRef} style={{
        flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: viewportW, height: viewportH, borderRadius: 8, overflow: "hidden",
          position: "relative", background: "#111", touchAction: "none", cursor: "grab",
        }}
             onPointerDown={onPointerDown} onPointerMove={onPointerMove}
             onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
          {rotatedUrl && (
            <img src={rotatedUrl} alt="" draggable={false} style={{
              position: "absolute",
              left: viewportW / 2 - displayedW / 2 + pan.x,
              top: viewportH / 2 - displayedH / 2 + pan.y,
              width: displayedW, height: displayedH,
              filter: filter.css, userSelect: "none",
            }}/>
          )}
        </div>
      </div>

      <div style={{ padding: "8px 16px" }}>
        <input type="range" min={1} max={3} step={0.01} value={zoom}
               onChange={(event) => setZoom(Number(event.target.value))}
               style={{ width: "100%" }}/>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "4px 16px 12px", overflowX: "auto" }}>
        {ASPECTS.map((option) => (
          <button key={option.key} onClick={() => setAspect(option)} style={{
            padding: "6px 14px", borderRadius: 20, fontSize: 12.5, flexShrink: 0, cursor: "pointer",
            border: `1px solid ${aspect.key === option.key ? G.accent : "#ffffff33"}`,
            background: aspect.key === option.key ? G.accentSoft : "transparent",
            color: aspect.key === option.key ? G.accentText : "#fff",
          }}>{option.label}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, padding: "0 16px 16px", overflowX: "auto" }}>
        {FILTERS.map((option) => (
          <div key={option.key} onClick={() => setFilter(option)} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
            flexShrink: 0, cursor: "pointer",
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: 8, overflow: "hidden",
              border: `2px solid ${filter.key === option.key ? G.accent : "transparent"}`,
              backgroundImage: rotatedUrl ? `url(${rotatedUrl})` : "none",
              backgroundSize: "cover", backgroundPosition: "center",
              filter: option.css,
            }}/>
            <span style={{ fontSize: 10.5, color: filter.key === option.key ? G.accentText : "#ffffffaa" }}>
              {option.label}
            </span>
          </div>
        ))}
      </div>

      <div style={{ padding: "0 16px 28px" }}>
        <Button onClick={done} disabled={!rotatedSrc || processing} style={{ width: "100%" }}>
          {processing ? "Processing…" : "Done"}
        </Button>
      </div>
    </div>
  );
}
