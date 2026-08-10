import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Button, G, I } from "./ui.jsx";

const FILTERS = [
  { key: "none", label: "Original", css: "none" },
  { key: "bw", label: "B&W", css: "grayscale(1) contrast(1.05)" },
  { key: "sepia", label: "Sepia", css: "sepia(0.65) saturate(1.1)" },
  { key: "vivid", label: "Vivid", css: "saturate(1.6) contrast(1.12)" },
  { key: "cool", label: "Cool", css: "saturate(1.1) hue-rotate(-8deg) brightness(1.04)" },
  { key: "warm", label: "Warm", css: "saturate(1.2) hue-rotate(8deg) sepia(0.18) brightness(1.02)" },
  { key: "fade", label: "Fade", css: "contrast(0.85) brightness(1.12) saturate(0.8)" },
  { key: "dramatic", label: "Drama", css: "contrast(1.3) saturate(1.1) brightness(0.95)" },
  { key: "noir", label: "Noir", css: "grayscale(1) contrast(1.25) brightness(0.9)" },
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

// 4 tabs: Adjust | Filter | Draw | Add
const TABS = [
  { key: "adjust", label: "Adjust", tools: [
    { key: "crop", label: "Crop" },
    { key: "rotate", label: "Rotate" },
    { key: "flip", label: "Flip" },
    { key: "tune", label: "Tune" },
  ]},
  { key: "filter", label: "Filter", tools: [] },
  { key: "annotate", label: "Draw", tools: [
    { key: "draw", label: "Pen" },
    { key: "highlighter", label: "Marker" },
    { key: "eraser", label: "Eraser" },
  ]},
  { key: "insert", label: "Add", tools: [
    { key: "text", label: "Text" },
    { key: "sticker", label: "Sticker" },
    { key: "shape", label: "Shape" },
  ]},
];

// Crop handle size
const HANDLE_SIZE = 22;
const HANDLE_HIT = 28;

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

/* SVG icons for the toolbar */
function CropIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <path d="M6 2v14a2 2 0 002 2h14"/>
      <path d="M18 22V8a2 2 0 00-2-2H2"/>
    </svg>
  );
}
function RotateIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6"/>
      <path d="M3 12a9 9 0 0115-6.7L21 8"/>
      <path d="M3 22v-6h6"/>
      <path d="M21 12a9 9 0 01-15 6.7L3 16"/>
    </svg>
  );
}
function FlipIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3H5a2 2 0 00-2 2v14c0 1.1.9 2 2 2h3"/>
      <path d="M16 3h3a2 2 0 012 2v14a2 2 0 01-2 2h-3"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
    </svg>
  );
}
function TuneIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.4" fill={color} stroke="none"/>
      <line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.4" fill={color} stroke="none"/>
      <line x1="4" y1="17" x2="20" y2="17"/><circle cx="11" cy="17" r="2.4" fill={color} stroke="none"/>
    </svg>
  );
}
function PenIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/>
    </svg>
  );
}
function MarkerIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l-6 6v3h9l3-3"/>
      <path d="M22 12l-4.6 4.6a2 2 0 01-2.8 0l-5.2-5.2a2 2 0 010-2.8L14 4"/>
    </svg>
  );
}
function EraserIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20H7L3 16a1 1 0 010-1.4l9.6-9.6a2 2 0 012.8 0l5.2 5.2a2 2 0 010 2.8L13 20"/>
      <path d="M6 11l4 4"/>
    </svg>
  );
}
function TextIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7"/>
      <line x1="9" y1="20" x2="15" y2="20"/>
      <line x1="12" y1="4" x2="12" y2="20"/>
    </svg>
  );
}
function StickerIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <line x1="9" y1="9" x2="9.01" y2="9"/>
      <line x1="15" y1="9" x2="15.01" y2="9"/>
    </svg>
  );
}
function ShapeIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
    </svg>
  );
}

const TOOL_ICON_MAP = {
  crop: CropIcon, rotate: RotateIcon, flip: FlipIcon, tune: TuneIcon,
  draw: PenIcon, highlighter: MarkerIcon, eraser: EraserIcon,
  text: TextIcon, sticker: StickerIcon, shape: ShapeIcon,
};

/**
 * Modern photo editor — WhatsApp/Instagram-inspired with 4-tab UI.
 *
 * Tabs: Adjust | Filter | Draw | Add
 * - Adjust: Crop overlay with draggable corner handles, rotate, flip, brightness/contrast/saturation
 * - Filter: Filter thumbnails grid
 * - Draw: Pen/Marker/Eraser with color picker & size slider
 * - Add: Text/Sticker/Shape tools
 *
 * Pinch-to-zoom replaces the zoom slider.
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
  const [activeTab, setActiveTab] = useState("adjust");
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [drawSize, setDrawSize] = useState(3);
  const [showStickers, setShowStickers] = useState(false);
  const [shapeType, setShapeType] = useState("rect");
  const overlayCanvasRef = useRef(null);
  const strokingRef = useRef(null);
  const shapeStartRef = useRef(null);

  // Crop overlay state — rect in normalized [0..1] coordinates
  const [cropRect, setCropRect] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [cropDrag, setCropDrag] = useState(null); // { type: "handle"|"move", corner?, startRect, startPt }
  const cropDragRef = useRef(null);
  const [cropActive, setCropActive] = useState(false);
  const [fineAngle, setFineAngle] = useState(0); // -45 to 45 degrees fine rotation

  // Pinch-to-zoom state
  const pinchRef = useRef(null);

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
    setCropRect({ x: 0, y: 0, w: 1, h: 1 });
  }, [sourceImg, rotation, flipped]);

  const viewportW = VIEWPORT_MAX_WIDTH;
  const viewportH = aspect.ratio ? viewportW / aspect.ratio : (rotatedSrc ? (viewportW * rotatedSrc.h) / rotatedSrc.w : viewportW);

  const coverScale = rotatedSrc ? Math.max(viewportW / rotatedSrc.w, viewportH / rotatedSrc.h) : 1;
  const effectiveScale = coverScale * zoom;
  const displayedW = rotatedSrc ? rotatedSrc.w * effectiveScale : 0;
  const displayedH = rotatedSrc ? rotatedSrc.h * effectiveScale : 0;
  const maxPanX = Math.max(0, (displayedW - viewportW) / 2);
  const maxPanY = Math.max(0, (displayedH - viewportH) / 2);

  const clampPan = useCallback((next) => {
    const mx = Math.max(0, (displayedW - viewportW) / 2);
    const my = Math.max(0, (displayedH - viewportH) / 2);
    return {
      x: Math.min(mx, Math.max(-mx, next.x)),
      y: Math.min(my, Math.max(-my, next.y)),
    };
  }, [displayedW, displayedH, viewportW, viewportH]);

  useEffect(() => { setPan((p) => clampPan(p)); }, [clampPan]);
  useEffect(() => { setMarks([]); }, [aspect]);

  // Web: mouse wheel zooms the editing area — scroll up to zoom in, down to
  // zoom out (touch already pinch-zooms via onTouchMove). Attached natively
  // with { passive: false } so preventDefault actually stops the page/panel
  // from scrolling underneath; React's onWheel can be passive and would just
  // warn instead. Disabled while the crop overlay is up so it doesn't fight
  // the crop-frame interaction.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function handleWheel(event) {
      if (cropActive) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom((z) => Math.min(5, Math.max(1, z * factor)));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [cropActive]);

  // Reset crop when aspect changes
  useEffect(() => {
    if (aspect.ratio && rotatedSrc) {
      // Calculate crop rect to match aspect ratio within the viewport
      const imgAspect = rotatedSrc.w / rotatedSrc.h;
      const targetAspect = aspect.ratio;
      if (targetAspect > imgAspect) {
        const h = imgAspect / targetAspect;
        setCropRect({ x: 0, y: (1 - h) / 2, w: 1, h });
      } else {
        const w = targetAspect / imgAspect;
        setCropRect({ x: (1 - w) / 2, y: 0, w, h: 1 });
      }
    } else {
      setCropRect({ x: 0, y: 0, w: 1, h: 1 });
    }
  }, [aspect, rotatedSrc]);

  function pointFromEvent(event) {
    const rect = viewportRef.current.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  // --- Pinch-to-zoom via touch events ---
  function onTouchStart(e) {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { dist: Math.hypot(dx, dy), zoom };
      e.preventDefault();
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDist = Math.hypot(dx, dy);
      const scale = newDist / pinchRef.current.dist;
      setZoom(Math.min(5, Math.max(1, pinchRef.current.zoom * scale)));
      e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) pinchRef.current = null;
  }

  // --- Crop handle interaction ---
  function getCropHandle(px, py) {
    // px, py are in viewport pixels
    const rect = {
      left: cropRect.x * viewportW,
      top: cropRect.y * viewportH,
      right: (cropRect.x + cropRect.w) * viewportW,
      bottom: (cropRect.y + cropRect.h) * viewportH,
    };
    const hit = HANDLE_HIT;
    // Corners: TL, TR, BL, BR
    if (Math.abs(px - rect.left) < hit && Math.abs(py - rect.top) < hit) return "tl";
    if (Math.abs(px - rect.right) < hit && Math.abs(py - rect.top) < hit) return "tr";
    if (Math.abs(px - rect.left) < hit && Math.abs(py - rect.bottom) < hit) return "bl";
    if (Math.abs(px - rect.right) < hit && Math.abs(py - rect.bottom) < hit) return "br";
    // Edges: top, bottom, left, right
    if (py > rect.top - hit && py < rect.top + hit && px > rect.left && px < rect.right) return "t";
    if (py > rect.bottom - hit && py < rect.bottom + hit && px > rect.left && px < rect.right) return "b";
    if (px > rect.left - hit && px < rect.left + hit && py > rect.top && py < rect.bottom) return "l";
    if (px > rect.right - hit && px < rect.right + hit && py > rect.top && py < rect.bottom) return "r";
    // Inside = move
    if (px > rect.left && px < rect.right && py > rect.top && py < rect.bottom) return "move";
    return null;
  }

  function onCropPointerDown(e) {
    const rect = viewportRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const handle = getCropHandle(px, py);
    if (!handle) return;
    cropDragRef.current = {
      type: handle,
      startRect: { ...cropRect },
      startX: e.clientX,
      startY: e.clientY,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  }

  function onCropPointerMove(e) {
    if (!cropDragRef.current) return;
    const { type, startRect, startX, startY } = cropDragRef.current;
    const dx = (e.clientX - startX) / viewportW;
    const dy = (e.clientY - startY) / viewportH;
    const minSize = 0.1;

    let next = { ...startRect };

    if (type === "move") {
      next.x = Math.max(0, Math.min(1 - startRect.w, startRect.x + dx));
      next.y = Math.max(0, Math.min(1 - startRect.h, startRect.y + dy));
    } else {
      // Handle corner/edge dragging
      if (type.includes("l")) {
        const newX = Math.max(0, Math.min(startRect.x + startRect.w - minSize, startRect.x + dx));
        next.w = startRect.w - (newX - startRect.x);
        next.x = newX;
      }
      if (type.includes("r")) {
        next.w = Math.max(minSize, Math.min(1 - startRect.x, startRect.w + dx));
      }
      if (type.includes("t")) {
        const newY = Math.max(0, Math.min(startRect.y + startRect.h - minSize, startRect.y + dy));
        next.h = startRect.h - (newY - startRect.y);
        next.y = newY;
      }
      if (type.includes("b")) {
        next.h = Math.max(minSize, Math.min(1 - startRect.y, startRect.h + dy));
      }
    }

    setCropRect(next);
  }

  function onCropPointerUp() {
    cropDragRef.current = null;
  }

  // --- Drawing / pan interaction ---
  function onPointerDown(event) {
    if (cropActive) return; // Crop overlay handles its own events
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
    if (cropActive) return;
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
    if (cropActive) return;
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
    if (cropActive) return;
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

  // Activate/deactivate crop mode
  useEffect(() => {
    setCropActive(activeTab === "adjust" && tool === "crop");
  }, [activeTab, tool]);

  async function done() {
    if (!rotatedSrc) return;
    setProcessing(true);
    try {
      const longEdge = hd ? OUTPUT_LONG_EDGE_HD : OUTPUT_LONG_EDGE;

      // Apply crop rect
      const srcW = rotatedSrc.w * cropRect.w;
      const srcH = rotatedSrc.h * cropRect.h;
      const srcX = rotatedSrc.w * cropRect.x;
      const srcY = rotatedSrc.h * cropRect.y;

      const outAspect = srcW / srcH;
      let outW, outH;
      if (srcW > srcH) {
        outW = Math.min(longEdge, srcW);
        outH = outW / outAspect;
      } else {
        outH = Math.min(longEdge, srcH);
        outW = outH * outAspect;
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(outW);
      canvas.height = Math.round(outH);
      const ctx = canvas.getContext("2d");
      ctx.filter = activeFilterCss;

      // Draw the cropped portion
      const scale = effectiveScale * (canvas.width / viewportW);
      // Map crop rect from normalized to viewport, then to export
      const cropViewLeft = cropRect.x * viewportW;
      const cropViewTop = cropRect.y * viewportH;
      const cropViewW = cropRect.w * viewportW;
      const cropViewH = cropRect.h * viewportH;

      const exportScaleX = canvas.width / cropViewW;
      const exportScaleY = canvas.height / cropViewH;

      // Image position in viewport
      const imgViewX = viewportW / 2 - displayedW / 2 + pan.x;
      const imgViewY = viewportH / 2 - displayedH / 2 + pan.y;

      // Map to export canvas
      const drawX = (imgViewX - cropViewLeft) * exportScaleX;
      const drawY = (imgViewY - cropViewTop) * exportScaleY;
      const drawW = displayedW * exportScaleX;
      const drawH = displayedH * exportScaleY;

      ctx.drawImage(rotatedSrc.canvas, drawX, drawY, drawW, drawH);
      ctx.filter = "none";

      // Draw marks scaled to crop
      for (const mark of marks) {
        // Marks are in viewport-normalized coords, remap to crop
        const remapped = remapMark(mark, cropRect, canvas.width, canvas.height);
        if (remapped) paintMarkAbsolute(ctx, remapped);
      }

      canvas.toBlob((blob) => {
        setProcessing(false);
        if (!blob) { onCancel(); return; }
        onDone(new File([blob], file.name || `edited-${Date.now()}.jpg`, { type: "image/jpeg" }));
      }, "image/jpeg", hd ? 0.95 : 0.9);
    } catch {
      setProcessing(false);
    }
  }

  // Remap a mark from viewport-normalized to crop-relative absolute coords
  function remapMark(mark, crop, outW, outH) {
    if (mark.kind === "stroke") {
      return {
        ...mark,
        points: mark.points.map((p) => ({
          x: ((p.x - crop.x) / crop.w) * outW,
          y: ((p.y - crop.y) / crop.h) * outH,
        })),
        _absolute: true,
      };
    }
    if (mark.kind === "text" || mark.kind === "sticker") {
      return {
        ...mark,
        x: ((mark.x - crop.x) / crop.w) * outW,
        y: ((mark.y - crop.y) / crop.h) * outH,
        _absolute: true,
      };
    }
    if (mark.kind === "shape") {
      return {
        ...mark,
        start: {
          x: ((mark.start.x - crop.x) / crop.w) * outW,
          y: ((mark.start.y - crop.y) / crop.h) * outH,
        },
        end: {
          x: ((mark.end.x - crop.x) / crop.w) * outW,
          y: ((mark.end.y - crop.y) / crop.h) * outH,
        },
        _absolute: true,
      };
    }
    return null;
  }

  function paintMarkAbsolute(ctx, mark) {
    // Same as paintMark but coords are already in canvas pixels
    if (mark.kind === "stroke") {
      ctx.strokeStyle = mark.color === "highlight" ? drawColor : mark.color;
      ctx.lineWidth = mark.size || 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = mark.color === "highlight" ? 0.35 : 1;
      ctx.globalCompositeOperation = mark.color === "erase" ? "destination-out" : "source-over";
      ctx.beginPath();
      mark.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    } else if (mark.kind === "text") {
      ctx.fillStyle = mark.color;
      ctx.font = `bold ${Math.round(ctx.canvas.height * 0.05)}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(mark.text, mark.x, mark.y);
    } else if (mark.kind === "sticker") {
      ctx.font = `${Math.round(ctx.canvas.height * 0.12)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(mark.emoji, mark.x, mark.y);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    } else if (mark.kind === "shape") {
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = mark.size || 3;
      ctx.beginPath();
      const { x: x1, y: y1 } = mark.start;
      const { x: x2, y: y2 } = mark.end;
      if (mark.shapeType === "rect") {
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
      } else if (mark.shapeType === "circle") {
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
      } else if (mark.shapeType === "line") {
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      } else if (mark.shapeType === "arrow") {
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 12;
        ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      }
      ctx.stroke();
    }
  }

  function undoLast() {
    setMarks((current) => current.slice(0, -1));
  }

  // Switch tab handler
  function switchTab(key) {
    setActiveTab(key);
    setTool(null);
    setShowStickers(false);
    if (key === "adjust") {
      setTool("crop"); // Auto-select crop when switching to Adjust
    }
  }

  // Crop overlay rendered on the viewport
  function renderCropOverlay() {
    if (!cropActive) return null;
    const left = cropRect.x * viewportW;
    const top = cropRect.y * viewportH;
    const w = cropRect.w * viewportW;
    const h = cropRect.h * viewportH;
    const hs = HANDLE_SIZE / 2;

    return (
      <div
        style={{ position: "absolute", inset: 0, zIndex: 5 }}
        onPointerDown={onCropPointerDown}
        onPointerMove={onCropPointerMove}
        onPointerUp={onCropPointerUp}
        onPointerLeave={onCropPointerUp}
      >
        {/* Dark overlay outside crop */}
        {/* Top */}
        <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: top, background: "rgba(0,0,0,0.6)" }}/>
        {/* Bottom */}
        <div style={{ position: "absolute", left: 0, top: top + h, width: "100%", bottom: 0, background: "rgba(0,0,0,0.6)" }}/>
        {/* Left */}
        <div style={{ position: "absolute", left: 0, top, width: left, height: h, background: "rgba(0,0,0,0.6)" }}/>
        {/* Right */}
        <div style={{ position: "absolute", left: left + w, top, right: 0, height: h, background: "rgba(0,0,0,0.6)" }}/>

        {/* Crop border */}
        <div style={{
          position: "absolute", left, top, width: w, height: h,
          border: "2px solid #fff",
          boxSizing: "border-box",
        }}>
          {/* Grid lines (rule of thirds) */}
          <div style={{ position: "absolute", left: "33.33%", top: 0, width: 1, height: "100%", background: "rgba(255,255,255,0.3)" }}/>
          <div style={{ position: "absolute", left: "66.66%", top: 0, width: 1, height: "100%", background: "rgba(255,255,255,0.3)" }}/>
          <div style={{ position: "absolute", top: "33.33%", left: 0, height: 1, width: "100%", background: "rgba(255,255,255,0.3)" }}/>
          <div style={{ position: "absolute", top: "66.66%", left: 0, height: 1, width: "100%", background: "rgba(255,255,255,0.3)" }}/>
        </div>

        {/* Corner handles — L-shaped like WhatsApp */}
        {/* Top-left */}
        <div style={{
          position: "absolute", left: left - 2, top: top - 2,
          width: HANDLE_SIZE, height: 4, background: "#fff", borderRadius: 2,
        }}/>
        <div style={{
          position: "absolute", left: left - 2, top: top - 2,
          width: 4, height: HANDLE_SIZE, background: "#fff", borderRadius: 2,
        }}/>
        {/* Top-right */}
        <div style={{
          position: "absolute", right: viewportW - left - w - 2, top: top - 2,
          width: HANDLE_SIZE, height: 4, background: "#fff", borderRadius: 2,
        }}/>
        <div style={{
          position: "absolute", right: viewportW - left - w - 2, top: top - 2,
          width: 4, height: HANDLE_SIZE, background: "#fff", borderRadius: 2,
        }}/>
        {/* Bottom-left */}
        <div style={{
          position: "absolute", left: left - 2, bottom: viewportH - top - h - 2,
          width: HANDLE_SIZE, height: 4, background: "#fff", borderRadius: 2,
        }}/>
        <div style={{
          position: "absolute", left: left - 2, bottom: viewportH - top - h - 2,
          width: 4, height: HANDLE_SIZE, background: "#fff", borderRadius: 2,
        }}/>
        {/* Bottom-right */}
        <div style={{
          position: "absolute", right: viewportW - left - w - 2, bottom: viewportH - top - h - 2,
          width: HANDLE_SIZE, height: 4, background: "#fff", borderRadius: 2,
        }}/>
        <div style={{
          position: "absolute", right: viewportW - left - w - 2, bottom: viewportH - top - h - 2,
          width: 4, height: HANDLE_SIZE, background: "#fff", borderRadius: 2,
        }}/>

        {/* Edge midpoint handles */}
        {/* Top edge */}
        <div style={{
          position: "absolute", left: left + w / 2 - 12, top: top - 2,
          width: 24, height: 4, background: "#fff", borderRadius: 2,
        }}/>
        {/* Bottom edge */}
        <div style={{
          position: "absolute", left: left + w / 2 - 12, bottom: viewportH - top - h - 2,
          width: 24, height: 4, background: "#fff", borderRadius: 2,
        }}/>
        {/* Left edge */}
        <div style={{
          position: "absolute", left: left - 2, top: top + h / 2 - 12,
          width: 4, height: 24, background: "#fff", borderRadius: 2,
        }}/>
        {/* Right edge */}
        <div style={{
          position: "absolute", right: viewportW - left - w - 2, top: top + h / 2 - 12,
          width: 4, height: 24, background: "#fff", borderRadius: 2,
        }}/>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0a0a0a", zIndex: 90,
      display: "flex", flexDirection: "column",
      animation: "txEditorSlideIn 0.3s ease-out",
    }}>
      {/* Top bar */}
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
      <div style={{
        flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden",
      }}>
        <div ref={viewportRef} style={{
          width: viewportW, height: viewportH, maxHeight: "100%", borderRadius: cropActive ? 0 : 12, overflow: "hidden",
          position: "relative", background: "#111",
          touchAction: "none",
          cursor: cropActive ? "default" : (locked ? (tool === "draw" || tool === "highlighter" || tool === "eraser" || tool === "shape" ? "crosshair" : "default") : "grab"),
        }}
             onPointerDown={onPointerDown} onPointerMove={onPointerMove}
             onPointerUp={onPointerUp} onPointerLeave={onPointerUp}
             onClick={onViewportTap}
             onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          {rotatedUrl && (
            <img src={rotatedUrl} alt="" draggable={false} style={{
              position: "absolute",
              left: viewportW / 2 - displayedW / 2 + pan.x,
              top: viewportH / 2 - displayedH / 2 + pan.y,
              width: displayedW, height: displayedH,
              filter: activeFilterCss, userSelect: "none",
              transform: fineAngle ? `rotate(${fineAngle}deg)` : "none",
              transformOrigin: "center center",
            }}/>
          )}
          <canvas ref={overlayCanvasRef} style={{
            position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2,
          }}/>
          {/* Crop overlay */}
          {renderCropOverlay()}
        </div>
      </div>

      {/* Context-sensitive tool options panel */}
      <div style={{ flexShrink: 0, maxHeight: 260, overflowY: "auto" }}>

        {/* ADJUST tab — Aspect pills + Brightness/Contrast/Saturation */}
        {activeTab === "adjust" && (
          <div style={{ padding: "8px 16px" }}>
            {/* Crop tool → aspect ratio pills + fine-rotation dial. Nothing in
                this panel shows until a tool is picked from the bottom bar, so
                the sliders no longer sit here permanently. */}
            {tool === "crop" && (<>
            {/* Aspect ratio pills */}
            <div style={{ display: "flex", gap: 8, marginBottom: 10, overflowX: "auto" }}>
              {ASPECTS.map((option) => (
                <div key={option.key} onClick={() => setAspect(option)} style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 12.5, flexShrink: 0, cursor: "pointer",
                  border: `1px solid ${aspect.key === option.key ? G.accent : "#ffffff22"}`,
                  background: aspect.key === option.key ? `${G.accent}22` : "transparent",
                  color: aspect.key === option.key ? G.accent : "#ffffffcc",
                }}>{option.label}</div>
              ))}
            </div>
            {/* Fine rotation dial — WhatsApp-style curved ruler */}
            <div style={{ position: "relative", height: 48, marginBottom: 8, overflow: "hidden" }}>
              <svg viewBox="0 0 340 48" width="100%" height="48" style={{ display: "block" }}>
                {/* Arc path for the curved ruler */}
                {Array.from({ length: 61 }, (_, i) => {
                  const deg = i - 30;
                  const angle = (deg / 30) * 0.5; // map to visual arc
                  const cx = 170 + Math.sin(angle) * 280;
                  const cy = 160 - Math.cos(angle) * 280;
                  const isMajor = deg % 10 === 0;
                  const len = isMajor ? 10 : deg % 5 === 0 ? 6 : 3;
                  const nx = Math.sin(angle);
                  const ny = -Math.cos(angle);
                  return (
                    <g key={deg}>
                      <line
                        x1={cx} y1={cy} x2={cx + nx * len} y2={cy + ny * len}
                        stroke={Math.abs(deg - fineAngle) < 1.5 ? "#fff" : "#ffffff55"}
                        strokeWidth={isMajor ? 1.5 : 0.8}
                      />
                      {isMajor && (
                        <text x={cx + nx * 16} y={cy + ny * 16}
                              fill={Math.abs(deg - fineAngle) < 5 ? "#fff" : "#ffffff66"}
                              fontSize="8" textAnchor="middle" dominantBaseline="middle">
                          {deg}
                        </text>
                      )}
                    </g>
                  );
                })}
                {/* Center indicator triangle */}
                <polygon points="170,0 166,8 174,8" fill="#fff"/>
              </svg>
              {/* Invisible range input for dragging */}
              <input type="range" min={-30} max={30} step={0.5} value={fineAngle}
                     onChange={(e) => setFineAngle(Number(e.target.value))}
                     style={{
                       position: "absolute", inset: 0, width: "100%", height: "100%",
                       opacity: 0, cursor: "ew-resize",
                     }}/>
              {fineAngle !== 0 && (
                <div onClick={() => setFineAngle(0)} style={{
                  position: "absolute", right: 4, top: 4, fontSize: 10, color: G.accent,
                  cursor: "pointer", padding: "2px 6px", borderRadius: 8, background: "#ffffff12",
                }}>Reset</div>
              )}
            </div>
            </>)}

            {/* Tune tool → Brightness / Contrast / Saturation (shown only when
                the Tune tool is active, not permanently). */}
            {tool === "tune" && (
            <div>
            {[
              { label: "Brightness", value: brightness, set: setBrightness },
              { label: "Contrast", value: contrast, set: setContrast },
              { label: "Saturation", value: saturation, set: setSaturation },
            ].map(({ label, value, set }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "#ffffff88", width: 64, flexShrink: 0 }}>{label}</span>
                <input type="range" min={50} max={150} value={value}
                       onChange={(e) => set(Number(e.target.value))}
                       className="tx-editor-slider"
                       style={{ flex: 1, appearance: "none", background: "transparent", height: 20 }}/>
                <span style={{ fontSize: 11, color: "#ffffff88", width: 28, textAlign: "right" }}>{value}</span>
              </div>
            ))}
            </div>
            )}
          </div>
        )}

        {/* FILTER tab — filter thumbnails */}
        {activeTab === "filter" && (
          <div style={{ display: "flex", gap: 10, padding: "8px 16px", overflowX: "auto", flexShrink: 0 }}>
            {FILTERS.map((option) => (
              <div key={option.key} onClick={() => setFilter(option)} style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                flexShrink: 0, cursor: "pointer",
              }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 10, overflow: "hidden",
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

        {/* DRAW tab — color picker + size */}
        {activeTab === "annotate" && (
          <div style={{ padding: "8px 16px" }}>
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

        {/* ADD tab — shape options */}
        {activeTab === "insert" && tool === "shape" && (
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

        {/* Sticker grid */}
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
      </div>

      {/* Bottom toolbar — 4 tabs + tool buttons */}
      <div style={{
        padding: "6px 16px 24px", background: "#0a0a0a",
        borderTop: "1px solid #ffffff12", flexShrink: 0,
      }}>
        {/* Tool buttons for active tab */}
        {TABS.find((t) => t.key === activeTab)?.tools.length > 0 && (
          <div style={{
            display: "flex", gap: 6, justifyContent: "center", marginBottom: 8,
          }}>
            {TABS.find((t) => t.key === activeTab).tools.map((t, i) => {
              const IconComponent = TOOL_ICON_MAP[t.key];
              const isActive = tool === t.key;
              const color = isActive ? G.accent : "#ffffffaa";
              return (
                <div key={t.key} onClick={() => {
                  if (t.key === "rotate") { setRotation((r) => (r + 90) % 360); return; }
                  if (t.key === "flip") { setFlipped((f) => !f); return; }
                  if (t.key === "sticker") { setShowStickers((v) => !v); setTool("sticker"); return; }
                  setTool((current) => current === t.key ? null : t.key);
                  setShowStickers(false);
                }} style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                  padding: "8px 14px", borderRadius: 12, cursor: "pointer",
                  background: isActive ? `${G.accent}22` : "#ffffff0d",
                  border: `1px solid ${isActive ? G.accent : "transparent"}`,
                  animation: `txToolPop 0.2s ease-out ${i * 0.05}s both`,
                }}>
                  {IconComponent && <IconComponent color={color} size={20}/>}
                  <span style={{ fontSize: 10, color }}>{t.label}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* 4-tab bar */}
        <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
          {TABS.map((tab) => (
            <div key={tab.key} onClick={() => switchTab(tab.key)} style={{
              flex: 1, padding: "8px", borderRadius: 12, cursor: "pointer",
              textAlign: "center", fontSize: 12.5, fontWeight: 600,
              background: activeTab === tab.key ? "#ffffff1a" : "transparent",
              color: activeTab === tab.key ? "#fff" : "#ffffff66",
              transition: "all 0.15s",
            }}>{tab.label}</div>
          ))}
        </div>

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
