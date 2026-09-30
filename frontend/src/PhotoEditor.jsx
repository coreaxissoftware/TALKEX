import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Button, G, I, usePrompt } from "./ui.jsx";

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

// WhatsApp's crop ratio list. "original" resolves to the image's own aspect at
// runtime (see cropRatio); "free" (Fit to screen) is unconstrained free-drag.
const ASPECTS = [
  { key: "original", label: "Original", ratio: "original" },
  { key: "free", label: "Fit to screen", ratio: null },
  { key: "square", label: "Square", ratio: 1 },
  { key: "r23", label: "2:3", ratio: 2 / 3 },
  { key: "r35", label: "3:5", ratio: 3 / 5 },
  { key: "r34", label: "3:4", ratio: 3 / 4 },
  { key: "r45", label: "4:5", ratio: 4 / 5 },
  { key: "r57", label: "5:7", ratio: 5 / 7 },
  { key: "r916", label: "9:16", ratio: 9 / 16 },
];

const DRAW_COLORS = ["#ffffff", "#ef4444", "#f59e0b", "#22c55e", "#38bdf8", "#a855f7", "#ec4899", "#000000"];

const STICKER_EMOJIS = ["😀", "😂", "😍", "🔥", "❤️", "👍", "🎉", "😎", "✨", "😢", "😮", "🙌",
                        "🥳", "💪", "🤩", "🥺", "😴", "🤯", "🫡", "🚀", "💯", "🎊", "🦋", "🌈"];

const VIEWPORT_MAX_WIDTH = 380;
// Cap the viewport height too, so a tall/portrait image (or a 9:16 crop) is
// shown WHOLE and never grows past the editing area into the tools below it.
// Without this the viewport was sized by width alone, so a portrait photo
// overflowed and the crop tools overlapped the image.
const VIEWPORT_MAX_HEIGHT = 520;
const PREVIEW_MAX_DIM = 800;
const OUTPUT_LONG_EDGE = 1600;
const OUTPUT_LONG_EDGE_HD = 2400;

// 4 tabs: Adjust | Filter | Draw | Add
const TABS = [
  { key: "adjust", label: "Adjust", tools: [
    { key: "crop", label: "Crop" },
    { key: "aspect", label: "Ratio" },
    { key: "angle", label: "Angle" },
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
const HANDLE_SIZE = 24;
const HANDLE_HIT = 36;

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

// Filter — three overlapping colour circles (the classic "filters" glyph).
function FilterIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <circle cx="9" cy="9" r="6"/>
      <circle cx="15" cy="9" r="6"/>
      <circle cx="12" cy="15" r="6"/>
    </svg>
  );
}
// Ratio (fixed aspect-ratio picker) — overlapping frames suggesting choices.
function AspectIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="12" rx="1.5"/>
      <path d="M19 9v9a1.5 1.5 0 01-1.5 1.5H8" opacity="0.55"/>
    </svg>
  );
}
// Angle (fine straighten dial) — a tilted line over a baseline, protractor-like.
function AngleIcon({ color = "#fff", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19h16"/>
      <path d="M4 19L18 8"/>
      <path d="M4 19a8 8 0 016.5-7.85"/>
    </svg>
  );
}

const TOOL_ICON_MAP = {
  crop: CropIcon, aspect: AspectIcon, angle: AngleIcon,
  rotate: RotateIcon, flip: FlipIcon, tune: TuneIcon,
  draw: PenIcon, highlighter: MarkerIcon, eraser: EraserIcon,
  text: TextIcon, sticker: StickerIcon, shape: ShapeIcon,
};

/**
 * A placed text/sticker as a real, live DOM element instead of a fixed
 * canvas paint — the actual iOS-Photos/Instagram gesture set: tap to
 * select, drag the body to move, drag the bottom-right handle to resize
 * AND rotate together in one gesture (exactly how a finger pinch-rotates a
 * sticker on iOS — distance from center drives scale, angle from center
 * drives rotation, both from the same drag), tap the top-left handle to
 * delete just this one element, double-tap text to retype it. Before this
 * existed, placing something was permanent the instant you tapped it down.
 */
function DraggableMark({ mark, viewportW, viewportH, selected, onSelect, onChange, onDelete, onEditText }) {
  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const gestureRef = useRef(null);

  const scale = mark.scale || 1;
  const rotation = mark.rotation || 0;

  function onBodyPointerDown(event) {
    event.stopPropagation();
    onSelect();
    dragRef.current = { startX: event.clientX, startY: event.clientY, startMarkX: mark.x, startMarkY: mark.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onBodyPointerMove(event) {
    if (!dragRef.current) return;
    const dx = (event.clientX - dragRef.current.startX) / viewportW;
    const dy = (event.clientY - dragRef.current.startY) / viewportH;
    onChange({
      x: Math.min(1, Math.max(0, dragRef.current.startMarkX + dx)),
      y: Math.min(1, Math.max(0, dragRef.current.startMarkY + dy)),
    });
  }
  function onBodyPointerUp() { dragRef.current = null; }

  function onHandlePointerDown(event) {
    event.stopPropagation();
    const rect = rootRef.current.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    gestureRef.current = {
      originX, originY,
      startDist: Math.max(1, Math.hypot(event.clientX - originX, event.clientY - originY)),
      startAngle: Math.atan2(event.clientY - originY, event.clientX - originX),
      startScale: scale, startRotation: rotation,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onHandlePointerMove(event) {
    if (!gestureRef.current) return;
    const g = gestureRef.current;
    const dist = Math.hypot(event.clientX - g.originX, event.clientY - g.originY);
    const angle = Math.atan2(event.clientY - g.originY, event.clientX - g.originX);
    onChange({
      scale: Math.min(4, Math.max(0.3, g.startScale * (dist / g.startDist))),
      rotation: g.startRotation + ((angle - g.startAngle) * 180) / Math.PI,
    });
  }
  function onHandlePointerUp() { gestureRef.current = null; }

  const counterTransform = `rotate(${-rotation}deg) scale(${1 / scale})`;

  return (
    <div ref={rootRef} style={{
      position: "absolute", left: `${mark.x * 100}%`, top: `${mark.y * 100}%`,
      transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`,
      touchAction: "none", cursor: "move", zIndex: 4,
    }}
      onPointerDown={onBodyPointerDown} onPointerMove={onBodyPointerMove}
      onPointerUp={onBodyPointerUp} onPointerLeave={onBodyPointerUp}
      // stopPropagation on pointerdown alone isn't enough — the viewport's
      // own onClick (which deselects on empty-space taps) is a SEPARATE
      // synthetic event that still bubbles from a click landing on this
      // element unless stopped here too, which without this made selecting
      // a mark and immediately losing that selection the same gesture.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => { event.stopPropagation(); mark.kind === "text" && onEditText?.(); }}
    >
      <div style={{
        padding: 8, borderRadius: 8,
        border: `1.5px dashed ${selected ? G.accent : "transparent"}`,
      }}>
        {mark.kind === "sticker"
          ? <span style={{ fontSize: 44, lineHeight: 1, display: "block" }}>{mark.emoji}</span>
          : <span style={{
              fontSize: 20, fontWeight: 700, color: mark.color, whiteSpace: "nowrap",
              textShadow: "0 1px 5px rgba(0,0,0,0.55)",
            }}>{mark.text}</span>}
      </div>
      {selected && (
        <>
          <div onPointerDown={(event) => { event.stopPropagation(); onDelete(); }} style={{
            position: "absolute", left: -13, top: -13, width: 26, height: 26, borderRadius: "50%",
            background: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
            boxShadow: "0 1px 5px rgba(0,0,0,0.4)", transform: counterTransform,
          }}>×</div>
          <div
            onPointerDown={onHandlePointerDown} onPointerMove={onHandlePointerMove}
            onPointerUp={onHandlePointerUp} onPointerLeave={onHandlePointerUp}
            style={{
              position: "absolute", right: -13, bottom: -13, width: 26, height: 26, borderRadius: "50%",
              background: G.accent, display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 12, cursor: "nwse-resize", touchAction: "none",
              boxShadow: "0 1px 5px rgba(0,0,0,0.4)", transform: counterTransform,
            }}>⤡</div>
        </>
      )}
    </div>
  );
}

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
export default function PhotoEditor({ file, onCancel, onDone, initialAspectKey, initialTool,
                                     onSend, initialCaption = "", initialViewOnce = false, recipientName }) {
  const [promptFn, promptModal] = usePrompt();
  const [rotatedSrc, setRotatedSrc] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [flipped, setFlipped] = useState(false);
  // Opening the editor for framing (e.g. a cover photo) starts on the crop tool.
  // `initialAspectKey` is optional — omit it to start on FREE crop with the
  // fully draggable/resizable crop box (the flexible mode), which the user can
  // still switch to any fixed ratio (including "Cover") from the aspect pills.
  const [aspect, setAspect] = useState(
    () => ASPECTS.find((a) => a.key === initialAspectKey) || ASPECTS.find((a) => a.key === "free"));
  const [filter, setFilter] = useState(FILTERS[0]);
  // 0-100 — iOS Photos/Instagram both let a filter be scrubbed to a
  // strength, not just switched on/off. Blended by stacking the unfiltered
  // image under the filtered one and fading the filtered layer's opacity
  // (see the two <img> layers in the viewport and the matching two-pass
  // draw in done() below) — the standard technique for "how much of this
  // preset filter" when the filter itself is an arbitrary combined CSS
  // filter string rather than one tunable numeric parameter.
  const [filterIntensity, setFilterIntensity] = useState(100);
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
  // Which placed text/sticker is currently selected for drag/resize/rotate/
  // delete — the actual "flexible" gap this fixes. Before this, a placed
  // mark was permanent the instant you tapped it down: no repositioning,
  // no resizing, no per-element delete (only a global "undo last"). null
  // means nothing is selected (tapping empty canvas clears it).
  const [selectedMarkIndex, setSelectedMarkIndex] = useState(null);
  const [tool, setTool] = useState((initialTool || initialAspectKey) ? "crop" : null);
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

  // Actual space the editing stage has RIGHT NOW. The image is fit into this,
  // so when a tool panel (Ratio / Angle / Tune) opens at the bottom and the
  // stage shrinks, the image zooms out to stay whole on screen instead of the
  // panel overlapping it. Measured live with a ResizeObserver.
  const stageRef = useRef(null);
  const [avail, setAvail] = useState({ w: VIEWPORT_MAX_WIDTH, h: VIEWPORT_MAX_HEIGHT });

  // Pinch-to-zoom state
  const pinchRef = useRef(null);

  const locked = tool === "draw" || tool === "highlighter" || tool === "eraser" || tool === "text"
    || tool === "sticker" || tool === "shape";

  useEffect(() => { injectEditorStyles(); }, []);

  // Track the stage's live size so the viewport can be fit into whatever space
  // is actually available (shrinks when a bottom tool panel opens).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setAvail({ w: r.width, h: r.height });
    };
    measure();
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => ro?.disconnect();
  }, []);

  const adjustmentCss = (brightness !== 100 || contrast !== 100 || saturation !== 100)
    ? `brightness(${brightness / 100}) contrast(${contrast / 100}) saturate(${saturation / 100})`
    : "";

  // Adjustments/enhance only, never the preset — the layer the preset-filter
  // image fades back into as its own intensity slider goes toward 0%.
  const baseFilterCss = [enhanced ? ENHANCE_CSS : "", adjustmentCss].filter(Boolean).join(" ") || "none";

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

    const drawRotated = (canvas, cw, ch) => {
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      ctx.translate(cw / 2, ch / 2);
      const scale = cw / w;
      ctx.scale(scale, scale);
      ctx.rotate((rotation * Math.PI) / 180);
      if (flipped) ctx.scale(-1, 1);
      ctx.drawImage(sourceImg, -sourceImg.naturalWidth / 2, -sourceImg.naturalHeight / 2);
    };

    const fullCanvas = document.createElement("canvas");
    drawRotated(fullCanvas, w, h);

    const ratio = Math.min(1, PREVIEW_MAX_DIM / Math.max(w, h));
    const pw = Math.round(w * ratio);
    const ph = Math.round(h * ratio);
    const prevCanvas = document.createElement("canvas");
    drawRotated(prevCanvas, pw, ph);

    setRotatedSrc({ canvas: fullCanvas, w, h, previewCanvas: prevCanvas, pw, ph });
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setMarks([]);
    setCropRect({ x: 0, y: 0, w: 1, h: 1 });
  }, [sourceImg, rotation, flipped]);

  // Fit the viewport inside BOTH the max width and max height, preserving the
  // target aspect (the fixed crop ratio, or the image's own aspect for free
  // crop). This is what makes a portrait photo / 9:16 crop show whole and stay
  // clear of the tools below, instead of overflowing off the editing area.
  // "original" resolves to the image's own aspect; everything else is its fixed
  // number, and null (Fit to screen) means free-drag.
  const cropRatio = aspect.ratio === "original"
    ? (rotatedSrc ? rotatedSrc.w / rotatedSrc.h : null)
    : aspect.ratio;
  const _targetAspect = cropRatio || (rotatedSrc ? rotatedSrc.w / rotatedSrc.h : 1);
  // Cap by the live stage size (minus a small gutter) as well as the absolute
  // maxima, so the image always fits the space that's actually there.
  const _maxW = Math.min(VIEWPORT_MAX_WIDTH, (avail.w || VIEWPORT_MAX_WIDTH) - 8);
  const _maxH = Math.min(VIEWPORT_MAX_HEIGHT, (avail.h || VIEWPORT_MAX_HEIGHT) - 8);
  let viewportW = _maxW;
  let viewportH = viewportW / _targetAspect;
  if (viewportH > _maxH) {
    viewportH = _maxH;
    viewportW = viewportH * _targetAspect;
  }

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
      // Scroll-to-zoom the image works even while cropping now, so the user can
      // frame it (pinch/scroll to zoom, drag to move) behind the crop box.
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom((z) => Math.min(5, Math.max(1, z * factor)));
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // The viewport box itself already carries the chosen aspect ratio (viewportH
  // is derived from aspect.ratio, see above), so the crop is simply the WHOLE
  // frame. For a FIXED ratio you frame the shot by panning/zooming the image
  // behind the fixed frame (Instagram-style — the ratio can never drift); for
  // FREE crop the frame equals the image and you drag the handles to sub-crop.
  // The old code computed a shrunken rect from the image aspect while the
  // viewport was ALSO already the target aspect, double-applying the ratio and
  // producing an off, distorted crop.
  useEffect(() => {
    setCropRect({ x: 0, y: 0, w: 1, h: 1 });
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
    // Only FREE crop has draggable resize handles. For a fixed ratio the frame
    // is locked to that ratio, so a pointer-down there pans/zooms the image
    // behind it instead of resizing (which would break the ratio).
    const handle = cropRatio ? null : getCropHandle(px, py);
    if (handle) {
      cropDragRef.current = {
        type: handle === "move" ? "move" : handle,
        startRect: { ...cropRect },
        startX: e.clientX,
        startY: e.clientY,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.stopPropagation();
      return;
    }
    if (pinchRef.current) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPan: pan };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onCropPointerMove(e) {
    // Panning the image behind the crop box.
    if (dragRef.current && !cropDragRef.current) {
      if (pinchRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPan(clampPan({ x: dragRef.current.startPan.x + dx, y: dragRef.current.startPan.y + dy }));
      return;
    }
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
    dragRef.current = null;
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
        const isHighlight = tool === "highlighter";
        const strokeColor = tool === "eraser" ? "erase" : drawColor;
        const size = isHighlight ? 14 : tool === "eraser" ? 22 : drawSize;
        setMarks((current) => [...current, { kind: "stroke", points: strokingRef.current, color: strokeColor, size, highlight: isHighlight }]);
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

  async function onViewportTap(event) {
    if (cropActive) return;
    if (tool === "text") {
      const point = pointFromEvent(event);
      const text = await promptFn("Text:");
      if (text && text.trim()) {
        const newIndex = marks.length;
        setMarks((current) => [...current, {
          kind: "text", x: point.x, y: point.y, text: text.trim(), color: drawColor,
          scale: 1, rotation: 0,
        }]);
        // Selected immediately — the same "type it, then it's live under
        // your finger to drag/resize/rotate" flow iOS Photos and Instagram
        // both use, rather than dropping it fixed and switching you back
        // to the text TOOL (which would just place another one on the next
        // tap instead of letting you arrange what you just typed).
        setSelectedMarkIndex(newIndex);
        setTool(null);
      }
      return;
    }
    // Tapping empty canvas (not the text tool, not on a mark — DraggableMark
    // stops propagation on its own pointerdown) clears whatever's selected.
    if (selectedMarkIndex !== null) setSelectedMarkIndex(null);
  }

  function placeSticker(emoji) {
    const newIndex = marks.length;
    setMarks((current) => [...current, { kind: "sticker", x: 0.5, y: 0.5, emoji, scale: 1, rotation: 0 }]);
    setSelectedMarkIndex(newIndex);
    setShowStickers(false);
    setTool(null);
  }

  async function editMarkText(index) {
    const mark = marks[index];
    if (!mark || mark.kind !== "text") return;
    const text = await promptFn("Edit text:", mark.text);
    if (text && text.trim()) {
      setMarks((current) => current.map((m, i) => (i === index ? { ...m, text: text.trim() } : m)));
    }
  }

  function updateMark(index, patch) {
    setMarks((current) => current.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  function deleteMark(index) {
    setMarks((current) => current.filter((_, i) => i !== index));
    setSelectedMarkIndex(null);
  }

  function paintMark(ctx, w, h, mark) {
    if (mark.kind === "stroke") {
      ctx.strokeStyle = mark.color === "erase" ? "#000" : mark.color;
      ctx.lineWidth = mark.size || Math.max(2, w * 0.01);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = mark.highlight ? 0.35 : 1;
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
    // Text/sticker marks are rendered as real, draggable DOM elements (see
    // DraggableMark below) while editing, not painted onto this canvas —
    // this canvas now only ever shows strokes/shapes, which stay
    // canvas-painted since "drag this whole freehand line" isn't a
    // meaningful gesture the way repositioning a sticker is.
    for (const mark of marks) {
      if (mark.kind === "stroke" || mark.kind === "shape") paintMark(ctx, canvas.width, canvas.height, mark);
    }
    if (strokingRef.current) {
      const isHighlight = tool === "highlighter";
      const strokeColor = tool === "eraser" ? "erase" : drawColor;
      const size = isHighlight ? 14 : tool === "eraser" ? 22 : drawSize;
      paintMark(ctx, canvas.width, canvas.height, { kind: "stroke", points: strokingRef.current, color: strokeColor, size, highlight: isHighlight });
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

  const rotatedUrl = useMemo(() => (rotatedSrc ? rotatedSrc.previewCanvas.toDataURL() : null), [rotatedSrc]);

  // Activate/deactivate crop mode. The crop frame is shown for all three
  // crop-family tools: free Crop, fixed Ratio, and straighten Angle (so you
  // can see and adjust the frame while picking a ratio or straightening).
  useEffect(() => {
    setCropActive(activeTab === "adjust" && (tool === "crop" || tool === "aspect" || tool === "angle"));
  }, [activeTab, tool]);

  // Picking the Crop tool means "free crop right now" — reset any previously
  // chosen fixed ratio to Free so the drag is unconstrained.
  useEffect(() => {
    if (tool === "crop") setAspect(ASPECTS.find((a) => a.key === "free"));
  }, [tool]);

  // Caption + view-once for the in-editor send bar (WhatsApp-style), only used
  // when onSend is provided (the send flow).
  const [cap, setCap] = useState(initialCaption);
  const [vo, setVo] = useState(initialViewOnce);

  async function done(deliver = onDone) {
    if (!rotatedSrc) return;
    setProcessing(true);
    try {
      const longEdge = hd ? OUTPUT_LONG_EDGE_HD : OUTPUT_LONG_EDGE;

      // WYSIWYG export. The viewport shows the image at a known position and
      // size (imgLeft/imgTop, displayedW×displayedH — cover-fit + pan/zoom)
      // with an optional fine-rotation about its centre (see the <img> in the
      // viewport). We reproduce EXACTLY that composition into the output
      // canvas: scale the context so the crop region hits the target long
      // edge, translate the crop's top-left to the origin, then draw the image
      // in viewport coordinates. The previous code drew the whole image with
      // SEPARATE x/y scales (exportScaleX ≠ exportScaleY whenever the photo's
      // aspect didn't match the viewport's), which stretched the result — the
      // "cropped output is wrong" bug.
      const cropLeftPx = cropRect.x * viewportW;
      const cropTopPx = cropRect.y * viewportH;
      const cropWpx = Math.max(1, cropRect.w * viewportW);
      const cropHpx = Math.max(1, cropRect.h * viewportH);

      // Don't upscale past the real resolution of the cropped source region —
      // enlarging a small crop to longEdge would just add blur.
      const srcCropLong = Math.max(
        (cropWpx / displayedW) * rotatedSrc.w,
        (cropHpx / displayedH) * rotatedSrc.h,
      );
      const outLong = Math.min(longEdge, Math.max(1, srcCropLong));
      const exportScale = outLong / Math.max(cropWpx, cropHpx);

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(cropWpx * exportScale));
      canvas.height = Math.max(1, Math.round(cropHpx * exportScale));
      const ctx = canvas.getContext("2d");

      const imgLeft = viewportW / 2 - displayedW / 2 + pan.x;
      const imgTop = viewportH / 2 - displayedH / 2 + pan.y;
      const centreX = imgLeft + displayedW / 2;
      const centreY = imgTop + displayedH / 2;

      // One pass of the image drawn in VIEWPORT coordinates; the transform maps
      // viewport space → output pixels (scale, then shift the crop's top-left
      // to 0,0). save/restore because filter and alpha differ between passes.
      function drawBaseImage() {
        ctx.save();
        ctx.setTransform(
          exportScale, 0, 0, exportScale,
          -cropLeftPx * exportScale, -cropTopPx * exportScale,
        );
        if (fineAngle) {
          ctx.translate(centreX, centreY);
          ctx.rotate((fineAngle * Math.PI) / 180);
          ctx.translate(-centreX, -centreY);
        }
        ctx.drawImage(rotatedSrc.canvas, imgLeft, imgTop, displayedW, displayedH);
        ctx.restore();
      }

      ctx.filter = baseFilterCss;
      drawBaseImage();
      // Same two-layer blend as the live preview (see the stacked <img>s in
      // the viewport): the base pass above is un-filtered adjustments only,
      // and the preset (if any) is drawn a second time on top at
      // filterIntensity% opacity — that's what makes the exported photo
      // actually match a filter that was scrubbed to less than full
      // strength, instead of the export always baking in 100% of the preset
      // regardless of what the slider said.
      if (filter.key !== "none") {
        ctx.filter = activeFilterCss;
        ctx.globalAlpha = filterIntensity / 100;
        drawBaseImage();
        ctx.globalAlpha = 1;
      }
      ctx.filter = "none";
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Draw marks scaled to crop
      for (const mark of marks) {
        // Marks are in viewport-normalized coords, remap to crop
        const remapped = remapMark(mark, cropRect, canvas.width, canvas.height);
        if (remapped) paintMarkAbsolute(ctx, remapped);
      }

      canvas.toBlob((blob) => {
        setProcessing(false);
        if (!blob) { onCancel(); return; }
        deliver(new File([blob], file.name || `edited-${Date.now()}.jpg`, { type: "image/jpeg" }));
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
    if (mark.kind === "stroke") {
      ctx.strokeStyle = mark.color === "erase" ? "#000" : mark.color;
      ctx.lineWidth = mark.size || 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = mark.highlight ? 0.35 : 1;
      ctx.globalCompositeOperation = mark.color === "erase" ? "destination-out" : "source-over";
      ctx.beginPath();
      mark.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    } else if (mark.kind === "text" || mark.kind === "sticker") {
      // Centered anchor + rotate/scale around that same center — matches
      // DraggableMark's `translate(-50%,-50%) rotate() scale()` exactly, so
      // the exported image lands where the person actually saw it while
      // dragging/resizing/rotating it live, not the fixed top-left/no-
      // transform placement this used to hard-code.
      ctx.save();
      ctx.translate(mark.x, mark.y);
      ctx.rotate(((mark.rotation || 0) * Math.PI) / 180);
      ctx.scale(mark.scale || 1, mark.scale || 1);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (mark.kind === "text") {
        ctx.fillStyle = mark.color;
        ctx.font = `bold ${Math.round(ctx.canvas.height * 0.045)}px -apple-system, sans-serif`;
        ctx.fillText(mark.text, 0, 0);
      } else {
        ctx.font = `${Math.round(ctx.canvas.height * 0.1)}px sans-serif`;
        ctx.fillText(mark.emoji, 0, 0);
      }
      ctx.restore();
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
        // touchAction:none is the fix for "the crop handle only nudges a
        // little per swipe": without it a touch drag is claimed by the browser
        // as a scroll gesture and the pointer drag is cancelled after a few
        // pixels, so the handle crept instead of following the finger.
        style={{ position: "absolute", inset: 0, zIndex: 5, touchAction: "none" }}
        onPointerDown={onCropPointerDown}
        onPointerMove={onCropPointerMove}
        onPointerUp={onCropPointerUp}
        onPointerLeave={onCropPointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
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

        {/* Resize handles only for FREE crop — a fixed ratio shows just the
            locked frame (you pan/zoom the image behind it). */}
        {!cropRatio && (<>
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
        </>)}
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0a0a0a", zIndex: 90,
      display: "flex", flexDirection: "column",
      animation: "txEditorSlideIn 0.3s ease-out",
      // The iOS system font stack — renders as actual San Francisco on an
      // iPhone/Mac, and each platform's own closest native equivalent
      // everywhere else, instead of the browser/WebView default serif-ish
      // fallback the rest of this screen used to inherit silently.
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif",
    }}>
      {/* Top bar — frosted glass over the photo, iOS-sheet style, rather
          than a flat solid bar sitting on top of it. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 12px", flexShrink: 0,
        background: "rgba(10,10,10,0.72)", backdropFilter: "blur(20px) saturate(1.5)",
        WebkitBackdropFilter: "blur(20px) saturate(1.5)",
        borderBottom: "0.5px solid rgba(255,255,255,0.08)",
      }}>
        <div onClick={onCancel} title="Close" style={{
          cursor: "pointer", width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
          background: "rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </div>
        {/* Flat WhatsApp-style icon row — direct access to the primary tools
            (Crop / Filter / Text / Sticker / Draw / Tune) instead of tab
            groups. The underlying activeTab/tool machinery is unchanged; each
            icon just sets both at once. Sub-tools still appear in the row below. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-around", alignItems: "center", gap: 2, overflowX: "auto" }}>
          {[
            { key: "crop", tab: "adjust", tool: "crop", Icon: CropIcon },
            { key: "filter", tab: "filter", tool: null, Icon: FilterIcon },
            { key: "text", tab: "insert", tool: "text", Icon: TextIcon },
            { key: "sticker", tab: "insert", tool: "sticker", Icon: StickerIcon },
            { key: "draw", tab: "annotate", tool: "draw", Icon: PenIcon },
            { key: "tune", tab: "adjust", tool: "tune", Icon: TuneIcon },
          ].map((a) => {
            const active = activeTab === a.tab && (a.tool ? tool === a.tool : true);
            return (
              <div key={a.key} onClick={() => {
                setActiveTab(a.tab);
                if (a.key === "sticker") { setShowStickers(true); setTool("sticker"); }
                else { setShowStickers(false); setTool(a.tool); }
              }} title={a.key} style={{
                flexShrink: 0, padding: "7px 9px", borderRadius: 10, cursor: "pointer",
                background: active ? `${G.accent}33` : "transparent",
                border: `1px solid ${active ? G.accent : "transparent"}`,
              }}>
                <a.Icon color={active ? G.accent : "#ffffffcc"} size={20}/>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
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
          <button onClick={done} disabled={!rotatedSrc || processing} title="Done" style={{
            padding: "7px 16px", borderRadius: 20, border: "none", cursor: "pointer",
            background: G.accent, color: "#fff", fontSize: 14, fontWeight: 700,
            opacity: !rotatedSrc || processing ? 0.5 : 1, flexShrink: 0,
          }}>{processing ? "…" : "Done ✓"}</button>
        </div>
      </div>

      {/* Viewport stage — measured live so the image fits the remaining space */}
      <div ref={stageRef} style={{
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
          {rotatedUrl && (() => {
            const shared = {
              position: "absolute",
              left: viewportW / 2 - displayedW / 2 + pan.x,
              top: viewportH / 2 - displayedH / 2 + pan.y,
              width: displayedW, height: displayedH, userSelect: "none",
              transform: fineAngle ? `rotate(${fineAngle}deg)` : "none",
              transformOrigin: "center center",
            };
            return (
              <>
                {/* Base layer — adjustments/enhance but never the preset
                    filter. When a preset is picked, this is what shows
                    through as the filter layer above it fades toward 0%. */}
                <img src={rotatedUrl} alt="" draggable={false} style={{ ...shared, filter: baseFilterCss }}/>
                {filter.key !== "none" && (
                  <img src={rotatedUrl} alt="" draggable={false} style={{
                    ...shared, filter: activeFilterCss, opacity: filterIntensity / 100,
                  }}/>
                )}
              </>
            );
          })()}
          <canvas ref={overlayCanvasRef} style={{
            position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2,
          }}/>
          {/* Live, draggable text/sticker marks — hidden during crop since
              cropping takes over the viewport's own gestures entirely. */}
          {!cropActive && marks.map((mark, index) => (
            (mark.kind === "text" || mark.kind === "sticker") && (
              <DraggableMark key={index} mark={mark} viewportW={viewportW} viewportH={viewportH}
                             selected={selectedMarkIndex === index}
                             onSelect={() => setSelectedMarkIndex(index)}
                             onChange={(patch) => updateMark(index, patch)}
                             onDelete={() => deleteMark(index)}
                             onEditText={() => editMarkText(index)}/>
            )
          ))}
          {/* Crop overlay */}
          {renderCropOverlay()}
        </div>
      </div>

      {/* Context-sensitive tool options panel */}
      <div style={{ flexShrink: 0, maxHeight: 260, overflowY: "auto" }}>

        {/* ADJUST tab — Aspect pills + Brightness/Contrast/Saturation */}
        {activeTab === "adjust" && (
          <div style={{ padding: "8px 16px" }}>
            {/* Crop tool → free crop only, no panel row of its own (the aspect
                is reset to Free by an effect below). Fixed ratios live under the
                Ratio tool, straightening under Angle. */}

            {/* Ratio tool → WhatsApp-style aspect-ratio bottom-sheet. Picking a
                ratio applies it and drops back to the crop frame. */}
            {tool === "aspect" && (
            <div onClick={() => setTool("crop")} style={{
              position: "fixed", inset: 0, zIndex: 60, background: "#00000066",
              display: "flex", alignItems: "flex-end", justifyContent: "center",
              animation: "txSheetFade 0.15s ease-out",
            }}>
              <div onClick={(e) => e.stopPropagation()} style={{
                width: "100%", maxWidth: 480, background: "#1c1c1e",
                borderTopLeftRadius: 18, borderTopRightRadius: 18,
                paddingBottom: "calc(10px + env(safe-area-inset-bottom))",
                maxHeight: "72vh", overflowY: "auto", animation: "txSheetUp 0.2s ease-out",
              }}>
                <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 4px" }}>
                  <div style={{ width: 38, height: 4, borderRadius: 2, background: "#ffffff33" }}/>
                </div>
                {ASPECTS.map((option) => (
                  <div key={option.key} onClick={() => { setAspect(option); setTool("crop"); }} style={{
                    padding: "15px 22px", fontSize: 16, cursor: "pointer",
                    color: aspect.key === option.key ? G.accent : "#fff",
                    fontWeight: aspect.key === option.key ? 700 : 400,
                  }}>{option.label}</div>
                ))}
              </div>
              <style>{"@keyframes txSheetFade{from{opacity:0}to{opacity:1}}@keyframes txSheetUp{from{transform:translateY(20px)}to{transform:none}}"}</style>
            </div>
            )}

            {/* Crop screen (WhatsApp) — straighten dial in the middle, a rotate
                button on the left and an aspect-ratio button on the right. Shown
                whenever the Crop or Angle tool is active. */}
            {(tool === "crop" || tool === "angle") && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div onClick={() => setRotation((r) => (r + 90) % 360)} title="Rotate"
                   style={{ flexShrink: 0, width: 42, height: 42, borderRadius: "50%", background: "#ffffff14",
                            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                <RotateIcon color="#fff" size={20}/>
              </div>
            <div style={{ position: "relative", height: 48, flex: 1, overflow: "hidden" }}>
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
              <div onClick={() => setTool("aspect")} title="Aspect ratio"
                   style={{ flexShrink: 0, width: 42, height: 42, borderRadius: "50%",
                            background: aspect.key !== "free" ? `${G.accent}33` : "#ffffff14",
                            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                <AspectIcon color={aspect.key !== "free" ? G.accent : "#fff"} size={20}/>
              </div>
            </div>
            )}

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

        {/* FILTER tab — filter thumbnails + intensity scrubber */}
        {activeTab === "filter" && (
          <div style={{ padding: "8px 16px" }}>
            <div style={{ display: "flex", gap: 10, overflowX: "auto", flexShrink: 0, marginBottom: filter.key !== "none" ? 10 : 0 }}>
              {FILTERS.map((option) => (
                <div key={option.key} onClick={() => { setFilter(option); setFilterIntensity(100); }} style={{
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
            {/* Strength scrubber — the flexible part a fixed on/off preset
                never had. 0 fades all the way back to the original photo;
                100 is the full preset, same range Instagram's own filter
                intensity slider covers. */}
            {filter.key !== "none" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "#ffffff88", width: 46, flexShrink: 0 }}>{filter.label}</span>
                <input type="range" min={0} max={100} value={filterIntensity}
                       onChange={(e) => setFilterIntensity(Number(e.target.value))}
                       className="tx-editor-slider"
                       style={{ flex: 1, appearance: "none", background: "transparent", height: 20 }}/>
                <span style={{ fontSize: 11, color: "#ffffff88", width: 30, textAlign: "right" }}>{filterIntensity}%</span>
              </div>
            )}
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
        padding: "6px 16px 24px", background: "rgba(10,10,10,0.72)",
        backdropFilter: "blur(20px) saturate(1.5)", WebkitBackdropFilter: "blur(20px) saturate(1.5)",
        borderTop: "0.5px solid rgba(255,255,255,0.08)", flexShrink: 0,
      }}>
        {/* Tool buttons for active tab */}
        {TABS.find((t) => t.key === activeTab)?.tools.length > 0 && (
          <div style={{
            display: "flex", gap: 6, marginBottom: 8,
            // The Adjust tab now has 6 tools (crop / ratio / angle / rotate /
            // flip / tune) — more than fit a narrow phone, so let the row
            // scroll horizontally instead of squishing the buttons. Tabs with a
            // few tools still centre; the crowded one starts at the left so the
            // first tool isn't clipped by centring the overflow.
            justifyContent: (TABS.find((t) => t.key === activeTab).tools.length > 4) ? "flex-start" : "center",
            overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch",
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
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0,
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

        {/* Tabs + Done now live in the header (see top bar) — nothing here, so
            the editing area above gets that vertical space back. */}
      </div>

      {/* WhatsApp-style in-editor caption + send bar (send flow only) */}
      {onSend && (
        <div style={{ padding: "8px 12px calc(10px + env(safe-area-inset-bottom))", background: "#000" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Add a caption…"
                   style={{
                     flex: 1, minWidth: 0, padding: "12px 16px", borderRadius: 22,
                     background: "#ffffff1a", border: "1px solid #ffffff2b", color: "#fff",
                     fontSize: 14.5, outline: "none",
                   }}/>
            <div onClick={() => setVo((v) => !v)} title={vo ? "View once is on" : "Send as view once"}
                 style={{
                   width: 44, height: 44, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                   display: "flex", alignItems: "center", justifyContent: "center",
                   background: vo ? "#25d36633" : "#ffffff1a", border: `1px solid ${vo ? "#25d366" : "#ffffff2b"}`,
                 }}>
              {I.eye ? I.eye(vo ? "#25d366" : "#fff", 20) : <span style={{ color: "#fff", fontWeight: 700 }}>1</span>}
            </div>
            <button onClick={() => done((f) => onSend(f, cap.trim(), vo))} disabled={processing} style={{
              width: 48, height: 48, borderRadius: "50%", border: "none", cursor: "pointer", flexShrink: 0,
              background: `linear-gradient(135deg,${G.accent},${G.accentD})`,
              display: "flex", alignItems: "center", justifyContent: "center", opacity: processing ? 0.6 : 1,
            }}>
              {I.send ? I.send() : <span style={{ color: "#fff", fontSize: 18 }}>➤</span>}
            </button>
          </div>
          {recipientName && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: "#ffffff99" }}>{recipientName}</div>
          )}
        </div>
      )}
      {promptModal}
    </div>
  );
}
