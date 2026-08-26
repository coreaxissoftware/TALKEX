let ctx = null;
let unlocked = false;

function ensure() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  return ctx;
}

function unlock() {
  if (unlocked) return;
  const c = ensure();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const buf = c.createBuffer(1, 1, 22050);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  src.start(0);
  unlocked = true;
}

if (typeof window !== "undefined") {
  const events = ["touchstart", "touchend", "mousedown", "click", "keydown"];
  function onInteraction() {
    unlock();
    events.forEach((e) => document.removeEventListener(e, onInteraction, true));
  }
  events.forEach((e) => document.addEventListener(e, onInteraction, true));
}

export function getAudioContext() {
  const c = ensure();
  if (c && c.state === "suspended") c.resume().catch(() => {});
  return c;
}
