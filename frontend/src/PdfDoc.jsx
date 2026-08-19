// In-app PDF viewer AND lightweight editor, built on pdf.js. This is loaded
// lazily (React.lazy in ChatView) so pdf.js — a heavy dependency — lands in
// its own chunk and never weighs down the initial app load.
//
// Viewing: every page is rasterised to a canvas via pdf.js and shown in a
// scrollable column. This is the ONLY way a PDF renders reliably inside
// Android's System WebView, which has no native PDF plugin.
//
// Editing: a transparent overlay canvas sits on each page for freehand pen
// strokes and tap-to-place text — the same "marks over pixels" idea the photo
// editor uses. Exporting flattens each page canvas + its marks into a fresh
// image and rewraps the lot into a new multi-page PDF (canvasesToPdfBlob), so
// no PDF-mutation library is needed.

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
// The non-minified worker (pdf.worker.mjs, not .min) so this shipped file is
// human-readable too, consistent with the rest of the un-minified build.
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { canvasesToPdfBlob } from "./imageToPdf.js";
import { G, I, usePrompt } from "./ui.jsx";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const PEN_COLORS = ["#ff3b30", "#0a84ff", "#111111", "#34c759", "#ffcc00"];

export default function PdfDoc({ src, name, onClose, onDownloadOriginal, toast }) {
  const [promptFn, promptModal] = usePrompt();
  const [pages, setPages] = useState(null); // [{ canvas, width, height }]
  const [error, setError] = useState(false);
  const [mode, setMode] = useState("view"); // "view" | "edit"
  const [tool, setTool] = useState("pen"); // "pen" | "text"
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [exporting, setExporting] = useState(false);
  // marks[pageIndex] = [{ kind:"stroke", points:[{x,y}], color } | { kind:"text", x,y,text,color }]
  const marksRef = useRef([]);
  const [, forceRender] = useState(0);
  const overlayRefs = useRef([]);
  const drawing = useRef(false);

  // Render every page to a canvas once, at a resolution that stays crisp on
  // high-DPI screens without ballooning memory for a long document.
  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(false);
    (async () => {
      try {
        // Fetch the bytes ourselves and hand them to pdf.js as `data` rather
        // than letting it fetch the blob: URL — keeps everything same-origin
        // and predictable under the app's CSP. isEvalSupported:false skips
        // pdf.js's eval feature-probe, which script-src 'self' would otherwise
        // block with a noisy console error.
        const buffer = await (await fetch(src)).arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: buffer, isEvalSupported: false }).promise;
        const out = [];
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
          out.push({ canvas, width: canvas.width, height: canvas.height });
        }
        if (!cancelled) {
          marksRef.current = out.map(() => []);
          setPages(out);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    function onKey(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Repaint one page's overlay from its stored marks.
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

  // Map a pointer event to the overlay canvas's own pixel space.
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

  return (
    <div style={{ position: "fixed", inset: 0, background: "#1e1e1e", zIndex: 1300, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
        background: G.surface, borderBottom: `1px solid ${G.border}`, flexShrink: 0,
      }}>
        <div onClick={onClose} title="Back" style={{ cursor: "pointer", display: "flex" }}>
          {I.back(G.accent, 22)}
        </div>
        <div style={{
          flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: G.text,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{name}</div>
        {mode === "view" ? (
          <>
            <button onClick={() => setMode("edit")} disabled={!pages} style={ghostBtn}>
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

      {/* Pages */}
      <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        {error && <div style={{ color: "#fff", marginTop: 40 }}>Could not open this PDF.</div>}
        {!pages && !error && <div style={{ color: "#fff", marginTop: 40 }}>Loading…</div>}
        {pages && pages.map((page, index) => (
          <div key={index} style={{ position: "relative", width: "100%", maxWidth: 820, boxShadow: "0 2px 12px #0006" }}>
            <img src={page.canvas.toDataURL("image/png")} alt={`Page ${index + 1}`}
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

function toolBtn(active) {
  return {
    padding: "6px 14px", borderRadius: 14, cursor: "pointer", fontSize: 13,
    fontWeight: active ? 600 : 400, color: active ? G.accentText : G.text,
    background: active ? G.accentSoft : G.dim, border: `1px solid ${active ? G.accent : G.border}`,
  };
}
