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
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && python3 -m venv /opt/venv \
    && rm -rf /var/lib/apt/lists/*

COPY frontend/package.json frontend/package-lock.json /app/frontend/
RUN cd /app/frontend && npm ci --omit=dev

COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY . /app
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir .
RUN if [ ! -f /app/frontend/config.yaml ] && [ -f /app/frontend/config.example.yaml ]; then \
      cp /app/frontend/config.example.yaml /app/frontend/config.yaml; \
    fi \
    && mkdir -p /app/runtime

WORKDIR /app/frontend

EXPOSE 8333

CMD ["node", "server.js"]
