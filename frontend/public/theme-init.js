// Paint the remembered theme's background before React ever mounts, so a
// returning dark-mode user does not see a flash of the light background
// (or vice versa) while the bundle loads. Kept to one property — anything
// more belongs in ui.jsx once React is running.
//
// Lives in its own file (rather than inline in index.html) so it loads as
// a same-origin <script src>, which a `script-src 'self'` CSP allows —
// an inline <script> block would need 'unsafe-inline' or a content hash,
// both of which either weaken the policy or break the moment this file's
// contents change.
(function () {
  try {
    var isDark = localStorage.getItem("ht_theme") === "dark";
    document.body.style.background = isDark ? "#0b1420" : "#f5f9fc";
  } catch (e) { /* localStorage blocked — light default stands */ }
})();
