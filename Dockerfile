# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for native modules (uTP, WebRTC) in case a prebuilt binary isn't available.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    TORRENT_PORT=6881
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# 3000: web app. 6881: incoming BitTorrent peers (optional, but downloads are faster when reachable).
EXPOSE 3000 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(process.env.ROLE==='worker'?0:1))"
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
