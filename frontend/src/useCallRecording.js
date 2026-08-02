import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Records a group call entirely client-side — nothing is ever sent to the
 * server or stored anywhere but the browser doing the recording. Every
 * participant's video is drawn into a grid on a canvas each frame; every
 * participant's audio (yours plus everyone else's already-decoded remote
 * audio) is mixed into one track via the Web Audio API. Both feed a single
 * MediaRecorder, which is downloaded as one .webm file the moment you stop.
 *
 * This is the honest scope of "recording" a browser app can do without a
 * server-side media pipeline: whoever hits Stop gets a file on their own
 * device, there's no shared/cloud recording every participant can later
 * fetch — that would mean routing every stream through a server, a much
 * bigger project than this pass covers.
 */
export function useCallRecording(call) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const canvasRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const rafRef = useRef(null);
  const videoElsRef = useRef({});
  const audioCtxRef = useRef(null);
  const timerRef = useRef(null);
  const callRef = useRef(call);
  callRef.current = call;

  function videoElFor(key, stream) {
    let el = videoElsRef.current[key];
    if (!el) {
      el = document.createElement("video");
      el.autoplay = true;
      el.muted = true;
      el.playsInline = true;
      videoElsRef.current[key] = el;
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    return el;
  }

  function drawFrame() {
    const canvas = canvasRef.current;
    const current = callRef.current;
    if (!canvas || !current) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const entries = [];
    if (current.localStream) entries.push(["me", current.localStream]);
    Object.entries(current.participants || {}).forEach(([id, p]) => {
      if (p.stream) entries.push([id, p.stream]);
    });

    const count = Math.max(entries.length, 1);
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cellW = canvas.width / cols;
    const cellH = canvas.height / rows;

    entries.forEach(([key, stream], i) => {
      const video = videoElFor(key, stream);
      if (!video.videoWidth) return; // voice-only or not yet decoding a frame
      const col = i % cols;
      const row = Math.floor(i / cols);
      ctx.drawImage(video, col * cellW, row * cellH, cellW, cellH);
    });

    rafRef.current = requestAnimationFrame(drawFrame);
  }

  const start = useCallback(() => {
    if (recorderRef.current) return;
    const current = callRef.current;
    if (!current) return;

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    canvasRef.current = canvas;
    drawFrame();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    audioCtxRef.current = audioCtx;
    const dest = audioCtx.createMediaStreamDestination();
    const allStreams = [
      current.localStream,
      ...Object.values(current.participants || {}).map((p) => p.stream),
    ].filter(Boolean);
    allStreams.forEach((stream) => {
      if (stream.getAudioTracks().length === 0) return;
      try {
        audioCtx.createMediaStreamSource(stream).connect(dest);
      } catch {
        // A track already routed through another source node in this
        // context, or one that Web Audio can't source — skipped rather
        // than failing the whole recording over one participant's audio.
      }
    });

    const canvasStream = canvas.captureStream(30);
    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const recorder = new MediaRecorder(combined, { mimeType: "video/webm" });
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `talkex-meeting-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  }, []);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    audioCtxRef.current = null;
    Object.values(videoElsRef.current).forEach((el) => { el.srcObject = null; });
    videoElsRef.current = {};
    clearInterval(timerRef.current);
    setRecording(false);
  }, []);

  // A call ending (leave/kicked/host ends it) must not leave a recorder
  // running forever in the background — same reasoning as any other cleanup
  // tied to the call's own lifetime, not the component's.
  useEffect(() => {
    if (!call && recorderRef.current) stop();
  }, [call, stop]);

  useEffect(() => stop, [stop]);

  return { recording, elapsed, start, stop };
}
