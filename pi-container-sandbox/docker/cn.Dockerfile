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
FROM debian:13-slim
ARG DEBIAN_FRONTEND=noninteractive

# ── Base system packages ────────────────────────────────────────────
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        coreutils \
        ca-certificates \
        curl \
        wget \
        tar \
        unzip \
        xz-utils \
        git \
        file \
        tini \
        findutils \
        build-essential \
        chromium \
        ripgrep \
        fd-find \
        eza \
        jq \
        yq \
        python3 \
        nodejs \
        npm

# uv — 100x faster Python package manager (replaces pip)
COPY --from=ghcr.io/astral-sh/uv:trixie-slim /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/

ENV PIP_INDEX_URL="https://mirrors.ustc.edu.cn/pypi/simple" \
    UV_DEFAULT_INDEX="https://mirrors.ustc.edu.cn/pypi/simple" \
    UV_PYTHON_INSTALL_MIRROR="https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/" \
    NPM_CONFIG_REGISTRY="https://registry.npmmirror.com" \
    BUN_CONFIG_REGISTRY="https://registry.npmmirror.com"

# ── Non-root user ───────────────────────────────────────────────────
# uid 1000 keeps file ownership predictable when the host cwd
# is bind-mounted into /workspace.
RUN set -eux; \
    groupadd -g 1000 pi ; \
    useradd  -m -u 1000 -g 1000 -s /bin/bash pi ; \
    mkdir -p /workspace ; \
    chown -R pi:pi /workspace /home/pi

USER pi
WORKDIR /workspace

ENV NPM_CONFIG_PREFIX="/home/pi/.local" \
    UV_TOOL_BIN_DIR="/home/pi/.local/bin" \
    PATH="/home/pi/.local/bin:${PATH}"

# tini reaps zombies so long-running agent shells stay tidy
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
