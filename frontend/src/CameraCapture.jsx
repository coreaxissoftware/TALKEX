import { useEffect, useRef, useState, useCallback } from "react";
import { ensurePermissions } from "./nativePermissions.js";
import { galleryAvailable, listMedia, mediaSrc, itemToFile } from "./nativeGallery.js";

/**
 * A full, WhatsApp-style in-app camera built on getUserMedia — a live preview
 * with its own shutter, PHOTO/VIDEO modes, flash (torch), flip, pinch/slider
 * zoom, a self-timer, a framing grid and a gallery shortcut.
 *
 * Why getUserMedia and not `<input capture>`: that attribute is only ever a
 * HINT — desktops ignore it, and many mobile browser/WebView combos honour it
 * by opening the gallery instead of the camera. A live stream is the only way
 * to guarantee the camera itself opens and to offer flash/zoom/modes.
 *
 * BUT getUserMedia can genuinely fail (WebView without camera permission, no
 * device, denied prompt). That's the "camera doesn't open at all" case, so on
 * any failure we fall back to the OS camera via a real `<input capture>` — the
 * user still gets a photo/video, just through the system camera app.
 *
 * Gestures (WhatsApp parity):
 *   • PHOTO mode: tap shutter = photo; press-and-hold = record video, release
 *     = stop. Drag the finger up while holding to zoom in.
 *   • VIDEO mode: tap shutter = start, tap again = stop.
 */
export default function CameraCapture({ onCapture, onClose, onGallery }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const galleryInputRef = useRef(null);
  const fallbackInputRef = useRef(null);

  const [facing, setFacing] = useState("environment");
  const [mode, setMode] = useState("photo"); // "photo" | "video"
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const [error, setError] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  const [flashOn, setFlashOn] = useState(false);
  const [needsTap, setNeedsTap] = useState(false); // WebView truly won't autoplay — show a start overlay
  const [ready, setReady] = useState(false);       // true once the live preview is actually playing
  const [recent, setRecent] = useState([]);        // recent device media for the gallery strip (native)

  // Load a few recent photos/videos for the WhatsApp-style gallery strip.
  useEffect(() => {
    if (!galleryAvailable()) return;
    let cancelled = false;
    listMedia({ limit: 18 }).then((items) => { if (!cancelled && items) setRecent(items); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function pickRecent(item) {
    try {
      const file = await itemToFile(item);
      if (onGallery) onGallery([file]); else onCapture(file);
    } catch { /* skip unreadable item */ }
  }
  const [showGrid, setShowGrid] = useState(false);
  const [selfTimer, setSelfTimer] = useState(0); // 0 | 3 | 10 seconds
  const [countdown, setCountdown] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [zoomCaps, setZoomCaps] = useState(null); // {min,max,step} or null
  const [torchCap, setTorchCap] = useState(false);

  // ── Live stream lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function start() {
      // Fully release any previous stream before opening the next (flip / retry).
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // On native Android, ask for camera + mic FIRST — the WebView's
      // getUserMedia can otherwise reject with no popup when they aren't
      // granted yet, which looks like "the camera doesn't work". No-op on web.
      try { await ensurePermissions(["camera", "microphone"]); } catch { /* fall through to getUserMedia */ }
      setNeedsTap(false);
      setReady(false);
      try {
        // Keep constraints SIMPLE — an over-specified request (a fixed 1080p, a
        // hard facingMode) makes some phone cameras hand back a black/frozen
        // frame that looks like "the camera doesn't work". Ask only for the
        // facing side as a preference and let the device pick a good size.
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: true });
        } catch (withAudio) {
          if (withAudio && withAudio.name === "NotAllowedError") throw withAudio;
          // Some devices fail the combined audio+video grab — retry video-only so
          // the preview still opens (a recording just won't carry sound).
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } } });
        }
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        // Discover what this camera actually supports (varies wildly by device).
        let caps = {};
        try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch { /* older WebView */ }
        setTorchCap(!!caps.torch);
        if (caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > (caps.zoom.min || 1)) {
          setZoomCaps({ min: caps.zoom.min || 1, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
        } else {
          setZoomCaps(null);
        }
        setZoom(1);
        setFlashOn(false);

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // Some Android WebViews take a few seconds to actually start rendering
          // a MediaStream <video>. A "Starting camera…" overlay (below) covers
          // the frozen poster meanwhile; here we keep nudging play() until it
          // runs (onPlaying flips `ready`), and only fall back to a one-tap
          // "start" overlay if it's still stuck after a long wait (~8s).
          for (let i = 0; i < 32 && !cancelled; i++) {
            try { await video.play(); } catch { /* keep retrying */ }
            if (!video.paused) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          if (!cancelled && video.paused) setNeedsTap(true);
        }
        setError("");
      } catch (problem) {
        if (cancelled) return;
        setError(
          problem && problem.name === "NotAllowedError"
            ? "Camera access was denied. Allow camera + microphone in your device settings, or use the device camera below."
            : "Couldn't open the in-app camera on this device. Use the device camera instead."
        );
      }
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing, retryTick]);

  // ── Recording timer ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!recording) { setRecordSecs(0); return; }
    const id = setInterval(() => setRecordSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  // ── Torch / flash ────────────────────────────────────────────────────────────
  const applyTorch = useCallback(async (on) => {
    const track = trackRef.current;
    if (!track || !torchCap) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      setFlashOn(on);
    } catch { /* some devices reject torch mid-stream */ }
  }, [torchCap]);

  // ── Zoom ─────────────────────────────────────────────────────────────────────
  const applyZoom = useCallback((z) => {
    const track = trackRef.current;
    if (!track || !zoomCaps) return;
    const clamped = Math.max(zoomCaps.min, Math.min(zoomCaps.max, z));
    setZoom(clamped);
    try { track.applyConstraints({ advanced: [{ zoom: clamped }] }); } catch { /* ignore */ }
  }, [zoomCaps]);

  // ── Capture: photo ───────────────────────────────────────────────────────────
  const grabPhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    // Front camera preview is mirrored for the user; flip the capture back so
    // the saved photo matches what a normal camera would produce (not mirrored).
    if (facing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  }, [facing, onCapture]);

  const takePhoto = useCallback(() => {
    if (selfTimer > 0) {
      let n = selfTimer;
      setCountdown(n);
      const id = setInterval(() => {
        n -= 1;
        if (n <= 0) { clearInterval(id); setCountdown(null); grabPhoto(); }
        else setCountdown(n);
      }, 1000);
    } else {
      grabPhoto();
    }
  }, [selfTimer, grabPhoto]);

  // ── Capture: video ───────────────────────────────────────────────────────────
  function pickMime() {
    // WebM (VP8/VP9 + Opus) is the most reliably recordable format inside a
    // Chromium WebView; mp4 recording is patchy there and often yields a
    // zero-byte or unplayable file, which is exactly the "recording issue".
    // So prefer WebM and only fall back to mp4 if that's somehow all there is.
    const wanted = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
      "video/mp4",
    ];
    for (const m of wanted) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
    }
    return "";
  }

  const startRecording = useCallback(() => {
    if (recording || !streamRef.current) return;
    chunksRef.current = [];
    let recorder;
    try {
      const mime = pickMime();
      recorder = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined);
    } catch {
      return; // MediaRecorder unsupported — the shutter just won't record here
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      setRecording(false);
      const type = recorder.mimeType || "video/webm";
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunksRef.current, { type });
      if (blob.size > 0) onCapture(new File([blob], `video-${Date.now()}.${ext}`, { type }));
    };
    // A timeslice makes ondataavailable fire periodically instead of only once
    // at stop — more robust on WebViews that otherwise drop the single final
    // chunk, and it means a very short clip still has data to save.
    recorder.start(250);
    recorderRef.current = recorder;
    setRecording(true);
  }, [recording, onCapture]);

  const stopRecording = useCallback(() => {
    const r = recorderRef.current;
    if (!r) return;
    try { if (r.state !== "inactive") { r.requestData?.(); r.stop(); } } catch { /* already stopped */ }
  }, []);

  // ── Shutter gesture (tap = photo, hold = video in photo mode) ────────────────
  const holdTimer = useRef(null);
  const pressInfo = useRef(null); // { startY, zoomAtStart, becameVideo }

  function onShutterDown(e) {
    e.preventDefault();
    // Capture the pointer so move/up keep firing on the shutter even if the
    // finger drifts off it mid-gesture — without this a hold-to-record whose
    // finger wandered never received pointerup, so recording never stopped.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (mode === "video") { return; } // handled on up as a toggle
    pressInfo.current = { startY: e.clientY, zoomAtStart: zoom, becameVideo: false };
    holdTimer.current = setTimeout(() => {
      if (pressInfo.current) pressInfo.current.becameVideo = true;
      startRecording();
    }, 320);
  }
  function onShutterMove(e) {
    if (!pressInfo.current || !pressInfo.current.becameVideo || !zoomCaps) return;
    // Drag up to zoom in while press-recording, like WhatsApp.
    const dy = pressInfo.current.startY - e.clientY;
    const span = zoomCaps.max - zoomCaps.min;
    applyZoom(pressInfo.current.zoomAtStart + (dy / 200) * span);
  }
  function onShutterUp() {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (mode === "video") {
      if (recording) stopRecording(); else startRecording();
      return;
    }
    if (pressInfo.current?.becameVideo) {
      stopRecording();
    } else {
      takePhoto();
    }
    pressInfo.current = null;
  }

  function flipCamera() {
    if (recording) return;
    if (flashOn) applyTorch(false);
    setFacing((c) => (c === "environment" ? "user" : "environment"));
  }

  // ── Pinch-to-zoom on the preview ─────────────────────────────────────────────
  const pinch = useRef({ pointers: new Map(), startDist: 0, zoomAtStart: 1 });
  const swipeRef = useRef(null); // single-finger horizontal swipe → switch photo/video
  function onPreviewDown(e) {
    pinch.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.pointers.size === 2) {
      const [a, b] = [...pinch.current.pointers.values()];
      pinch.current.startDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinch.current.zoomAtStart = zoom;
      swipeRef.current = null; // a pinch is not a swipe
    } else if (pinch.current.pointers.size === 1) {
      swipeRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    }
  }
  function onPreviewMove(e) {
    if (!pinch.current.pointers.has(e.pointerId)) return;
    pinch.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.pointers.size === 2 && pinch.current.startDist > 0 && zoomCaps) {
      const [a, b] = [...pinch.current.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      applyZoom(pinch.current.zoomAtStart * (dist / pinch.current.startDist));
    }
  }
  function onPreviewUp(e) {
    const sw = swipeRef.current;
    pinch.current.pointers.delete(e.pointerId);
    if (pinch.current.pointers.size < 2) pinch.current.startDist = 0;
    // A clear single-finger horizontal swipe flips photo ⇄ video (WhatsApp-
    // style), unless a recording is in progress.
    if (sw && sw.id === e.pointerId && !recording) {
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        setMode((m) => (m === "photo" ? "video" : "photo"));
      }
    }
    swipeRef.current = null;
  }

  function fmt(s) {
    const m = Math.floor(s / 60), r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  // ── Inline SVG icons (self-contained so the camera never depends on ui.jsx) ──
  const ic = {
    close: <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>,
    flip: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5V3L8 7l4 4V8a5 5 0 0 1 5 5"/><path d="M12 19v2l4-4-4-4v3a5 5 0 0 1-5-5"/></svg>,
    flashOn: <svg width="24" height="24" viewBox="0 0 24 24" fill="#ffd43b" stroke="#ffd43b" strokeWidth="1.5" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>,
    flashOff: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/><path d="M2 2l20 20"/></svg>,
    grid: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>,
    timer: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>,
    gallery: <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-5-5L5 21"/></svg>,
  };

  const controlBtn = {
    width: 42, height: 42, borderRadius: "50%", background: "#00000055",
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 90, display: "flex", flexDirection: "column", userSelect: "none" }}>
      {/* Hidden inputs: gallery (multi) and OS-camera fallback */}
      <input ref={galleryInputRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }}
             onChange={(e) => {
               const files = Array.from(e.target.files || []);
               e.target.value = "";
               if (files.length) (onGallery || ((fs) => fs.forEach(onCapture)))(files);
             }}/>
      <input ref={fallbackInputRef} type="file" accept={mode === "video" ? "video/*" : "image/*"} capture="environment" style={{ display: "none" }}
             onChange={(e) => {
               const f = e.target.files?.[0];
               e.target.value = "";
               if (f) onCapture(f);
             }}/>

      {error ? (
        // ── Fallback screen: in-app camera unavailable ──
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28 }}>
          <div onClick={onClose} style={{ position: "absolute", top: 14, left: 14, ...controlBtn }}>{ic.close}</div>
          <div style={{ color: "#fff", fontSize: 14.5, textAlign: "center", lineHeight: 1.5, maxWidth: 320 }}>{error}</div>
          <div style={{ display: "flex", gap: 12, marginTop: 22, flexWrap: "wrap", justifyContent: "center" }}>
            <button onClick={() => fallbackInputRef.current?.click()} style={{
              padding: "12px 22px", borderRadius: 24, background: "#25d366", color: "#04180d",
              border: "none", fontSize: 14.5, fontWeight: 700, cursor: "pointer",
            }}>Use device camera</button>
            <button onClick={() => galleryInputRef.current?.click()} style={{
              padding: "12px 22px", borderRadius: 24, background: "#ffffff1f", color: "#fff",
              border: "1px solid #ffffff33", fontSize: 14.5, fontWeight: 600, cursor: "pointer",
            }}>Gallery</button>
            <button onClick={() => { setError(""); setRetryTick((n) => n + 1); }} style={{
              padding: "12px 22px", borderRadius: 24, background: "transparent", color: "#fff",
              border: "1px solid #ffffff33", fontSize: 14.5, fontWeight: 600, cursor: "pointer",
            }}>Try again</button>
          </div>
        </div>
      ) : (
        <>
          {/* Top control bar (overlays the full-screen preview) */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 4,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "calc(10px + env(safe-area-inset-top)) 14px 0",
          }}>
            <div onClick={onClose} style={controlBtn}>{ic.close}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {torchCap && facing === "environment" && (
                <div onClick={() => applyTorch(!flashOn)} style={controlBtn}>{flashOn ? ic.flashOn : ic.flashOff}</div>
              )}
              <div onClick={() => setSelfTimer((t) => (t === 0 ? 3 : t === 3 ? 10 : 0))}
                   style={{ ...controlBtn, position: "relative" }}>
                {ic.timer}
                {selfTimer > 0 && (
                  <span style={{
                    position: "absolute", bottom: -2, right: -2, background: "#25d366", color: "#04180d",
                    fontSize: 10, fontWeight: 800, borderRadius: 8, padding: "1px 4px", lineHeight: 1.2,
                  }}>{selfTimer}</span>
                )}
              </div>
              <div onClick={() => setShowGrid((g) => !g)} style={{ ...controlBtn, opacity: showGrid ? 1 : 0.6 }}>{ic.grid}</div>
            </div>
          </div>

          {/* Live preview — full-screen, edge to edge; all controls overlay on top */}
          <div style={{ position: "absolute", inset: 0, zIndex: 1, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}
               onPointerDown={onPreviewDown} onPointerMove={onPreviewMove} onPointerUp={onPreviewUp} onPointerCancel={onPreviewUp}>
            <video ref={videoRef} playsInline muted autoPlay disablePictureInPicture
              controls={false}
              onLoadedMetadata={() => videoRef.current?.play().catch(() => {})}
              onCanPlay={() => videoRef.current?.play().catch(() => {})}
              onPlaying={() => { setReady(true); setNeedsTap(false); }}
              onClick={() => { videoRef.current?.play().then(() => { setReady(true); setNeedsTap(false); }).catch(() => {}); }}
              style={{
                width: "100%", height: "100%", objectFit: "cover",
                transform: facing === "user" ? "scaleX(-1)" : "none",
                // Hide the element (and its frozen poster) until it's actually
                // playing — the loader below shows during the WebView warm-up.
                opacity: ready ? 1 : 0,
              }}/>

            {/* Warm-up loader — covers the WebView's frozen play-button poster
                for the couple of seconds before the live stream starts. */}
            {!ready && !needsTap && (
              <div style={{
                position: "absolute", inset: 0, zIndex: 2, background: "#000",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: "50%",
                  border: "3px solid #ffffff33", borderTopColor: "#fff",
                  animation: "txCamSpin 0.8s linear infinite",
                }}/>
                <div style={{ color: "#ffffffcc", fontSize: 13.5, fontWeight: 500 }}>Starting camera…</div>
              </div>
            )}

            {/* If the WebView refused to autoplay the live stream, a single tap
                (a real user gesture) always starts it — no more staring at a
                frozen play-button poster. */}
            {needsTap && (
              <div onClick={() => { videoRef.current?.play().then(() => setNeedsTap(false)).catch(() => {}); }}
                   style={{
                     position: "absolute", inset: 0, zIndex: 2, display: "flex", flexDirection: "column",
                     alignItems: "center", justifyContent: "center", gap: 12, background: "#000000aa", cursor: "pointer",
                   }}>
                <div style={{
                  width: 74, height: 74, borderRadius: "50%", border: "3px solid #fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>Tap to start camera</div>
              </div>
            )}

            {/* Rule-of-thirds grid */}
            {showGrid && (
              <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} preserveAspectRatio="none" viewBox="0 0 3 3">
                <path d="M1 0v3M2 0v3M0 1h3M0 2h3" stroke="#ffffff55" strokeWidth="0.008"/>
              </svg>
            )}

            {/* Recording pill */}
            {recording && (
              <div style={{
                position: "absolute", top: 66, left: "50%", transform: "translateX(-50%)",
                display: "flex", alignItems: "center", gap: 7, background: "#00000066",
                padding: "5px 12px", borderRadius: 20,
              }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#ef4444", animation: "txRecBlink 1s steps(2) infinite" }}/>
                <span style={{ color: "#fff", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{fmt(recordSecs)}</span>
              </div>
            )}

            {/* Self-timer countdown */}
            {countdown != null && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#00000033" }}>
                <span style={{ color: "#fff", fontSize: 96, fontWeight: 800, textShadow: "0 2px 20px #000" }}>{countdown}</span>
              </div>
            )}

            {/* Zoom slider (only when the camera reports zoom support) */}
            {zoomCaps && (
              <div style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", height: "46%", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#fff", fontSize: 12, fontWeight: 700, background: "#00000055", borderRadius: 12, padding: "2px 7px" }}>{zoom.toFixed(1)}x</span>
                <input type="range" min={zoomCaps.min} max={zoomCaps.max} step={zoomCaps.step} value={zoom}
                       onChange={(e) => applyZoom(Number(e.target.value))}
                       style={{
                         writingMode: "vertical-lr", direction: "rtl",
                         WebkitAppearance: "slider-vertical", width: 6, flex: 1, accentColor: "#25d366",
                       }}/>
              </div>
            )}
          </div>

          {/* Bottom controls overlay: mode row + shutter + gallery + flip */}
          <div style={{
            position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 4,
            padding: "10px 0 calc(20px + env(safe-area-inset-bottom))",
            background: "linear-gradient(transparent, #000000cc 45%)",
          }}>
            {/* Recent-media gallery strip (native) — tap to pick, WhatsApp-style */}
            {recent.length > 0 && !recording && (
              <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "0 12px 10px" }}>
                {recent.map((it) => (
                  <div key={it.id} onClick={() => pickRecent(it)} style={{
                    flexShrink: 0, width: 54, height: 54, borderRadius: 8, overflow: "hidden",
                    background: "#ffffff14", cursor: "pointer", position: "relative",
                  }}>
                    {it.isVideo
                      ? <video src={mediaSrc(it)} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
                      : <img src={mediaSrc(it)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>}
                    {it.isVideo && <div style={{ position: "absolute", bottom: 3, left: 4 }}><svg width="12" height="12" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>}
                  </div>
                ))}
              </div>
            )}

            {/* Quick zoom buttons (when the camera supports zoom) */}
            {zoomCaps && !recording && (
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 10 }}>
                {[1, 2, zoomCaps.max >= 4 ? 4 : null].filter(Boolean).map((z) => (
                  <div key={z} onClick={() => applyZoom(z)} style={{
                    minWidth: 34, height: 30, padding: "0 8px", borderRadius: 15, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: Math.abs(zoom - z) < 0.15 ? "#ffffff33" : "#00000055",
                    color: Math.abs(zoom - z) < 0.15 ? "#ffd43b" : "#fff", fontSize: 12, fontWeight: 700,
                  }}>{z}x</div>
                ))}
              </div>
            )}

            {/* PHOTO / VIDEO mode switch */}
            <div style={{ display: "flex", justifyContent: "center", gap: 26, marginBottom: 14 }}>
              {["photo", "video"].map((m) => (
                <span key={m} onClick={() => { if (!recording) setMode(m); }}
                      style={{
                        color: mode === m ? "#ffd43b" : "#ffffffaa", fontSize: 13, fontWeight: 700,
                        letterSpacing: 1, cursor: "pointer", textTransform: "uppercase",
                      }}>
                  {m}
                </span>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0 26px" }}>
              {/* Gallery */}
              <div onClick={() => galleryInputRef.current?.click()} style={{
                width: 46, height: 46, borderRadius: 10, background: "#ffffff1a",
                border: "1px solid #ffffff33", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              }}>{ic.gallery}</div>

              {/* Shutter */}
              <div
                onPointerDown={onShutterDown}
                onPointerMove={onShutterMove}
                onPointerUp={onShutterUp}
                onPointerCancel={onShutterUp}
                style={{
                  width: 82, height: 82, borderRadius: "50%",
                  border: `5px solid ${recording ? "#ef4444" : "#ffffff"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", touchAction: "none",
                }}>
                <div style={{
                  transition: "all .15s",
                  width: recording ? 30 : (mode === "video" ? 58 : 66),
                  height: recording ? 30 : (mode === "video" ? 58 : 66),
                  borderRadius: recording ? 8 : "50%",
                  background: mode === "video" || recording ? "#ef4444" : "#fff",
                }}/>
              </div>

              {/* Flip */}
              <div onClick={flipCamera} style={{
                width: 46, height: 46, borderRadius: "50%", background: "#ffffff1a",
                border: "1px solid #ffffff33", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", opacity: recording ? 0.4 : 1,
              }}>{ic.flip}</div>
            </div>

            <div style={{ textAlign: "center", marginTop: 12, color: "#ffffff66", fontSize: 11 }}>
              {mode === "photo" ? "Tap for photo · hold to record · swipe to switch" : "Tap to record · swipe for photo"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
