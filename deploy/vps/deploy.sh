#!/usr/bin/env bash
# deploy.sh — routine update: refresh backend code + deps, rebuild & place the web
# app and marketing site, restart ONLY the TalkEx backend. Isolated; no other
# service or vhost is touched.
#
#   bash deploy.sh            # full: backend + web + site
#   bash deploy.sh backend    # just the API
#   bash deploy.sh web        # just the web app
#   bash deploy.sh site       # just the marketing site
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
APP_DIR="${APP_DIR:-/opt/talkex/app}"
VENV_DIR="${VENV_DIR:-/opt/talkex/venv}"
WEB_ROOT="${WEB_ROOT:-/var/www/talkex/web}"
SITE_ROOT="${SITE_ROOT:-/var/www/talkex/site}"
SERVICE_USER="${SERVICE_USER:-talkex}"
WHAT="${1:-all}"

build_web() {
  echo ">> build web app (VITE_API_URL must point at api.talkex.in)"
  # frontend/.env.production should already read VITE_API_URL=https://api.talkex.in
  ( cd "$REPO_DIR/frontend" && npm ci && npm run build )
  echo ">> place web app -> $WEB_ROOT"
  rsync -a --delete "$REPO_DIR/frontend/dist/" "$WEB_ROOT/"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$WEB_ROOT"
}

build_site() {
  echo ">> build marketing site"
  ( cd "$REPO_DIR/website" && python3 build.py )
  echo ">> place marketing -> $SITE_ROOT"
  rsync -a --delete "$REPO_DIR/website/deploy/" "$SITE_ROOT/"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$SITE_ROOT"
}

update_backend() {
  echo ">> sync backend code -> $APP_DIR/backend"
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude '__pycache__' \
    "$REPO_DIR/backend/" "$APP_DIR/backend/"
  "$VENV_DIR/bin/pip" install -r "$APP_DIR/backend/requirements.txt"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"
  echo ">> restart talkex-backend"
  sudo systemctl restart talkex-backend
  sleep 2
  sudo systemctl --no-pager status talkex-backend | head -n 5
}

case "$WHAT" in
  all)     update_backend; build_web; build_site ;;
  backend) update_backend ;;
  web)     build_web ;;
  site)    build_site ;;
  *) echo "usage: deploy.sh [all|backend|web|site]"; exit 1 ;;
esac

echo ">> done ($WHAT). If web/site changed, they're live immediately (static)."
