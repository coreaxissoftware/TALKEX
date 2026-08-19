// Built-in sticker packs — hand-drawn SVG, no external CDN.
// Users can enable/disable packs via the sticker picker. Preferences
// are stored in localStorage under "talkex_sticker_packs".

export const STICKER_PACKS = [
  {
    id: "classic",
    name: "Classic",
    icon: "😊",
    builtin: true,
    stickers: [
      {
        id: "heart", label: "Heart",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <path d="M50 88 C20 65 5 45 5 28 C5 12 18 2 32 2 C42 2 48 8 50 14 C52 8 58 2 68 2 C82 2 95 12 95 28 C95 45 80 65 50 88 Z" fill="#fb7185"/>
          </svg>
        ),
      },
      {
        id: "fire", label: "Fire",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <path d="M50 96c-24 0-38-16-38-35 0-15 9-26 9-26s3 9 10 9c-3-11 2-26 16-35-2 11 3 17 8 17 8 0 6-10 6-10s18 13 18 37c0 3-1 6-1 9 5-4 7-9 7-15 9 9 14 21 14 32 0 21-19 35-49 35Z" fill="#fb923c"/>
            <path d="M50 86c-12 0-19-8-19-17 0-6 3-12 3-12s2 4 6 4c-2-6 1-13 8-17-1 5 2 8 4 8 4 0 3-4 3-4s9 6 9 17c0 9-8 17-14 21Z" fill="#fde047"/>
          </svg>
        ),
      },
      {
        id: "star", label: "Star",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <polygon points="50,4 61,37 96,37 68,58 79,92 50,72 21,92 32,58 4,37 39,37" fill="#fbbf24"/>
          </svg>
        ),
      },
      {
        id: "thumbsup", label: "Thumbs up",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="50" r="48" fill="#38bdf8"/>
            <path d="M35 45h-8a4 4 0 0 0-4 4v28a4 4 0 0 0 4 4h8Zm4 0v36h30a6 6 0 0 0 6-5l4-20a6 6 0 0 0-6-7H55l3-13a6 6 0 0 0-6-8Z" fill="#fff"/>
          </svg>
        ),
      },
      {
        id: "party", label: "Party",
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
        id: "laugh", label: "Laughing",
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
        id: "clap", label: "Clap",
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
        id: "sad", label: "Sad",
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
    ],
  },
  {
    id: "animated",
    name: "Animated",
    icon: "✨",
    builtin: true,
    stickers: [
      {
        id: "anim_heart_beat", label: "Heartbeat", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <g>
              <path d="M50 88 C20 65 5 45 5 28 C5 12 18 2 32 2 C42 2 48 8 50 14 C52 8 58 2 68 2 C82 2 95 12 95 28 C95 45 80 65 50 88 Z" fill="#fb7185"/>
              <animateTransform attributeName="transform" type="scale" values="1;1.15;1;0.95;1" dur="1s" repeatCount="indefinite" additive="sum" origin="50 50"/>
              <animate attributeName="opacity" values="1;0.85;1" dur="1s" repeatCount="indefinite"/>
            </g>
          </svg>
        ),
      },
      {
        id: "anim_waving", label: "Waving", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="50" r="48" fill="#fbbf24"/>
            <circle cx="35" cy="42" r="5" fill="#1e293b"/>
            <circle cx="65" cy="42" r="5" fill="#1e293b"/>
            <path d="M32 62c4 8 10 12 18 12s14-4 18-12" stroke="#1e293b" strokeWidth="3" fill="none" strokeLinecap="round"/>
            <g>
              <path d="M82 20c2-8 6-14 10-14s6 3 6 8c0 4-4 12-8 16l-4 6c-2-4-4-10-4-16Z" fill="#fbbf24" stroke="#e5a000" strokeWidth="1.5"/>
              <animateTransform attributeName="transform" type="rotate" values="0 86 30;-20 86 30;20 86 30;-20 86 30;0 86 30" dur="1s" repeatCount="indefinite"/>
            </g>
          </svg>
        ),
      },
      {
        id: "anim_spin_star", label: "Spinning Star", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <g>
              <polygon points="50,4 61,37 96,37 68,58 79,92 50,72 21,92 32,58 4,37 39,37" fill="#fbbf24"/>
              <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="3s" repeatCount="indefinite"/>
            </g>
          </svg>
        ),
      },
      {
        id: "anim_lol", label: "LOL", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="50" r="48" fill="#fde047"/>
            <g>
              <circle cx="33" cy="42" r="5" fill="#1e293b"/>
              <circle cx="67" cy="42" r="5" fill="#1e293b"/>
              <path d="M25 58c5 15 20 22 25 22s20-7 25-22c-15 8-35 8-50 0Z" fill="#1e293b"/>
              <animateTransform attributeName="transform" type="rotate" values="-3 50 50;3 50 50;-3 50 50" dur="0.3s" repeatCount="indefinite"/>
            </g>
          </svg>
        ),
      },
      {
        id: "anim_rocket", label: "Rocket", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <g>
              <path d="M50 8c-8 12-14 28-14 42v20l14 10 14-10V50c0-14-6-30-14-42Z" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.5"/>
              <circle cx="50" cy="45" r="6" fill="#38bdf8"/>
              <path d="M36 55l-10 15 10 5Z" fill="#fb923c"/>
              <path d="M64 55l10 15-10 5Z" fill="#fb923c"/>
              <path d="M42 72c0 0 2 14 8 18 6-4 8-18 8-18" fill="#fb923c">
                <animate attributeName="d" values="M42 72c0 0 2 14 8 18 6-4 8-18 8-18;M42 72c0 0 4 18 8 24 4-6 8-24 8-24;M42 72c0 0 2 14 8 18 6-4 8-18 8-18" dur="0.4s" repeatCount="indefinite"/>
              </path>
              <path d="M44 72c0 0 2 10 6 14 4-4 6-14 6-14" fill="#fde047">
                <animate attributeName="d" values="M44 72c0 0 2 10 6 14 4-4 6-14 6-14;M44 72c0 0 3 14 6 18 3-4 6-18 6-18;M44 72c0 0 2 10 6 14 4-4 6-14 6-14" dur="0.3s" repeatCount="indefinite"/>
              </path>
              <animateTransform attributeName="transform" type="translate" values="0,2;0,-2;0,2" dur="0.6s" repeatCount="indefinite"/>
            </g>
          </svg>
        ),
      },
      {
        id: "anim_confetti", label: "Confetti", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="50" r="48" fill="#a78bfa"/>
            <text x="50" y="58" textAnchor="middle" fontSize="32" fill="#fff">🎉</text>
            {[
              { cx: 20, delay: "0s", color: "#fb7185", dy: 80 },
              { cx: 35, delay: "0.2s", color: "#fde047", dy: 75 },
              { cx: 50, delay: "0.4s", color: "#34d399", dy: 85 },
              { cx: 65, delay: "0.1s", color: "#38bdf8", dy: 70 },
              { cx: 80, delay: "0.3s", color: "#fb923c", dy: 78 },
            ].map(({ cx, delay, color, dy }) => (
              <rect key={cx} x={cx - 2} width="4" height="4" rx="1" fill={color}>
                <animate attributeName="y" values={`-5;${dy}`} dur="1.5s" begin={delay} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="1;0" dur="1.5s" begin={delay} repeatCount="indefinite"/>
                <animateTransform attributeName="transform" type="rotate" values={`0 ${cx} 0;${cx > 50 ? 180 : -180} ${cx} 40`} dur="1.5s" begin={delay} repeatCount="indefinite"/>
              </rect>
            ))}
          </svg>
        ),
      },
      {
        id: "anim_flame", label: "Flames", animated: true,
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <path d="M50 96c-24 0-38-16-38-35 0-15 9-26 9-26s3 9 10 9c-3-11 2-26 16-35-2 11 3 17 8 17 8 0 6-10 6-10s18 13 18 37c0 3-1 6-1 9 5-4 7-9 7-15 9 9 14 21 14 32 0 21-19 35-49 35Z" fill="#fb923c">
              <animate attributeName="d" values="M50 96c-24 0-38-16-38-35 0-15 9-26 9-26s3 9 10 9c-3-11 2-26 16-35-2 11 3 17 8 17 8 0 6-10 6-10s18 13 18 37c0 3-1 6-1 9 5-4 7-9 7-15 9 9 14 21 14 32 0 21-19 35-49 35Z;M50 94c-22 0-36-14-36-33 0-13 8-24 8-24s4 10 11 10c-2-12 3-27 17-36-1 12 4 18 9 18 7 0 5-11 5-11s19 14 19 38c0 2-1 5-1 8 4-3 6-8 6-14 10 10 15 22 15 33 0 20-20 33-53 33Z;M50 96c-24 0-38-16-38-35 0-15 9-26 9-26s3 9 10 9c-3-11 2-26 16-35-2 11 3 17 8 17 8 0 6-10 6-10s18 13 18 37c0 3-1 6-1 9 5-4 7-9 7-15 9 9 14 21 14 32 0 21-19 35-49 35Z" dur="0.8s" repeatCount="indefinite"/>
            </path>
            <path d="M50 86c-12 0-19-8-19-17 0-6 3-12 3-12s2 4 6 4c-2-6 1-13 8-17-1 5 2 8 4 8 4 0 3-4 3-4s9 6 9 17c0 9-8 17-14 21Z" fill="#fde047">
              <animate attributeName="opacity" values="1;0.7;1" dur="0.5s" repeatCount="indefinite"/>
            </path>
          </svg>
        ),
      },
    ],
  },
  {
    id: "animals",
    name: "Animals",
    icon: "🐾",
    builtin: true,
    stickers: [
      {
        id: "cat", label: "Cat",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="54" r="40" fill="#fbbf24"/>
            <polygon points="18,30 12,2 38,22" fill="#fbbf24"/>
            <polygon points="82,30 88,2 62,22" fill="#fbbf24"/>
            <circle cx="36" cy="48" r="5" fill="#1e293b"/>
            <circle cx="64" cy="48" r="5" fill="#1e293b"/>
            <ellipse cx="50" cy="60" rx="4" ry="3" fill="#fb7185"/>
            <path d="M46 63c2 3 6 3 8 0" stroke="#1e293b" strokeWidth="2" fill="none"/>
            <line x1="14" y1="52" x2="34" y2="55" stroke="#1e293b" strokeWidth="1.5"/>
            <line x1="14" y1="58" x2="34" y2="58" stroke="#1e293b" strokeWidth="1.5"/>
            <line x1="86" y1="52" x2="66" y2="55" stroke="#1e293b" strokeWidth="1.5"/>
            <line x1="86" y1="58" x2="66" y2="58" stroke="#1e293b" strokeWidth="1.5"/>
          </svg>
        ),
      },
      {
        id: "dog", label: "Dog",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="54" r="40" fill="#d4a574"/>
            <ellipse cx="28" cy="30" rx="14" ry="20" fill="#a0744a" transform="rotate(-15 28 30)"/>
            <ellipse cx="72" cy="30" rx="14" ry="20" fill="#a0744a" transform="rotate(15 72 30)"/>
            <circle cx="36" cy="48" r="5" fill="#1e293b"/>
            <circle cx="64" cy="48" r="5" fill="#1e293b"/>
            <ellipse cx="50" cy="62" rx="8" ry="6" fill="#1e293b"/>
            <path d="M42 70c3 5 13 5 16 0" stroke="#1e293b" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        id: "bear", label: "Bear",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="26" cy="24" r="14" fill="#92400e"/>
            <circle cx="74" cy="24" r="14" fill="#92400e"/>
            <circle cx="26" cy="24" r="8" fill="#b45309"/>
            <circle cx="74" cy="24" r="8" fill="#b45309"/>
            <circle cx="50" cy="54" r="40" fill="#b45309"/>
            <ellipse cx="50" cy="62" rx="18" ry="14" fill="#d4a574"/>
            <circle cx="36" cy="48" r="4" fill="#1e293b"/>
            <circle cx="64" cy="48" r="4" fill="#1e293b"/>
            <ellipse cx="50" cy="58" rx="5" ry="4" fill="#1e293b"/>
          </svg>
        ),
      },
      {
        id: "penguin", label: "Penguin",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <ellipse cx="50" cy="55" rx="32" ry="40" fill="#1e293b"/>
            <ellipse cx="50" cy="60" rx="22" ry="30" fill="#fff"/>
            <circle cx="38" cy="42" r="4" fill="#fff"/>
            <circle cx="62" cy="42" r="4" fill="#fff"/>
            <circle cx="38" cy="42" r="2.5" fill="#1e293b"/>
            <circle cx="62" cy="42" r="2.5" fill="#1e293b"/>
            <polygon points="50,50 44,56 56,56" fill="#fb923c"/>
            <ellipse cx="24" cy="60" rx="8" ry="16" fill="#1e293b" transform="rotate(20 24 60)"/>
            <ellipse cx="76" cy="60" rx="8" ry="16" fill="#1e293b" transform="rotate(-20 76 60)"/>
          </svg>
        ),
      },
      {
        id: "bunny", label: "Bunny",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <ellipse cx="38" cy="22" rx="8" ry="22" fill="#f9a8d4"/>
            <ellipse cx="62" cy="22" rx="8" ry="22" fill="#f9a8d4"/>
            <ellipse cx="38" cy="22" rx="5" ry="18" fill="#fce7f3"/>
            <ellipse cx="62" cy="22" rx="5" ry="18" fill="#fce7f3"/>
            <circle cx="50" cy="58" r="36" fill="#fce7f3"/>
            <circle cx="37" cy="52" r="4" fill="#1e293b"/>
            <circle cx="63" cy="52" r="4" fill="#1e293b"/>
            <ellipse cx="50" cy="62" rx="3" ry="2.5" fill="#fb7185"/>
            <path d="M47 65c1 2 5 2 6 0" stroke="#1e293b" strokeWidth="1.5" fill="none"/>
          </svg>
        ),
      },
    ],
  },
  {
    id: "food",
    name: "Food",
    icon: "🍔",
    builtin: true,
    stickers: [
      {
        id: "pizza", label: "Pizza",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <path d="M50 10 L10 90 L90 90 Z" fill="#fbbf24"/>
            <path d="M50 10 L10 90 L90 90 Z" fill="none" stroke="#d97706" strokeWidth="3"/>
            <circle cx="40" cy="55" r="6" fill="#ef4444"/>
            <circle cx="60" cy="65" r="5" fill="#ef4444"/>
            <circle cx="50" cy="40" r="5" fill="#ef4444"/>
            <circle cx="45" cy="75" r="4" fill="#22c55e"/>
          </svg>
        ),
      },
      {
        id: "coffee", label: "Coffee",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <rect x="22" y="34" width="50" height="52" rx="6" fill="#92400e"/>
            <rect x="26" y="34" width="42" height="10" rx="3" fill="#78350f"/>
            <path d="M72 48c10 0 16 6 16 14s-6 14-16 14" stroke="#92400e" strokeWidth="5" fill="none"/>
            <rect x="20" y="86" width="54" height="6" rx="3" fill="#78350f"/>
            <path d="M36 30c2-6 4-10 4-14" stroke="#a8a29e" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <path d="M47 28c2-6 4-10 4-14" stroke="#a8a29e" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
            <path d="M58 30c2-6 4-10 4-14" stroke="#a8a29e" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        id: "cake", label: "Cake",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <rect x="18" y="50" width="64" height="36" rx="8" fill="#f9a8d4"/>
            <rect x="18" y="50" width="64" height="12" rx="6" fill="#fb7185"/>
            <path d="M18 56c8-6 16 2 24-4s16 2 24-4 8 2 16-4" stroke="#fce7f3" strokeWidth="3" fill="none"/>
            <rect x="46" y="30" width="8" height="22" rx="2" fill="#fbbf24"/>
            <ellipse cx="50" cy="28" rx="5" ry="6" fill="#fb923c"/>
            <ellipse cx="50" cy="24" rx="2" ry="4" fill="#fde047"/>
            <rect x="18" y="82" width="64" height="8" rx="4" fill="#e879a8"/>
          </svg>
        ),
      },
      {
        id: "icecream", label: "Ice cream",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <polygon points="50,96 30,45 70,45" fill="#d4a574"/>
            <circle cx="50" cy="36" r="20" fill="#f9a8d4"/>
            <circle cx="36" cy="30" r="14" fill="#a78bfa"/>
            <circle cx="64" cy="30" r="14" fill="#86efac"/>
            <circle cx="50" cy="22" r="14" fill="#fde047"/>
            <circle cx="42" cy="18" r="3" fill="#ef4444"/>
          </svg>
        ),
      },
    ],
  },
  {
    id: "weather",
    name: "Weather",
    icon: "🌤",
    builtin: true,
    stickers: [
      {
        id: "sunny", label: "Sunny",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <circle cx="50" cy="50" r="22" fill="#fbbf24"/>
            {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
              <line key={angle} x1="50" y1="50" x2={50 + 38 * Math.cos(angle * Math.PI / 180)} y2={50 + 38 * Math.sin(angle * Math.PI / 180)} stroke="#fbbf24" strokeWidth="4" strokeLinecap="round"/>
            ))}
            <circle cx="42" cy="46" r="3" fill="#1e293b"/>
            <circle cx="58" cy="46" r="3" fill="#1e293b"/>
            <path d="M40 56c4 6 16 6 20 0" stroke="#1e293b" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        id: "rainy", label: "Rainy",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <ellipse cx="50" cy="38" rx="30" ry="20" fill="#94a3b8"/>
            <circle cx="30" cy="34" r="16" fill="#94a3b8"/>
            <circle cx="68" cy="36" r="14" fill="#94a3b8"/>
            <line x1="30" y1="62" x2="26" y2="78" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round"/>
            <line x1="45" y1="62" x2="41" y2="82" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round"/>
            <line x1="60" y1="62" x2="56" y2="78" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round"/>
            <line x1="75" y1="60" x2="71" y2="74" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        id: "rainbow", label: "Rainbow",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <path d="M10 80 A40 40 0 0 1 90 80" fill="none" stroke="#ef4444" strokeWidth="6"/>
            <path d="M16 80 A34 34 0 0 1 84 80" fill="none" stroke="#fb923c" strokeWidth="5"/>
            <path d="M22 80 A28 28 0 0 1 78 80" fill="none" stroke="#fbbf24" strokeWidth="5"/>
            <path d="M28 80 A22 22 0 0 1 72 80" fill="none" stroke="#22c55e" strokeWidth="5"/>
            <path d="M34 80 A16 16 0 0 1 66 80" fill="none" stroke="#3b82f6" strokeWidth="5"/>
            <path d="M40 80 A10 10 0 0 1 60 80" fill="none" stroke="#8b5cf6" strokeWidth="5"/>
            <ellipse cx="16" cy="82" rx="10" ry="7" fill="#e2e8f0"/>
            <ellipse cx="84" cy="82" rx="10" ry="7" fill="#e2e8f0"/>
          </svg>
        ),
      },
      {
        id: "snowflake", label: "Snowflake",
        render: () => (
          <svg viewBox="0 0 100 100" width="88" height="88">
            <g stroke="#60a5fa" strokeWidth="3" strokeLinecap="round" fill="none">
              <line x1="50" y1="8" x2="50" y2="92"/>
              <line x1="14" y1="29" x2="86" y2="71"/>
              <line x1="14" y1="71" x2="86" y2="29"/>
              <line x1="50" y1="20" x2="40" y2="14"/><line x1="50" y1="20" x2="60" y2="14"/>
              <line x1="50" y1="80" x2="40" y2="86"/><line x1="50" y1="80" x2="60" y2="86"/>
              <line x1="26" y1="36" x2="20" y2="26"/><line x1="74" y1="64" x2="80" y2="74"/>
              <line x1="26" y1="64" x2="20" y2="74"/><line x1="74" y1="36" x2="80" y2="26"/>
            </g>
          </svg>
        ),
      },
    ],
  },
];

export function getEnabledPacks() {
  try {
    const stored = localStorage.getItem("talkex_sticker_packs");
    if (stored) return JSON.parse(stored);
  } catch {}
  return STICKER_PACKS.map((p) => p.id);
}

export function setEnabledPacks(ids) {
  localStorage.setItem("talkex_sticker_packs", JSON.stringify(ids));
}

// Flat exports for backward compatibility.
export const STICKERS = STICKER_PACKS[0].stickers;
export const ANIMATED_STICKERS = STICKER_PACKS[1].stickers;
export const ALL_STICKERS = STICKER_PACKS.flatMap((p) => p.stickers);
export const STICKERS_BY_ID = Object.fromEntries(ALL_STICKERS.map((s) => [s.id, s]));
