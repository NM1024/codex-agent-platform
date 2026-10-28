# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS admin-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund --strict-ssl=true
COPY frontend ./frontend
RUN npm run build:admin
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# Node uses bundled roots; the Rust Codex CLI also needs the OS trust store.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=1000:1000 package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --strict-ssl=true
COPY --chown=1000:1000 prompts ./prompts
COPY --chown=1000:1000 src ./src
COPY --from=admin-build --chown=1000:1000 /build/src/manager/web-dist ./src/manager/web-dist
COPY --chown=1000:1000 scripts ./scripts
RUN node scripts/check-release.mjs
RUN mkdir -p /data /workspace /codex /management && chown 1000:1000 /data /workspace /codex /management
ENV NODE_ENV=production PATH="/app/node_modules/.bin:${PATH}" \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 1000:1000
FROM base AS gateway
CMD ["node", "src/main-gateway.mjs"]
FROM base AS runner
ENV CODEX_HOME=/codex HOME=/codex
CMD ["node", "src/main-runner.mjs"]
FROM base AS manager
COPY --chown=1000:1000 frontend/src ./frontend/src
COPY --chown=1000:1000 frontend/tsconfig.json frontend/vite.config.ts ./frontend/
COPY --chown=1000:1000 docs ./docs
COPY --chown=1000:1000 README.md README.zh-CN.md Dockerfile ./
RUN node scripts/check-release.mjs --manager-source
CMD ["node", "src/main-manager.mjs"]
FROM base AS test
COPY --chown=1000:1000 tests ./tests
COPY --chown=1000:1000 frontend ./frontend
CMD ["node", "scripts/container-tests.mjs"]
