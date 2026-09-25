# syntax=docker/dockerfile:1
# Lakshya: the portal plus the coding-agent CLIs it drives (Claude Code, Codex, OpenCode).

FROM node:22-trixie-slim AS node

FROM oven/bun:1.4-debian

# Real Node for the agent CLIs, which ship as npm packages (the image's `node` is a Bun shim).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Tools the agents use while they work.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps less openssh-client python3 \
 && rm -rf /var/lib/apt/lists/*

# The agent CLIs. Pin versions with --build-arg; set one to "none" to leave it out.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCODE_VERSION=latest
RUN set -e; pkgs=""; \
    [ "$CLAUDE_CODE_VERSION" = none ] || pkgs="$pkgs @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"; \
    [ "$CODEX_VERSION" = none ] || pkgs="$pkgs @openai/codex@$CODEX_VERSION"; \
    [ -z "$pkgs" ] || npm install -g $pkgs; \
    npm cache clean --force
# OpenCode v2 ships through its own installer (npm's opencode-ai is still 1.x). It installs into
# $HOME/.opencode, so install under /opt, outside the home volume, and link it onto the PATH.
RUN set -e; [ "$OPENCODE_VERSION" = none ] && exit 0; \
    v=""; [ "$OPENCODE_VERSION" = latest ] || v="--version $OPENCODE_VERSION"; \
    curl -fsSL https://opencode.ai/install | HOME=/opt/opencode bash -s -- --no-modify-path $v; \
    chmod -R a+rX /opt/opencode; \
    ln -s /opt/opencode/.opencode/bin/opencode /usr/local/bin/opencode

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json components.json ./
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/lakshya-entrypoint

ENV NODE_ENV=production \
    AOS_HOST=0.0.0.0 \
    AOS_PORT=4777 \
    AOS_DATA_DIR=/data \
    AOS_WORKSPACE=/workspace \
    DISABLE_AUTOUPDATER=1

RUN mkdir -p /data /workspace && chown bun:bun /data /workspace
# Claude Code refuses YOLO mode as root, and agents should not run as root anyway.
USER bun

EXPOSE 4777
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:4777/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["lakshya-entrypoint"]
CMD ["bun", "src/server/index.ts"]
