#!/usr/bin/env bash
# One-command local start after configuration: installs pinned engines, migrates, bootstraps the first administrator
# once, then serves the application with its worker. Requires Node 24, PostgreSQL 16, and the tools listed in README.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Create .env from .env.example first." >&2; exit 2; }
set -a; . ./.env; set +a
npm ci --no-audit --no-fund
[ -d engines ] || node scripts/bootstrap-engines.mjs
node src/app/main.ts migrate
if [ ! -f "${PAM_DATA_DIR:-./data}/.bootstrapped" ]; then
  mkdir -p "${PAM_DATA_DIR:-./data}"
  node src/app/main.ts bootstrap-admin && touch "${PAM_DATA_DIR:-./data}/.bootstrapped"
fi
exec node src/app/main.ts serve
