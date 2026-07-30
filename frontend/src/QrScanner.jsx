import { useEffect, useRef } from "react";
import jsQR from "jsqr";

/**
 * Live camera QR scanning, decoded frame-by-frame on a hidden canvas with
 * jsQR rather than the native BarcodeDetector API — Safari (desktop and
 * iOS) still doesn't ship BarcodeDetector, and this is exactly the kind of
 * "works on my Chrome" gap that would quietly break the feature for a chunk
 * of users. One small pure-JS dependency covers every browser getUserMedia
 * already does.
 */
export default function QrScanner({ onDecode, onError }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || doneRef.current) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(frame.data, frame.width, frame.height);
        if (result?.data) {
          doneRef.current = true;
          onDecode(result.data);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    async function start() {
      try {
        // The back camera by default — this is almost always used to scan a
        // code shown on a different device's screen, not a selfie.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        if (!cancelled) tick();
      } catch (problem) {
        if (!cancelled) {
          onError(problem.name === "NotAllowedError"
            ? "Camera access was denied."
            : "Could not open the camera.");
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{
      position: "relative", borderRadius: 16, overflow: "hidden",
      background: "#000", aspectRatio: "1", width: "100%",
    }}>
      <video ref={videoRef} playsInline muted
             style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
      <canvas ref={canvasRef} style={{ display: "none" }}/>
      {/* A plain framing guide — jsQR reads the whole frame regardless, this
          just tells a person where to hold the other screen's code steady. */}
      <div style={{
        position: "absolute", inset: "12%", border: "3px solid #ffffffb0",
        borderRadius: 18, pointerEvents: "none",
      }}/>
    </div>
  );
}
