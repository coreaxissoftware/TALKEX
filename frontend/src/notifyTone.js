import { getAudioContext } from "./audioCtx.js";

const PRESETS = {
  default: [{ freq: 720, duration: 0.11, delay: 0 }, { freq: 980, duration: 0.13, delay: 0.09 }],
  chime: [{ freq: 587, duration: 0.14, delay: 0 }, { freq: 880, duration: 0.22, delay: 0.1 }],
  pop: [{ freq: 520, duration: 0.07, delay: 0 }],
  marimba: [
    { freq: 494, duration: 0.1, delay: 0 },
    { freq: 659, duration: 0.1, delay: 0.08 },
    { freq: 831, duration: 0.16, delay: 0.16 },
  ],
};

/** Every valid value ChatSettingsRequest.notify_tone accepts, for pickers. */
export const TONE_OPTIONS = ["default", "chime", "pop", "marimba", "none"];

/**
 * Play a chat's tone once. `tone` is whatever chat_members.notify_tone holds
 * — undefined/null/"default" all play the default preset; "none" plays
 * nothing (the chat was explicitly set silent, distinct from a muted chat,
 * which never calls this at all).
 */
export function playNotifyTone(tone) {
  if (tone === "none") return;
  const notes = PRESETS[tone] || PRESETS.default;
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  notes.forEach(({ freq, duration, delay }) => {
    const start = now + delay;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.14, start + 0.015);
    gain.gain.linearRampToValueAtTime(0, start + duration);
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + duration);
  });
}
