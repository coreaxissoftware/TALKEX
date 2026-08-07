import { useEffect, useMemo, useRef, useState } from "react";
import { Button, G, I } from "./ui.jsx";

const FILTERS = [
  { key: "none", label: "Original", css: "none", icon: "○" },
  { key: "bw", label: "B&W", css: "grayscale(1) contrast(1.05)", icon: "◐" },
  { key: "sepia", label: "Sepia", css: "sepia(0.65) saturate(1.1)", icon: "◉" },
  { key: "vivid", label: "Vivid", css: "saturate(1.6) contrast(1.12)", icon: "◈" },
  { key: "cool", label: "Cool", css: "saturate(1.1) hue-rotate(-8deg) brightness(1.04)", icon: "◇" },
  { key: "warm", label: "Warm", css: "saturate(1.2) hue-rotate(8deg) sepia(0.18) brightness(1.02)", icon: "◆" },
  { key: "fade", label: "Fade", css: "contrast(0.85) brightness(1.12) saturate(0.8)", icon: "◌" },
  { key: "dramatic", label: "Drama", css: "contrast(1.3) saturate(1.1) brightness(0.95)", icon: "◍" },
  { key: "noir", label: "Noir", css: "grayscale(1) contrast(1.25) brightness(0.9)", icon: "●" },
];

const ENHANCE_CSS = "saturate(1.15) contrast(1.08) brightness(1.03)";

const ASPECTS = [
  { key: "free", label: "Free", ratio: null },
  { key: "square", label: "1:1", ratio: 1 },
  { key: "portrait", label: "4:5", ratio: 4 / 5 },
  { key: "wide", label: "16:9", ratio: 16 / 9 },
  { key: "story", label: "9:16", ratio: 9 / 16 },
];

const DRAW_COLORS = ["#ffffff", "#ef4444", "#f59e0b", "#22c55e", "#38bdf8", "#a855f7", "#ec4899", "#000000"];

const STICKER_EMOJIS = ["😀", "😂", "😍", "🔥", "❤️", "👍", "🎉", "😎", "✨", "😢", "😮", "🙌",
                        "🥳", "💪", "🤩", "🥺", "😴", "🤯", "🫡", "🚀", "💯", "🎊", "🦋", "🌈"];

const VIEWPORT_MAX_WIDTH = 340;
const OUTPUT_LONG_EDGE = 1600;
const OUTPUT_LONG_EDGE_HD = 2400;

// Tool categories for the modern toolbar
const TOOL_GROUPS = [
  { key: "adjust", label: "Adjust", tools: [
    { key: "crop", icon: "⬡", label: "Crop" },
    { key: "rotate", icon: "↻", label: "Rotate" },
    { key: "flip", icon: "⇔", label: "Flip" },
  ]},
  { key: "annotate", label: "Draw", tools: [
    { key: "draw", icon: "✏️", label: "Pen" },
    { key: "highlighter", icon: "🖍️", label: "Marker" },
    { key: "eraser", icon: "⌫", label: "Eraser" },
  ]},
  { key: "insert", label: "Add", tools: [
    { key: "text", icon: "Aa", label: "Text" },
    { key: "sticker", icon: "😊", label: "Sticker" },
    { key: "shape", icon: "□", label: "Shape" },
  ]},
];

let _editorStylesInjected = false;
function injectEditorStyles() {
  if (_editorStylesInjected) return;
  _editorStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes txEditorSlideIn {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    @keyframes txToolPop {
      0% { transform: scale(0.8); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }
    .tx-editor-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 20px; height: 20px; border-radius: 50%;
      background: #fff; cursor: pointer;
      box-shadow: 0 1px 4px #00000055;
    }
    .tx-editor-slider::-webkit-slider-runnable-track {
      height: 3px; background: #ffffff33; border-radius: 2px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Modern photo editor — Instagram/WhatsApp-inspired with a clean dark UI.
 *
 * Three tool categories (Adjust, Draw, Add) accessible via a bottom tab bar.
 * Filter thumbnails show actual previewed images. The edit viewport uses the
 * same pan/zoom/crop math as before but with a polished UI wrapper.
 */
export default function PhotoEditor({ file, onCancel, onDone }) {
  const [rotatedSrc, setRotatedSrc] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [aspect, setAspect] = useState(ASPECTS[0]);
  const [filter, setFilter] = useState(FILTERS[0]);
  const [enhanced, setEnhanced] = useState(false);
  const [hd, setHd] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [processing, setProcessing] = useState(false);
  const dragRef = useRef(null);
  const viewportRef = useRef(null);

  // Adjustment sliders
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);

  const [marks, setMarks] = useState([]);
  const [tool, setTool] = useState(null);
  const [activeGroup, setActiveGroup] = useState(null); // "adjust" | "annotate" | "insert" | null
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [drawSize, setDrawSize] = useState(3);
  const [showStickers, setShowStickers] = useState(false);
  const [shapeType, setShapeType] = useState("rect");
  const overlayCanvasRef = useRef(null);
  const strokingRef = useRef(null);
  const shapeStartRef = useRef(null);
  const locked = tool === "draw" || tool === "highlighter" || tool === "eraser" || tool === "text"
    || tool === "sticker" || tool === "shape";

  useEffect(() => { injectEditorStyles(); }, []);

  const adjustmentCss = (brightness !== 100 || contrast !== 100 || saturation !== 100)
    ? `brightness(${brightness / 100}) contrast(${contrast / 100}) saturate(${saturation / 100})`
    : "";

  const activeFilterCss = [
    filter.css !== "none" ? filter.css : "",
    enhanced ? ENHANCE_CSS : "",
    adjustmentCss,
  ].filter(Boolean).join(" ") || "none";

  const [sourceImg, setSourceImg] = useState(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setSourceImg(img);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

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
    if (flipped) ctx.scale(-1, 1);
    ctx.drawImage(sourceImg, -sourceImg.naturalWidth / 2, -sourceImg.naturalHeight / 2);
    setRotatedSrc({ canvas, w, h });
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setMarks([]);
  }, [sourceImg, rotation, flipped]);

  const viewportW = VIEWPORT_MAX_WIDTH;
  const viewportH = aspect.ratio ? viewportW / aspect.ratio : (rotatedSrc ? (viewportW * rotatedSrc.h) / rotatedSrc.w : viewportW);

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

  useEffect(() => { setPan((p) => clampPan(p)); }, [zoom, aspect, rotatedSrc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMarks([]); }, [aspect]);

  function pointFromEvent(event) {
    const rect = viewportRef.current.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function onPointerDown(event) {
    if (tool === "draw" || tool === "highlighter" || tool === "eraser") {
      const point = pointFromEvent(event);
      strokingRef.current = [point];
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (tool === "shape") {
      shapeStartRef.current = pointFromEvent(event);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (locked) return;
    dragRef.current = {
      startX: event.clientX, startY: event.clientY,
      startPan: pan,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if ((tool === "draw" || tool === "highlighter" || tool === "eraser") && strokingRef.current) {
      strokingRef.current = [...strokingRef.current, pointFromEvent(event)];
      drawOverlay();
      return;
    }
    if (tool === "shape" && shapeStartRef.current) {
      drawOverlay(pointFromEvent(event));
      return;
    }
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPan(clampPan({ x: dragRef.current.startPan.x + dx, y: dragRef.current.startPan.y + dy }));
  }

  function onPointerUp(event) {
    if ((tool === "draw" || tool === "highlighter" || tool === "eraser") && strokingRef.current) {
      if (strokingRef.current.length > 1) {
        const strokeColor = tool === "eraser" ? "erase" : tool === "highlighter" ? "highlight" : drawColor;
        const size = tool === "highlighter" ? 14 : tool === "eraser" ? 22 : drawSize;
        setMarks((current) => [...current, { kind: "stroke", points: strokingRef.current, color: strokeColor, size }]);
      }
      strokingRef.current = null;
      return;
    }
    if (tool === "shape" && shapeStartRef.current) {
      const endPoint = pointFromEvent(event);
      setMarks((current) => [...current, {
        kind: "shape", shapeType, start: shapeStartRef.current, end: endPoint, color: drawColor, size: drawSize,
      }]);
      shapeStartRef.current = null;
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
    }
  }

  function placeSticker(emoji) {
    setMarks((current) => [...current, { kind: "sticker", x: 0.5, y: 0.5, emoji }]);
    setShowStickers(false);
    setTool(null);
  }

  function paintMark(ctx, w, h, mark) {
    if (mark.kind === "stroke") {
      ctx.strokeStyle = mark.color === "highlight" ? drawColor : mark.color;
      ctx.lineWidth = mark.size || Math.max(2, w * 0.01);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = mark.color === "highlight" ? 0.35 : 1;
      ctx.globalCompositeOperation = mark.color === "erase" ? "destination-out" : "source-over";
      ctx.beginPath();
      mark.points.forEach((point, i) => {
        const x = point.x * w, y = point.y * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    } else if (mark.kind === "text") {
      ctx.fillStyle = mark.color;
      ctx.font = `bold ${Math.round(h * 0.05)}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(mark.text, mark.x * w, mark.y * h);
    } else if (mark.kind === "sticker") {
      ctx.font = `${Math.round(h * 0.12)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mark.emoji, mark.x * w, mark.y * h);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    } else if (mark.kind === "shape") {
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = mark.size || 3;
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      const x1 = mark.start.x * w, y1 = mark.start.y * h;
      const x2 = mark.end.x * w, y2 = mark.end.y * h;
      if (mark.shapeType === "rect") {
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
      } else if (mark.shapeType === "circle") {
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
      } else if (mark.shapeType === "line") {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      } else if (mark.shapeType === "arrow") {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 12;
        ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      }
      ctx.stroke();
    }
  }

  function drawOverlay(shapeEnd) {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const mark of marks) paintMark(ctx, canvas.width, canvas.height, mark);
    if (strokingRef.current) {
      const strokeColor = tool === "eraser" ? "erase" : tool === "highlighter" ? "highlight" : drawColor;
      const size = tool === "highlighter" ? 14 : tool === "eraser" ? 22 : drawSize;
      paintMark(ctx, canvas.width, canvas.height, { kind: "stroke", points: strokingRef.current, color: strokeColor, size });
    }
    if (shapeEnd && shapeStartRef.current) {
      paintMark(ctx, canvas.width, canvas.height, {
        kind: "shape", shapeType, start: shapeStartRef.current, end: shapeEnd, color: drawColor, size: drawSize,
      });
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
      const exportScale = canvas.width / viewportW;
      const scale = effectiveScale * exportScale;
      const dx = canvas.width / 2 - (rotatedSrc.w / 2) * scale + pan.x * exportScale;
      const dy = canvas.height / 2 - (rotatedSrc.h / 2) * scale + pan.y * exportScale;
      ctx.drawImage(rotatedSrc.canvas, dx, dy, rotatedSrc.w * scale, rotatedSrc.h * scale);
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

  function undoLast() {
    setMarks((current) => current.slice(0, -1));
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0a0a0a", zIndex: 90,
      display: "flex", flexDirection: "column",
      animation: "txEditorSlideIn 0.3s ease-out",
    }}>
      {/* Top bar — minimal, modern */}
      <div style={{
        display: "flex", alignItems: "center", padding: "12px 16px", flexShrink: 0,
        background: "#0a0a0a",
      }}>
        <div onClick={onCancel} style={{
          color: "#fff", fontSize: 14, cursor: "pointer", padding: "6px 12px",
          borderRadius: 20, background: "#ffffff14",
        }}>Cancel</div>
        <div style={{ flex: 1 }}/>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {marks.length > 0 && (
            <div onClick={undoLast} title="Undo" style={{
              cursor: "pointer", padding: "6px 10px", borderRadius: 16,
              background: "#ffffff14", fontSize: 13, color: "#ffffffcc",
            }}>↩ Undo</div>
          )}
          <div onClick={() => setEnhanced((v) => !v)} title="Auto-enhance" style={{
            cursor: "pointer", padding: "6px 12px", borderRadius: 16, fontSize: 13,
            background: enhanced ? `${G.accent}33` : "#ffffff14",
            color: enhanced ? G.accent : "#ffffffcc",
            border: enhanced ? `1px solid ${G.accent}55` : "1px solid transparent",
          }}>✨ Enhance</div>
          <div onClick={() => setHd((v) => !v)} title="HD quality" style={{
            cursor: "pointer", padding: "6px 12px", borderRadius: 16, fontSize: 12, fontWeight: 700,
            background: hd ? `${G.accent}33` : "#ffffff14",
            color: hd ? G.accent : "#ffffffcc",
            border: hd ? `1px solid ${G.accent}55` : "1px solid transparent",
          }}>HD</div>
        </div>
      </div>

      {/* Viewport */}
      <div ref={viewportRef} style={{
        flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: viewportW, height: viewportH, borderRadius: 12, overflow: "hidden",
          position: "relative", background: "#111",
          touchAction: "none",
          cursor: locked ? (tool === "draw" || tool === "highlighter" || tool === "eraser" ? "crosshair"
            : tool === "shape" ? "crosshair" : "default") : "grab",
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

      {/* Context-sensitive tool options — shown based on activeGroup */}
      {activeGroup === "adjust" && !tool && (
        <div style={{ padding: "0 16px 8px" }}>
          {/* Aspect ratio pills */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, overflowX: "auto" }}>
            {ASPECTS.map((option) => (
              <div key={option.key} onClick={() => setAspect(option)} style={{
                padding: "6px 14px", borderRadius: 20, fontSize: 12.5, flexShrink: 0, cursor: "pointer",
                border: `1px solid ${aspect.key === option.key ? G.accent : "#ffffff22"}`,
                background: aspect.key === option.key ? `${G.accent}22` : "transparent",
                color: aspect.key === option.key ? G.accent : "#ffffffcc",
              }}>{option.label}</div>
            ))}
          </div>
          {/* Brightness / Contrast / Saturation sliders */}
          {[
            { label: "Brightness", value: brightness, set: setBrightness },
            { label: "Contrast", value: contrast, set: setContrast },
            { label: "Saturation", value: saturation, set: setSaturation },
          ].map(({ label, value, set }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#ffffff88", width: 64, flexShrink: 0 }}>{label}</span>
              <input type="range" min={50} max={150} value={value}
                     onChange={(e) => set(Number(e.target.value))}
                     className="tx-editor-slider"
                     style={{ flex: 1, appearance: "none", background: "transparent", height: 20 }}/>
              <span style={{ fontSize: 11, color: "#ffffff88", width: 28, textAlign: "right" }}>{value}</span>
            </div>
          ))}
          {/* Zoom slider */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "#ffffff88", width: 64, flexShrink: 0 }}>Zoom</span>
            <input type="range" min={1} max={3} step={0.01} value={zoom}
                   onChange={(e) => setZoom(Number(e.target.value))}
                   className="tx-editor-slider"
                   style={{ flex: 1, appearance: "none", background: "transparent", height: 20 }}/>
          </div>
        </div>
      )}

      {activeGroup === "annotate" && (
        <div style={{ padding: "8px 16px" }}>
          {/* Color picker */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10, justifyContent: "center", alignItems: "center" }}>
            {DRAW_COLORS.map((color) => (
              <div key={color} onClick={() => setDrawColor(color)} style={{
                width: drawColor === color ? 28 : 22, height: drawColor === color ? 28 : 22,
                borderRadius: "50%", background: color, cursor: "pointer",
                border: drawColor === color ? "2.5px solid #fff" : "2px solid #ffffff33",
                transition: "all 0.15s",
                boxShadow: drawColor === color ? `0 0 8px ${color}88` : "none",
              }}/>
            ))}
          </div>
          {/* Size slider for pen */}
          {tool === "draw" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }}/>
              <input type="range" min={1} max={12} value={drawSize}
                     onChange={(e) => setDrawSize(Number(e.target.value))}
                     className="tx-editor-slider"
                     style={{ flex: 1, appearance: "none", background: "transparent", height: 20 }}/>
              <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff" }}/>
            </div>
          )}
        </div>
      )}

      {activeGroup === "insert" && tool === "shape" && (
        <div style={{ padding: "8px 16px" }}>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 8 }}>
            {[
              { key: "rect", icon: "□" }, { key: "circle", icon: "○" },
              { key: "line", icon: "╱" }, { key: "arrow", icon: "→" },
            ].map((s) => (
              <div key={s.key} onClick={() => setShapeType(s.key)} style={{
                width: 36, height: 36, borderRadius: 10, cursor: "pointer", fontSize: 18,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: shapeType === s.key ? "#ffffff2a" : "#ffffff0d",
                color: shapeType === s.key ? "#fff" : "#ffffff88",
              }}>{s.icon}</div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            {DRAW_COLORS.slice(0, 6).map((color) => (
              <div key={color} onClick={() => setDrawColor(color)} style={{
                width: 22, height: 22, borderRadius: "50%", background: color, cursor: "pointer",
                border: drawColor === color ? "2px solid #fff" : "2px solid transparent",
              }}/>
            ))}
          </div>
        </div>
      )}

      {showStickers && (
        <div style={{
          display: "flex", gap: 8, padding: "8px 16px", flexWrap: "wrap", justifyContent: "center",
          maxHeight: 160, overflowY: "auto",
        }}>
          {STICKER_EMOJIS.map((emoji, i) => (
            <div key={emoji} onClick={() => placeSticker(emoji)} style={{
              fontSize: 28, cursor: "pointer", padding: 4,
              animation: `txToolPop 0.2s ease-out ${i * 0.02}s both`,
            }}>
              {emoji}
            </div>
          ))}
        </div>
      )}

      {/* Filter strip — always visible, horizontal scroll */}
      {(!activeGroup || activeGroup === "adjust") && !locked && (
        <div style={{ display: "flex", gap: 10, padding: "8px 16px", overflowX: "auto", flexShrink: 0 }}>
          {FILTERS.map((option) => (
            <div key={option.key} onClick={() => setFilter(option)} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              flexShrink: 0, cursor: "pointer",
            }}>
              <div style={{
                width: 52, height: 52, borderRadius: 10, overflow: "hidden",
                border: `2.5px solid ${filter.key === option.key ? G.accent : "transparent"}`,
                backgroundImage: rotatedUrl ? `url(${rotatedUrl})` : "none",
                backgroundSize: "cover", backgroundPosition: "center",
                filter: option.css,
                transition: "border-color 0.15s",
              }}/>
              <span style={{
                fontSize: 10, letterSpacing: 0.3,
                color: filter.key === option.key ? G.accent : "#ffffff88",
                fontWeight: filter.key === option.key ? 700 : 400,
              }}>
                {option.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Bottom toolbar — modern category tabs */}
      <div style={{
        padding: "8px 16px 24px", background: "#0a0a0a",
        borderTop: "1px solid #ffffff12", flexShrink: 0,
      }}>
        {/* Tool category bar */}
        <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
          {TOOL_GROUPS.map((group) => (
            <div key={group.key} onClick={() => {
              setActiveGroup((g) => g === group.key ? null : group.key);
              setTool(null);
              setShowStickers(false);
            }} style={{
              flex: 1, padding: "8px", borderRadius: 12, cursor: "pointer",
              textAlign: "center", fontSize: 12.5, fontWeight: 600,
              background: activeGroup === group.key ? "#ffffff1a" : "transparent",
              color: activeGroup === group.key ? "#fff" : "#ffffff66",
              transition: "all 0.15s",
            }}>{group.label}</div>
          ))}
        </div>

        {/* Expanded tool row when a group is active */}
        {activeGroup && (
          <div style={{
            display: "flex", gap: 6, justifyContent: "center", marginBottom: 10,
          }}>
            {TOOL_GROUPS.find((g) => g.key === activeGroup)?.tools.map((t, i) => (
              <div key={t.key} onClick={() => {
                if (t.key === "rotate") { setRotation((r) => (r + 90) % 360); return; }
                if (t.key === "flip") { setFlipped((f) => !f); return; }
                if (t.key === "crop") { setTool(null); return; }
                if (t.key === "sticker") { setShowStickers((v) => !v); setTool("sticker"); return; }
                setTool((current) => current === t.key ? null : t.key);
                setShowStickers(false);
              }} style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                padding: "8px 14px", borderRadius: 12, cursor: "pointer",
                background: tool === t.key ? `${G.accent}22` : "#ffffff0d",
                border: `1px solid ${tool === t.key ? G.accent : "transparent"}`,
                animation: `txToolPop 0.2s ease-out ${i * 0.05}s both`,
              }}>
                <span style={{ fontSize: 18 }}>{t.icon}</span>
                <span style={{ fontSize: 10, color: tool === t.key ? G.accent : "#ffffffaa" }}>{t.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Done button */}
        <button onClick={done} disabled={!rotatedSrc || processing} style={{
          width: "100%", padding: "14px", borderRadius: 14, border: "none", cursor: "pointer",
          background: G.accent, color: "#fff", fontSize: 15, fontWeight: 700,
          opacity: !rotatedSrc || processing ? 0.5 : 1,
          boxShadow: `0 2px 16px ${G.accentGlow}`,
        }}>
          {processing ? "Processing…" : "Done ✓"}
        </button>
      </div>
    </div>
  );
}
