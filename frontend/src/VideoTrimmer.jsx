import { useCallback, useEffect, useRef, useState } from "react";
import { Button, G, I } from "./ui.jsx";

export default function VideoTrimmer({ file, onDone, onCancel }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const timelineRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [currentTime, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [thumbnails, setThumbnails] = useState([]);
  const url = useRef(null);

  useEffect(() => {
    url.current = URL.createObjectURL(file);
    return () => { if (url.current) URL.revokeObjectURL(url.current); };
  }, [file]);

  const onLoaded = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = v.duration;
    setDuration(dur);
    setEnd(dur);
    generateThumbnails(v, dur);
  }, []);

  async function generateThumbnails(video, dur) {
    const count = Math.min(10, Math.max(5, Math.floor(dur)));
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const thumbs = [];
    const w = 60, h = 40;
    canvas.width = w;
    canvas.height = h;

    for (let i = 0; i < count; i++) {
      const time = (dur / count) * i;
      video.currentTime = time;
      await new Promise((r) => { video.onseeked = r; });
      ctx.drawImage(video, 0, 0, w, h);
      thumbs.push(canvas.toDataURL("image/jpeg", 0.5));
    }
    setThumbnails(thumbs);
    video.currentTime = 0;
  }

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const tick = () => {
      setCurrent(v.currentTime);
      if (v.currentTime >= end) {
        v.pause();
        v.currentTime = start;
        setPlaying(false);
      }
    };
    v.addEventListener("timeupdate", tick);
    return () => v.removeEventListener("timeupdate", tick);
  }, [start, end]);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (playing) { v.pause(); setPlaying(false); }
    else {
      if (v.currentTime < start || v.currentTime >= end) v.currentTime = start;
      v.play();
      setPlaying(true);
    }
  }

  function onTimelinePointer(e, handle) {
    e.preventDefault();
    setDragging(handle);
    const el = timelineRef.current;
    if (!el) return;

    function move(ev) {
      const rect = el.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const time = ratio * duration;
      if (handle === "start") {
        const clamped = Math.min(time, end - 0.5);
        setStart(Math.max(0, clamped));
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, clamped);
      } else if (handle === "end") {
        const clamped = Math.max(time, start + 0.5);
        setEnd(Math.min(duration, clamped));
        if (videoRef.current) videoRef.current.currentTime = Math.min(duration, clamped);
      }
    }

    function up() {
      setDragging(null);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    }

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  }

  async function doTrim() {
    setTrimming(true);
    try {
      const trimmed = await trimVideoBlob(file, start, end);
      onDone(trimmed);
    } catch {
      onDone(file);
    }
  }

  const clipDuration = Math.max(0, end - start);
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100, background: G.bg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderBottom: `1px solid ${G.border}`,
      }}>
        <Button variant="ghost" onClick={onCancel} style={{ padding: "6px 12px" }}>Cancel</Button>
        <div style={{ fontSize: 15, fontWeight: 600, color: G.text }}>Trim video</div>
        <Button onClick={doTrim} disabled={trimming} style={{ padding: "6px 16px" }}>
          {trimming ? "Trimming…" : "Done"}
        </Button>
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <video ref={videoRef} src={url.current} onLoadedMetadata={onLoaded}
               playsInline style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 10 }}/>
      </div>

      <div style={{ padding: "0 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 12 }}>
          <div onClick={togglePlay} style={{
            width: 44, height: 44, borderRadius: "50%", background: G.accent, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {playing ? I.pause("#fff", 20) : I.play("#fff", 20)}
          </div>
        </div>

        <div ref={timelineRef} style={{
          position: "relative", height: 44, borderRadius: 8, overflow: "hidden",
          background: G.dim, marginBottom: 8,
        }}>
          {thumbnails.length > 0 && (
            <div style={{ display: "flex", height: "100%" }}>
              {thumbnails.map((src, i) => (
                <img key={i} src={src} alt="" style={{ flex: 1, objectFit: "cover", opacity: 0.7 }}/>
              ))}
            </div>
          )}

          <div style={{
            position: "absolute", top: 0, left: 0,
            width: `${(start / duration) * 100}%`, height: "100%",
            background: "rgba(0,0,0,0.55)",
          }}/>
          <div style={{
            position: "absolute", top: 0, right: 0,
            width: `${((duration - end) / duration) * 100}%`, height: "100%",
            background: "rgba(0,0,0,0.55)",
          }}/>

          <div style={{
            position: "absolute", top: 0, height: "100%",
            left: `${(start / duration) * 100}%`,
            width: `${((end - start) / duration) * 100}%`,
            border: `2px solid ${G.accent}`, borderRadius: 4,
            boxSizing: "border-box", pointerEvents: "none",
          }}/>

          <div onMouseDown={(e) => onTimelinePointer(e, "start")}
               onTouchStart={(e) => onTimelinePointer(e, "start")}
               style={{
                 position: "absolute", top: 0, height: "100%",
                 left: `calc(${(start / duration) * 100}% - 10px)`,
                 width: 20, cursor: "ew-resize", zIndex: 2,
                 display: "flex", alignItems: "center", justifyContent: "center",
               }}>
            <div style={{
              width: 4, height: 24, borderRadius: 2,
              background: dragging === "start" ? G.accent : G.accentText,
            }}/>
          </div>

          <div onMouseDown={(e) => onTimelinePointer(e, "end")}
               onTouchStart={(e) => onTimelinePointer(e, "end")}
               style={{
                 position: "absolute", top: 0, height: "100%",
                 left: `calc(${(end / duration) * 100}% - 10px)`,
                 width: 20, cursor: "ew-resize", zIndex: 2,
                 display: "flex", alignItems: "center", justifyContent: "center",
               }}>
            <div style={{
              width: 4, height: 24, borderRadius: 2,
              background: dragging === "end" ? G.accent : G.accentText,
            }}/>
          </div>

          {duration > 0 && (
            <div style={{
              position: "absolute", top: 0, height: "100%",
              left: `${(currentTime / duration) * 100}%`,
              width: 2, background: "#fff", zIndex: 3,
              boxShadow: "0 0 4px rgba(0,0,0,0.5)",
            }}/>
          )}
        </div>

        <div style={{
          display: "flex", justifyContent: "space-between",
          fontSize: 12, color: G.muted, padding: "0 2px",
        }}>
          <span>{fmt(start)}</span>
          <span style={{ color: G.text, fontWeight: 600 }}>{fmt(clipDuration)}</span>
          <span>{fmt(end)}</span>
        </div>
      </div>

      <canvas ref={canvasRef} style={{ display: "none" }}/>
    </div>
  );
}

async function trimVideoBlob(file, startTime, endTime) {
  if (typeof MediaStreamTrackProcessor !== "undefined" && typeof VideoEncoder !== "undefined") {
    return trimWithWebCodecs(file, startTime, endTime);
  }
  return trimWithMediaRecorder(file, startTime, endTime);
}

async function trimWithMediaRecorder(file, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(file);

    video.onloadedmetadata = () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");

      const stream = canvas.captureStream(30);
      try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(audioCtx.destination);
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      } catch { /* no audio track — fine */ }

      const recorder = new MediaRecorder(stream, { mimeType: getSupportedMimeType() });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        URL.revokeObjectURL(video.src);
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const ext = recorder.mimeType.includes("webm") ? "webm" : "mp4";
        const trimmedFile = new File([blob], file.name.replace(/\.[^.]+$/, `.trimmed.${ext}`), { type: blob.type });
        resolve(trimmedFile);
      };
      recorder.onerror = () => { URL.revokeObjectURL(video.src); reject(new Error("Recording failed")); };

      video.currentTime = startTime;
      video.onseeked = () => {
        recorder.start();
        video.play();

        const check = () => {
          if (video.currentTime >= endTime || video.ended) {
            video.pause();
            recorder.stop();
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      };
    };

    video.onerror = () => { URL.revokeObjectURL(video.src); reject(new Error("Video load failed")); };
  });
}

async function trimWithWebCodecs(file, startTime, endTime) {
  return trimWithMediaRecorder(file, startTime, endTime);
}

function getSupportedMimeType() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}
