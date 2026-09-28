#!/usr/bin/env bash
# preflight.sh — READ-ONLY inspection of the VPS before we change anything.
# Confirms the chosen port + paths are free and shows existing web/service layout
# so TalkEx slots in WITHOUT disturbing other projects. Changes nothing.
#
# Usage: bash preflight.sh
set -euo pipefail

# ---- edit these to the intended TalkEx values ----
BACKEND_PORT="${BACKEND_PORT:-8100}"
APP_DIR="${APP_DIR:-/opt/talkex/app}"
VENV_DIR="${VENV_DIR:-/opt/talkex/venv}"
DATA_DIR="${DATA_DIR:-/var/lib/talkex}"
WEB_ROOT="${WEB_ROOT:-/var/www/talkex/web}"
SITE_ROOT="${SITE_ROOT:-/var/www/talkex/site}"
ENV_FILE="${ENV_FILE:-/etc/talkex/talkex.env}"
# --------------------------------------------------

line() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

line "OS / kernel"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a

line "Is the chosen backend port ($BACKEND_PORT) free?"
if command -v ss >/dev/null; then
  if ss -ltnp 2>/dev/null | grep -q ":$BACKEND_PORT "; then
    echo "!! PORT $BACKEND_PORT IS IN USE — pick another (see the list below)."
  else
    echo "OK: $BACKEND_PORT is free."
  fi
  echo "-- all listening TCP ports --"
  ss -ltnp 2>/dev/null || true
fi

line "Do TalkEx paths already exist? (they should NOT, except parents)"
for p in "$APP_DIR" "$VENV_DIR" "$DATA_DIR" "$WEB_ROOT" "$SITE_ROOT" "$ENV_FILE"; do
  if [ -e "$p" ]; then echo "EXISTS (inspect before reuse): $p"; else echo "free: $p"; fi
done

line "Web server present?"
command -v nginx >/dev/null && nginx -v 2>&1 || echo "nginx NOT found"
command -v caddy >/dev/null && echo "caddy present: $(caddy version 2>/dev/null)" || true
command -v apache2 >/dev/null && echo "apache2 present" || true

line "Existing nginx sites (do NOT edit these)"
ls -1 /etc/nginx/sites-enabled/ 2>/dev/null || ls -1 /etc/nginx/conf.d/ 2>/dev/null || echo "n/a"
echo "-- server_name entries already claimed --"
grep -rhoE "server_name[^;]+;" /etc/nginx/ 2>/dev/null | sort -u || true

line "Is a global websocket 'connection_upgrade' map already defined?"
grep -rl "connection_upgrade" /etc/nginx/ 2>/dev/null || echo "none — talkex-api.conf will need one added"

line "TLS tooling"
command -v certbot >/dev/null && certbot --version 2>&1 || echo "certbot NOT found"
ls -1 /etc/letsencrypt/live/ 2>/dev/null || echo "no existing certs"

line "Python"
command -v python3 >/dev/null && python3 --version || echo "python3 NOT found"

line "Node (needed to build the web app on the box; else build locally)"
command -v node >/dev/null && node -v || echo "node NOT found — build frontend locally and upload dist"

line "Disk space"
df -h / "$(dirname "$DATA_DIR")" 2>/dev/null | sort -u

line "Done — read-only. Nothing was changed."
