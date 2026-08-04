import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
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
