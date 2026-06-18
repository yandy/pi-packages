# Minimal sandbox image for pi-container-sandbox
#
# Goals:
#   - small, predictable surface area
#   - tools the agent typically needs to read/edit/grep/build code
#   - non-root user `pi` (uid/gid 1000) — agent never runs as root
#   - no SSH, no sudo, no setuid binaries beyond what debian-slim ships
#   - every downloaded binary is SHA256-verified at build time
#
# Built with:
#   npm run build-image
#   docker build -t pi-container-sandbox:latest -f docker/Dockerfile docker
FROM debian:12-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG ARCH=x86_64

# ── Base system packages ────────────────────────────────────────────
# ripgrep gives us `rg`; everything else is core CLI tooling.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        chromium \
        coreutils \
        curl \
        file \
        findutils \
        git \
        jq \
        less \
        libatomic1 \
        make \
        ripgrep \
        sed \
        tar \
        tini \
        unzip \
        xz-utils


# ── Helper: download + verify + install ─────────────────────────────
# Usage: dl-verify <url> <expected-sha256> <output-path>
# Fails the build if the hash doesn't match.
RUN printf '#!/bin/sh\nset -e\nURL="$1" HASH="$2" OUT="$3"\nFILE=$(mktemp)\ncurl -fsSL "$URL" -o "$FILE"\necho "$HASH  $FILE" | sha256sum -c\nmv "$FILE" "$OUT"\nchmod +x "$OUT"\n' > /usr/local/bin/dl-verify \
 && chmod +x /usr/local/bin/dl-verify

# ── Modern CLI tools (GitHub release binaries, SHA256-verified) ─────
# Every binary is pinned to an exact version with an integrity check.
# To upgrade: change VERSION, update the SHA256, rebuild.

# bat — better cat (syntax-highlighted, line numbers, git integration)
ARG BAT_VERSION=0.26.1
ARG BAT_SHA256=726f04c8f576a7fd18b7634f1bbf2f915c43494c1c0f013baa3287edb0d5a2a3
RUN dl-verify \
      https://github.com/sharkdp/bat/releases/download/v${BAT_VERSION}/bat-v${BAT_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz \
      "${BAT_SHA256}" \
      /tmp/bat.tar.gz \
 && tar xzf /tmp/bat.tar.gz -C /tmp \
 && mv /tmp/bat-v${BAT_VERSION}-${ARCH}-unknown-linux-gnu/bat /usr/local/bin/bat \
 && rm -rf /tmp/bat.tar.gz /tmp/bat-v${BAT_VERSION}-${ARCH}-unknown-linux-gnu

# fd — better find (smart defaults, respects .gitignore, way faster)
ARG FD_VERSION=10.4.2
ARG FD_SHA256=def59805cd14b5651b68990855f426ad087f3b96881296d963910431ba3143c8
RUN dl-verify \
      https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-${ARCH}-unknown-linux-gnu.tar.gz \
      "${FD_SHA256}" \
      /tmp/fd.tar.gz \
 && tar xzf /tmp/fd.tar.gz -C /tmp \
 && mv /tmp/fd-v${FD_VERSION}-${ARCH}-unknown-linux-gnu/fd /usr/local/bin/fd \
 && rm -rf /tmp/fd.tar.gz /tmp/fd-v${FD_VERSION}-${ARCH}-unknown-linux-gnu

# eza — better ls (colors, git status, tree view built-in)
# Extract to /tmp first, then move known binary (no direct tar into /usr/local/bin).
ARG EZA_VERSION=0.23.4
ARG EZA_SHA256=0c38665440226cd8bef5d1d4f3bc6ff77c927fb0d68b752739105db7ab5b358d
RUN dl-verify \
      https://github.com/eza-community/eza/releases/download/v${EZA_VERSION}/eza_${ARCH}-unknown-linux-gnu.tar.gz \
      "${EZA_SHA256}" \
      /tmp/eza.tar.gz \
 && tar xzf /tmp/eza.tar.gz -C /tmp \
 && mv /tmp/eza /usr/local/bin/eza \
 && rm -f /tmp/eza.tar.gz

# yq — jq for YAML, TOML, XML, CSV, JSON
ARG YQ_VERSION=4.53.3
ARG YQ_ARCH=amd64
ARG YQ_SHA256=fa52a4e758c63d38299163fbdd1edfb4c4963247918bf9c1c5d31d84789eded4
RUN dl-verify \
      https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${YQ_ARCH} \
      "${YQ_SHA256}" \
      /usr/local/bin/yq

# ast-grep — structural code search & replace (AST-aware, not regex)
ARG AST_GREP_VERSION=0.43.0
ARG AST_GREP_SHA256=a26253a9c821d935f7e383e40f0de7c2ca62a4121de1f73a6d81ec32eae631e0
RUN dl-verify \
      https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/app-${ARCH}-unknown-linux-gnu.zip \
      "${AST_GREP_SHA256}" \
      /tmp/ast-grep.zip \
 && unzip -o /tmp/ast-grep.zip -d /tmp/ast-grep-out \
 && if [ -f /tmp/ast-grep-out/app-${ARCH}-unknown-linux-gnu ]; then \
      mv /tmp/ast-grep-out/app-${ARCH}-unknown-linux-gnu /usr/local/bin/ast-grep; \
    elif [ -f /tmp/ast-grep-out/sg ]; then \
      mv /tmp/ast-grep-out/sg /usr/local/bin/ast-grep; \
    else \
      echo "ERROR: ast-grep binary not found in zip" >&2; exit 1; \
    fi \
 && chmod +x /usr/local/bin/ast-grep \
 && rm -rf /tmp/ast-grep.zip /tmp/ast-grep-out

# uv — 100x faster Python package manager (replaces pip)
# Download the release tarball directly instead of piping a remote install script to shell.
ARG UV_VERSION=0.11.19
ARG UV_SHA256=7035608168e106375b36d0c818d537a889c51a8625fe7f8f7cad5e62b947c368
RUN dl-verify \
      https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${ARCH}-unknown-linux-gnu.tar.gz \
      "${UV_SHA256}" \
      /tmp/uv.tar.gz \
 && tar xzf /tmp/uv.tar.gz -C /tmp \
 && mv /tmp/uv-${ARCH}-unknown-linux-gnu/uv /usr/local/bin/uv \
 && mv /tmp/uv-${ARCH}-unknown-linux-gnu/uvx /usr/local/bin/uvx \
 && rm -rf /tmp/uv.tar.gz /tmp/uv-${ARCH}-unknown-linux-gnu

# ── Python 3.12.13 via uv ──────────────────────────────────────────
# Replace apt python3 with a uv-managed Python 3.12.13.
# UV_PYTHON_INSTALL_DIR is set to /opt/uv-python so the installation is
# accessible to all users (not just root).
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PYTHON_INSTALL_MIRROR=https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/ \
    UV_DEFAULT_INDEX=https://mirrors.ustc.edu.cn/pypi/simple
RUN uv python install 3.12.13 \
 && PYTHON_BIN=$(uv python find 3.12.13) \
 && ln -sf "$PYTHON_BIN" /usr/local/bin/python3 \
 && ln -sf "$PYTHON_BIN" /usr/local/bin/python \
 && python3 --version

# ── Wrapper scripts: modern tools override legacy commands ──────────
# IMPORTANT: The sandbox agent runs commands via `sh -c` (dash shell).
# Dash does NOT support aliases, so bash aliases in /etc/bash.bashrc
# are invisible to the agent. We use executable wrapper scripts in
# /usr/local/bin instead, which work in ALL shells.
#
# The original binaries are preserved under their real names (cat→cat,
# ls→ls, etc.) so scripts that need POSIX behavior can call them directly.
# Wrappers are installed AFTER /usr/local/bin is populated above.

# Move originals out of the way (apt installs to /usr/bin, so no conflict)
# These wrappers sit in /usr/local/bin which takes precedence on PATH.

# cat → bat (plain output, no paging)
RUN printf '#!/bin/sh\nexec bat --paging=never --style=plain "$@"\n' > /usr/local/bin/cat \
 && chmod +x /usr/local/bin/cat

# ls → eza
RUN printf '#!/bin/sh\nexec eza --icons "$@"\n' > /usr/local/bin/ls \
 && chmod +x /usr/local/bin/ls

# find → fd (only for bare `find` with no args or simple name searches)
# NOTE: find is complex and fd is NOT a drop-in replacement. We do NOT
# override find because it would break too many scripts. The agent can
# call `fd` directly when it wants smart behavior.
# (intentionally not wrapping)

# grep → rg (NOT wrapped — rg has different flag semantics and would
# break scripts that depend on GNU grep behavior. Agent calls `rg` directly.)
# (intentionally not wrapping)

# pip → uv pip (so both interactive and sh -c "pip install ..." work)
RUN printf '#!/bin/sh\nexec uv pip "$@"\n' > /usr/local/bin/pip \
 && printf '#!/bin/sh\nexec uv pip "$@"\n' > /usr/local/bin/pip3 \
 && chmod +x /usr/local/bin/pip /usr/local/bin/pip3

# ── Bash aliases (for interactive use only — `!` commands) ──────────
RUN printf "alias ll='eza --icons -l --git'\nalias la='eza --icons -la --git'\nalias lt='eza --icons --tree --level=3'\n" >> /etc/bash.bashrc

RUN printf "alias ll='eza --icons -l --git'\nalias la='eza --icons -la --git'\nalias lt='eza --icons --tree --level=3'\n" > /etc/profile.d/sandbox-aliases.sh

# ── Runtime: bun ────────────────────────────────────────────────────
# Download the release tarball directly instead of piping install script to sh.
ARG BUN_VERSION=1.3.14
ARG BUN_ARCH=x64
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN dl-verify \
      https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip \
      "${BUN_SHA256}" \
      /tmp/bun.zip \
 && unzip -o /tmp/bun.zip -d /tmp/bun-out \
 && mv /tmp/bun-out/bun-linux-${BUN_ARCH}/bun /usr/local/bin/bun \
 && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
 && chmod +x /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun-out \
 && bun --version

ENV BUN_CONFIG_REGISTRY="https://registry.npmmirror.com"

# ── Node.js v24 (replaces Debian package that ships v18) ────────────────
ARG NODE_VERSION=24.16.0
ARG NODE_ARCH=x64
ARG NODE_SHA256=d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9
RUN dl-verify \
      https://mirrors.aliyun.com/nodejs-release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz \
      ${NODE_SHA256} \
      /tmp/node.tar.xz \
 && tar xf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && ln -sf /usr/local/bin/node /usr/local/bin/nodejs \
 && rm -f /tmp/node.tar.xz \
 && node --version \
 && npm --version
ENV NPM_CONFIG_REGISTRY="https://registry.npmmirror.com" COREPACK_NPM_REGISTRY="https://registry.npmmirror.com" ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# Remove the build helper — no longer needed, reduces attack surface
RUN rm -f /usr/local/bin/dl-verify

# ── Non-root user ───────────────────────────────────────────────────
# uid 1000 keeps file ownership predictable when the host cwd
# is bind-mounted into /workspace.
RUN groupadd -g 1000 pi \
 && useradd  -m -u 1000 -g 1000 -s /bin/bash pi \
 && mkdir -p /workspace \
 && chown -R pi:pi /workspace /home/pi

USER pi
WORKDIR /workspace

# tini reaps zombies so long-running agent shells stay tidy
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
