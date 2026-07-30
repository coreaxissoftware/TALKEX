// A small built-in sticker pack — hand-drawn SVG, not photos or a third-party
// GIF/sticker API. WhatsApp/Telegram's sticker and GIF pickers both call out
// to a network service (Giphy/Tenor, or a sticker CDN); this app has no
// credentials for one and fabricating that integration would just be a
// picker that silently fails offline. A small self-contained set covers the
// same *use case* — sending an illustration instead of text — without an
// external dependency.

export const STICKERS = [
  {
    id: "heart",
    label: "Heart",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <path d="M50 88 C20 65 5 45 5 28 C5 12 18 2 32 2 C42 2 48 8 50 14 C52 8 58 2 68 2 C82 2 95 12 95 28 C95 45 80 65 50 88 Z" fill="#fb7185"/>
      </svg>
    ),
  },
  {
    id: "fire",
    label: "Fire",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <path d="M50 96c-24 0-38-16-38-35 0-15 9-26 9-26s3 9 10 9c-3-11 2-26 16-35-2 11 3 17 8 17 8 0 6-10 6-10s18 13 18 37c0 3-1 6-1 9 5-4 7-9 7-15 9 9 14 21 14 32 0 21-19 35-49 35Z" fill="#fb923c"/>
        <path d="M50 86c-12 0-19-8-19-17 0-6 3-12 3-12s2 4 6 4c-2-6 1-13 8-17-1 5 2 8 4 8 4 0 3-4 3-4s9 6 9 17c0 9-8 17-14 21Z" fill="#fde047"/>
      </svg>
    ),
  },
  {
    id: "star",
    label: "Star",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <polygon points="50,4 61,37 96,37 68,58 79,92 50,72 21,92 32,58 4,37 39,37" fill="#fbbf24"/>
      </svg>
    ),
  },
  {
    id: "thumbsup",
    label: "Thumbs up",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <circle cx="50" cy="50" r="48" fill="#38bdf8"/>
        <path d="M35 45h-8a4 4 0 0 0-4 4v28a4 4 0 0 0 4 4h8Zm4 0v36h30a6 6 0 0 0 6-5l4-20a6 6 0 0 0-6-7H55l3-13a6 6 0 0 0-6-8Z" fill="#fff"/>
      </svg>
    ),
  },
  {
    id: "party",
    label: "Party",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <circle cx="50" cy="50" r="48" fill="#a78bfa"/>
        <path d="M30 72 65 37l8 8-35 35Z" fill="#fff"/>
        <circle cx="62" cy="28" r="4" fill="#fde047"/>
        <circle cx="76" cy="46" r="3" fill="#34d399"/>
        <circle cx="46" cy="20" r="3" fill="#fb7185"/>
      </svg>
    ),
  },
  {
    id: "laugh",
    label: "Laughing",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <circle cx="50" cy="50" r="48" fill="#fde047"/>
        <circle cx="33" cy="42" r="5" fill="#1e293b"/>
        <circle cx="67" cy="42" r="5" fill="#1e293b"/>
        <path d="M25 58c5 15 20 22 25 22s20-7 25-22c-15 8-35 8-50 0Z" fill="#1e293b"/>
      </svg>
    ),
  },
  {
    id: "clap",
    label: "Clap",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <circle cx="50" cy="50" r="48" fill="#34d399"/>
        <path d="M35 30l14 14-6 6-14-14Z" fill="#fff"/>
        <path d="M65 30 51 44l6 6 14-14Z" fill="#fff"/>
        <path d="M50 52c-9 0-16 7-16 16v6c0 7 7 12 16 12s16-5 16-12v-6c0-9-7-16-16-16Z" fill="#fff"/>
      </svg>
    ),
  },
  {
    id: "sad",
    label: "Sad",
    render: () => (
      <svg viewBox="0 0 100 100" width="88" height="88">
        <circle cx="50" cy="50" r="48" fill="#60a5fa"/>
        <circle cx="35" cy="45" r="5" fill="#1e293b"/>
        <circle cx="65" cy="45" r="5" fill="#1e293b"/>
        <path d="M30 70c5-10 15-14 20-14s15 4 20 14" stroke="#1e293b" strokeWidth="4" fill="none" strokeLinecap="round"/>
        <path d="M60 55c3 2 5 6 4 10" stroke="#bae6fd" strokeWidth="3" fill="none" strokeLinecap="round"/>
      </svg>
    ),
  },
];

export const STICKERS_BY_ID = Object.fromEntries(STICKERS.map((sticker) => [sticker.id, sticker]));
