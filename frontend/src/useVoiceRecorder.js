import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Records a voice note with MediaRecorder.
 *
 * Kept as a hook rather than inline in the composer because the cleanup rules
 * are easy to get wrong: every started stream's tracks must be stopped again
 * (`getUserMedia` leaves the mic's in-use indicator lit otherwise), and that
 * has to happen on stop, on cancel, AND on unmount if the component goes away
 * mid-recording.
 */
export function useVoiceRecorder(onFinished) {
  const [state, setState] = useState("idle");   // idle | recording | error
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");

  const recorder = useRef(null);
  const chunks = useRef([]);
  const stream = useRef(null);
  const timer = useRef(null);
  // Set by cancel() so onstop knows to discard. A plain "clear chunks before
  // stop()" is NOT enough: stop() flushes one last ondataavailable BEFORE
  // onstop fires, which repopulates the buffer — that final chunk is exactly
  // why a cancelled recording used to still get sent.
  const cancelled = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const releaseStream = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    clearInterval(timer.current);
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("error");
      setError("Voice recording is not supported in this browser");
      return;
    }

    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      chunks.current = [];

      const instance = new MediaRecorder(media);
      instance.ondataavailable = (event) => {
        if (cancelled.current) return;                 // dropping this recording
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        releaseStream();
        // Only hand the blob to the caller when this wasn't a cancel — the
        // flag is the source of truth, not the buffer length (see cancelled).
        if (!cancelled.current && chunks.current.length > 0) {
          const blob = new Blob(chunks.current, { type: instance.mimeType || "audio/webm" });
          onFinishedRef.current?.(blob);
        }
        chunks.current = [];
        cancelled.current = false;
        setState("idle");
        setSeconds(0);
      };

      recorder.current = instance;
      cancelled.current = false;
      instance.start();
      setState("recording");
      setSeconds(0);
      timer.current = setInterval(() => setSeconds((current) => current + 1), 1000);
    } catch (problem) {
      // Covers both "permission denied" and "no microphone" — getUserMedia
      // throws the same DOMException shape for either.
      setState("error");
      setError(problem.name === "NotAllowedError"
        ? "Microphone permission was denied"
        : "No microphone is available");
      releaseStream();
    }
  }, [releaseStream]);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;  // onstop discards regardless of the final chunk
    chunks.current = [];
    if (recorder.current?.state === "recording") recorder.current.stop();
    else { releaseStream(); setState("idle"); setSeconds(0); }
  }, [releaseStream]);

  // The docstring above already says this has to happen on unmount too —
  // it just never did. Without it, navigating away mid-recording (tapping
  // back to the chat list) leaves the MediaRecorder running: the mic stays
  // captured (browser mic-in-use indicator stuck on) and the seconds timer
  // keeps firing setState on a hook instance nothing renders anymore, for
  // the rest of the page's life.
  useEffect(() => cancel, [cancel]);

  return { state, seconds, error, start, stop, cancel };
}
