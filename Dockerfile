# syntax=docker/dockerfile:1

# Heavy OS packages live in their own stage so apk only re-runs when this
# stage changes (or the base tag moves), not on every app/source rebuild.
FROM node:22-alpine AS runtime-base
RUN apk add --no-cache ffmpeg g++ python3 bash util-linux-misc bubblewrap \
  && addgroup -S app && adduser -S -G app app \
  && mkdir -p /app/data && chown -R app:app /app/data

FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY console/web/package.json console/web/package-lock.json* ./
# Coolify often sets NODE_ENV=production at build time; still need vite/typescript to build.
ENV NODE_ENV=development
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev
COPY console/web/ ./
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY console/package.json console/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM runtime-base
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY console/package.json ./
COPY console/src ./src
COPY --from=web-build /app/src/public ./src/public

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
