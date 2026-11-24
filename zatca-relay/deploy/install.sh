#!/usr/bin/env bash
# SA'DA H2O — install / update the ZATCA signing relay on the relay server
# (same box and same PM2 setup as the SMS relay).
#
# Run as root from the copied zatca-relay folder:
#     bash deploy/install.sh
#
# Safe to re-run for updates: it replaces the code, but NEVER touches an existing
# .env or the secrets/ folder (private key + ZATCA certificates).
#
# Options (environment variables):
#     APP_DIR=/root/zatca-relay   where the relay lives            (default shown)
#     ZATCA_ENV=simulation        only used when creating a new .env (core = PRODUCTION)
#     PORT=8791                   only used when creating a new .env
#     SKIP_PM2=1                  install + self-test only, do not start under PM2
#
# Production (core) relay beside the simulation one, as a separate copy:
#     APP_DIR=/root/zatca-relay-prod ZATCA_ENV=core PORT=8792 bash deploy/install.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/root/zatca-relay}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEW_ENV="${ZATCA_ENV:-simulation}"
NEW_PORT="${PORT:-8791}"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

say "Checking the server"
command -v node >/dev/null    || die "Node.js is not installed. Install Node 18 or newer first (the SMS relay box already has it)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ]      || die "Node $(node -v) is too old — Node 18 or newer is required."
ok "Node $(node -v)"
command -v npm >/dev/null     || die "npm is not installed."
command -v openssl >/dev/null || die "openssl is not installed (needed to create the ZATCA key and CSR)."
openssl ecparam -list_curves 2>/dev/null | grep -q secp256k1 || die "This openssl build has no secp256k1 curve, which ZATCA requires."
ok "openssl with secp256k1"

say "Copying the relay to $APP_DIR"
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rm -rf "$APP_DIR/src" "$APP_DIR/test" "$APP_DIR/deploy"
  cp -r "$SRC_DIR/src" "$SRC_DIR/test" "$SRC_DIR/deploy" "$SRC_DIR/package.json" "$APP_DIR/"
  [ -f "$SRC_DIR/README.md" ] && cp "$SRC_DIR/README.md" "$APP_DIR/"
  [ -f "$SRC_DIR/.env.example" ] && cp "$SRC_DIR/.env.example" "$APP_DIR/"
fi
ok "code in place"

say "Installing dependencies"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
ok "npm packages installed"

say "Secrets folder"
mkdir -p "$APP_DIR/secrets"
chmod 700 "$APP_DIR/secrets"
ok "$APP_DIR/secrets (private — only root can read it)"

say "Configuration (.env)"
CREATED_ENV=0
if [ -f "$APP_DIR/.env" ]; then
  ok ".env already exists — left unchanged"
else
  KEY="$(openssl rand -hex 32)"
  sed -e "s|^ZATCA_ENV=.*|ZATCA_ENV=$NEW_ENV|" \
      -e "s|^RELAY_API_KEY=.*|RELAY_API_KEY=$KEY|" \
      -e "s|^CERT_DIR=.*|CERT_DIR=$APP_DIR/secrets|" \
      -e "s|^PORT=.*|PORT=$NEW_PORT|" \
      "$APP_DIR/deploy/env.template" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  CREATED_ENV=1
  ok "created .env (ZATCA_ENV=$NEW_ENV, PORT=$NEW_PORT, new random RELAY_API_KEY)"
fi

say "Self-test (crypto, no ZATCA calls)"
( cd "$APP_DIR" && node test/selftest.js | tail -1 )

if [ "${SKIP_PM2:-0}" = "1" ]; then
  say "SKIP_PM2=1 — not starting the service"
else
  say "Starting under PM2"
  command -v pm2 >/dev/null || { npm install -g pm2 --no-audit --no-fund --loglevel=error; ok "installed pm2"; }
  PM2_NAME="$(cd "$APP_DIR" && node -p "require('./deploy/ecosystem.config.js').apps[0].name")"
  ( cd "$APP_DIR" && pm2 startOrReload deploy/ecosystem.config.js --update-env )
  pm2 save >/dev/null
  ok "$PM2_NAME running (pm2 logs $PM2_NAME to watch it)"
  sleep 2
  PORT_NUM="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d ' ' || true)"
  PORT_NUM="${PORT_NUM:-8791}"
  if curl -fsS "http://127.0.0.1:$PORT_NUM/health" >/dev/null 2>&1; then
    ok "health check passed on 127.0.0.1:$PORT_NUM"
  else
    printf '    \033[33m!\033[0m health check failed — run: pm2 logs $PM2_NAME --lines 50\n'
  fi
fi

say "Done"
if [ "$CREATED_ENV" = "1" ]; then
  echo "    Relay key (paste into Cloudflare as the Worker secret ZATCA_RELAY_KEY):"
  echo "        $(grep -E '^RELAY_API_KEY=' "$APP_DIR/.env" | cut -d= -f2)"
fi
echo "    Next:"
echo "      1. Edit $APP_DIR/.env: set EGS_ORG_UNIT_NAME to Saadat Alarab's 10-digit tax number,"
echo "         then: pm2 restart ${PM2_NAME:-zatca-relay} --update-env"
echo "      2. nginx + HTTPS for this relay's hostname — deploy/SETUP.md step 4 (production: 'Going live')"
echo "      3. Cloudflare Worker secrets ZATCA_RELAY_URL and ZATCA_RELAY_KEY — SETUP.md step 5"
