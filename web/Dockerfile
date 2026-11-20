FROM node:22-alpine AS frontend

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/index.html frontend/tsconfig.json frontend/tsconfig.app.json frontend/tsconfig.node.json frontend/vite.config.ts ./
COPY frontend/public ./public
COPY frontend/src ./src

RUN npm run build

FROM golang:1.26-alpine AS backend

WORKDIR /src

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ks-tunnel .

FROM alpine:3.22

RUN addgroup -S kstunnel \
    && adduser -S -G kstunnel kstunnel \
    && mkdir -p /app/web /data \
    && chown -R kstunnel:kstunnel /app /data

WORKDIR /app

COPY --from=backend /out/ks-tunnel /app/ks-tunnel
COPY --from=frontend /app/dist /app/web

ENV PORT=8080 \
    KS_WEB_DIR=/app/web \
    KS_DATA_FILE=/data/ks-tunnel.json

EXPOSE 8080
VOLUME ["/data"]

USER kstunnel

CMD ["/app/ks-tunnel"]
