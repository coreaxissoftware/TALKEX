// In-app PDF viewer AND lightweight editor, built on pdf.js. This is loaded
// lazily (React.lazy in ChatView) so pdf.js — a heavy dependency — lands in
// its own chunk and never weighs down the initial app load.
//
// Viewing: every page is rasterised to a canvas via pdf.js and shown in a
// scrollable, zoomable column. This is the ONLY way a PDF renders reliably
// inside Android's System WebView, which has no native PDF plugin.
//
// Responsiveness: pages render PROGRESSIVELY — page 1 appears the moment it's
// ready instead of waiting for the whole document — and each page is rasterised
// to a JPEG data URL exactly ONCE (not re-encoded on every React render, which
// was the big open/scroll stall before). Zoom is CSS width scaling with
// wheel/ctrl-wheel, pinch, and +/- buttons; the column scrolls in both axes.
//
// Editing: a transparent overlay canvas sits on each page for freehand pen
// strokes and tap-to-place text. Exporting flattens each page canvas + its
// marks into a fresh image and rewraps the lot into a new multi-page PDF.

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { canvasesToPdfBlob } from "./imageToPdf.js";
import { G, I, usePrompt } from "./ui.jsx";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const PEN_COLORS = ["#ff3b30", "#0a84ff", "#111111", "#34c759", "#ffcc00"];
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;

export default function PdfDoc({ src, name, onClose, onDownloadOriginal, toast }) {
  const [promptFn, promptModal] = usePrompt();
  const [pages, setPages] = useState(null);   // [{ canvas, url, width, height }] — grows as pages render
  const [total, setTotal] = useState(0);      // page count (known before all are rendered)
  const [error, setError] = useState(false);
  const [mode, setMode] = useState("view");   // "view" | "edit"
  const [tool, setTool] = useState("pen");    // "pen" | "text"
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [exporting, setExporting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [containerW, setContainerW] = useState(0);

  const marksRef = useRef([]);
  const [, forceRender] = useState(0);
  const overlayRefs = useRef([]);
  const drawing = useRef(false);
  const scrollRef = useRef(null);
  const pinchRef = useRef(null); // { startDist, startZoom }
  const urlsRef = useRef([]);    // page blob object-URLs to revoke on cleanup

  // ── Load + render every page PROGRESSIVELY ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setTotal(0);
    setError(false);
    setZoom(1);
    // Revoke any URLs from a previous document before loading the next.
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    (async () => {
      try {
        const buffer = await (await fetch(src)).arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: buffer, isEvalSupported: false }).promise;
        if (cancelled) return;
        setTotal(pdf.numPages);
        marksRef.current = Array.from({ length: pdf.numPages }, () => []);
        setPages([]); // switch from "Loading…" to the (empty, filling) column

        // Crisp on high-DPI without ballooning memory for a long document.
        const scale = Math.min(2, (window.devicePixelRatio || 1) * 1.3);
        for (let p = 1; p <= pdf.numPages; p++) {
          if (cancelled) return;
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          // Encode ONCE to a Blob object-URL (not a base64 data URL): a blob is
          // far cheaper for the browser to hold and paint than a multi-MB base64
          // string, which is what made rendering/scroll heavy on big pages.
          const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
          if (cancelled) { return; }
          const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/jpeg", 0.8);
          if (blob) urlsRef.current.push(url);
          const pageObj = { canvas, url, width: canvas.width, height: canvas.height };
          // Append so page 1 shows immediately, then the rest stream in.
          setPages((prev) => (prev ? [...prev, pageObj] : [pageObj]));
          // Yield to the event loop between pages so the UI stays responsive
          // (scroll/tap) while a long document is still rendering.
          await new Promise((r) => setTimeout(r, 0));
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      urlsRef.current = [];
    };
  }, [src]);

  useEffect(() => {
    function onKey(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Measure the viewport width so zoom is relative to fit-width ─────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.clientWidth);
    measure();
    let ro;
    if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => ro?.disconnect();
  }, [pages !== null]);

  // ── Zoom: ctrl/⌘+wheel (desktop & trackpad pinch) and two-finger pinch ──────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function onWheel(e) {
      // Trackpad pinch arrives as ctrlKey+wheel; ctrl/⌘+wheel is the mouse zoom.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setZoom((z) => clampZoom(z * factor));
    }
    function dist(t) {
      const [a, b] = t;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function onTouchStart(e) {
      if (e.touches.length === 2) pinchRef.current = { startDist: dist(e.touches) || 1, startZoom: zoom };
    }
    function onTouchMove(e) {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault(); // stop native scroll while pinching
        setZoom(clampZoom(pinchRef.current.startZoom * (dist(e.touches) / pinchRef.current.startDist)));
      }
    }
    function onTouchEnd(e) {
      if (e.touches.length < 2) pinchRef.current = null;
    }

    // Non-passive so preventDefault actually suppresses the browser's own zoom/scroll.
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [zoom, pages !== null]);

  function clampZoom(z) { return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)); }
  const zoomBy = (f) => setZoom((z) => clampZoom(z * f));

  // Fit-width base (minus padding), capped so a page isn't absurdly wide on
  // desktop; zoom multiplies it and the column scrolls when it overflows.
  const baseW = Math.min((containerW || 800) - 28, 900);
  const pageW = Math.round(baseW * zoom);

  // ── Edit overlay painting ───────────────────────────────────────────────────
  function repaintOverlay(pageIndex) {
    const canvas = overlayRefs.current[pageIndex];
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const mark of marksRef.current[pageIndex] || []) {
      if (mark.kind === "stroke") {
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = Math.max(2, canvas.width * 0.004);
        ctx.lineJoin = ctx.lineCap = "round";
        ctx.beginPath();
        mark.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.stroke();
      } else if (mark.kind === "text") {
        ctx.fillStyle = mark.color;
        ctx.font = `${Math.round(canvas.width * 0.04)}px sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(mark.text, mark.x, mark.y);
      }
    }
  }

  useEffect(() => {
    if (mode === "edit" && pages) pages.forEach((_, i) => repaintOverlay(i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pages]);

  function toCanvasPoint(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  async function onPointerDown(pageIndex, event) {
    if (mode !== "edit") return;
    const canvas = overlayRefs.current[pageIndex];
    const point = toCanvasPoint(canvas, event);
    if (tool === "text") {
      const text = await promptFn("Text:");
      if (text && text.trim()) {
        marksRef.current[pageIndex].push({ kind: "text", x: point.x, y: point.y, text: text.trim(), color });
        repaintOverlay(pageIndex);
      }
      return;
    }
    drawing.current = true;
    marksRef.current[pageIndex].push({ kind: "stroke", color, points: [point] });
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(pageIndex, event) {
    if (!drawing.current || mode !== "edit" || tool !== "pen") return;
    const canvas = overlayRefs.current[pageIndex];
    const marks = marksRef.current[pageIndex];
    marks[marks.length - 1].points.push(toCanvasPoint(canvas, event));
    repaintOverlay(pageIndex);
  }

  function onPointerUp() { drawing.current = false; }

  function undo() {
    for (let i = marksRef.current.length - 1; i >= 0; i--) {
      if (marksRef.current[i].length) {
        marksRef.current[i].pop();
        repaintOverlay(i);
        forceRender((n) => n + 1);
        return;
      }
    }
  }

  const hasMarks = marksRef.current.some((list) => list && list.length);

  async function exportEdited() {
    setExporting(true);
    try {
      const flattened = pages.map((page, pageIndex) => {
        const out = document.createElement("canvas");
        out.width = page.width;
        out.height = page.height;
        const ctx = out.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(page.canvas, 0, 0);
        for (const mark of marksRef.current[pageIndex] || []) {
          if (mark.kind === "stroke") {
            ctx.strokeStyle = mark.color;
            ctx.lineWidth = Math.max(2, out.width * 0.004);
            ctx.lineJoin = ctx.lineCap = "round";
            ctx.beginPath();
            mark.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
            ctx.stroke();
          } else if (mark.kind === "text") {
            ctx.fillStyle = mark.color;
            ctx.font = `${Math.round(out.width * 0.04)}px sans-serif`;
            ctx.textBaseline = "top";
            ctx.fillText(mark.text, mark.x, mark.y);
          }
        }
        return out;
      });
      const pdfBlob = await canvasesToPdfBlob(flattened, 0.85);
      const url = URL.createObjectURL(pdfBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `edited-${name || "document.pdf"}`.replace(/(\.pdf)?$/i, ".pdf");
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast && toast("Saved edited PDF");
      setMode("view");
    } catch {
      toast && toast("Could not export the PDF");
    } finally {
      setExporting(false);
    }
  }

  const rendering = pages !== null && total > 0 && pages.length < total;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#1e1e1e", zIndex: 1300, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
        background: G.surface, borderBottom: `1px solid ${G.border}`, flexShrink: 0,
      }}>
        <div onClick={onClose} title="Back" style={{ cursor: "pointer", display: "flex" }}>
          {I.back(G.accent, 22)}
        </div>
        <div style={{
          flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: G.text,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{name}{rendering ? ` · ${pages.length}/${total}` : ""}</div>

        {/* Zoom controls (view mode) */}
        {mode === "view" && (
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <div onClick={() => zoomBy(1 / 1.25)} title="Zoom out" style={zoomBtn}>−</div>
            <div onClick={() => setZoom(1)} title="Reset zoom" style={{ ...zoomBtn, width: "auto", padding: "0 8px", fontSize: 12 }}>
              {Math.round(zoom * 100)}%
            </div>
            <div onClick={() => zoomBy(1.25)} title="Zoom in" style={zoomBtn}>+</div>
          </div>
        )}

        {mode === "view" ? (
          <>
            <button onClick={() => setMode("edit")} disabled={!pages || !pages.length} style={ghostBtn}>
              {I.edit ? I.edit(G.sub, 16) : null}<span>Edit</span>
            </button>
            <div onClick={onDownloadOriginal} title="Download" style={{ cursor: "pointer", display: "flex" }}>
              {I.download(G.sub, 20)}
            </div>
          </>
        ) : (
          <>
            <button onClick={() => setMode("view")} style={ghostBtn}><span>Cancel</span></button>
            <button onClick={exportEdited} disabled={exporting || !hasMarks} style={{
              ...ghostBtn, background: G.accent, color: "#fff", opacity: exporting || !hasMarks ? 0.5 : 1,
            }}>
              <span>{exporting ? "Saving…" : "Save"}</span>
            </button>
          </>
        )}
      </div>

      {/* Edit toolbar */}
      {mode === "edit" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
          background: G.surface, borderBottom: `1px solid ${G.border}`, flexShrink: 0, flexWrap: "wrap",
        }}>
          <button onClick={() => setTool("pen")} style={toolBtn(tool === "pen")}>Pen</button>
          <button onClick={() => setTool("text")} style={toolBtn(tool === "text")}>Text</button>
          <div style={{ display: "flex", gap: 6, marginLeft: 4 }}>
            {PEN_COLORS.map((c) => (
              <div key={c} onClick={() => setColor(c)} style={{
                width: 22, height: 22, borderRadius: "50%", background: c, cursor: "pointer",
                border: color === c ? `2px solid ${G.text}` : `2px solid ${G.border}`,
              }}/>
            ))}
          </div>
          <button onClick={undo} disabled={!hasMarks} style={{ ...toolBtn(false), marginLeft: "auto", opacity: hasMarks ? 1 : 0.5 }}>
            Undo
          </button>
        </div>
      )}

      {/* Pages — scrollable both axes; pinch / wheel / buttons zoom */}
      <div ref={scrollRef} style={{
        flex: 1, overflow: "auto", background: "#1e1e1e", WebkitOverflowScrolling: "touch",
        // Allow one-finger pan/scroll but hand two-finger pinch to our zoom
        // handler instead of letting the WebView zoom the whole page (which is
        // why pinch "did nothing" before).
        touchAction: "pan-x pan-y",
      }}>
        {error && <div style={{ color: "#fff", textAlign: "center", marginTop: 40 }}>Could not open this PDF.</div>}
        {pages === null && !error && <div style={{ color: "#fff", textAlign: "center", marginTop: 40 }}>Loading…</div>}
        {pages !== null && (
          <div style={{ width: "max-content", minWidth: "100%", margin: "0 auto", padding: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            {pages.map((page, index) => (
              <div key={index} style={{ position: "relative", width: pageW, maxWidth: "none", boxShadow: "0 2px 12px #0006", flexShrink: 0 }}>
                <img src={page.url} alt={`Page ${index + 1}`}
                     style={{ width: "100%", display: "block", background: "#fff" }}/>
                {mode === "edit" && (
                  <canvas
                    ref={(el) => { overlayRefs.current[index] = el; }}
                    width={page.width} height={page.height}
                    onPointerDown={(e) => onPointerDown(index, e)}
                    onPointerMove={(e) => onPointerMove(index, e)}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    style={{
                      position: "absolute", inset: 0, width: "100%", height: "100%",
                      touchAction: "none", cursor: tool === "text" ? "text" : "crosshair",
                    }}/>
                )}
              </div>
            ))}
            {rendering && (
              <div style={{ color: "#ffffff99", fontSize: 12, padding: "6px 0 14px" }}>Rendering pages…</div>
            )}
          </div>
        )}
      </div>
      {promptModal}
    </div>
  );
}

const ghostBtn = {
  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 16,
  cursor: "pointer", fontSize: 13, fontWeight: 600, color: G.text,
  background: G.dim, border: "none",
};

const zoomBtn = {
  width: 30, height: 30, borderRadius: 8, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 18, color: G.text, background: G.dim, userSelect: "none",
};

function toolBtn(active) {
  return {
    padding: "6px 14px", borderRadius: 14, cursor: "pointer", fontSize: 13,
    fontWeight: active ? 600 : 400, color: active ? G.accentText : G.text,
    background: active ? G.accentSoft : G.dim, border: `1px solid ${active ? G.accent : G.border}`,
  };
}
