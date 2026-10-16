# syntax=docker/dockerfile:1.7
# BeeGit web UI: build the SPA, serve it with an unprivileged nginx on :8080.
# Build from the repository root (the protocol lives in ../proto):
#   podman build -f web/Dockerfile -t beegit-web .
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /src
COPY proto ./proto
COPY web/package.json web/package-lock.json ./web/
WORKDIR /src/web
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/web/dist /usr/share/nginx/html
EXPOSE 8080
