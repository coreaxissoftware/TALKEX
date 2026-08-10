import { useEffect, useRef, useState } from "react";
import { I } from "./ui.jsx";

/**
 * A real in-app camera — live getUserMedia preview with its own shutter and
 * record controls, rather than an `<input type="file" capture>`. That
 * attribute is only ever a HINT: desktop browsers ignore it outright, and
 * plenty of mobile browser/OS combinations honor it by showing the ordinary
 * gallery/file chooser instead of actually opening the camera. This is the
 * only way to guarantee the camera itself opens on click.
 */
export default function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const [facing, setFacing] = useState("environment");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  // Bumped by the Retry button (below) to force the getUserMedia effect
  // to re-run without needing to change `facing`. Without it, a person who
  // hit "Deny" on the OS permission dialog by mistake had no way back —
  // the error string just sat there forever and the only escape was
  // closing the camera and reopening the whole sheet.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: true,
        });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setError("");
      } catch (problem) {
        if (!cancelled) {
          setError(problem.name === "NotAllowedError"
            ? "Camera access was denied. Grant camera + microphone permission from your device settings and try again."
            : "Could not open the camera.");
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facing, retryTick]);

  function takePhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  }

  function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (!streamRef.current) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(streamRef.current);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      setRecording(false);
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      onCapture(new File([blob], `video-${Date.now()}.webm`, { type: "video/webm" }));
    };
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 80,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
        <div onClick={onClose} style={{ cursor: "pointer" }}>{I.back("#fff", 24)}</div>
        <div onClick={() => setFacing((current) => (current === "environment" ? "user" : "environment"))}
             title="Flip camera" style={{ cursor: "pointer" }}>
          {I.rotateRight("#fff", 22)}
        </div>
      </div>

      <div style={{
        flex: 1, minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {error ? (
          <div style={{ color: "#fff", fontSize: 14, textAlign: "center", padding: 24, maxWidth: 320 }}>
            {error}
            <div onClick={() => { setError(""); setRetryTick((n) => n + 1); }} style={{
              marginTop: 18, padding: "10px 20px", borderRadius: 22, background: "#ffffff22",
              border: "1px solid #ffffff44", display: "inline-block", cursor: "pointer",
              fontSize: 14, fontWeight: 600,
            }}>
              Try again
            </div>
          </div>
        ) : (
          <video ref={videoRef} playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 28,
        padding: "20px 20px 32px",
      }}>
        <div onClick={toggleRecording} title={recording ? "Stop recording" : "Record a video"}
             style={{
               width: 52, height: 52, borderRadius: "50%",
               border: `3px solid ${recording ? "#ef4444" : "#ffffffcc"}`,
               display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
             }}>
          {recording && <div style={{ width: 16, height: 16, borderRadius: 4, background: "#ef4444" }}/>}
        </div>
        <div onClick={takePhoto} title="Take photo" style={{
          width: 70, height: 70, borderRadius: "50%", background: "#fff",
          border: "4px solid #ffffff66", cursor: "pointer",
        }}/>
      </div>
    </div>
  );
}
