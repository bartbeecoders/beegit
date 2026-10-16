# syntax=docker/dockerfile:1.7
# BeeGit container image: beegit-server plus the beegit, beegit-daemon and beegit-import tools.
#
#   docker build -t beegit:dev .
#
# The same image runs the server (default command) and one-off tools, e.g.
#   docker run --rm beegit:dev beegit --help

FROM rust:1.98.0-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked \
      --bin beegit-server --bin beegit --bin beegit-daemon --bin beegit-import \
 && mkdir -p /out \
 && cp target/release/beegit-server target/release/beegit \
       target/release/beegit-daemon target/release/beegit-import /out/

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home --home-dir /var/lib/beegit beegit
COPY --from=build /out/ /usr/local/bin/
COPY config/beegit-server.toml /etc/beegit/beegit-server.toml
ENV BEEGIT_SERVER_CONFIG=/etc/beegit/beegit-server.toml \
    BEEGIT_LISTEN=0.0.0.0:7443 \
    BEEGIT_METRICS_LISTEN=0.0.0.0:9464 \
    BEEGIT_REPO=monorepo \
    BEEGIT_LOG_FORMAT=json \
    BEEGIT_TLS_CERT=/etc/beegit/tls/tls.crt \
    BEEGIT_TLS_KEY=/etc/beegit/tls/tls.key \
    BEEGIT_SIGNING_KEY=/etc/beegit/keys/signing.ed25519.pem \
    BEEGIT_POLICY_PATH=/etc/beegit/policy/acl.toml
USER 10001
EXPOSE 7443 9464
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:9464/healthz || exit 1
ENTRYPOINT []
CMD ["beegit-server"]
