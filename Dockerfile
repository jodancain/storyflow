# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium ffmpeg fonts-noto-cjk python3 python3-venv tini \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/storyflow-venv \
    && /opt/storyflow-venv/bin/pip install --no-cache-dir pypdf==6.1.1
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=18296 \
    STORYFLOW_DATA_DIR=/data/storyflow \
    PYTHON=/opt/storyflow-venv/bin/python \
    CHROMIUM_PATH=/usr/bin/chromium \
    FFMPEG=/usr/bin/ffmpeg \
    FFPROBE=/usr/bin/ffprobe
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY examples ./examples
RUN mkdir -p /data/storyflow && chown -R node:node /data /app
USER node
VOLUME ["/data/storyflow"]
EXPOSE 18296
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18296/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","--import","tsx","server/main.ts"]
