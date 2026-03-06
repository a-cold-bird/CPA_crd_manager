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
    && apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 \
    && python -m pip install --no-cache-dir requests \
    && rm -rf /var/lib/apt/lists/*

COPY frontend/package.json frontend/package-lock.json /app/frontend/
RUN cd /app/frontend && npm ci --omit=dev

COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY . /app
RUN if [ ! -f /app/frontend/config.yaml ] && [ -f /app/frontend/config.example.yaml ]; then \
      cp /app/frontend/config.example.yaml /app/frontend/config.yaml; \
    fi \
    && mkdir -p /app/runtime

WORKDIR /app/frontend

EXPOSE 8333

CMD ["node", "server.js"]
