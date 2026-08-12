# TalkEx Desktop (Windows .exe)

A thin Electron wrapper around the live web app (`https://talkex.coreaxis.cloud`),
so the desktop app always matches the deployed frontend — no per-release rebuild.

## Build the .exe (on Windows)

```bash
cd desktop
npm install
npm run dist
```

Output lands in `desktop/release/`:
- **`TalkEx Setup 1.0.7.exe`** — the NSIS installer (creates Start-menu + desktop shortcuts).
- **`TalkEx 1.0.7.exe`** (portable) — a single-file run-anywhere build.

## Icon

Place a Windows icon at `desktop/build/icon.ico` (256×256 recommended) before
building. You can convert `frontend/public/icon-512.png` to `.ico` with any
converter. Without it, electron-builder uses a default Electron icon.

## Run in dev (without packaging)

```bash
cd desktop
npm install
npm start
```

## Notes
- Camera/mic (for calls) and notifications are granted for the app's own origin.
- To point at a different URL (e.g. staging): `set TALKEX_URL=https://... && npm start`.
- Code-signing: the `.exe` is unsigned by default, so Windows SmartScreen may warn
  on first run. For a warning-free installer you need an Authenticode
  code-signing certificate (add `win.certificateFile` / `certificatePassword` to
  `package.json`'s build config).
