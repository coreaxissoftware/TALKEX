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

// A fixed, one-tap boost rather than a real auto-enhance algorithm (which
// would mean actually analyzing the image's histogram) — the same trade a
// filter preset already makes, just framed as "fix this photo" instead of
// "restyle this photo." Multiplies with whatever FILTERS preset is active
// rather than replacing it.
const ENHANCE_CSS = "saturate(1.15) contrast(1.08) brightness(1.03)";

const ASPECTS = [
  { key: "free", label: "Free", ratio: null },
  { key: "square", label: "1:1", ratio: 1 },
  { key: "portrait", label: "4:5", ratio: 4 / 5 },
  { key: "wide", label: "16:9", ratio: 16 / 9 },
];

const DRAW_COLORS = ["#f8fafc", "#ef4444", "#f59e0b", "#22c55e", "#38bdf8", "#a855f7"];

// Plain emoji rather than the app's SVG sticker pack (stickers.jsx) — those
// are React components meant for a chat bubble, not something easily baked
// onto an export <canvas>. An emoji is just a glyph `fillText` already
// knows how to draw, which is what actually needs to happen here.
const STICKER_EMOJIS = ["😀", "😂", "😍", "🔥", "❤️", "👍", "🎉", "😎", "✨", "😢", "😮", "🙌"];

const VIEWPORT_MAX_WIDTH = 340;
const OUTPUT_LONG_EDGE = 1600; // caps export size — a phone photo's native
// resolution is already far more than a chat bubble ever needs, and this
// keeps the exported file a sane size regardless of the source.
const OUTPUT_LONG_EDGE_HD = 2400;

/**
 * Crop/rotate/filter/draw/text/sticker a photo before it's sent —
 * canvas-based, no server round trip until the edited result is handed
 * back as a File the same shape a raw camera/gallery pick would be.
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
 *
 * Draw/text/sticker marks are captured in 0–1 viewport-fraction
 * coordinates, same convention the meeting Whiteboard uses, and rendered
 * onto a transparent overlay canvas sitting on top of the photo. Panning
 * and zooming are locked while a mark tool is active (see `locked` below)
 * — marks are anchored to the CURRENT crop view, not the underlying photo,
 * so letting the photo move underneath them after they're placed would
 * leave them pointing at the wrong thing. This is the same "adjust first,
 * then annotate" split most photo editors use.
 */
export default function PhotoEditor({ file, onCancel, onDone }) {
  const [rotatedSrc, setRotatedSrc] = useState(null); // {canvas, w, h} — the working (rotated) bitmap
  const [rotation, setRotation] = useState(0);
  const [aspect, setAspect] = useState(ASPECTS[0]);
  const [filter, setFilter] = useState(FILTERS[0]);
  const [enhanced, setEnhanced] = useState(false);
  const [hd, setHd] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [processing, setProcessing] = useState(false);
  const dragRef = useRef(null);
  const viewportRef = useRef(null);

  // Marks: [{kind:"stroke", points:[{x,y}...], color} | {kind:"text", x,y,text,color} | {kind:"sticker", x,y,emoji}]
  const [marks, setMarks] = useState([]);
  const [tool, setTool] = useState(null); // null | "draw" | "text" | "sticker"
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [showStickers, setShowStickers] = useState(false);
  const overlayCanvasRef = useRef(null);
  const strokingRef = useRef(null); // current in-progress stroke's points, while drawing
  const locked = tool !== null; // pan/zoom disabled while annotating — see file docstring

  const activeFilterCss = enhanced && filter.css !== "none"
    ? `${filter.css} ${ENHANCE_CSS}` : enhanced ? ENHANCE_CSS : filter.css;

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
    // Marks are reset too, for the same reason: they were anchored to a
    // crop view that no longer exists once the underlying photo rotates.
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setMarks([]);
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

  // Resets marks whenever the aspect/crop frame's own shape changes — a 0–1
  // fraction position only means the same thing on the same-shaped frame.
  useEffect(() => { setMarks([]); }, [aspect]);

  function pointFromEvent(event) {
    const rect = viewportRef.current.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function onPointerDown(event) {
    if (tool === "draw") {
      const point = pointFromEvent(event);
      strokingRef.current = [point];
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (locked) return; // text/sticker tools place on tap, not drag
    dragRef.current = {
      startX: event.clientX, startY: event.clientY,
      startPan: pan,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event) {
    if (tool === "draw" && strokingRef.current) {
      strokingRef.current = [...strokingRef.current, pointFromEvent(event)];
      drawOverlay();
      return;
    }
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPan(clampPan({ x: dragRef.current.startPan.x + dx, y: dragRef.current.startPan.y + dy }));
  }
  function onPointerUp() {
    if (tool === "draw" && strokingRef.current) {
      if (strokingRef.current.length > 1) {
        setMarks((current) => [...current, { kind: "stroke", points: strokingRef.current, color: drawColor }]);
      }
      strokingRef.current = null;
      return;
    }
    dragRef.current = null;
  }

  function onViewportTap(event) {
    if (tool === "text") {
      const point = pointFromEvent(event);
      const text = window.prompt("Text:");
      if (text && text.trim()) {
        setMarks((current) => [...current, { kind: "text", x: point.x, y: point.y, text: text.trim(), color: drawColor }]);
      }
      setTool(null);
    }
  }

  function placeSticker(emoji) {
    setMarks((current) => [...current, { kind: "sticker", x: 0.5, y: 0.5, emoji }]);
    setShowStickers(false);
    setTool(null);
  }

  function paintMark(ctx, w, h, mark) {
    if (mark.kind === "stroke") {
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = Math.max(2, w * 0.01);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      mark.points.forEach((point, i) => {
        const x = point.x * w, y = point.y * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else if (mark.kind === "text") {
      ctx.fillStyle = mark.color;
      ctx.font = `${Math.round(h * 0.045)}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(mark.text, mark.x * w, mark.y * h);
    } else if (mark.kind === "sticker") {
      ctx.font = `${Math.round(h * 0.12)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mark.emoji, mark.x * w, mark.y * h);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
  }

  // Redraws the overlay canvas from `marks` (plus whatever stroke is
  // currently mid-drag) — called on every draw-move and whenever marks
  // change, same "just repaint everything" approach the meeting Whiteboard
  // uses, simple to keep correct since there's no live-collab ordering to
  // worry about here.
  function drawOverlay() {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const mark of marks) paintMark(ctx, canvas.width, canvas.height, mark);
    if (strokingRef.current) {
      paintMark(ctx, canvas.width, canvas.height, { kind: "stroke", points: strokingRef.current, color: drawColor });
    }
  }
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    canvas.width = viewportW;
    canvas.height = viewportH;
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, viewportW, viewportH]);

  const rotatedUrl = useMemo(() => (rotatedSrc ? rotatedSrc.canvas.toDataURL() : null), [rotatedSrc]);

  async function done() {
    if (!rotatedSrc) return;
    setProcessing(true);
    try {
      const longEdge = hd ? OUTPUT_LONG_EDGE_HD : OUTPUT_LONG_EDGE;
      const outW = aspect.ratio ? longEdge : Math.min(longEdge, rotatedSrc.w);
      const outH = aspect.ratio ? outW / aspect.ratio : (outW * rotatedSrc.h) / rotatedSrc.w;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(outW);
      canvas.height = Math.round(outH);
      const ctx = canvas.getContext("2d");
      ctx.filter = activeFilterCss;
      // Same viewport-to-source mapping the preview uses, just scaled up
      // to the export resolution instead of VIEWPORT_MAX_WIDTH.
      const exportScale = canvas.width / viewportW;
      const scale = effectiveScale * exportScale;
      const dx = canvas.width / 2 - (rotatedSrc.w / 2) * scale + pan.x * exportScale;
      const dy = canvas.height / 2 - (rotatedSrc.h / 2) * scale + pan.y * exportScale;
      ctx.drawImage(rotatedSrc.canvas, dx, dy, rotatedSrc.w * scale, rotatedSrc.h * scale);
      // Marks are drawn AFTER the filter is reset — a filter is meant to
      // grade the photo, not desaturate a red pen stroke someone just drew
      // on top of it.
      ctx.filter = "none";
      for (const mark of marks) paintMark(ctx, canvas.width, canvas.height, mark);
      canvas.toBlob((blob) => {
        setProcessing(false);
        if (!blob) { onCancel(); return; }
        onDone(new File([blob], file.name || `edited-${Date.now()}.jpg`, { type: "image/jpeg" }));
      }, "image/jpeg", hd ? 0.95 : 0.9);
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
        <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
          <div onClick={() => setRotation((r) => (r + 90) % 360)} title="Rotate" style={{ cursor: "pointer" }}>
            {I.rotateRight("#fff", 22)}
          </div>
          <div onClick={() => setEnhanced((v) => !v)} title="Enhance" style={{
            cursor: "pointer", fontSize: 20, opacity: enhanced ? 1 : 0.55,
          }}>✨</div>
          <div onClick={() => { setTool((t) => (t === "draw" ? null : "draw")); setShowStickers(false); }}
               title="Draw" style={{ cursor: "pointer", opacity: tool === "draw" ? 1 : 0.55 }}>
            {I.edit("#fff", 20)}
          </div>
          <div onClick={() => setTool((t) => (t === "text" ? null : "text"))}
               title="Add text" style={{
                 cursor: "pointer", fontSize: 16, fontWeight: 700, color: "#fff", opacity: tool === "text" ? 1 : 0.55,
               }}>Aa</div>
          <div onClick={() => { setTool("sticker"); setShowStickers((v) => !v); }}
               title="Sticker" style={{ cursor: "pointer", fontSize: 18, opacity: tool === "sticker" ? 1 : 0.55 }}>😊</div>
          <div onClick={() => setHd((v) => !v)} title="HD quality" style={{
            cursor: "pointer", fontSize: 11, fontWeight: 700, padding: "3px 7px", borderRadius: 6,
            border: `1px solid ${hd ? G.accent : "#ffffff55"}`, color: hd ? G.accentText : "#ffffffaa",
            background: hd ? G.accentSoft : "transparent",
          }}>HD</div>
        </div>
      </div>

      <div ref={viewportRef} style={{
        flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: viewportW, height: viewportH, borderRadius: 8, overflow: "hidden",
          position: "relative", background: "#111",
          touchAction: "none", cursor: tool === "draw" ? "crosshair" : locked ? "default" : "grab",
        }}
             onPointerDown={onPointerDown} onPointerMove={onPointerMove}
             onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
             onClick={onViewportTap}>
          {rotatedUrl && (
            <img src={rotatedUrl} alt="" draggable={false} style={{
              position: "absolute",
              left: viewportW / 2 - displayedW / 2 + pan.x,
              top: viewportH / 2 - displayedH / 2 + pan.y,
              width: displayedW, height: displayedH,
              filter: activeFilterCss, userSelect: "none",
            }}/>
          )}
          <canvas ref={overlayCanvasRef} style={{
            position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none",
          }}/>
        </div>
      </div>

      {tool === "draw" && (
        <div style={{ display: "flex", gap: 10, padding: "6px 16px", justifyContent: "center" }}>
          {DRAW_COLORS.map((color) => (
            <div key={color} onClick={() => setDrawColor(color)} style={{
              width: 24, height: 24, borderRadius: "50%", background: color, cursor: "pointer",
              border: drawColor === color ? "2px solid #fff" : "2px solid transparent",
            }}/>
          ))}
        </div>
      )}

      {showStickers && (
        <div style={{ display: "flex", gap: 10, padding: "6px 16px", flexWrap: "wrap", justifyContent: "center" }}>
          {STICKER_EMOJIS.map((emoji) => (
            <div key={emoji} onClick={() => placeSticker(emoji)} style={{ fontSize: 26, cursor: "pointer" }}>
              {emoji}
            </div>
          ))}
        </div>
      )}

      {!locked && (
        <div style={{ padding: "8px 16px" }}>
          <input type="range" min={1} max={3} step={0.01} value={zoom}
                 onChange={(event) => setZoom(Number(event.target.value))}
                 style={{ width: "100%" }}/>
        </div>
      )}

      {!locked && (
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
      )}

      {!locked && (
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
      )}

      <div style={{ padding: "0 16px 28px" }}>
        <Button onClick={done} disabled={!rotatedSrc || processing} style={{ width: "100%" }}>
          {processing ? "Processing…" : "Done"}
        </Button>
      </div>
    </div>
  );
}
