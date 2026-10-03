FROM node:24.14.0-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
COPY types ./types
RUN npm run typecheck && npm run build

FROM node:24.14.0-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99 \
    DATA_DIR=/data \
    BROWSER_TOKEN_FILE=/data/access-token \
    MCP_URL=http://127.0.0.1:8931/mcp \
    VNC_VIEW_PORT=5900 \
    VNC_CONTROL_PORT=5901 \
    PORT=8080
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates chromium chromium-sandbox \
        dbus-x11 ffmpeg fonts-dejavu-core fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
        openbox tini util-linux x11-utils x11vnc xauth xclip xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN install -d -m 1777 /tmp/.X11-unix
COPY --from=build /app/dist ./dist
COPY public ./public
COPY docker ./docker
COPY LICENSE NOTICE ./
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node --input-type=module -e "try { const r = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(4000) }); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }"
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/scripts/runtime.js"]
CMD []
