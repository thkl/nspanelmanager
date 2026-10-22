FROM node:24-alpine AS build
WORKDIR /workspace
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --prefix apps/api && npm install --prefix apps/web
COPY apps ./apps
RUN npm run build --prefix apps/web && npm run build --prefix apps/api
RUN npm prune --omit=dev --prefix apps/api

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_ROOT=/app/public
COPY --from=build /workspace/apps/api ./apps/api
COPY --from=build /workspace/apps/web/dist/web/browser ./public
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
