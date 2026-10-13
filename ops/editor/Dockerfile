FROM node:22.23.1-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
ARG DEBIAN_MIRROR=http://deb.debian.org
ARG PYTHON3_VERSION=3.11.2-1+b1
ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
ARG CHROMIUM_VERSION=155.0.8059.39-1~deb12u1
ARG FONTS_NOTO_CJK_VERSION=1:20220127+repack1-1
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      "python3=${PYTHON3_VERSION}" "ffmpeg=${FFMPEG_VERSION}" \
      "chromium=${CHROMIUM_VERSION}" "fonts-noto-cjk=${FONTS_NOTO_CJK_VERSION}" \
      ca-certificates gcc libc6-dev linux-libc-dev libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/claude
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=storyflow-editor-npm,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --no-audit --no-fund \
    && ln -s /opt/claude/node_modules/.bin/claude /usr/local/bin/claude \
    && claude --version | grep -F '2.1.258'
WORKDIR /opt/editor
COPY sandbox-exec.c ./
RUN gcc -O2 -Wall -Wextra sandbox-exec.c -lseccomp -o /usr/local/bin/editor-sandbox-exec \
    && groupadd --gid 10001 editor && useradd --uid 10001 --gid 10001 --no-create-home editor \
    && mkdir -p /state /work /sessions /input \
    && chown editor:editor /state /work /sessions
COPY worker.py sandbox.py mcp_server.py sandbox_smoke.py image_bridge.py ./
ENV PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
    EDITOR_STATE_DIR=/state EDITOR_WORK_DIR=/work EDITOR_SESSION_DIR=/sessions EDITOR_INPUT_DIR=/input \
    EDITOR_API_KEY_FILE=/run/secrets/anthropic_api_key EDITOR_ROUTE_PROFILE=9router-native ANTHROPIC_BASE_URL=https://router.yundongyl.cn \
    EDITOR_MODEL=ezr/claude-opus-5-5 CHROME_BIN=/usr/bin/chromium \
    OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
USER 10001:10001
CMD ["python3", "/opt/editor/worker.py", "serve"]
