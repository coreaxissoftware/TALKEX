# TalkEx — VPS migration (DRAFT)

Moving TalkEx off **Render (backend)** + **Hostinger (web app & marketing)** onto the
shared VPS, **fully isolated** so nothing already deployed there breaks.

> Status: DRAFT templates. Values in `<ANGLE_BRACKETS>` must be filled from the
> VPS conventions (asked of the "CoreAxis ePOS" session). Nothing here has been
> run on the server yet.

---

## Isolation guarantees (the whole point)

TalkEx lives entirely in its own paths and its own service. No existing project's
files, service, port, vhost, or cert is touched.

| Concern | TalkEx uses (isolated) |
|---|---|
| Backend code | `<APP_DIR>` (default `/opt/talkex/app`) |
| Python venv | `<APP_DIR>/../venv` (default `/opt/talkex/venv`) |
| Persistent data (SQLite + uploads) | `<DATA_DIR>` (default `/var/lib/talkex`) |
| Env / secrets | `<ENV_FILE>` (default `/etc/talkex/talkex.env`, `chmod 600`) |
| systemd service | `talkex-backend.service` (its own unit) |
| Backend port (localhost only) | `<BACKEND_PORT>` (default `127.0.0.1:8100`) — **must be free** |
| Web app static root | `<WEB_ROOT>` (default `/var/www/talkex/web`) |
| Marketing static root | `<SITE_ROOT>` (default `/var/www/talkex/site`) |
| nginx config | own files `talkex-*.conf` in `sites-available` — **no edits to existing vhosts or `nginx.conf`** |
| TLS | Let's Encrypt certs for TalkEx domains only |

**Safety rules while deploying:**
1. Run `preflight.sh` FIRST — it only *reads* (ports in use, existing vhosts,
   disk, whether the chosen port/dirs are taken). Changes nothing.
2. Never edit another project's files. Only ADD new files in the paths above.
3. After any nginx change: `sudo nginx -t` **before** `sudo systemctl reload nginx`.
   A reload (not restart) is graceful and won't drop other sites — but only if
   the config validates, so always `-t` first.
4. `systemctl` only ever targets `talkex-backend` — never other services.

---

## Fill these in (from CoreAxis ePOS / the box)

- `<SSH_HOST>` `<SSH_USER>` `<SSH_PORT>` — VPS connection
- `<OS>` — Ubuntu 22.04 / 24.04 / Debian 12 (changes package names slightly)
- Web server: is it **nginx** already? config dir layout? (these templates assume
  Debian/Ubuntu nginx with `sites-available` + `sites-enabled`)
- TLS: **certbot** already installed? or **Cloudflare** in front (then origin cert
  instead of Let's Encrypt)?
- `<BACKEND_PORT>` — pick one NOT in use (preflight lists busy ports)
- Confirm the base dir convention (`/opt/...` vs `/var/www/...` vs `/srv/...`)

## Frontend code changes needed at cutover (NOT applied yet)

The web build currently points at Render. Before building for the VPS:
- `frontend/.env.production` → `VITE_API_URL=https://api.talkex.in`
- `frontend/index.html` CSP (and `android/app/src/main/assets/public/index.html`
  for the app) — replace `https://talkex-backend.onrender.com` /
  `wss://talkex-backend.onrender.com` with `https://api.talkex.in` /
  `wss://api.talkex.in`. (Grep for `onrender.com` across the repo.)
- Bump `frontend/public/service-worker.js` `SHELL_CACHE` (currently `v66`).

## Backend env changes vs Render

- `CORS_ALLOWED_ORIGINS=https://talkex.in,https://web.talkex.in`
- `DATA_DIR=<DATA_DIR>` (was `/data` on Render)
- **Reuse the same `SECRET_KEY`** from Render, or all users get logged out.
- Copy every other secret (`MSG91_*`, `MAILGUN_*`, `FCM_SERVICE_ACCOUNT_JSON`,
  `TENOR_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`, `LIVEKIT_*`) — see `talkex.env.example`.

---

## DNS records to add (in the domain's DNS panel)

Point at the VPS IP `<VPS_IP>`:

| Type | Name | Value |
|---|---|---|
| A | `@` (talkex.in) | `<VPS_IP>` |
| A | `web` | `<VPS_IP>` |
| A | `api` | `<VPS_IP>` |

(If Cloudflare: proxy can stay ON for web/apex; for `api` with WebSockets, Cloudflare
proxied is fine but start with "DNS only" (grey cloud) while testing, then enable.)

---

## Order of operations (staged, near-zero downtime)

1. `preflight.sh` — inspect the box, confirm free port + free paths. (read-only)
2. `provision.sh` — create dirs, venv, install deps, install systemd unit + nginx
   confs (disabled until DNS + certs ready). Idempotent; touches only TalkEx paths.
3. **Migrate data** — pull SQLite DB + uploads off Render (see `render_export.md`)
   into `<DATA_DIR>`.
4. Fill `<ENV_FILE>` from `talkex.env.example` with real secrets.
5. `systemctl start talkex-backend`; curl `http://127.0.0.1:<BACKEND_PORT>/health`.
6. Add DNS A-records (above). Wait for propagation.
7. `certbot` for the three domains → nginx serves HTTPS.
8. `deploy.sh` — build + place the web app and marketing static files.
9. Verify all three domains over HTTPS (app loads, login works, WS connects,
   a Hindi-named file opens, an upload succeeds).
10. Only then decommission Render (keep it as rollback for a few days).

## Rollback

DNS still has low TTL → repoint back to Render/Hostinger. Nothing on the VPS
touched other projects, so removing `talkex-*` vhosts + `talkex-backend` service
fully reverts TalkEx with zero effect on the rest of the box.
