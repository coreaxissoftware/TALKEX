import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { I18nProvider } from './i18n.jsx'
import './locales/en.js'
import './locales/hi.js'
import { ensureLocaleLoaded } from './i18n.jsx'

ensureLocaleLoaded(localStorage.getItem("talkex_lang"));

// ── App-like touch behaviour (WhatsApp parity) ───────────────────────────────
// Two native browser behaviours fight the app's own long-press / right-click
// menus and make it feel like a web page instead of a messenger:
//   1. Right-click (desktop) and touch-and-hold (phone) pop the *browser's*
//      context menu (Back / Reload / Save-as / Inspect …) over our own menu.
//   2. Touch-and-hold also starts a native text/row selection (the blue
//      highlight + selection handles) and, on mobile, the long-press callout
//      (image "save"/"copy" bubble) — so the custom menu opens on top of an
//      accidental selection.
// A real messenger suppresses both everywhere except where typing/pasting is
// genuinely wanted (the composer and other inputs). Copying message text still
// works — it's done through our own menu's Copy action, not a drag-select.
(function installAppLikeInput() {
  const style = document.createElement("style");
  style.textContent = `
    html, body, #root {
      -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
    }
    /* Re-enable selection/callout only where it's actually useful: form fields,
       editable regions, and anything explicitly opted in with data-selectable. */
    input, textarea, [contenteditable="true"], [contenteditable=""],
    [data-selectable], .tx-selectable, .tx-selectable * {
      -webkit-user-select: text; -moz-user-select: text; -ms-user-select: text; user-select: text;
      -webkit-touch-callout: default;
    }
    @keyframes txRecBlink { 50% { opacity: 0.2; } }
    @keyframes txCamSpin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);

  // Kill the native context menu, but leave it on inputs/editable so the
  // composer keeps its paste / spell-check menu. The app's own bubble and
  // chat-row handlers run first (on the target, before this bubbles to
  // window) and open the custom menu; this only stops the browser fallback
  // on everything else.
  window.addEventListener("contextmenu", (event) => {
    const el = event.target;
    if (el && el.closest && el.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [data-selectable], .tx-selectable')) {
      return;
    }
    event.preventDefault();
  });
})();

// Self-heal a stale PWA after a new deploy: when a lazily-imported chunk 404s
// (an already-open app's old index.html points at a hashed file the new build
// replaced), Vite fires `vite:preloadError`. Reload once to pull the fresh
// index + chunks instead of showing the "Something broke" screen. The 10s
// timestamp guard prevents a reload loop while still allowing recovery on each
// future deploy.
window.addEventListener("vite:preloadError", () => {
  const last = Number(sessionStorage.getItem("tx_preload_reload_at") || 0);
  if (Date.now() - last > 10000) {
    sessionStorage.setItem("tx_preload_reload_at", String(Date.now()));
    window.location.reload();
  }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>
)

// Registered unconditionally, not just when push notifications are turned
// on (push.js's enablePush() also registers the same script — calling
// register() twice with the same URL/scope is a no-op, it just hands back
// the existing registration). This is what lets the app shell itself load
// with no connection; push subscribing is a separate, later, opt-in step
// on top of the same worker. Deferred off the initial paint and swallowed
// on failure (unsupported browser, blocked storage) since this is a pure
// enhancement — the app already works without it, just not offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').then((registration) => {
      // service-worker.js has a fixed filename — unlike the hashed JS/CSS
      // bundle, a plain static host (no explicit no-cache header on this
      // one file, which most shared-hosting file-manager uploads don't
      // set) can keep serving browsers the OLD script indefinitely, so a
      // real deploy with an actual bug fix in this file never reaches
      // anyone already running the app. The spec has browsers check for
      // updates on navigation, but that check is itself subject to
      // whatever caching this file's response carries — calling
      // update() explicitly forces a real revalidation request every
      // load, the same way a version-checked native app would.
      registration.update().catch(() => {})
    }).catch(() => {})
  })
}
