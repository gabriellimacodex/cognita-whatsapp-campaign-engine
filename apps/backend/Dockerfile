FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --recursive --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @cognita-campaign/backend... build
RUN pnpm prisma generate --schema=prisma/schema.prisma \
    && mkdir -p /tmp/prisma-client \
    && PRISMA_CLIENT_PATH="$(ls -d node_modules/.pnpm/@prisma+client@* | head -n 1)" \
    && cp -a "${PRISMA_CLIENT_PATH}/node_modules/.prisma" /tmp/prisma-client/

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/turbo.json /app/tsconfig.base.json ./
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/config/package.json ./packages/config/package.json
RUN pnpm install --filter @cognita-campaign/backend... --prod --frozen-lockfile=false
COPY --from=build /tmp/prisma-client /tmp/prisma-client
RUN PRISMA_CLIENT_PATH="$(ls -d /app/node_modules/.pnpm/@prisma+client@* | head -n 1)" \
    && cp -a /tmp/prisma-client/.prisma "${PRISMA_CLIENT_PATH}/node_modules/.prisma"
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/apps/backend/scripts ./apps/backend/scripts
RUN chmod +x apps/backend/scripts/bootstrap-db.sh
EXPOSE 3001
ENTRYPOINT ["sh", "/app/apps/backend/scripts/bootstrap-db.sh"]
