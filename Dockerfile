FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
RUN pnpm --filter @nspanel/web build && pnpm --filter @nspanel/api build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_ROOT=/app/public
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api ./apps/api
COPY --from=build /workspace/apps/web/dist/web/browser ./public
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
