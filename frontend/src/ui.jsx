import { useCallback, useEffect, useRef, useState } from "react";
import { Uploads } from "./api.js";
import {
  TEXTURES, getWallpaper, getWallpaperBlur, onWallpaperBlurChange, onWallpaperChange,
} from "./chatWallpaper.js";

// Below this width the app is the single-column, phone-shaped layout it was
// designed around. At or above it there's room for a WhatsApp-Web-style
// split view.
export const DESKTOP_QUERY = "(min-width: 900px)";

/**
 * Device-appropriate call layout: fills the real desktop viewport (and asks
 * the browser for true fullscreen, Zoom/Meet-style) on web, stays the
 * existing single-column phone layout on a phone — where the viewport IS
 * already that width, so there's nothing to expand into. `toggle` is the
 * manual override in either direction, exposed as a button in the call UI.
 *
 * requestFullscreen() only works from inside a user-gesture handler (a
 * plain click, same as this toggle), which is why it's never called
 * automatically on mount — only `expanded`'s initial value responds to
 * device type; entering real OS fullscreen always needs an explicit tap.
 */
export function useCallLayout() {
  const isDesktop = useIsDesktop();
  const isLandscape = useIsLandscape();
  const [expanded, setExpanded] = useState(isDesktop);

  useEffect(() => {
    setExpanded(isDesktop);
  }, [isDesktop]);

  const toggle = () => {
    setExpanded((current) => {
      const next = !current;
      if (typeof document !== "undefined") {
        if (next && isDesktop && document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else if (!next && document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
      return next;
    });
  };

  return { expanded, toggle, isDesktop, isLandscape };
}

export function useIsLandscape() {
  const [isLandscape, setIsLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight
  );
  useEffect(() => {
    const check = () => setIsLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener("resize", check);
    // orientation change event fires on mobile rotation
    window.addEventListener("orientationchange", () => setTimeout(check, 100));
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);
  return isLandscape;
}

export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    // Both listeners recompute the same matchMedia check — belt and
    // suspenders, because some environments (browser automation resizing
    // a viewport via devtools protocol, some embedded webviews) fire a
    // plain `resize` without ever dispatching the MediaQueryList's own
    // `change` event.
    const onChange = () => setIsDesktop(window.matchMedia(DESKTOP_QUERY).matches);
    mql.addEventListener("change", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);
  return isDesktop;
}

/**
 * Add-to-home-screen / install support for the PWA.
 *
 * Chromium fires `beforeinstallprompt` when the app meets the installability
 * bar (valid manifest, served over https, a registered service worker) and is
 * not already installed — we stash that event so our own UI can trigger the
 * native install dialog on demand (the browser's own mini-infobar is
 * suppressed by preventDefault, so without capturing it there'd be no way in).
 * `appinstalled` clears the affordance once it's done. Browsers that don't
 * implement this (Safari/Firefox) simply never set canInstall, so any UI
 * gated on it stays hidden — on iOS the install path is the Share-sheet's
 * "Add to Home Screen", which isn't scriptable and so isn't offered here.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia?.("(display-mode: standalone)").matches
  );

  useEffect(() => {
    const onBefore = (event) => { event.preventDefault(); setDeferred(event); };
    const onInstalled = () => { setDeferred(null); setInstalled(true); };
    window.addEventListener("beforeinstallprompt", onBefore);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBefore);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return false;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // A dismissed prompt can't be re-shown with the same event — drop it
    // either way; a fresh beforeinstallprompt fires if they're still eligible.
    setDeferred(null);
    return outcome === "accepted";
  }, [deferred]);

  return { canInstall: Boolean(deferred) && !installed, installed, promptInstall };
}

/**
 * A canvas particle network: dots drifting on their own physics, thin lines
 * connecting nearby ones, and — beyond what most of these effects do — the
 * dots gently give way as the cursor passes near them, with a warm line
 * drawn from each nearby dot to the cursor itself. Canvas rather than CSS
 * because "draw a line between every pair of points currently within N
 * pixels of each other, every frame" is a per-frame numeric computation,
 * not something keyframes can express.
 *
 * `fixed` (default true) covers the whole viewport, for a full-page backdrop
 * (Login). Pass `fixed={false}` to instead fill whatever positioned parent
 * it's dropped into (e.g. the desktop empty-chat panel) — the parent needs
 * `position: relative` (or similar) of its own for that to work.
 */
export function ParticleNetwork({ fixed = true }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, particles = [], animationId;
    const mouse = { x: null, y: null };
    const LINK_DIST = 130;
    const MOUSE_DIST = 160;

    function makeParticles() {
      // Density-scaled, capped so a huge desktop window doesn't tank frame rate.
      const count = Math.min(110, Math.max(35, Math.floor((width * height) / 13000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.6 + 1.1,
        warm: Math.random() < 0.16,
      }));
    }

    function onResize() {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
      makeParticles();
    }

    function onMouseMove(event) {
      const rect = canvas.getBoundingClientRect();
      mouse.x = event.clientX - rect.left;
      mouse.y = event.clientY - rect.top;
    }
    function onMouseLeave() { mouse.x = null; mouse.y = null; }

    function step() {
      ctx.clearRect(0, 0, width, height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
        if (mouse.x != null) {
          const dx = p.x - mouse.x, dy = p.y - mouse.y;
          const dist = Math.hypot(dx, dy) || 1;
          if (dist < 85) {
            p.x += (dx / dist) * 0.7;
            p.y += (dy / dist) * 0.7;
          }
        }
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DIST) {
            ctx.strokeStyle = `rgba(148,197,255,${(1 - dist / LINK_DIST) * 0.35})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        if (mouse.x != null) {
          const dist = Math.hypot(particles[i].x - mouse.x, particles[i].y - mouse.y);
          if (dist < MOUSE_DIST) {
            ctx.strokeStyle = `rgba(245,165,36,${(1 - dist / MOUSE_DIST) * 0.55})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.warm ? "#f5a524" : "#7dd3fc";
        ctx.fill();
      }

      animationId = requestAnimationFrame(step);
    }

    onResize();
    step();
    window.addEventListener("resize", onResize);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseleave", onMouseLeave);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
    };
  }, []);

  return (
    <div aria-hidden style={{
      position: fixed ? "fixed" : "absolute", inset: 0, zIndex: 0, overflow: "hidden",
      background: "linear-gradient(135deg, #0b1c33, #14294a 55%, #0b1c33)",
    }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}/>
    </div>
  );
}

/**
 * Renders whatever the current chat-wallpaper preference is (particle
 * network / a CSS texture / a custom photo / nothing), and stays in sync if
 * that preference changes while mounted — every chat screen drops this in
 * once instead of each re-implementing the same read-preference-and-branch
 * logic, and ChatWallpaperPicker (the Settings UI) never has to know who's
 * listening.
 */
const DARK_CANVAS_BG = "linear-gradient(160deg, #0b1420, #10192b 60%, #0b1420)";

/** Soft glowing orbs drifting upward, like light bokeh — a calmer, ambient
 * alternative to the particle network's connected-dots look. */
export function BokehCanvas({ fixed = true }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, orbs = [], animationId;

    function makeOrbs() {
      const count = Math.min(28, Math.max(10, Math.floor((width * height) / 45000)));
      orbs = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 40 + 20,
        vy: -(Math.random() * 0.25 + 0.08),
        vx: (Math.random() - 0.5) * 0.15,
        warm: Math.random() < 0.35,
        alpha: Math.random() * 0.16 + 0.06,
        phase: Math.random() * Math.PI * 2,
      }));
    }

    function onResize() {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
      makeOrbs();
    }

    function step(time) {
      ctx.clearRect(0, 0, width, height);
      for (const o of orbs) {
        o.y += o.vy;
        o.x += o.vx + Math.sin(time / 3000 + o.phase) * 0.15;
        if (o.y < -o.r) { o.y = height + o.r; o.x = Math.random() * width; }
        if (o.x < -o.r) o.x = width + o.r;
        if (o.x > width + o.r) o.x = -o.r;
        const rgb = o.warm ? "245,165,36" : "125,211,252";
        const gradient = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
        gradient.addColorStop(0, `rgba(${rgb},${o.alpha})`);
        gradient.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        ctx.fill();
      }
      animationId = requestAnimationFrame(step);
    }

    onResize();
    animationId = requestAnimationFrame(step);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div aria-hidden style={{
      position: fixed ? "fixed" : "absolute", inset: 0, zIndex: 0, overflow: "hidden", background: DARK_CANVAS_BG,
    }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}/>
    </div>
  );
}

/** A handful of slow sine-wave lines drifting across a dark background. */
export function FlowLinesCanvas({ fixed = true }) {
  const canvasRef = useRef(null);
  const LINES = 6;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, animationId;

    function onResize() {
      width = canvas.width = canvas.offsetWidth;
      height = canvas.height = canvas.offsetHeight;
    }

    function step(time) {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < LINES; i++) {
        const t = time / 1800 + i * 1.1;
        const baseY = height * ((i + 0.5) / LINES);
        ctx.beginPath();
        for (let x = 0; x <= width; x += 8) {
          const y = baseY + Math.sin(x / 90 + t) * 18 + Math.sin(x / 240 + t * 0.6) * 10;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = i % 3 === 0 ? "rgba(245,165,36,0.35)" : "rgba(125,211,252,0.3)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      animationId = requestAnimationFrame(step);
    }

    onResize();
    animationId = requestAnimationFrame(step);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div aria-hidden style={{
      position: fixed ? "fixed" : "absolute", inset: 0, zIndex: 0, overflow: "hidden", background: DARK_CANVAS_BG,
    }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}/>
    </div>
  );
}

export function ChatBackdrop({ fixed = false }) {
  const [wallpaper, setWallpaperState] = useState(getWallpaper);
  const [blur, setBlur] = useState(getWallpaperBlur);
  useEffect(() => onWallpaperChange(setWallpaperState), []);
  useEffect(() => onWallpaperBlurChange(setBlur), []);

  let content = null;
  if (wallpaper.type === "particles") {
    content = <ParticleNetwork fixed={false}/>;
  } else if (wallpaper.type === "canvas") {
    content = wallpaper.id === "flowlines" ? <FlowLinesCanvas fixed={false}/> : <BokehCanvas fixed={false}/>;
  } else if (wallpaper.type === "texture") {
    const texture = TEXTURES.find((t) => t.id === wallpaper.id) || TEXTURES[0];
    content = (
      <div style={{
        position: "absolute", inset: 0, background: G.bg,
        backgroundImage: texture.css(G), backgroundSize: texture.size,
      }}/>
    );
  } else if (wallpaper.type === "custom" && wallpaper.dataUrl) {
    content = (
      <div style={{
        position: "absolute", inset: 0, backgroundImage: `url(${wallpaper.dataUrl})`,
        backgroundSize: "cover", backgroundPosition: "center",
      }}/>
    );
  }

  if (!content) return null;

  // Blurring right at the container edge leaves a faint transparent halo
  // (the filter samples pixels beyond the element's own bounds, which don't
  // exist). Rendering the content oversized and clipping it back down with
  // the outer overflow:hidden gives the blur real pixels to sample instead.
  const overscan = blur > 0 ? Math.min(blur * 2, 40) : 0;

  return (
    <div aria-hidden style={{ position: fixed ? "fixed" : "absolute", inset: 0, zIndex: 0, overflow: "hidden" }}>
      <div style={{
        position: "absolute", inset: overscan ? -overscan : 0,
        filter: blur ? `blur(${blur}px)` : undefined,
      }}>
        {content}
      </div>
    </div>
  );
}

// Design system: palette, icons and the small shared components.
//
// Colors are a sky-blue-to-blue gradient accent on cool, faintly blue-tinted
// neutrals — a two-tone gradient reads as more distinct than the single flat
// blue most chat apps use, without drifting into anyone else's brand color.
//
// Every color usage elsewhere in the app treats G's values as real hex
// strings — appending an alpha suffix directly (`${G.accent}33`) is the
// pattern used throughout. That rules out swapping G for CSS custom
// properties (`var(--accent)33` is not valid CSS), so theming instead works
// by mutating this one object's fields in place. Because nothing in this
// codebase uses React.memo, a parent re-render always re-invokes every child
// component's render function, and each one reads G.xxx fresh at that point
// — so mutating G and then triggering any re-render anywhere above a screen
// is enough to repaint the whole app in the new colors, with no context or
// prop-drilling needed.

const THEMES = {
  light: {
    bg: "#f5f9fc", surface: "#ffffff", card: "#ffffff", card2: "#eaf6fe",
    border: "#dce8f0",
    text: "#101828", sub: "#5c7189", muted: "#9fb2c2", dim: "#eef4f8",
    red: "#e5484d", yellow: "#e8a23b", green: "#1fa96a",
  },
  dark: {
    bg: "#0b1420", surface: "#0f1b2b", card: "#142235", card2: "#17293f",
    border: "#233247",
    // muted was #4c5f76 — ~2.8:1 against bg, under WCAG AA's 4.5:1 floor for
    // normal text (empty-state copy, captions, timestamps all use it). This
    // keeps it visually the dimmest of the three text tones while clearing
    // the bar (~4.65:1).
    text: "#eaf2fb", sub: "#8ca3bb", muted: "#6b8299", dim: "#182a3d",
    red: "#ff6b6b", yellow: "#ffc24b", green: "#3ecf8e",
  },
};

// Accent choices for the "Theme Color" picker in Settings. Sky-blue is the
// app's default and stays first in the list; the rest give people who don't
// want it a real choice instead of a second forced color, which is what
// caused the original switch away from orange in the first place.
export const ACCENTS = {
  skyblue: {
    // Deeper, saturated shades (500/600) so the sent chat bubble reads richly
    // against white text instead of the washed-out pastel it used to be.
    label: "Sky Blue", accent: "#0ea5e9", accentD: "#0369a1", accentGlow: "#0ea5e933",
    light: { accentSoft: "#e6f5fe", accentText: "#0369a1" },
    dark: { accentSoft: "#0ea5e922", accentText: "#7dd3fc" },
  },
  violet: {
    label: "Violet", accent: "#7c3aed", accentD: "#5b21b6", accentGlow: "#7c3aed33",
    light: { accentSoft: "#f1ecfe", accentText: "#6d28d9" },
    dark: { accentSoft: "#7c3aed22", accentText: "#c4b5fd" },
  },
  emerald: {
    label: "Emerald", accent: "#059669", accentD: "#047857", accentGlow: "#05966933",
    light: { accentSoft: "#e3faf1", accentText: "#047857" },
    dark: { accentSoft: "#05966922", accentText: "#6ee7b7" },
  },
  rose: {
    label: "Rose", accent: "#e11d48", accentD: "#be123c", accentGlow: "#e11d4833",
    light: { accentSoft: "#feecee", accentText: "#be123c" },
    dark: { accentSoft: "#e11d4822", accentText: "#fda4af" },
  },
  amber: {
    label: "Amber", accent: "#d97706", accentD: "#b45309", accentGlow: "#d9770633",
    light: { accentSoft: "#fff6e0", accentText: "#b45309" },
    dark: { accentSoft: "#d9770622", accentText: "#fcd34d" },
  },
  teal: {
    label: "Teal", accent: "#0d9488", accentD: "#0f766e", accentGlow: "#0d948833",
    light: { accentSoft: "#e1faf7", accentText: "#0f766e" },
    dark: { accentSoft: "#0d948822", accentText: "#5eead4" },
  },
  darkblue: {
    label: "Dark Blue", accent: "#3b82f6", accentD: "#1e3a5f", accentGlow: "#3b82f633",
    light: { accentSoft: "#dbeafe", accentText: "#1e40af" },
    dark: { accentSoft: "#3b82f61f", accentText: "#93c5fd" },
  },
  navy: {
    label: "Navy", accent: "#1e3a8a", accentD: "#0a1628", accentGlow: "#1e3a8a33",
    light: { accentSoft: "#dce3f4", accentText: "#1e3a8a" },
    dark: { accentSoft: "#1e3a8a1f", accentText: "#6b8dd6" },
  },
  darkpink: {
    label: "Dark Pink", accent: "#db2777", accentD: "#881337", accentGlow: "#db277733",
    light: { accentSoft: "#fce7f3", accentText: "#9d174d" },
    dark: { accentSoft: "#db27771f", accentText: "#f9a8d4" },
  },
  litepink: {
    label: "Lite Pink", accent: "#f9a8d4", accentD: "#ec4899", accentGlow: "#f9a8d433",
    light: { accentSoft: "#fdf2f8", accentText: "#be185d" },
    dark: { accentSoft: "#f9a8d41f", accentText: "#fbcfe8" },
  },
};

const DEFAULT_ACCENT = "skyblue";
const THEME_STORAGE_KEY = "ht_theme";
const ACCENT_STORAGE_KEY = "ht_accent";
const ENTER_TO_SEND_KEY = "ht_enter_to_send";
// Custom event the composer listens for so a change made in Settings takes
// effect immediately, without needing the chat to be reopened.
const ENTER_TO_SEND_EVENT = "ht-enter-to-send-changed";

// A real, mutable object — never reassigned, only its fields change. Every
// file in the app does `import { G } from "./ui.jsx"` and reads G.xxx at
// render time, so mutating these fields is what makes the switch visible
// everywhere at once.
export const G = { ...THEMES.light, ...accentFields(DEFAULT_ACCENT, "light") };

function accentFields(accentKey, mode) {
  const accent = ACCENTS[accentKey] || ACCENTS[DEFAULT_ACCENT];
  return {
    accent: accent.accent, accentD: accent.accentD, accentGlow: accent.accentGlow,
    ...accent[mode],
  };
}

export function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" ? "dark" : "light";       // light is the default
  } catch {
    return "light";                                     // localStorage blocked (private mode etc.)
  }
}

export function getStoredAccent() {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    return ACCENTS[stored] ? stored : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function applyTheme(mode, accentKey = getStoredAccent()) {
  const themeMode = mode === "dark" ? "dark" : "light";
  Object.assign(G, THEMES[themeMode], accentFields(accentKey, themeMode));
}

export function saveTheme(mode) {
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch { /* best effort */ }
}

export function saveAccent(accentKey) {
  try { localStorage.setItem(ACCENT_STORAGE_KEY, accentKey); } catch { /* best effort */ }
}

// "Press Enter to send" — a per-device composer preference. Defaults ON (the
// long-standing behaviour), so anyone who never touches the setting keeps the
// exact same Enter-sends experience. When OFF, Enter inserts a newline and
// only the send button sends.
export function getStoredEnterToSend() {
  try {
    return localStorage.getItem(ENTER_TO_SEND_KEY) !== "0"; // absent → default ON
  } catch {
    return true;
  }
}

export function saveEnterToSend(on) {
  try { localStorage.setItem(ENTER_TO_SEND_KEY, on ? "1" : "0"); } catch { /* best effort */ }
  // Let any mounted composer update live rather than only on next open.
  try { window.dispatchEvent(new Event(ENTER_TO_SEND_EVENT)); } catch { /* SSR / no window */ }
}

// Live-updating read of the preference for the composer.
export function useEnterToSend() {
  const [on, setOn] = useState(getStoredEnterToSend);
  useEffect(() => {
    const update = () => setOn(getStoredEnterToSend());
    window.addEventListener(ENTER_TO_SEND_EVENT, update);
    window.addEventListener("storage", update); // another tab changed it
    return () => {
      window.removeEventListener(ENTER_TO_SEND_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return on;
}

// Applied once at module load, before the first render, so the very first
// paint already uses the remembered theme instead of flashing light-then-dark.
applyTheme(getStoredTheme(), getStoredAccent());

// The original set was the 8 WhatsApp shows on a long-press by default —
// fine for a quick react, but nowhere near the full picker Telegram/WhatsApp
// actually offer once you tap "more." This is that fuller set: still a fixed
// list (no live Unicode CLDR lookup or search), but broad enough to cover
// what people actually reach for, grouped loosely by feeling.
export const EMOJIS = [
  "👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉",
  "😍", "😊", "😅", "🤔", "😎", "🥳", "😴", "🤯",
  "👏", "🙌", "💯", "✅", "❌", "👀", "💔", "😡",
  "🤝", "🎂", "☕", "😭", "🤣", "😘", "🫡", "🚀",
  "🥹", "🫶", "🫠", "🩷", "🩵", "🤌", "🫰", "🥸",
];

// The composer's full picker, one tier up from EMOJIS above: grouped into
// tabs the way WhatsApp/Telegram do, plus a name so a text search can find
// "fire" without the person knowing which category it lives in.
export const EMOJI_GROUPS = [
  // A dedicated first tab for the newest Unicode additions (14.0–15.1,
  // 2022-2023) — faces, gestures, hearts and objects that didn't exist in
  // most emoji pickers until recently. Called out as its own tab rather than
  // only folded into the older categories below so it's obvious at a glance
  // that these are here, not just quietly present somewhere in Smileys.
  { label: "New", icon: "🆕", items: [
    ["🫠", "melting face"], ["🫢", "hand over mouth"], ["🫣", "peeking eye"],
    ["🫡", "salute"], ["🫤", "diagonal mouth"], ["🥹", "holding back tears"],
    ["🫶", "heart hands"], ["🫰", "money finger snap"], ["🩷", "pink heart"],
    ["🩵", "light blue heart"], ["🩶", "grey heart"], ["🫀", "anatomical heart"],
    ["🫁", "lungs"], ["🪷", "lotus"], ["🫧", "bubbles"], ["🪺", "nest eggs"],
    ["🫙", "jar"], ["🪸", "coral"], ["🫘", "beans"], ["🫗", "pouring liquid"],
    ["🛞", "wheel"], ["🪫", "low battery"], ["🩻", "x-ray"], ["🫥", "dotted face"],
    ["🫱", "hand right"], ["🫲", "hand left"], ["🫳", "palm down"], ["🫴", "palm up"],
  ]},
  { label: "Smileys", icon: "😀", items: [
    ["😀", "grinning"], ["😃", "smile"], ["😄", "happy"], ["😁", "grin"], ["😆", "laugh"],
    ["😅", "sweat smile"], ["🤣", "rofl"], ["😂", "joy tears"], ["🙂", "slight smile"],
    ["🙃", "upside down"], ["😉", "wink"], ["😊", "blush"], ["😇", "halo angel"],
    ["🥰", "in love"], ["😍", "heart eyes"], ["🤩", "star struck"], ["😘", "kiss"],
    ["😗", "kissing"], ["😚", "kiss closed"], ["😋", "yum"], ["😛", "tongue"],
    ["😜", "wink tongue"], ["🤪", "zany crazy"], ["🤨", "raised eyebrow"], ["🧐", "monocle"],
    ["🤓", "nerd"], ["😎", "cool sunglasses"], ["🥸", "disguise"], ["🤗", "hug"],
    ["😴", "sleep"], ["🥱", "yawn"], ["😪", "sleepy"], ["😌", "relieved"], ["🤤", "drool"],
    ["🤔", "thinking"], ["🤫", "shush"], ["🤭", "oops"], ["🥳", "party"], ["🥺", "pleading"],
    ["😢", "sad cry"], ["😭", "crying"], ["😤", "huff"], ["😠", "angry"], ["😡", "mad rage"],
    ["🤯", "mind blown"], ["😳", "flushed"], ["🥵", "hot"], ["🥶", "cold"], ["😱", "scream"],
    ["😨", "fearful"], ["😰", "anxious"], ["😥", "disappointed"], ["😓", "sweat"],
    ["🤢", "nauseous"], ["🤮", "vomit"], ["🥴", "woozy"], ["😵", "dizzy"], ["🤐", "zip mouth"],
    ["🥲", "smile tear"], ["😑", "expressionless"], ["😐", "neutral"], ["😶", "no mouth"],
    ["🫠", "melting face"], ["🫤", "diagonal mouth"], ["🥹", "holding back tears"],
  ]},
  { label: "Gestures", icon: "👍", items: [
    ["👍", "thumbs up"], ["👎", "thumbs down"], ["👌", "ok"], ["🤌", "pinched"],
    ["✌️", "peace victory"], ["🤞", "fingers crossed"], ["🤟", "love you"], ["🤘", "rock"],
    ["👋", "wave hi"], ["🤙", "call me"], ["💪", "muscle strong"], ["🙏", "pray thanks"],
    ["👏", "clap"], ["🙌", "raised hands"], ["🤝", "handshake"], ["👊", "fist bump"],
    ["✊", "fist"], ["👆", "point up"], ["👇", "point down"], ["👈", "point left"],
    ["👉", "point right"], ["☝️", "index up"], ["🖐️", "hand raised"], ["🤚", "back hand"],
    ["✋", "stop hand"], ["🖖", "vulcan"], ["👀", "eyes look"], ["🧠", "brain"],
    ["🫶", "heart hands"], ["🫡", "salute"], ["🫰", "money finger snap"],
  ]},
  { label: "Hearts", icon: "❤️", items: [
    ["❤️", "red heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"],
    ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"], ["🖤", "black heart"],
    ["🤍", "white heart"], ["🤎", "brown heart"], ["🩷", "pink heart"], ["🩵", "light blue heart"],
    ["🩶", "grey heart"], ["💔", "broken heart"], ["❣️", "heart exclaim"],
    ["💕", "two hearts"], ["💞", "revolving hearts"], ["💓", "beating heart"],
    ["💗", "growing heart"], ["💖", "sparkling heart"], ["💘", "cupid arrow"],
    ["💝", "gift heart"], ["💯", "hundred points"], ["🔥", "fire lit"], ["✨", "sparkles"],
    ["🎉", "party celebrate"], ["🎊", "confetti"],
  ]},
  { label: "Animals", icon: "🐶", items: [
    ["🐶", "dog"], ["🐱", "cat"], ["🐭", "mouse"], ["🐹", "hamster"], ["🐰", "rabbit"],
    ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"], ["🐨", "koala"], ["🐯", "tiger"],
    ["🦁", "lion"], ["🐮", "cow"], ["🐷", "pig"], ["🐸", "frog"], ["🐵", "monkey"],
    ["🐔", "chicken"], ["🐧", "penguin"], ["🐦", "bird"], ["🦋", "butterfly"], ["🐢", "turtle"],
    ["🐍", "snake"], ["🦄", "unicorn"], ["🐝", "bee"], ["🐳", "whale"], ["🐬", "dolphin"],
  ]},
  { label: "Food", icon: "🍕", items: [
    ["🍏", "apple"], ["🍕", "pizza"], ["🍔", "burger"], ["🍟", "fries"], ["🌭", "hotdog"],
    ["🍿", "popcorn"], ["🍩", "donut"], ["🍪", "cookie"], ["🎂", "cake birthday"],
    ["🍰", "cake slice"], ["🧁", "cupcake"], ["🍫", "chocolate"], ["🍬", "candy"],
    ["🍭", "lollipop"], ["🍎", "red apple"], ["🍌", "banana"], ["🍇", "grapes"],
    ["🍓", "strawberry"], ["🍉", "watermelon"], ["🍍", "pineapple"], ["🥑", "avocado"],
    ["☕", "coffee"], ["🍵", "tea"], ["🍺", "beer"], ["🍷", "wine"], ["🥤", "drink soda"],
  ]},
  { label: "Activities", icon: "⚽", items: [
    ["⚽", "soccer football"], ["🏀", "basketball"], ["🏈", "american football"],
    ["🎾", "tennis"], ["🏐", "volleyball"], ["🏓", "ping pong"], ["🎮", "gaming"],
    ["🎲", "dice"], ["🎯", "dart target"], ["🎳", "bowling"], ["🎵", "music note"],
    ["🎸", "guitar"], ["🎤", "microphone"], ["🎧", "headphones"], ["🎨", "art paint"],
    ["🎬", "movie clapper"], ["📚", "books"], ["✈️", "airplane travel"], ["🚗", "car"],
    ["🚀", "rocket launch"], ["🏆", "trophy win"], ["🥇", "gold medal"],
  ]},
  { label: "Objects", icon: "💡", items: [
    ["💡", "idea lightbulb"], ["🔑", "key"], ["🔒", "lock"], ["🔓", "unlock"],
    ["📱", "phone mobile"], ["💻", "laptop computer"], ["⌚", "watch"], ["📷", "camera"],
    ["🔋", "battery"], ["💰", "money bag"], ["💵", "cash dollar"], ["💳", "credit card"],
    ["🎁", "gift present"], ["📌", "pin"], ["📎", "paperclip"], ["✏️", "pencil write"],
    ["📝", "note memo"], ["📅", "calendar date"], ["⏰", "alarm clock"], ["🔔", "bell notify"],
  ]},
  { label: "Symbols", icon: "✅", items: [
    ["✅", "check done"], ["❌", "cross wrong"], ["⭐", "star"], ["❓", "question"],
    ["❗", "exclaim important"], ["⚠️", "warning"], ["♻️", "recycle"], ["🔁", "repeat loop"],
    ["🔀", "shuffle"], ["🆗", "ok button"], ["🆕", "new"], ["🔝", "top"], ["🔞", "18 plus"],
    ["💤", "sleep zzz"], ["🚫", "prohibited no"], ["‼️", "double exclaim"],
  ]},
];

// ── Icons ────────────────────────────────────────────────────────────────────

export const I = {
  // Two overlapping speech bubbles in a circular badge — a "conversation
  // between two people" mark, rather than the single plain outline every
  // other messaging icon set uses. This is the app's own tab; it should
  // read as TalkEx's mark, not a generic "chat" stock icon.
  chat: (c = G.text, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="11" fill={c} fillOpacity="0.12"/>
    <rect x="9.5" y="3.5" width="11" height="8.5" rx="4.25" fill={c} fillOpacity="0.5"/>
    <polygon points="12.5,11.2 15,11.2 12.2,14.3" fill={c} fillOpacity="0.5"/>
    <rect x="3.5" y="9" width="11.5" height="9" rx="4.5" fill={c}/>
    <polygon points="7.2,17.2 10.2,17.2 6.6,20.8" fill={c}/>
  </svg>,
  channel: (c = G.text, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>,
  community: (c = G.text, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  // A segmented "story ring" around a solid center — the shape every status/
  // update feature (Instagram, WhatsApp) uses to mean "new to view here,"
  // rather than the old squiggle this replaced, which read as noise rather
  // than a status concept.
  status: (c = G.text, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9.5" stroke={c} strokeWidth="2" strokeDasharray="4.2 3.4" strokeLinecap="round"/>
    <circle cx="12" cy="12" r="4.5" fill={c}/>
  </svg>,
  // TalkEx's own send glyph — a solid, faceted paper dart rather than the
  // stock outline icon this replaced. The old version was fill="none" with
  // only a thin 2.5px stroke tracing a concave polygon; at the 18px it's
  // actually rendered on a phone WebView that hairline anti-aliases down to
  // nearly nothing, which is why it was reported as "missing" on device even
  // though desktop Chrome rendered it fine. Solid fill removes that failure
  // mode outright. The two overlapping facets (full-opacity top half, dimmer
  // underside) are the same layered-shading trick `chat` above uses — it's
  // what makes this read as TalkEx's icon set rather than a generic
  // send-arrow dropped in from an icon library.
  send: (c = "#fff", s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
    <polygon points="22,2 15,22 11,13 2,9" fill={c}/>
    <polygon points="22,2 11,13 2,9" fill={c} fillOpacity="0.5"/>
  </svg>,
  back: (c = G.accent, s = 24) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  edit: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  trash: (c = G.red, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  // A real thumbtack/pushpin glyph (pinned chats & messages) — the old shape
  // here was a map-location pin, which reads as "a place," not "pinned to
  // the top."
  pin: (c = G.sub, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c} stroke="none"><path d="M16 3H8a1 1 0 0 0 0 2h1v4.59c0 1.13-.36 2.23-1.03 3.14L6.4 14.9A1 1 0 0 0 7.2 16.5h3.8v5.5a1 1 0 0 0 2 0v-5.5h3.8a1 1 0 0 0 .8-1.6l-1.57-2.17A5.3 5.3 0 0 1 15 9.59V5h1a1 1 0 0 0 0-2z"/></svg>,
  settings: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  lock: (c = G.green, s = 12) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  fingerprint: (c = G.accent, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a8 8 0 0 0-8 8c0 2.5.5 4 1.5 6"/><path d="M12 4a6 6 0 0 1 6 6c0 3-.5 5-1.5 7"/><path d="M12 8a2 2 0 0 0-2 2c0 4-1 6-3 8"/><path d="M12 8a2 2 0 0 1 2 2c0 1.5-.15 2.7-.5 3.8"/><path d="M9 16.5c1.2-1.5 1.5-3 1.5-4.5"/></svg>,
  tag: (c = G.accent, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.17H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.59 9.59a2 2 0 0 0 2.83 0l4.58-4.58a2 2 0 0 0 0-2.83z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>,
  globe: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  bolt: (c = G.accent, s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  search: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  plus: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  timer: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  poll: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  clock: (c = G.muted, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  calendar: (c = G.muted, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  fwd: (c = G.sub, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>,
  reply: (c = G.sub, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>,
  info: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  star: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  starFill: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c} stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  download: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  copy: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  share: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>,
  select: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="8 12 11 15 16 9"/></svg>,
  keyboard: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/></svg>,
  verified: (c = G.accent, s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>,
  // The activity-earned blue tick (see BLUE_TICK_TARGET in main.py) — a
  // TalkEx-specific mark, not the stock Instagram/X plain-circle-with-check
  // this replaced. Distinctive shape choices:
  //   - 16-point rounded starburst (rosette) outer edge, so the badge
  //     reads as its own icon at a glance rather than "the same blue
  //     circle every social app uses";
  //   - a top-left → bottom-right blue gradient (#4bb4ff → #0d7bc4) for
  //     depth, matching the TX icon's own gradient rather than a flat
  //     brand-blue fill;
  //   - a heavier white check with rounded caps sitting on a subtle inner
  //     ring, so it's still legible at 12–14px in a chat header row.
  // Kept in a fixed brand palette (never G.accent) for the same reason
  // note above: it must read as "the blue tick" in every user's theme,
  // not shift color with the accent picker.
  blueTick: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24">
    <defs>
      <linearGradient id="talkexBlueTick" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#4bb4ff"/>
        <stop offset="1" stopColor="#0d7bc4"/>
      </linearGradient>
    </defs>
    <polygon fill="url(#talkexBlueTick)" strokeLinejoin="round" strokeWidth="0.4" stroke="url(#talkexBlueTick)"
             points="12,1 13.8,3 16.2,1.8 17.1,4.4 19.8,4.2 19.7,6.9 22.2,7.8 21,10.2 23,12 21,13.8 22.2,16.2 19.7,17.1 19.8,19.8 17.1,19.7 16.2,22.2 13.8,21 12,23 10.2,21 7.8,22.2 6.9,19.7 4.2,19.8 4.4,17.1 1.8,16.2 3,13.8 1,12 3,10.2 1.8,7.8 4.4,6.9 4.2,4.2 6.9,4.4 7.8,1.8 10.2,3"/>
    <circle cx="12" cy="12" r="8" fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="0.6"/>
    <path d="M7.5 12.3 L10.7 15.5 L16.6 9.2" fill="none" stroke="#fff" strokeWidth="2.6"
          strokeLinecap="round" strokeLinejoin="round"/>
  </svg>,
  check: (c = G.accent, s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  checkDouble: (c = G.accent, s = 15) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 7 17l-5-5"/><path d="M22 6 12.5 15.5"/></svg>,
  doc: (c = G.accent, s = 28) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  paperclip: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  mic: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  sun: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/><line x1="4.2" y1="4.2" x2="5.9" y2="5.9"/><line x1="18.1" y1="18.1" x2="19.8" y2="19.8"/><line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/><line x1="4.2" y1="19.8" x2="5.9" y2="18.1"/><line x1="18.1" y1="5.9" x2="19.8" y2="4.2"/></svg>,
  moon: (c = G.sub, s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.8 14.5A8.5 8.5 0 1 1 9.5 3.2a7 7 0 0 0 11.3 11.3z"/></svg>,
  mapPin: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  contactCard: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="9" cy="10" r="2.5"/><path d="M5 17c.7-2.3 2.4-3.5 4-3.5s3.3 1.2 4 3.5"/><line x1="15" y1="9" x2="19" y2="9"/><line x1="15" y1="13" x2="19" y2="13"/></svg>,
  image: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  camera: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  // "Flip camera" — a camera body with two curved arrows circling the lens,
  // the standard front/back-switch glyph WhatsApp/Instagram/Meet all use
  // (replaces the old generic rotate-arrow that read as "rotate photo").
  cameraFlip: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><path d="M8.5 13a3.5 3.5 0 0 1 6-2.4"/><polyline points="14.8 8 14.8 10.6 12.2 10.6"/><path d="M15.5 13a3.5 3.5 0 0 1-6 2.4"/><polyline points="9.2 18 9.2 15.4 11.8 15.4"/></svg>,
  musicNote: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
  scan: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>,
  rotateLeft: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 5 10l4-4"/><path d="M5 10h9a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5H9"/></svg>,
  rotateRight: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l4-4-4-4"/><path d="M19 10h-9a5 5 0 0 0-5 5v1a5 5 0 0 0 5 5h6"/></svg>,
  phone: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  phoneOff: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.11-2.51m-2.7-3.4A19.8 19.8 0 0 1 2.05 5.18 2 2 0 0 1 4.11 3h3a2 2 0 0 1 2 1.72c.127.96.362 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 10.9"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  // The classic iOS "decline/end call" glyph — a solid handset silhouette
  // rotated 135° (pointing away, receiver-down), unlike the generic
  // outlined phone-with-slash above. Used specifically for the red
  // end/decline/leave call buttons.
  callEnd: (c = "#fff", s = 24) => <svg width={s} height={s} viewBox="0 0 24 24"><path fill={c} transform="rotate(135 12 12)" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>,
  video: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
  // Call layout mode switch: fill the whole desktop viewport vs a compact
  // windowed panel — see CallOverlay/GroupCallOverlay's `expanded` state.
  expand: (c = "#fff", s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>,
  shrink: (c = "#fff", s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>,
  videoOff: (c = G.sub, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9.5 5H14a2 2 0 0 1 2 2v3.5"/><polygon points="23 7 16 12 23 17 23 7"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  micOff: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  sticker: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7a2 2 0 0 1 2-2h9l5 5v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M15 5v4a1 1 0 0 0 1 1h4"/><circle cx="9" cy="13" r="1"/><circle cx="14" cy="13" r="1"/></svg>,
  link: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  chevronDown: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,

  // Call-controls icons — speaker/output device, an overflow "more" menu,
  // and screen sharing, added alongside the existing mic/video/phone set.
  volume: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>,
  volumeOff: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>,
  moreVertical: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c} stroke="none"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>,
  screenShare: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><path d="M9 11l3-3 3 3"/><line x1="12" y1="8" x2="12" y2="14"/></svg>,
  newChatBox: (c = "#fff", s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h1v3l3.5-3H18a2 2 0 0 0 2-2v-4"/><line x1="17" y1="3" x2="17" y2="9"/><line x1="14" y1="6" x2="20" y2="6"/></svg>,
  eraser: (c = "#fff", s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20H8.5L3 14.5a2 2 0 0 1 0-2.83l7.5-7.5a2 2 0 0 1 2.83 0L20 10.83a2 2 0 0 1 0 2.83L14 20"/><path d="M8.5 14.5 15 8"/></svg>,

  // Settings-row and chat-info icons — added to replace raw emoji, which
  // render inconsistently across platforms/fonts and read as placeholder
  // art next to the rest of this hand-drawn, single-color icon set.
  bell: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  bellOff: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  archive: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><line x1="10" y1="13" x2="14" y2="13"/></svg>,
  broom: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 4 10 14"/><path d="M10 14 4 20a2.4 2.4 0 0 0 3.4 3.4L10 21"/><path d="M9 9c2 0 5 2 5 5"/></svg>,
  ban: (c = G.red, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>,
  user: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  palette: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 2-4 2 2 0 0 1 2-3h1.5A4.5 4.5 0 0 0 22 10.5C22 5.8 17.5 2 12 2z"/><circle cx="7.5" cy="10.5" r="1.2" fill={c}/><circle cx="11" cy="7" r="1.2" fill={c}/><circle cx="15.5" cy="8.5" r="1.2" fill={c}/></svg>,
  barChart: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  eye: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  shield: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  monitor: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
  key: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M11 12 20.5 2.5"/><path d="M16 7l2 2"/><path d="M19 4l2 2"/></svg>,
  logOut: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  wifi: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>,
  play: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M6 4.5v15l13-7.5z"/></svg>,
  pause: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>,
  mail: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>,
};

// ── Shared components ────────────────────────────────────────────────────────

// One shared blob URL per avatar, resolved once and reused by every <Av> that
// shows the same person. Two things this fixes over fetching per-instance:
//
//   1. No revoke race. The old code revoked its object URL on unmount — fine
//      when each instance had its own, but any refactor toward sharing would
//      have one Av unmounting and breaking every other Av still showing that
//      face. Session-lifetime URLs (avatars are small and few) sidestep it
//      entirely: nothing is revoked while the app is open.
//   2. Automatic retry. A single transient failure (Render free-tier cold
//      start, a dropped request) used to leave the avatar stuck on its letter
//      fallback forever, since photoId never changes to re-trigger the fetch.
//      On failure we drop the cache entry so the very next mount tries again,
//      and the effect below also retries once on its own after a short delay.
const avatarUrlCache = new Map(); // photoId -> Promise<string blobURL>
function loadAvatarUrl(photoId) {
  const existing = avatarUrlCache.get(photoId);
  if (existing) return existing;
  const pending = Uploads.fetchBlobUrl(photoId, { cache: true }).catch((error) => {
    avatarUrlCache.delete(photoId); // let a later mount/retry have another go
    throw error;
  });
  avatarUrlCache.set(photoId, pending);
  return pending;
}

/**
 * Load an avatar/cover blob URL into a React state setter, retrying through a
 * backend cold start. The Render free tier sleeps and can take 30-60s to wake,
 * so a single quick retry left photos stuck on the letter fallback "aksar"
 * (often). This keeps trying with growing backoff (~1.5s → 24s, capped) until
 * it succeeds or the component unmounts.
 */
function useImageBlob(photoId, setUrl) {
  useEffect(() => {
    if (!photoId) { setUrl(null); return; }
    let cancelled = false;
    let timer = null;
    const DELAYS = [1500, 3000, 6000, 12000, 24000]; // ~46s total — a cold start
    const attempt = (i) => {
      loadAvatarUrl(photoId)
        .then((url) => { if (!cancelled) setUrl(url); })
        .catch(() => {
          if (cancelled) return;
          setUrl(null);
          if (i < DELAYS.length) timer = setTimeout(() => attempt(i + 1), DELAYS[i]);
        });
    };
    attempt(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [photoId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** A wide cover/banner image fetched by attachment id (auth'd blob, same as
 *  Av). Falls back to a soft accent gradient when there's no cover. `children`
 *  render on top (e.g. an edit button). */
export function CoverImage({ coverId, height = 130, children, style }) {
  const [url, setUrl] = useState(null);
  useImageBlob(coverId, setUrl);
  return (
    <div style={{
      height, width: "100%", position: "relative", flexShrink: 0,
      background: url
        ? `#0b1220 url(${url}) center/cover no-repeat`
        : `linear-gradient(135deg, ${G.accent}55, ${G.accent}18)`,
      ...style,
    }}>{children}</div>
  );
}

export function Av({ av, color, size = 44, online, hasStory, isMe, photoId }) {
  // The download endpoint needs an Authorization header a plain <img src>
  // can't send, so a real profile photo is fetched as a blob URL — same
  // pattern used for chat attachments and story media.
  const [photoUrl, setPhotoUrl] = useState(null);
  useImageBlob(photoId, setPhotoUrl);

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div style={{
        width: size, height: size, borderRadius: "50%",
        background: photoUrl ? undefined : `linear-gradient(135deg,${color || G.accent}cc,${color || G.accent}44)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: size * 0.36, fontWeight: 700, color: "#fff", overflow: "hidden",
        border: hasStory ? `2.5px solid ${G.accent}` : isMe ? `2px dashed ${G.muted}` : `1.5px solid ${(color || G.accent)}33`,
        boxShadow: hasStory ? `0 0 10px ${G.accentGlow}` : "none",
      }}>
        {photoUrl
          ? <img src={photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
          : (av || "?")}
      </div>
      {online && <div style={{
        position: "absolute", bottom: 1, right: 1,
        width: size * 0.23, height: size * 0.23, borderRadius: "50%",
        background: G.green, border: `2px solid ${G.bg}`,
      }}/>}
    </div>
  );
}

// The category/designation/service tags a profile can carry (WhatsApp Business
// "category" style). The Edit-profile screen lets the user pick any number of
// these; the picks are stored joined with " · " in users.business_category and
// shown under the name on their profile.
export const BUSINESS_CATEGORIES = [
  "Software company", "Web designer", "App developer", "IT services", "Digital marketing",
  "Graphic designer", "Photographer", "Videographer", "Content creator", "Consultant",
  "Freelancer", "Entrepreneur", "Founder / CEO", "Manager", "Engineer",
  "Doctor", "Teacher", "Student", "Lawyer", "Accountant",
  "Retail / shop", "Wholesale", "Restaurant / food", "Grocery", "Electronics",
  "Real estate", "Construction", "Interior design", "Automobile", "Travel & tourism",
  "Education / coaching", "Healthcare", "Finance / banking", "Insurance", "NGO / non-profit",
  "Beauty & salon", "Fashion & clothing", "Fitness & gym", "Event management", "Printing press",
  "Agriculture", "Manufacturing", "Logistics / transport", "Government service", "Other",
];

// The social links a profile can carry, each with its real brand mark (an
// inline SVG glyph on the brand's colour) rather than an emoji stand-in — one
// definition shared by the Settings editor and every profile that displays
// them, so a link the user adds shows the right logo everywhere at once.
// `field` is the users-table column; `match` recognises which platform an
// arbitrary URL belongs to so even a link typed into the wrong box still gets
// a sensible icon.
export const SOCIAL_PLATFORMS = [
  {
    key: "website", field: "link_website", label: "Website", brand: "#0ea5e9",
    match: () => true, // fallback for anything not matched below
    glyph: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18"/></svg>,
  },
  {
    key: "facebook", field: "link_facebook", label: "Facebook", brand: "#1877f2",
    match: (u) => /facebook\.com|fb\.com|fb\.me/i.test(u),
    glyph: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M13.5 21v-7h2.4l.4-2.9h-2.8V9.3c0-.85.24-1.43 1.46-1.43H16.8V5.28c-.27-.04-1.2-.12-2.28-.12-2.26 0-3.8 1.38-3.8 3.9v2.05H8.3V14h2.42v7z"/></svg>,
  },
  {
    key: "instagram", field: "link_instagram", label: "Instagram", brand: "#e1306c",
    match: (u) => /instagram\.com|instagr\.am/i.test(u),
    glyph: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill={c} stroke="none"/></svg>,
  },
  {
    key: "twitter", field: "link_twitter", label: "Twitter / X", brand: "#000000",
    match: (u) => /twitter\.com|x\.com/i.test(u),
    glyph: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M17.5 3h3l-6.55 7.48L21.75 21h-6.04l-4.72-6.17L5.6 21H2.6l7-8-6.85-10h6.2l4.27 5.64zm-1.06 16.13h1.66L7.65 4.77H5.86z"/></svg>,
  },
  {
    key: "youtube", field: "link_youtube", label: "YouTube", brand: "#ff0000",
    match: (u) => /youtube\.com|youtu\.be/i.test(u),
    glyph: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M21.6 7.2a2.5 2.5 0 0 0-1.75-1.77C18.25 5 12 5 12 5s-6.25 0-7.85.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.75 1.77C5.75 19 12 19 12 19s6.25 0 7.85-.43a2.5 2.5 0 0 0 1.75-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>,
  },
  {
    key: "linkedin", field: "link_linkedin", label: "LinkedIn", brand: "#0a66c2",
    match: (u) => /linkedin\.com|linked\.in/i.test(u),
    glyph: (c, s) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M4.98 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.4c0-1.3-.02-2.96-1.8-2.96-1.8 0-2.08 1.4-2.08 2.86V21h-4z"/></svg>,
  },
];

/** Which platform a URL belongs to (for showing the right logo), defaulting
 *  to the generic website globe when nothing more specific matches. */
export function platformForUrl(url) {
  return SOCIAL_PLATFORMS.find((p) => p.key !== "website" && p.match(url))
    || SOCIAL_PLATFORMS[0];
}

/** One clickable brand icon (icon-only — the URL text isn't shown, just the
 *  platform's logo in its brand colour). `platform` is a SOCIAL_PLATFORMS entry. */
export function SocialChip({ platform, url }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={platform.label} style={{
      width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
      background: platform.brand, display: "inline-flex", alignItems: "center", justifyContent: "center",
      textDecoration: "none", cursor: "pointer",
    }}>{platform.glyph("#fff", 17)}</a>
  );
}

/** Renders every social link a profile object carries as brand chips. Reads
 *  the same link_* fields Settings edits, so any link the user adds shows up
 *  here — on their own profile and on how others see them — automatically. */
export function SocialLinks({ profile, style }) {
  if (!profile) return null;
  const chips = SOCIAL_PLATFORMS
    .map((platform) => ({ platform, url: profile[platform.field] }))
    .filter((entry) => entry.url && entry.url.trim());
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", ...style }}>
      {chips.map((entry) => <SocialChip key={entry.platform.key} platform={entry.platform} url={entry.url}/>)}
    </div>
  );
}

export function Toggle({ on, onChange, label }) {
  return (
    <div
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!on)}
      onKeyDown={(event) => {
        // Space/Enter are what every native checkbox/switch responds to —
        // without this a keyboard user can Tab to a toggle (now that it's
        // focusable) but still has no way to actually flip it.
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onChange(!on);
        }
      }}
      style={{
      width: 44, height: 26, borderRadius: 13, background: on ? G.accent : G.dim,
      position: "relative", cursor: "pointer", transition: "background 0.2s",
      border: `1px solid ${on ? G.accent : G.border}`, flexShrink: 0,
    }}>
      <div style={{
        position: "absolute", top: 2, left: on ? 20 : 2, width: 20, height: 20,
        borderRadius: "50%", background: "#fff", transition: "left 0.2s",
      }}/>
    </div>
  );
}

/**
 * A small popup menu anchored near a point (mouse right-click coordinates,
 * or a touch/long-press point on mobile) rather than a full-width bottom
 * sheet — this is what both the chat-list row menu and the chat-view
 * background menu use, so right-clicking behaves the same everywhere.
 * Clamped to the viewport so a click near an edge doesn't render off-screen.
 */
export function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, visible: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, innerWidth - rect.width - 8);
    const top = Math.min(y, innerHeight - rect.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top), visible: true });
  }, [x, y]);

  // No keyboard dismissal previously existed anywhere in this menu — a
  // keyboard user who opened it (or a mouse user who just wants to tap
  // Escape, the universal "back out of this" key) had no way to close it
  // except clicking the transparent backdrop.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{
      position: "fixed", inset: 0, zIndex: 1200, background: "transparent",
    }}>
      <div ref={ref} role="menu" onClick={(e) => e.stopPropagation()} style={{
        position: "fixed", left: pos.left, top: pos.top, opacity: pos.visible ? 1 : 0,
        minWidth: 200, maxWidth: 260, background: G.card, border: `1px solid ${G.border}`,
        borderRadius: 12, boxShadow: "0 8px 28px #00000033", padding: 6, color: G.text,
      }}>
        {items.map((item, i) => item.divider ? (
          <div key={`d${i}`} style={{ height: 1, background: G.border, margin: "5px 4px" }}/>
        ) : (
          <div key={item.label}
               onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
               style={{
                 display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
                 borderRadius: 8, cursor: item.disabled ? "default" : "pointer",
                 opacity: item.disabled ? 0.45 : 1,
                 color: item.danger ? G.red : G.text,
               }}
               onMouseEnter={(e) => !item.disabled && (e.currentTarget.style.background = G.dim)}
               onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
            {item.icon}
            <span style={{ fontSize: 13.5 }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Keeps a CSS variable `--app-height` in sync with the ACTUALLY-VISIBLE
 * viewport height (window.visualViewport) rather than the layout viewport
 * that `100vh` measures. The two differ exactly when it matters here: when
 * the on-screen keyboard is open, or the mobile browser's URL bar is showing,
 * `100vh` stays the full screen height while visualViewport.height shrinks to
 * the strip above the keyboard. Binding the app shell's height to this
 * variable is what stops the bottom nav / message composer from being pushed
 * off-screen behind the keyboard — or, on some Android WebViews, floating up
 * over it — instead of sitting neatly just above it, WhatsApp-style. Call
 * once, high in the tree.
 */
export function useViewportHeightVar() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    function apply() {
      const height = vv && vv.height ? vv.height : window.innerHeight;
      root.style.setProperty("--app-height", `${Math.round(height)}px`);
    }
    // The keyboard show/hide animation (and, on Android, the WebView's own
    // adjustResize firing independently of visualViewport) can deliver a
    // resize/scroll event mid-animation — applying that value immediately
    // is what used to leave the composer floating with a gap under it, or
    // briefly under-sized so the nav bar peeked over it. Apply right away
    // for a snappy first response, then re-apply once more shortly after:
    // whatever the height has settled to by then wins, so a stale
    // in-between reading never gets stuck as the final value.
    let raf = null;
    let settleTimer = null;
    function scheduleApply() {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        apply();
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(apply, 140);
      });
    }
    apply();
    if (vv) {
      vv.addEventListener("resize", scheduleApply);
      vv.addEventListener("scroll", scheduleApply);
    }
    window.addEventListener("resize", scheduleApply);
    window.addEventListener("orientationchange", scheduleApply);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
      if (vv) {
        vv.removeEventListener("resize", scheduleApply);
        vv.removeEventListener("scroll", scheduleApply);
      }
      window.removeEventListener("resize", scheduleApply);
      window.removeEventListener("orientationchange", scheduleApply);
    };
  }, []);
}

export function Screen({ children, style }) {
  return (
    <div style={{
      // A fixed height (not minHeight) is what actually keeps the header and
      // bottom nav in place: with minHeight, a screen whose content is taller
      // than the viewport just grows the whole page, and the browser scrolls
      // the header/footer away with everything else. Fixed height + hidden
      // overflow here forces each screen's own `flex:1, overflowY:auto` inner
      // pane to be the only thing that scrolls.
      //
      // --app-height (kept live by useViewportHeightVar) is the visible
      // height above any open keyboard; 100vh is the fallback before the
      // variable is first set or where visualViewport isn't available.
      height: "var(--app-height, 100vh)", overflow: "hidden", background: G.bg,
      fontFamily: "'SF Pro Text',-apple-system,sans-serif", color: G.text,
      maxWidth: 430, margin: "0 auto", display: "flex", flexDirection: "column",
      ...style,
    }}>{children}</div>
  );
}

export function Spinner({ small } = {}) {
  const size = small ? 16 : 32;
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: small ? 0 : 40 }}>
      <div style={{
        width: size, height: size, borderRadius: "50%",
        border: `${small ? 2 : 3}px solid ${G.border}`, borderTopColor: G.accent,
        animation: "spin 0.8s linear infinite",
      }}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export function SRow({ icon, label, sub, right, onClick, danger }) {
  return (
    <div onClick={onClick}
      // role/tabIndex/onKeyDown only when this row actually does something —
      // a display-only SRow (no onClick) stays a plain div, same as before.
      // The accessible name comes from the visible label/sub text itself
      // (the standard behavior for a role="button" with no aria-label), so
      // nothing else needs to change at any of this component's ~37 call sites.
      {...(onClick ? {
        role: "button",
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            onClick(event);
          }
        },
      } : {})}
      style={{
        display: "flex", alignItems: "center", gap: 14, padding: "14px 20px",
        borderBottom: `1px solid ${G.border}`, cursor: onClick ? "pointer" : "default",
      }}
      onMouseEnter={(e) => onClick && (e.currentTarget.style.background = G.card)}
      onMouseLeave={(e) => onClick && (e.currentTarget.style.background = "transparent")}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: danger ? `${G.red}22` : G.accentSoft,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 18, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: danger ? G.red : G.text }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: G.muted, marginTop: 1 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export function Button({ children, onClick, variant = "solid", style, disabled }) {
  const base = {
    padding: "12px 18px", borderRadius: 12, fontSize: 14, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer", border: "none",
    opacity: disabled ? 0.5 : 1, ...style,
  };
  const looks = {
    solid: { background: `linear-gradient(135deg,${G.accent},${G.accentD})`, color: "#fff" },
    ghost: { background: G.dim, color: G.text, border: `1px solid ${G.border}` },
    danger: { background: `${G.red}22`, color: G.red, border: `1px solid ${G.red}44` },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...looks[variant] }}>
      {children}
    </button>
  );
}

export function Field({ label, ...props }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      {label && <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>{label}</div>}
      <input {...props} style={{
        width: "100%", padding: "12px 14px", borderRadius: 12,
        background: G.dim, border: `1px solid ${G.border}`, color: G.text,
        fontSize: 15, outline: "none", boxSizing: "border-box", ...props.style,
      }}/>
    </label>
  );
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Server timestamps are Unix seconds; JavaScript dates want milliseconds. */
export const toDate = (seconds) => new Date(seconds * 1000);

export function clockTime(seconds) {
  if (!seconds) return "";
  return toDate(seconds).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function whenLabel(seconds) {
  if (!seconds) return "";
  const date = toDate(seconds);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return clockTime(seconds);
  return date.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + clockTime(seconds);
}

/** "last seen just now" / "5m ago" / "yesterday, 4:20 PM" / a full date —
 * the WhatsApp-style scale for how precise "when were they last around"
 * needs to be, which gets coarser the further back it was. */
export function lastSeenLabel(seconds) {
  if (!seconds) return "";
  const now = Date.now() / 1000;
  const ago = now - seconds;
  if (ago < 60) return "last seen just now";
  if (ago < 3600) return `last seen ${Math.round(ago / 60)}m ago`;

  const date = toDate(seconds);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `last seen today at ${clockTime(seconds)}`;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `last seen yesterday at ${clockTime(seconds)}`;
  }
  return `last seen ${date.toLocaleDateString([], { day: "numeric", month: "short" })} at ${clockTime(seconds)}`;
}

export function countdown(seconds) {
  const away = seconds - Date.now() / 1000;
  if (away < 0) return "now";
  if (away < 3600) return `in ${Math.max(1, Math.round(away / 60))} min`;
  if (away < 86400) return `in ${Math.round(away / 3600)} h`;
  return `in ${Math.round(away / 86400)} d`;
}

/** Seconds -> "5m", "1h", "7d" for the disappearing-timer chip. */
export function durationLabel(seconds) {
  if (!seconds) return "off";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * Turn a datetime-local input value into the Unix seconds the API expects.
 * The input has no timezone, so `new Date(value)` reads it as local time —
 * which is what the user meant when they picked it.
 */
export const localInputToUnix = (value) => new Date(value).getTime() / 1000;

/** The reverse, for pre-filling a datetime-local input. */
export function unixToLocalInput(seconds) {
  const date = toDate(seconds);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
