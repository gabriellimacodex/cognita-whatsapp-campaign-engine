#!/usr/bin/env sh
set -eu

if [ "${AUTO_DB_PUSH:-1}" = "1" ]; then
  PRISMA_BIN="$(ls -d /app/node_modules/.pnpm/prisma@* 2>/dev/null | head -n 1)/node_modules/prisma/build/index.js"

  if [ -f "${PRISMA_BIN}" ]; then
    echo "[bootstrap] Applying Prisma schema (db push --skip-generate)."
    node "${PRISMA_BIN}" db push \
      --accept-data-loss \
      --skip-generate \
      --schema /app/prisma/schema.prisma
  else
    echo "[bootstrap] Prisma CLI not found at ${PRISMA_BIN}. Skipping database bootstrap."
  fi
fi

exec node apps/backend/dist/main.js
