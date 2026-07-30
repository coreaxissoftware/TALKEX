import { useCallback, useRef, useState } from "react";

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
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        releaseStream();
        // A cancel clears chunks before stopping, so an empty buffer here
        // means "throw it away," not "send a silent recording."
        if (chunks.current.length > 0) {
          const blob = new Blob(chunks.current, { type: instance.mimeType || "audio/webm" });
          onFinishedRef.current?.(blob);
        }
        chunks.current = [];
        setState("idle");
        setSeconds(0);
      };

      recorder.current = instance;
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
    chunks.current = [];       // onstop sees an empty buffer and discards
    if (recorder.current?.state === "recording") recorder.current.stop();
    else { releaseStream(); setState("idle"); setSeconds(0); }
  }, [releaseStream]);

  return { state, seconds, error, start, stop, cancel };
}
