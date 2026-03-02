FROM node:20-bookworm-slim AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8333

# Keep python in runtime because frontend local API may call `python main.py` for OAuth tasks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY frontend/package.json frontend/package-lock.json /app/frontend/
RUN cd /app/frontend && npm ci --omit=dev

COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY frontend/server.js /app/frontend/server.js
COPY frontend/config.yaml /app/frontend/config.yaml

# Keep project root artifacts used by frontend local API wrappers.
COPY main.py /app/main.py
COPY pyproject.toml /app/pyproject.toml
COPY src /app/src
RUN mkdir -p /app/runtime

WORKDIR /app/frontend

EXPOSE 8333

CMD ["node", "server.js"]

