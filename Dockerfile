# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json ./
COPY frontend/postcss.config.js frontend/tailwind.config.js ./
COPY frontend/public ./public
COPY frontend/src ./src
RUN npm run build


FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8333

COPY frontend/package.json frontend/package-lock.json /app/frontend/
RUN --mount=type=cache,target=/root/.npm \
    cd /app/frontend \
    && npm ci --omit=dev

COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY frontend/server.js frontend/runtimeProbePlanner.js /app/frontend/
COPY frontend/serializedJsonStore.js frontend/keyedOperationQueue.js /app/frontend/
COPY frontend/asyncRequestCache.js frontend/asyncConcurrency.js /app/frontend/
COPY frontend/credentialStatusTransaction.js frontend/managementAuth.js frontend/config.example.yaml /app/frontend/
COPY frontend/src/shared/providerRuntimeStrategies.js /app/frontend/src/shared/

RUN mkdir -p /app/config /app/runtime

WORKDIR /app/frontend

EXPOSE 8333

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8333) + '/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
