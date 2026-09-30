#!/usr/bin/env bash
# e2e smoke：typecheck + 全量 vitest（integration 在无可用 runner 的机器上自动 skip）
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npx vitest run
echo "e2e OK ($(uname -s), runner chain resolved at test time)"
