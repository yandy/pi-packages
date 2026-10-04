# Windows CI 设计（tests 跨平台梳理 + 启用 windows-latest 测试矩阵）

- 日期：2026-10-04
- 状态：设计稿，待评审
- 范围：`.github/workflows/test.yml`、根 `package.json`、根 `.gitattributes`（新增）、9 个包的测试修复、`pi-sandbox/src/fence.ts` 一处实现修复
- 明确不在范围内：`pi-container-sandbox`（Linux 特异包，Windows CI 跳过，`package.json` 的 `"os": ["linux"]` 保持不动）；`pi-lark` / `pi-dingtalk` / `pi-superpowers`（无测试，`--if-present` 自动跳过）

---

## 1. 背景与目标

当前 `.github/workflows/test.yml` 的所有 job 都只跑 `ubuntu-latest`。目标：为 8 个有测试的包增加 Windows 测试覆盖，重点收益是 pi-sandbox 的 win32 真机套件（`win32/e2e` 19 例 + `win32/diagnose-script` 10 例，目前只能在 Windows 上执行，Linux CI 上整段 skip）与 pi-memory 的 `fs-retry.win32`（同理）。

成功标准：**启用 Windows job 时即为绿**（先修完所有已知失败再上线，见 §2 决策 D2），后续作为常规检查存在，不留长期性的 `skipIf(win32)` 掩盖回归。

## 2. 决策记录（均已与使用者确认）

| # | 决策 |
|---|------|
| D1 | `pi-container-sandbox` 是 Linux 特异包，Windows CI 跳过它；`"os": ["linux"]` 声明不改 |
| D2 | 节奏：先把全部已知失败修完 + 风险点做完防护，再启用 Windows job，一步到位保证绿（不做 continue-on-error 观察期） |
| D3 | Windows CI **只跑 test**；lint / typecheck / check:* 维持 ubuntu-only |
| D4 | 平台特异行为用**平台特异的测试**处理：每个平台分支的用例在它所属的平台上执行（严格平台特异，不做"Linux 上注入假平台"的单向覆盖），覆盖由 ubuntu + windows 矩阵整体拼出 |
| D5 | 工作约定：除明确平台特异的实现代码外，**实现代码允许为跨平台适配而修改**；大部分修复预期落在测试侧（POSIX 字面量断言），实现仅在确有跨平台缺陷时改动 |
| D6 | 测试与实现的修复全部在 `windows-ci` 分支（本 worktree）内完成 |

## 3. 测试梳理结论（2026-10-04 全量梳理）

7 个并行探查覆盖 11 个注册 vitest 的包、155 个测试文件。要点：

### 3.1 分包结论

| 包 | 文件数 | Windows CI 预期（修复前） | 修复责任 |
|---|---|---|---|
| pi-subagents | 57 | 3 例确定性失败 + 1 个隔离模式失效 | §4.1 / §4.3 |
| pi-memory | 30 | 3 例失败（`con.md` 保留名 fixture，2 个文件） | §4.2 |
| pi-coding-tools | 13 | 2 例确定性失败 | §4.1 |
| pi-sandbox | 26 | 0 确定性失败；2 例盘符断言条件性失败（真实实现缺陷） | §4.4 |
| pi-ask-user | 2 | 2 例确定性失败 | §4.1 |
| pi-web-tools | 3 | 3 例确定性失败 | §4.1 |
| pi-vision-tools | 8 | 1 例确定性失败 | §4.1 |
| pi-todo | 2 | 全绿 | — |
| pi-container-sandbox | 14 | 约 22 例失败 + EBADPLATFORM 阻断 | **不修，Windows 跳过（D1）** |

### 3.2 共性模式

绝大多数确定性失败是同一类：**实现用平台化 `join()`/`resolve()` 拼路径（行为正确），测试断言写死 POSIX 字面量**（`toBe("/home/u/...")`、`endsWith(".pi/coding-tools.json")`、mock fs 的 POSIX 键）。修法统一：测试侧用 `path.join`/分隔符归一化构造期望值，实现不动（D5）。

### 3.3 环境依赖矩阵（windows-latest）

| 依赖 | 涉及测试 | 可用性 |
|---|---|---|
| git CLI | pi-memory paths、pi-subagents env | ✅ runner 自带 Git for Windows |
| PowerShell / icacls / cmd | pi-sandbox win32 套件、pi-memory fs-retry.win32 | ✅ 原生 |
| koffi（native FFI） | pi-sandbox win32-* 6 个文件 | ✅ lockfile 已含 `@koromix/koffi-win32-x64`；缺失时**响亮失败**（无静默 skip） |
| ast-grep 二进制 | pi-coding-tools 2 个 integration | ⚠️ 平台包装上则跑、装不上则**静默 skip** → CI 需显式断言（§5.4） |
| docker/podman | （pi-container-sandbox） | Windows runner 仅 Windows 容器模式 Docker、无 podman —— 与 D1 一致，不在 Windows 跑 |
| 网络 / TTY | 无任何测试依赖 | — |

### 3.4 安装阻断（实验证实）

npm 11.12.1 对 **workspace 包**的 `os` 字段同样执行平台检查（Arborist `#checkEngineAndPlatform` 遍历 `idealTree.inventory` 含 workspace 节点）。最小复现实验：workspace 子包声明 `os: ["win32"]` 时，Linux 上连 `npm install --package-lock-only` 都抛 EBADPLATFORM。对称地，Windows 上根 `npm ci` 会因 `pi-container-sandbox` 的 `os: ["linux"]` 直接失败。

**解法（实验验证通过）**：Windows job 用 `npm ci --force`（plain `npm ci` 复现 EBADPLATFORM，`--force` 放行且 workspace link 正常建立）。`pi-container-sandbox` 声明不动；其测试通过不进入 Windows 的测试命令而跳过（§5.2）。

## 4. 测试与实现修复设计

### 4.1 路径字面量断言归一化（测试侧，共 11 例）

| 文件 | 问题 | 修法 |
|---|---|---|
| `pi-subagents/tests/session/session-dir.test.ts`（2 例） | `toBe("/home/user/…/tasks")` 等字面量 vs 实现 `path.join` | 期望值改 `path.join` 构造 |
| `pi-subagents/tests/session/recover-subagents.test.ts`（1 例） | mock 探针与断言硬编码 `/parent/tasks/old-agent.jsonl` | mock 键与断言统一 `path.join` 构造 |
| `pi-coding-tools/tests/config.test.ts`（2 例） | mock `readFileSync` 用 `.endsWith(".pi/coding-tools.json")` 正斜杠后缀匹配 | 匹配前 `replaceAll("\\", "/")` 归一化（或用 `resolve` 构造后缀） |
| `pi-ask-user/tests/index.test.ts`（2 例） | fakeFiles 键为 POSIX 字面量（`/home/testuser/...`、`/tmp/project/...`）vs 实现 `join()` | 键改 `path.join` 构造（保持与 os mock 的 homedir/tmpdir 一致） |
| `pi-web-tools/tests/config.test.ts`（3 例） | mock fs 以 `=== "/home/user/.myapp/agent/web-tools.json"` 比较 | 期望路径 `path.join`/`resolve` 构造 |
| `pi-vision-tools/tests/config.test.ts`（1 例） | `toBe("/home/u/.pi/agent/vision-tools.json")` | 期望值 `join(mockAgentDir, ...)` 构造 |

### 4.2 `con.md`：严格平台特异拆分（pi-memory，D4）

涉及 `tests/dream.test.ts`（2 例）与 `tests/memory-store-read.test.ts`（1 例，现为单用例内同时断言 win32 skip + linux keep，需拆开）：

- **win32 分支用例**（"skips Windows device-named files …"）：`it.skipIf(process.platform !== "win32")`，**只在 Windows 跑**；移除 `platform: "win32"` 注入，用宿主真实平台；fixture 用 `\\?\` 前缀路径创建（见下）。
- **linux 分支用例**（"keeps Windows device-named files …"）：`it.skipIf(process.platform === "win32")`，**只在 Linux 跑**，用宿主真实平台；同样移除 platform 注入。此门控是硬性的：platform=linux 的 store 在 Windows 宿主上会真读 CON 设备（可能阻塞在控制台读取），绝不能在 Windows 上执行。
- `memory-store-read.test.ts` 的混合用例拆成上述两条平台特异用例。

**`\\?\` fixture helper**：Windows 上 `fs.writeFile("C:\\…\\con.md")` 因路径规范化命中保留设备名而失败；`\\?\C:\…\con.md` 前缀绕过规范化，NTFS 允许创建、`readdir` 可见。封装测试 helper：Windows 上创建/删除（`rm` 同样需要 `\\?\` 前缀）均走 `\\?\` + 绝对反斜杠路径，POSIX 上为普通路径。两个测试文件共用。

**Fallback**：若 `\\?\` 在 CI 环境不可靠（Dev Drive/策略限制，属首次真机验证点），win32 分支用例退化为 `vi.mock` `readdir` 注入 `con.md` 文件名——win32 分支逻辑是"按名字跳过、不读内容"，覆盖等价。

**覆盖说明（D4 的代价）**：单平台 CI 不再覆盖另一平台的分支逻辑——Linux CI 不跑 win32 跳过分支，Windows CI 不跑 linux 保留分支；由矩阵整体覆盖。

### 4.3 `custom-agents.test.ts` 隔离模式修正（pi-subagents）

`process.env.HOME = tmpDir` 的隔离在 Windows 上无效（`os.homedir()` 读 `USERPROFILE`）：干净 runner 上碰巧能过、开发者机器上必挂。改为同文件内已验证的 `vi.stubEnv("PI_CODING_AGENT_DIR", tempDir)` 模式（跨平台、语义直接）。

### 4.4 `pi-sandbox/src/fence.ts`：盘符相对路径实现修复（唯一实现改动）

**缺陷**：`isWithinRoots` 的 dev/ino 身份回退里 `statSync("C:")` / `statSync("C:work")` 按**每驱动器当前目录**（per-drive CWD）解析。若进程的 C: per-drive CWD 恰为盘根，裸盘符 `"C:"` 的身份就与授予根 `"C:\"` 相同 → `isWithinRoots("C:", ["C:\\"])` 返回 true。安全边界判定被进程 CWD 摆布，属于真实缺陷（`tests/fence.test.ts` 两条裸盘符断言在 Windows CI 上条件性变红暴露了它）。

**修法**：win32 语义下，盘符后不紧跟分隔符的 target（`C:`、`C:work`，即裸盘符与盘符相对路径）语义依赖 per-drive CWD，是歧义路径 → `isWithinRoots` 直接判 false（词法与身份回退都不得命中）。POSIX 宿主行为不变。文件顶部已有 `DRIVE_LETTER_PREFIX = /^[A-Za-z]:$/` 常量可扩展复用（形如 `/^[A-Za-z]:(?![\\/])/`）。既有用例恰好构成验收：`fence.test.ts` 的 "does not treat a bare drive letter as a drive root"（不门控、两端都跑）与 win32-gated 用例内的 `C:work` 断言。

### 4.5 `pi-coding-tools/tests/lsp/client.test.ts` 清理防抖（顺带防护）

`afterAll` 的 `rmSync(root)` 紧随 `client.stop()`，而实现只 `proc.kill("SIGKILL")` 不等退出；Windows 上子进程 cwd 占用目录会 EBUSY/EPERM → afterAll 报错（POSIX 不复现）。修法：`rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })`，或先 await 子进程 exit 事件再删。属 Option A 节奏下"已知风险先防护"的一部分。

## 5. CI 设计

### 5.1 `.gitattributes`（新增根文件）

```
* text=auto eol=lf
```

biome 强制 LF；避免 Windows 检出 CRLF 影响 `format`、lockfile 类步骤。（二进制由 `text=auto` 自动识别豁免。）

### 5.2 `test.yml` 改造

- **`test-full`**（root 变更触发）：加 `strategy.matrix.os: [ubuntu-latest, windows-latest]`。
  - ubuntu 步骤不变。
  - windows：`npm ci --force`（注释说明原因，见 §3.4）→ `npm run test:windows`。
- **`test-packages`**（按路径过滤）：matrix 增加 `os` 维度 + `exclude: { package: pi-container-sandbox, os: windows-latest }`；windows 步骤同上，测试命令为 `npm test -w ${{ matrix.package }}`。矩阵经 exclude 后为空时 job 自然不产生运行（仅 container-sandbox 变更时 Windows 无 job，符合 D1）。
- **`changes` / `lockfile-sync`** 维持 ubuntu（bash + jq 依赖）。
- **`typecheck` / `lint` / `check:*` 不进 Windows job**（D3）。

### 5.3 根 `package.json` 新增脚本

```json
"test:windows": "npm test -w pi-ask-user -w pi-coding-tools -w pi-memory -w pi-sandbox -w pi-subagents -w pi-todo -w pi-vision-tools -w pi-web-tools"
```

即全量 workspace 减去 `pi-container-sandbox`（D1 的测试面表达；`-w` 可多次叠加）。

### 5.4 ast-grep 二进制存在性断言（Windows job 前置步骤）

`@ast-grep/cli` 依赖平台 optional 包 `@ast-grep/cli-win32-x64-msvc`；缺失时两个 integration 套件**静默 skip**，CI 假绿。Windows job 在 `npm test` 前加一步：

```
node -p "require.resolve('@ast-grep/cli-win32-x64-msvc/ast-grep.exe')"
```

失败即 job 红，杜绝静默 skip。koffi 无需此步（缺失时测试响亮失败）。

### 5.5 超时

Windows job 加 `timeout-minutes`（建议 test-full 30 / test-packages 25），防 win32 e2e 类长用例（内部 spawnSync 120–165s 超时）叠加意外挂起占满 runner。

## 6. 修复但不展开的已知风险（接受并记录）

| 风险 | 处置 |
|---|---|
| pi-memory `fs-lock` 死 pid 探测在 Windows 的 PID 复用竞态 | 接受：低概率 flake，观察 |
| pi-memory `fs-retry.win32` 计时（600ms/8s、杀软干扰） | 接受：Windows CI 上首跑，flake 再治 |
| pi-sandbox `win32/e2e`、`win32/diagnose-script` 的环境敏感断言（%TEMP% ACL 传播、0xC0000005 镜像、icacls 方言）从未在 CI 环境跑过 | 接受：静态梳理无已知必败点；首次真机 CI run 是验证点 |
| pi-subagents `print-mode.test.ts` 读真实 `~/.pi/agent` | 接受：干净 runner 通过 |
| pi-vision-tools `image.test.ts` 100 字符路径启发式 | 接受：低风险 |
| pi-ask-user 5ms 真实定时器 | 接受 |

## 7. 验收标准

1. `windows-ci` 分支上，Linux 本地：`npm test`（全 workspace，含 container-sandbox）、`npm run typecheck`、`npm run lint` 全绿。
2. 分支推送后首个 PR：`test-full` 的 windows-latest job 与 `test-packages` 的 windows 组合全绿；ubuntu 结果与 main 持平。
3. Windows job 上 pi-container-sandbox 不出现（无其测试输出）；pi-sandbox 的 win32 e2e / diagnose 套件有真实执行记录（非 skip）；`fs-retry.win32.test.ts` 有真实执行记录。
4. 无新增长期 `skipIf(win32)`：除 §4.2 的两条平台特异门控（win32-only / linux-only 成对）外，不得引入"Windows 上跳过"的用例。
5. ast-grep 存在性断言步骤出现在 Windows job 且通过。

## 8. 实施顺序

1. 测试修复：§4.1 六个文件 → §4.3 → §4.2（含 `\\?\` helper）→ §4.5
2. 实现修复：§4.4 `fence.ts`（现有 `fence.test.ts` 的裸盘符/win32-gated 断言即守卫，win32 宿主专属分支由 Windows CI 首跑验证；Linux 上无法复现 per-drive CWD 语义，不新增可本地运行的回归用例）
3. CI：§5.1 `.gitattributes` → §5.3 根脚本 → §5.2 `test.yml` → §5.4/§5.5
4. 本地全量验证（验收标准 1）→ 推分支开 PR → 依首次 Windows run 处理真机偏差（`\\?\` fallback 触发点在此）
