#!/usr/bin/env bash
# provision.sh — FIRST-TIME setup for TalkEx on the VPS. Idempotent; touches ONLY
# TalkEx paths/units/vhosts. Run after preflight.sh confirms the port + paths are free.
#
#   sudo bash provision.sh
#
# It does NOT obtain TLS certs (do that with certbot after DNS resolves) and does
# NOT start the backend until you've placed the env file + migrated data.
set -euo pipefail

# ---- config (match preflight.sh / the .conf + .service placeholders) ----
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"   # the checked-out repo
APP_DIR="${APP_DIR:-/opt/talkex/app}"
VENV_DIR="${VENV_DIR:-/opt/talkex/venv}"
DATA_DIR="${DATA_DIR:-/var/lib/talkex}"
ENV_DIR="${ENV_DIR:-/etc/talkex}"
ENV_FILE="${ENV_FILE:-$ENV_DIR/talkex.env}"
SERVICE_USER="${SERVICE_USER:-talkex}"
BACKEND_PORT="${BACKEND_PORT:-8100}"
# ------------------------------------------------------------------------

echo ">> dedicated service user ($SERVICE_USER)"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"

echo ">> directories (TalkEx only)"
mkdir -p "$APP_DIR" "$DATA_DIR" "$ENV_DIR" /var/www/talkex/web /var/www/talkex/site

echo ">> sync backend code into $APP_DIR (from $REPO_DIR)"
# rsync keeps it self-contained; excludes local junk. Frontend/website are built
# and placed by deploy.sh, not run from here.
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '__pycache__' \
  "$REPO_DIR/backend/" "$APP_DIR/backend/"

echo ">> python venv + deps"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$APP_DIR/backend/requirements.txt"

echo ">> ownership"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR" "$VENV_DIR" "$DATA_DIR"

echo ">> env file skeleton (fill secrets, then chmod 600)"
if [ ! -f "$ENV_FILE" ]; then
  cp "$(dirname "$0")/talkex.env.example" "$ENV_FILE"
  chown "$SERVICE_USER":"$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   created $ENV_FILE — EDIT IT with real values (esp. SECRET_KEY from Render)."
else
  echo "   $ENV_FILE already exists — left untouched."
fi

echo ">> systemd unit (talkex-backend) — not started yet"
sed -e "s#<APP_DIR>#$APP_DIR#g" -e "s#<VENV_DIR>#$VENV_DIR#g" \
    -e "s#<DATA_DIR>#$DATA_DIR#g" -e "s#<ENV_FILE>#$ENV_FILE#g" \
    -e "s#<SERVICE_USER>#$SERVICE_USER#g" -e "s#<SERVICE_GROUP>#$SERVICE_USER#g" \
    -e "s#<BACKEND_PORT>#$BACKEND_PORT#g" \
    "$(dirname "$0")/talkex-backend.service" > /etc/systemd/system/talkex-backend.service
systemctl daemon-reload
echo "   installed. Start later with: systemctl enable --now talkex-backend"

echo ">> nginx vhosts (installed but only reloaded after 'nginx -t' passes)"
for f in talkex-api talkex-web talkex-site; do
  sed -e "s#<BACKEND_PORT>#$BACKEND_PORT#g" \
      -e "s#<WEB_ROOT>#/var/www/talkex/web#g" \
      -e "s#<SITE_ROOT>#/var/www/talkex/site#g" \
      "$(dirname "$0")/nginx/$f.conf" > "/etc/nginx/sites-available/$f.conf"
  ln -sf "../sites-available/$f.conf" "/etc/nginx/sites-enabled/$f.conf"
done
echo "   validate + reload:  sudo nginx -t && sudo systemctl reload nginx"

cat <<EOF

>> NEXT (manual, in order):
   1) Fill $ENV_FILE with real secrets (reuse Render's SECRET_KEY).
   2) Migrate data into $DATA_DIR  (see render_export.md).
   3) systemctl enable --now talkex-backend
      curl -f http://127.0.0.1:$BACKEND_PORT/health
   4) Add DNS A-records for talkex.in / web / api -> this VPS.
   5) certbot --nginx -d talkex.in -d www.talkex.in -d web.talkex.in -d api.talkex.in
   6) bash deploy.sh   (build + place the web app and marketing static files)
Nothing other than TalkEx paths/units/vhosts was created.
EOF
