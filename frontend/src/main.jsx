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
    navigator.serviceWorker.register('/service-worker.js').catch(() => {})
  })
}
