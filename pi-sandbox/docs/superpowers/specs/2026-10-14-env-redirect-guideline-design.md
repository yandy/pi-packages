# pi-sandbox：缓存/数据目录重定向禁令（常驻提示词，A-only）设计

日期：2026-10-14
状态：已与用户确认（用户选择 A-only：仅提示词，不做检测/拒绝），已落地
落点：`pi-sandbox/src/tools.ts`（`ENV_REDIRECT_GUIDELINE`，四工具共用）、`tests/tools.test.ts`、`README.md`、`README.zh.md`
前置设计：`2026-10-02-denial-first-escalation-design.md` §4.3（提权门的"上膛"条件）

## 1. 背景与问题

用户报告：`workspace-write` 下 uv/pnpm 等工具要写 `~/.cache/uv`、`~/.local/share/pnpm/store` 等全局目录，模型往往**先手**用环境变量（`XDG_CACHE_HOME`、`UV_CACHE_DIR`、`PNPM_HOME`、`npm_config_cache`…）把这些目录重定向进 workspace，而不是走提权。

机制上的要害：这些写入在 `workspace-write` 下本会被沙箱拒绝，而拒绝正是 denial-first 提权门的"上膛"条件（`src/denial-ledger.ts` + `resolveCall`）。重定向让写入落在可写的 workspace：

```
模型: XDG_CACHE_HOME=$PWD/.cache uv run ...
现状: 命令成功（写入 workspace）→ 拒绝不再发生 → denial-ledger 不上膛
      → 提权门（resolveCall）永远放行不了 → 无声绕行
```

后果：workspace 被缓存污染、全局缓存复用被破坏、本该由用户批准的写入被跳过。

检测面的事实：模型的 `VAR=... cmd` 内联在**命令文本**里；pi 的 bash 工具没有 env 参数（`shell-ops` 的 spawn env 只来自 `process.env` + pi 的 `getShellEnv()`），所以 env diff 类检测抓不到它，只能扫命令文本。

## 2. 决策（用户拍板）

**A-only**：只在常驻提示词里把"搬迁全局缓存/数据目录"定性为沙箱绕行，并写出正确路径（原样运行 → 真被拒 → 提权）；不做检测、不做拒绝、不做自动审批。

理由：

1. 这是模型决策问题，最便宜的杠杆是决策点的规则；
2. 检测是启发式，且绕行路线很多（引号、`env -i`、脚本内赋值、任意自定义变量名、CLI flag、配置文件），B 方案的误判会打断合法命令（例如测试里的 `HOME=$tmp ...`）；
3. 先观察 A 的收敛率，不满足再升级 B——同一条规则文案可原样复用。

## 3. 落地内容

新增常驻规则 `ENV_REDIRECT_GUIDELINE`（`src/tools.ts`），接入 bash/write/edit/powershell 四个工具的 `promptGuidelines`：

> Never work around the sandbox by relocating global cache/data directories into the workspace — no environment-variable overrides (XDG_CACHE_HOME, XDG_DATA_HOME, HOME, UV_CACHE_DIR, PIP_CACHE_DIR, npm_config_cache, PNPM_HOME, YARN_CACHE_FOLDER, CARGO_HOME, GOPATH, ...), no cache-relocating tool flags (--cache-dir, --store-dir, --cache), and no config files that do the same — unless the user explicitly asked for exactly that relocation. Run tools unmodified — including on the escalated retry: when their real global write is denied, retry that same call with escalation rather than adding a relocation.

措辞上的四个刻意选择：

- **点名三类路线**（env / flag / 配置文件）：A-only 下没有检测兜底，措辞就是唯一防线；
- **显式写 "including on the escalated retry"**：被拒后改成 env 重定向再提权是主要失败模式（用户批准的是全权命令，写入却仍落在 workspace）；
- **保留 "unless the user explicitly asked" 例外**：尊重用户显式指令，避免模型把用户的合法要求当违规抗命；
- **不做机制性声称**（不说"会被拒绝"）：那是 B 方案的行为，A-only 下写了就是假话，模型试一次发现没事会失去对规则的信任。

放置与预算：进 `promptGuidelines` 而非 `description`（pi 按字符串去重进 system rules，整条只付 1 份；description 是每工具一份）；插在 `ESCALATION_GUIDELINE` **之前**，保持协议行（含 `sandbox_permissions` 参数名）是最后一条。

## 4. 被否掉的替代（防止回潮）

- **B 检测 + 拒绝 + 记账**：受限模式下扫描命令文本命中的重定向变量则不 spawn、抛出 denial 标记、`onDenial()` 上膛提权门。本期不做，理由见 §2；若升级，落点是 `shell-ops` 的前置守卫（bash/pwsh 共用、在 guard/confine 之后 spawn 之前），专用 hint 必须说"重试时**去掉**重定向"（现成的 `escalationHintMarker` 说 "retry this exact command"，此处会误导）。
- **改 `escalationHintMarker`（真实拒绝后补一句"别用 env 重定向"）**：不加。hint 是恢复协议（可用目标、重试参数、审批），政策已在 system rules 每轮可见；且该 marker 与 write/edit 围栏共用，对显式路径被拒的场景是噪声。
- **D 检测到即自动弹窗请求 `danger-full-access`**：与 denial-first（防审批轰炸）冲突；且要让写入真的落在正常目录还需改写命令，违背 path transparent。
- **E 运行时拦截（`BASH_ENV` + `DEBUG` trap、工具函数包装）**：能覆盖脚本内部，但脆弱（sh/zsh 不读 `BASH_ENV`、`env -i`/`command uv`/`/usr/bin/uv` 均可绕过）且破坏 shell 语义。

## 5. 已知边界（A-only 的固有代价）

- 无强制力：模型仍可能预置 override，或带着 override 提权重试；没有任何代码路径会拦它。
- 脚本文件、`.env`、`.npmrc`、`uv.toml` 等内部的重定向完全在规则文本之外。
- CLI flag 路线只有规则点名，没有检测。
- 提权目标仍只能是 `danger-full-access`（一次全放开）；若审批体验/风险不可接受，再讨论更窄的提权档位，与本设计独立。

## 6. 验证与观察

- 单测（`tests/tools.test.ts`）：四工具都含该规则；位置在提权协议之前；关键措辞（三类路线、提权重试、用户例外）齐全；长度 ≤700 chars 的预算回归闸。
- 行为观察（升级判据）：真实任务中模型是否 (a) 仍预置 override、(b) 被拒后夹带 override 提权重试。出现任一，再补 hint 或转 B。
