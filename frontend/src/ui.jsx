import { useEffect, useState } from "react";
import { Uploads } from "./api.js";

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
    text: "#eaf2fb", sub: "#8ca3bb", muted: "#4c5f76", dim: "#182a3d",
    red: "#ff6b6b", yellow: "#ffc24b", green: "#3ecf8e",
  },
};

// Accent choices for the "Theme Color" picker in Settings. Sky-blue is the
// app's default and stays first in the list; the rest give people who don't
// want it a real choice instead of a second forced color, which is what
// caused the original switch away from orange in the first place.
export const ACCENTS = {
  skyblue: {
    label: "Sky Blue", accent: "#38bdf8", accentD: "#2563eb", accentGlow: "#38bdf833",
    light: { accentSoft: "#e6f5fe", accentText: "#0369a1" },
    dark: { accentSoft: "#38bdf81f", accentText: "#7dd3fc" },
  },
  violet: {
    label: "Violet", accent: "#a78bfa", accentD: "#7c3aed", accentGlow: "#a78bfa33",
    light: { accentSoft: "#f1ecfe", accentText: "#6d28d9" },
    dark: { accentSoft: "#a78bfa1f", accentText: "#c4b5fd" },
  },
  emerald: {
    label: "Emerald", accent: "#34d399", accentD: "#059669", accentGlow: "#34d39933",
    light: { accentSoft: "#e3faf1", accentText: "#047857" },
    dark: { accentSoft: "#34d3991f", accentText: "#6ee7b7" },
  },
  rose: {
    label: "Rose", accent: "#fb7185", accentD: "#e11d48", accentGlow: "#fb718533",
    light: { accentSoft: "#feecee", accentText: "#be123c" },
    dark: { accentSoft: "#fb71851f", accentText: "#fda4af" },
  },
  amber: {
    label: "Amber", accent: "#fbbf24", accentD: "#d97706", accentGlow: "#fbbf2433",
    light: { accentSoft: "#fff6e0", accentText: "#b45309" },
    dark: { accentSoft: "#fbbf241f", accentText: "#fcd34d" },
  },
  teal: {
    label: "Teal", accent: "#2dd4bf", accentD: "#0d9488", accentGlow: "#2dd4bf33",
    light: { accentSoft: "#e1faf7", accentText: "#0f766e" },
    dark: { accentSoft: "#2dd4bf1f", accentText: "#5eead4" },
  },
};

const DEFAULT_ACCENT = "skyblue";
const THEME_STORAGE_KEY = "ht_theme";
const ACCENT_STORAGE_KEY = "ht_accent";

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
];

// The composer's full picker, one tier up from EMOJIS above: grouped into
// tabs the way WhatsApp/Telegram do, plus a name so a text search can find
// "fire" without the person knowing which category it lives in.
export const EMOJI_GROUPS = [
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
  ]},
  { label: "Gestures", icon: "👍", items: [
    ["👍", "thumbs up"], ["👎", "thumbs down"], ["👌", "ok"], ["🤌", "pinched"],
    ["✌️", "peace victory"], ["🤞", "fingers crossed"], ["🤟", "love you"], ["🤘", "rock"],
    ["👋", "wave hi"], ["🤙", "call me"], ["💪", "muscle strong"], ["🙏", "pray thanks"],
    ["👏", "clap"], ["🙌", "raised hands"], ["🤝", "handshake"], ["👊", "fist bump"],
    ["✊", "fist"], ["👆", "point up"], ["👇", "point down"], ["👈", "point left"],
    ["👉", "point right"], ["☝️", "index up"], ["🖐️", "hand raised"], ["🤚", "back hand"],
    ["✋", "stop hand"], ["🖖", "vulcan"], ["👀", "eyes look"], ["🧠", "brain"],
  ]},
  { label: "Hearts", icon: "❤️", items: [
    ["❤️", "red heart love"], ["🧡", "orange heart"], ["💛", "yellow heart"],
    ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"], ["🖤", "black heart"],
    ["🤍", "white heart"], ["🤎", "brown heart"], ["💔", "broken heart"], ["❣️", "heart exclaim"],
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
  send: (c = "#fff", s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  back: (c = G.accent, s = 24) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>,
  edit: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  trash: (c = G.red, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  // A real thumbtack/pushpin glyph (pinned chats & messages) — the old shape
  // here was a map-location pin, which reads as "a place," not "pinned to
  // the top."
  pin: (c = G.sub, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c} stroke="none"><path d="M16 3H8a1 1 0 0 0 0 2h1v4.59c0 1.13-.36 2.23-1.03 3.14L6.4 14.9A1 1 0 0 0 7.2 16.5h3.8v5.5a1 1 0 0 0 2 0v-5.5h3.8a1 1 0 0 0 .8-1.6l-1.57-2.17A5.3 5.3 0 0 1 15 9.59V5h1a1 1 0 0 0 0-2z"/></svg>,
  settings: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  lock: (c = G.green, s = 12) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  bolt: (c = G.accent, s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  search: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  plus: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  timer: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  poll: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  clock: (c = G.muted, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  calendar: (c = G.muted, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  fwd: (c = G.sub, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>,
  reply: (c = G.sub, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>,
  verified: (c = G.accent, s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg>,
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
  musicNote: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
  scan: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>,
  rotateLeft: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 5 10l4-4"/><path d="M5 10h9a5 5 0 0 1 5 5v1a5 5 0 0 1-5 5H9"/></svg>,
  rotateRight: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l4-4-4-4"/><path d="M19 10h-9a5 5 0 0 0-5 5v1a5 5 0 0 0 5 5h6"/></svg>,
  phone: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  phoneOff: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.11-2.51m-2.7-3.4A19.8 19.8 0 0 1 2.05 5.18 2 2 0 0 1 4.11 3h3a2 2 0 0 1 2 1.72c.127.96.362 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 10.9"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  video: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
  videoOff: (c = G.sub, s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9.5 5H14a2 2 0 0 1 2 2v3.5"/><polygon points="23 7 16 12 23 17 23 7"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  micOff: (c = "#fff", s = 22) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  sticker: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7a2 2 0 0 1 2-2h9l5 5v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M15 5v4a1 1 0 0 0 1 1h4"/><circle cx="9" cy="13" r="1"/><circle cx="14" cy="13" r="1"/></svg>,
  link: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  chevronDown: (c = G.muted, s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,

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
  mail: (c = G.sub, s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>,
};

// ── Shared components ────────────────────────────────────────────────────────

export function Av({ av, color, size = 44, online, hasStory, isMe, photoId }) {
  // The download endpoint needs an Authorization header a plain <img src>
  // can't send, so a real profile photo is fetched as a blob URL — same
  // pattern used for chat attachments and story media.
  const [photoUrl, setPhotoUrl] = useState(null);
  useEffect(() => {
    if (!photoId) { setPhotoUrl(null); return; }
    let cancelled = false;
    let objectUrl = null;
    Uploads.fetchBlobUrl(photoId, { cache: true }).then((url) => {
      if (cancelled) { URL.revokeObjectURL(url); return; }
      objectUrl = url;
      setPhotoUrl(url);
    }).catch(() => setPhotoUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId]);

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

export function Toggle({ on, onChange }) {
  return (
    <div onClick={() => onChange(!on)} style={{
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

export function Screen({ children, style }) {
  return (
    <div style={{
      // A fixed height (not minHeight) is what actually keeps the header and
      // bottom nav in place: with minHeight, a screen whose content is taller
      // than the viewport just grows the whole page, and the browser scrolls
      // the header/footer away with everything else. Fixed height + hidden
      // overflow here forces each screen's own `flex:1, overflowY:auto` inner
      // pane to be the only thing that scrolls.
      height: "100vh", overflow: "hidden", background: G.bg,
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
