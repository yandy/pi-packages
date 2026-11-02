#!/usr/bin/env bash
#
# pi-todo 看板提醒的受控 A/B。
#
#   off 手臂 = pi-todo v0.4.2（有提示词纪律，无提醒）
#   on  手臂 = main（同一份提示词纪律 + context 提醒）
#
# 两个手臂跑**完全相同的任务提示词**（scripts/experiments/todo-nag/task.md）、同一模型、
# 同一 run 数，只是 `-e` 指向的扩展文件不同。这样手臂是实验设计决定的，不依赖会话内容去猜。
#
# 用法：
#   bash scripts/experiments/todo-nag/run.sh              # 默认每个手臂 6 次
#   RUNS=10 MODEL=deepseek-v4-1-flash-261017 bash scripts/experiments/todo-nag/run.sh
#   OUT=/tmp/my-ab bash scripts/experiments/todo-nag/run.sh
#
# 注意：
# - pi 需要能写 ~/.pi/agent（锁文件、trust.json）。只读 HOME 的沙箱里跑不起来。
# - 每次 run 用一个全新的空目录当工作区，并且不带 .pi/ 资源，所以不会触发 project trust 弹窗。
# - `-nc` 关掉 AGENTS.md 发现，避免本仓库的开发规范渗进任务。

set -uo pipefail

REPO=${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
RUNS=${RUNS:-6}
MODEL=${MODEL:-deepseek-v4-1-flash-261017}
OUT=${OUT:-/tmp/pi-todo-ab}
OLD_TAG=${OLD_TAG:-pi-todo-v0.4.2}
OLD_WT=${OLD_WT:-$REPO/.worktrees/pi-todo-v042}

OLD_SRC="$OLD_WT/pi-todo/index.ts"
NEW_SRC="$REPO/pi-todo/index.ts"
SPY="$REPO/scripts/todo-nag-spy.ts"
AUDIT="$REPO/scripts/todo-audit.ts"
TASK_FILE="$REPO/scripts/experiments/todo-nag/task.md"

for f in "$NEW_SRC" "$SPY" "$AUDIT" "$TASK_FILE"; do
	if [[ ! -f $f ]]; then
		echo "缺少文件：$f" >&2
		exit 1
	fi
done

# off 手臂要用旧版本的扩展文件；没有就建一个 detached worktree
if [[ ! -f $OLD_SRC ]]; then
	echo "==> 建旧版 worktree: $OLD_TAG -> $OLD_WT"
	git -C "$REPO" worktree add --detach "$OLD_WT" "$OLD_TAG" || exit 1
fi

TASK=$(cat "$TASK_FILE")
rm -rf "$OUT"
mkdir -p "$OUT"

run_arm() {
	local arm=$1 src=$2
	mkdir -p "$OUT/$arm/sessions"
	for i in $(seq 1 "$RUNS"); do
		local wd="$OUT/$arm/ws-$i"
		mkdir -p "$wd"
		printf '  [%s] run %d/%d ... ' "$arm" "$i" "$RUNS"
		# 每个 run 独立 cwd + 独立 spy 输出；stdout/stderr 各存一份便于事后回看
		(
			cd "$wd" &&
				PI_TODO_SPY_OUT="$OUT/$arm/spy.jsonl" \
					PI_TODO_SPY_RUN="$arm-$i" \
					pi -ne -nc \
					-e "$src" \
					-e "$SPY" \
					--model "$MODEL" \
					--session-dir "$OUT/$arm/sessions" \
					-p "$TASK" >"$OUT/$arm/run-$i.log" 2>&1
		)
		echo "exit=$?"
	done
}

echo "==> off: $OLD_SRC"
run_arm off "$OLD_SRC"
echo "==> on:  $NEW_SRC"
run_arm on "$NEW_SRC"

report() {
	local arm=$1
	echo
	echo "=============== $arm ==============="
	node --no-warnings "$AUDIT" --dir "$OUT/$arm/sessions"
	# 注入计数：只统计 count>0 的请求，验证提醒真的进了请求
	local spy="$OUT/$arm/spy.jsonl"
	if [[ -f $spy ]]; then
		local runs_with_nudge
		runs_with_nudge=$(node --no-warnings -e '
			const fs = require("node:fs");
			const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
			const runs = new Set(rows.map((r) => r.run));
			const hit = new Set(rows.filter((r) => r.count > 0).map((r) => r.run));
			const total = rows.reduce((a, r) => a + r.count, 0);
			console.log(`${hit.size}/${runs.size} runs, ${total} requests carried a reminder`);
		' "$spy")
		echo "  提醒注入：$runs_with_nudge"
	fi
}

report off
report on

echo
echo "判据（spec §5.3）：上面 4 项指标 on 手臂都没有改善 → 删功能，而不是留噪声。"
echo "原始数据：$OUT"
