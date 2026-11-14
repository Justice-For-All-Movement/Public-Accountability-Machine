#!/bin/sh
# Container entry: migrate every engine schema, create the first administrator once (when PAM_ADMIN_PASSWORD is set and
# no administrator exists yet), then serve the application with its worker.
set -e
node src/app/main.ts migrate
if [ -n "${PAM_ADMIN_PASSWORD:-}" ]; then
  node src/app/main.ts bootstrap-admin || echo "bootstrap-admin: not run (an administrator already exists or the input is invalid)"
fi
exec node src/app/main.ts serve
