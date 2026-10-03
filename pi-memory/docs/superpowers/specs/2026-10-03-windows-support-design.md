# pi-memory：Windows 支持设计

日期：2026-10-03
状态：已与用户逐轮确认（5 轮问答拍板），待 spec 评审
前置设计：`2026-09-30-readable-memory-paths-design.md`（可读目录名，本设计只改其 Windows 分支语义）、`2026-10-01-per-entry-storage-design.md`（CRLF 归一与「写回恒 LF」的来源）、`2026-10-02-pi-memory-simplify-design.md`（锁分层）
真机验收清单：`pi-memory/docs/superpowers/verification/2026-10-03-windows-support-acceptance.md`

## 1. 背景与问题

pi-memory 之前只在 Linux/macOS 上验证过：`paths.ts` 明确声明命名「面向 POSIX 文件系统：`\` 视为普通字符，不做 Windows 设备名或结尾点/空格处理」，跨进程锁使用硬链接（NTFS-only），测试里有 POSIX 硬编码，CI 只有 `ubuntu-latest`。

用户诉求（原话）：「pi-memory 需要对 windows 有良好支持」，并在澄清中定为 **主动对齐、真机可用为标准**；同时明确两点边界：

1. **命名边界可以简化**：`memoryDir` 下的 `local/` 类别**不需要**多机共享，`git/` 类别天然跨机共享（同一仓库在 Windows 与 Linux 上必须映射到同一个目录名）。
2. **换行符必须能正确处理**（Windows 与 Linux/macOS 的 CRLF/LF 差异）。

### 1.1 事实基础（均已核实，标注出处）

| 事实 | 出处 |
|---|---|
| `projectDirName("C:\\Users\\yandy\\workspace\\proj")` = `C_3a\Users\yandy\workspace\proj`；在 Windows 上 `join("C:\mem","local",<该名>)` = `C:\mem\local\C_3a\Users\yandy\workspace\proj` —— 一个「目录名」被 `\` 拆成 3 级 | 本机 `path.win32` 实验（可复现，见 §5.1 用例） |
| 恶意 git remote `host/a\..\..\..\etc` → 名字 `host__a\..\..\..\etc` → `win32.resolve(win32.join("C:\mem","local",<该名>))` = **`C:\etc`**，逃出 `memoryDir`（路径穿越） | 同上 |
| `CreateHardLinkW`「only supported on the NTFS file system」；支持表：SMB 3.0 = Yes、SMB 3.0 with Continuous Availability = **No**、**ReFS = No** | [MS Learn: CreateHardLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw) |
| 信号 0 是跨平台的「进程是否存在」探测；libuv 的 `uv_kill` 对不存在的 pid 返回 `UV_ESRCH`（Windows 的 `ERROR_INVALID_PARAMETER` → `ESRCH`），权限不足等其它失败按存活处理 | Node `process.kill` 文档；libuv `src/win/process.c` |
| 从 Git Bash 启动的程序调用 `git rev-parse --show-toplevel`，git 返回 **POSIX 形态** `/c/Users/alice/project`；PowerShell 下返回原生 `C:/Users/...`。`PathBuf::from("/c/...")` 在 Windows 上不是有效绝对路径 | 公开 issue 案例：《Git Bash on Windows returns POSIX paths from "git rev-parse --show-toplevel"》 |
| Windows 上 `resolve("/c/pi-packages")` = `C:\c\pi-packages` | `path.win32` 语义 |
| Windows 保留设备名：`CON` `PRN` `AUX` `NUL` `COM1..COM9` `LPT1..LPT9`（含扩展名形态：`NUL.txt` 等价于 `NUL`）、`CONIN$` `CONOUT$` | [MS Learn: Naming Files, Paths, and Namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) |
| Windows 会静默剥掉文件名结尾的句点与空格（`proj.` 与 `proj ` 都是 `proj`） | 同上 |
| Node 的 `fs.rm` 自带重试（`maxRetries`/`retryDelay`，重试集合 `EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM`；非 Windows 忽略重试参数） | Node `fs` 文档 |
| 读取侧 CRLF 归一已经存在：`entry-file.ts`、`entry-index.ts`、`inject.ts` 三处；写入侧（`serializeEntryFile` 与索引写回）恒输出 LF | 代码 + `2026-10-01-per-entry-storage-design.md` |

### 1.2 问题清单（按严重度）

| # | 问题 | 后果 |
|---|---|---|
| P1 | 命名未中和 `\`，git remote / 本地路径里的 `\..\..` 会让目录逃出 `memoryDir` | **安全**：可写出到记忆根之外 |
| P2 | 段内出现保留设备名或结尾点/空格（如 `C:\con\proj`） | 目录创建失败 → 该项目记忆**完全不可用** |
| P3 | `git rev-parse --show-toplevel` 的绝对路径输出在 Git Bash 下是 `/c/...`，`resolve()` 后变成 `C:\c\...` | 同一项目从不同 shell 启动 → **两个记忆目录**，且都不指向真实路径 |
| P4 | 跨进程锁用硬链接（NTFS-only；ReFS / 部分网络共享不支持） | 非 NTFS 卷上取不到锁 → 记忆**完全不可写** |
| P5 | `unlink`/`writeFile` 在 Windows 上会被杀软、编辑器、索引器打成瞬时 `EPERM`/`EBUSY`；释放锁时的 `rm(.lock)` 命中就会残留锁 | 残留 `.lock` 之后该项目**所有**写入被堵死，只能人工 `/memory unlock` |
| P6 | entry 文件名可派生为保留设备名（`memory add name="CON"` → `con.md`） | Windows 上写入落到控制台设备：索引多了一行、文件不存在 → **静默丢记忆** |
| P7 | 本地项目（`local/`）目录名退化成深层嵌套 | 可用但不可读、可诊断性差 |
| P8 | `expandTilde` 只认 `~/` | Windows 用户按习惯写 `~\...` 时路径不展开 |
| P9 | 测试不可在 Windows 上运行：硬编码 POSIX 期望、`chmod` 权限用例、`GIT_CONFIG_GLOBAL=/dev/null` | 真机无法跑全量套件 → 无法判定回归 |
| P10 | 无 Windows 验收证据与文档 | 用户不知道哪些行为在 Windows 上成立 |

## 2. 已确认决策（用户逐条拍板，不得擅自变更）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 验证方式 | **以真机为准**：设计给出编号验收清单与预期输出（PowerShell + git-bash 两套命令），用户在 Windows 机器执行并回贴原始输出，据此迭代。**CI 保持 ubuntu**；win32 纯逻辑用平台参数注入在 Linux CI 上直接单测 |
| D2 | 命名适用范围 | `\` 作为分隔符只在 **win32** 生效 → POSIX 输出逐字节不变（不构成破坏性变更）。`local/` 不要求跨平台稳定，`git/` 必须保持 `host__owner__repo` 形态不变 |
| D3 | 目录身份 | toplevel 改用 `git rev-parse --show-cdup` + `resolve(cwd, …)`（相对路径，无盘符可被 MSYS 转换）；win32 上 `expandTilde` 也认 `~\` |
| D4 | 穿越兜底 | `resolveMemoryDir` 组装完成后断言结果仍在 `memoryDir` 之下，越界抛错（fail-closed） |
| D5 | entry 文件名 | 保留设备名 stem 加前缀变换（`con` → `_con.md`），**全平台生效**（git 类目录跨机共享，名字必须在两边都安全） |
| D6 | 跨进程锁 | 主原语改为 `open(lockPath, "wx")` + 立即写入，删掉「临时文件 + `link`」舞蹈；读取新增「空记录 = 建立中」态 |
| D7 | 瞬时错误 | 新增 `withFsRetry`：win32 `EPERM`/`EACCES` + 全平台 `EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`；6 次重试、20ms 起指数退避、单次上限 300ms；仅用于物理写入路径；非瞬时错误立即上抛 |
| D8 | 换行符 | **鲁棒档**：不新增归一逻辑（审计无缺口）；读取容错 + 写入恒 LF；补回归测试与 README 口径 |
| D9 | 测试可移植性 | POSIX-only 用例 `it.skipIf(win32)`；硬编码 POSIX 路径期望平台化；git 隔离从 `/dev/null` 改为临时空配置文件 |
| D10 | 文档 | README（EN+ZH 同步）Windows 小节 + `⚠️ Breaking changes` 一条；spec 与验收清单落 `pi-memory/docs/superpowers/{specs,verification}/` |
| D11 | 范围外 | 版本号 bump 与 npm 发布（真机验收通过后按 `docs/guides/release.md` 单独进行）；CI 改动 |
| D12 | 收尾 | 走 PR（不开直连 main） |

### 2.1 Rulings（实现与测试按编号引用）

- **Ruling 1**：`projectDirName(key, { platform })` 的 win32 分支必须保证输出满足三条不变量：① 不含 `/` 与 `\`（单分量）；② 不以 `.` 或空格结尾；③ 不是保留设备名（按「第一个 `.` 之前的部分」判定）。`local/` 与 `git/` 共用同一套保证。
- **Ruling 2**：`escapeSegment` 的既有 `_XX` 十六进制转义词汇表扩展用于新场景，不引入第二套转义风格；`\` 通过「作为分隔符参与分段」中和，而不是转义成字面量。
- **Ruling 3**：`--show-cdup` 是 toplevel 的**唯一**来源。不做「先试 `--show-toplevel` 再启发式归一 MSYS 路径」的双路径。
- **Ruling 4**：`~\` 展开只在 win32 生效（POSIX 上 `~\foo` 是合法文件名，不得改写）。
- **Ruling 5**：`entryFileName` 对保留设备名的变换**不带平台条件**（POSIX 也生效）；win32 上 `#entryFiles` 额外跳过保留设备名文件（防历史/外部创建的文件命中 CON 设备导致读取阻塞）。
- **Ruling 6**：锁的四态读取（`absent` / `empty` / `unreadable` / `held`）中，**只有 acquire 路径**区分 `empty`（等待）与 `unreadable`（立即报遗弃）；`readLockStatus` 对外仍只暴露三态（`empty` 归入 `unreadable`），`/memory` 输出与 `/memory unlock` 契约不变。
- **Ruling 7**：重试只包住**物理文件系统调用**，不包住逻辑（不做「整个 store 原语重试」）。快照裁剪的 `rm` 用 Node 自带的 `maxRetries`/`retryDelay`，不套 `withFsRetry`。
- **Ruling 8**：`withFsRetry` 的失败必须保留原始 errno 与路径（不包装成新错误类型），以免改变既有的 fail-closed 语义与错误文案。
- **Ruling 9**：CRLF 相关的既有行为（读取归一、写回转 LF）**不得**为了「保留原风格」而改动；本设计只加测试与文档。
- **Ruling 10**：真机验收清单里的每一条都必须给出**可粘贴的命令 + 预期输出**；代码无法自动判定的条目才进清单（能单测的不进）。

## 3. 方案选择（被否决的路线）

### 3.1 命名：平台无关的统一分段（被否决）
把「按 `/` 与 `\` 双分隔符分段」做成全平台行为，代码只有一条路径，且 Windows/Linux 对同一字符串得到同名目录。否决原因：会改变 POSIX 上含 `\` 的 key 的目录名（README 已声明「反斜杠是普通字符」），构成对现有 POSIX 用户的破坏性变更，而收益（极端 key 的跨平台一致性）用户已明确不需要（`local/` 不共享）。选择 win32 分支后 POSIX 输出零变化。

### 3.2 锁：`link` 为主 + 失败降级 / 运行期探测（被否决）
保留 NTFS 上的既有行为，仅在 `link` 失败（`EPERM`/`ENOSYS`/`EACCES`）时降级到 `open(wx)` 路径；或首次写入前探测该目录是否支持硬链接并缓存结果。否决原因：得到两条各自需要被测试的路径，且降级时机的不确定性会污染 `readLockState` 的三态语义；`open(wx)` 在 NTFS/exFAT/SMB 上都原子，没有必要为省下一次 `open` 而保留第二条路径。

### 3.3 锁：只改错误文案（被否决）
把 `link` 失败翻译成「此卷不支持硬链接，请把 `memoryDir` 换到 NTFS 卷」。否决原因：用户已确认 `git/` 类目录天然跨机共享 —— 网络盘/同步盘正是目标场景，这些场景下「记忆完全不可写」不可接受。

### 3.4 锁：`mkdir` 目录锁（被否决）
`mkdir` 在所有文件系统上原子，是教科书式的可移植锁。否决原因：`.lock` 是**文件**这件事已写进 README 的存储布局、`/memory` 状态行与 `/memory unlock`；改成目录是更大的契约变更，而 `open(wx)` 已能覆盖同一批文件系统。

### 3.5 身份：`--show-toplevel` + MSYS 路径启发式归一（被否决）
识别 `/c/...` 形态并映射成 `C:\...`。否决原因：启发式要处理盘符大小写、`/cygdrive/c/...`、`//server/share`、多盘符等分支，且每一分支都只能靠猜；`--show-cdup` 输出的相对路径没有可被转换的绝对路径成分，天然免疫。

### 3.6 换行符：保留原风格 / 平台产出（被否决）
「写入时保持原文件行尾」或「Windows 上产出 CRLF」都能让 Windows 编辑器更「顺眼」。否决原因（用户已确认鲁棒档）：同一 `git/` 记忆目录被 Windows 与 Linux 交替写入时，文件行尾会来回翻转；若目录进了版控或云盘，会产生整份 diff 抖动。写入恒 LF 是既有的明确决定，本次不推翻。

### 3.7 长路径（>260）工程化（被否决）
估算：默认 `memoryDir`（`%USERPROFILE%\.pi\memory`，约 30–40 字符）+ `git/` 或 `local/` + 目录名上限 120 字节 + 文件名上限 100 字节 + `.md`，单文件全路径约 200 字符；`MEMORY.md`、`.backups/<ts>-write/`、`sessions/` 都更短。本设计不引入 `\\?\` 前缀或长路径专门处理。

### 3.8 加 Windows CI job（本次被否决）
见 D1：pi-sandbox 的既有决策是「真机为准、CI 保持 ubuntu」。本任务的 win32 差异大部分是纯字符串/路径语义，可在 Linux CI 上用 `path.win32` + 平台注入直接单测；真正只有真机能验的部分（fs 原语、Git Bash 下的 git 输出、全链路）由验收清单承担。仓库里还有 pi-container-sandbox 等对 Windows runner 不友好的包，加矩阵的成本大于收益。

## 4. 详细设计

### 4.1 目录名派生（`src/paths.ts`）

`projectDirName(key, options?: { platform?: NodeJS.Platform })`，`platform` 默认 `process.platform`（可注入，便于在 Linux CI 上测 win32 分支）。

算法（win32 与 POSIX 只在第 1 步不同）：

1. 分段：win32 按 `[/\\]` 拆分；POSIX 按 `/` 拆分。丢弃空段、`.`、`..`。
2. 逐段转义：既有 `ILLEGAL_SEGMENT_CHARS = [<>:"|?*\x00-\x1f]` → `_XX` 十六进制。
3. 用 `__` 连接；无段时返回 `root`。
4. 超过 120 字节 → 截断到 100 字节（grapheme 边界）+ `__<sha256 前 8 位>`。
5. **仅 win32**：对最终名做 `windowsSafeName` 收尾，两步有固定顺序 —— ① 结尾是 `.` / 空格 → 转义为 `_2e` / `_20`；② 再判「第一个 `.` 之前的部分」是否命中保留设备名表，命中则前缀 `_`（顺序固定是为了让判定看到的是最终形态，结果与顺序无关地安全）。

| key（win32） | 名字 |
|---|---|
| `C:\Users\yandy\workspace\proj` | `C_3a__Users__yandy__workspace__proj` |
| `\\server\share\proj` | `server__share__proj` |
| `C:\con\proj` | `C_3a__con__proj`（中间段是保留名也无害：判定的基准是**第一个 `.` 之前的部分**，而最终名里连 `.` 都没有） |
| `con.md/repo` | `_con.md__repo`（**必须**前缀：`con.md__repo` 的首段是 `con` → Windows 仍把它当 CON 设备） |
| `C:\Users\yandy\proj.` | `C_3a__Users__yandy__proj_2e` |
| `nul`（单段保留名） | `_nul` |
| `host/a\..\..\..\etc` | `host__a__etc`（`..` 段被丢弃 → 不可能逃出） |

POSIX 侧示例保持不变：`/home/yandy/proj` → `home__yandy__proj`，`/home/a\b` → `home__a\b`。

### 4.2 目录身份（`src/paths.ts`、`src/config.ts`）

- `gitToplevel(cwd)`：`git rev-parse --show-cdup` → `resolve(cwd, stdout.trim() || ".")`。仓库根处输出为空行 → `resolve(cwd, ".")`。`stdout` 为空且非仓库时 git 非零退出 → 既有 catch 返回 `null`。
  - 为什么不带 `--show-toplevel` 兜底：Ruling 3。`--show-cdup` 自 git 1.5.4 起存在，无版本风险。
- `expandTilde(p, platform = process.platform)`：`~` → `homedir()`；`~/` 前缀（两端都认）；`~\` 前缀**仅 win32**。
- `resolveMemoryDir` 兜底（D4）：
  ```ts
  const dir = join(base, kind, name);
  const rel = relative(base, dir);              // win32 的 relative 大小写不敏感
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(...)
  ```
  出错形态与其它配置错误一致（被 `session_start` 转成配置错误态），错误文案写明 memoryDir、kind 与派生名。

### 4.3 entry 文件名与保留设备名（`src/windows-names.ts`、`src/filename.ts`、`src/memory-store.ts`）

新增 `src/windows-names.ts`（两条规则共用一份设备名表）：

```ts
// 判定按「第一个 `.` 之前的部分」：Windows 上 NUL.tar.gz 等价于 NUL
export function isReservedWindowsName(name: string): boolean;   // con|prn|aux|nul|com1..9|lpt1..9|conin$|conout$（大小写不敏感）
export function windowsSafeName(name: string): string;          // 保留名 → `_` 前缀；结尾 `.`/空格 → `_2e`/`_20`
```

- `filename.ts`：`entryFileName(name)` 在派生 stem 之后、拼 `.md` 之前调用 `isReservedWindowsName(stem)`，命中则前缀 `_`。全平台生效（Ruling 5）。既有文件不受影响：`addEntry` 按 frontmatter `name` 复用已有文件，改名只影响**新建**文件的派生名。
- `memory-store.ts`：`#entryFiles` 在 win32 上跳过保留设备名文件（`isReservedWindowsName(n)` 为真 → 不入清单）。作用是防「历史版本（修复前）或外部工具创建的 `con.md`」在 Windows 上被 `readFile` 命中 CON 设备（可能阻塞），把最坏情况降级为「该条记忆在本机不可见」。

### 4.4 跨进程锁（`src/fs-lock.ts`）

- 获取：`open(lockPath, "wx")` → 写入完整 JSON → 关闭。`open` 的 `O_CREAT|O_EXCL` 语义在 NTFS/exFAT/SMB 上都是原子的（Windows 的 `CREATE_NEW`、SMB2 的 `FILE_CREATE`），因此「只有一个人能建立锁文件」这条互斥保证不变。
- 读取四态：`absent` / `empty`（存在且 0 字节）/ `unreadable`（非空但读不懂）/ `held`。
- acquire 路径：`empty` → **当作「持有者正在建立记录」继续轮询等待**（不是遗弃）；到 `timeoutMs` 仍拿不到 → `MemoryLockedError(holder=null, abandoned=false)`。`unreadable` 语义不变（立即报遗弃，给出清除指引）。
- `tryWithLock`：`empty` → 返回 `null`（忙，跳过本轮），**不抛错**（抛错是「遗弃」的语义，`empty` 不是遗弃）。
- `readLockStatus`：对外仍是三态，`empty` 归入 `unreadable`（Ruling 6）—— `/memory` 的 `Lock:` 行与 `/memory unlock` 行为不变。
- 崩溃窗口的代价（明确记录）：持有者若在「建立文件」与「写入内容」之间被杀，留下 0 字节 `.lock`。此后等待者要耗满 `timeoutMs`（默认 5s）才报错；错误文案仍指向 `delete the file to clear it`，`/memory unlock` 可清。这个窗口在旧实现里不存在（`link` 让内容原子出现），换来的是在任意卷上都能工作。
- 临时文件：不再需要（删除 `.tmp` 的产生与清理）。

### 4.5 瞬时文件系统错误重试（`src/fs-retry.ts`）

```ts
export function isTransientFsError(err: unknown, platform?: NodeJS.Platform): boolean;
export async function withFsRetry<T>(fn: () => Promise<T>, options?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; platform?: NodeJS.Platform; sleep?: (ms: number) => Promise<void> }): Promise<T>;
```

- errno 集合取自 Node `fs.rm` 自带重试的集合（`EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM`），在此基础上按平台收敛：全平台 `EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`；**仅 win32** 追加 `EPERM`/`EACCES`（POSIX 上 `EACCES`/`EPERM` 是永久性权限错误，重试只会平白拖慢 fail-closed）。
- 参数：`retries: 6`、`baseDelayMs: 20`、指数退避、单次上限 300ms → 最坏新增等待 ≈ 900ms（远小于 `lock.timeoutMs` 默认 5000）。
- 非瞬时错误、重试耗尽后的错误都**原样上抛**（Ruling 8）。
- 应用点（Ruling 7，只包物理调用）：
  | 位置 | 调用 |
  |---|---|
  | `memory-store.ts` | 四个写原语的 `writeFile`（entry 与索引）+ `unlinkStrict` 的 `unlink` |
  | `fs-lock.ts` | `open(lockPath,"wx")`、记录写入、`releaseLock` 的 `rm` |
  | `snapshot.ts` | `pruneSnapshots` 的 `rm` 用 `{ recursive: true, force: true, maxRetries: 6, retryDelay: 50 }` |
  | `snapshot.ts` | `createSnapshot` 的 `cp`/`mkdir` 保持原样（失败即抛，已有语义） |
- `nudge.ts` 的 `.dream-meta.json` 写入不在范围内（best-effort，失败已有兜底），避免把重试铺进副作用最小的路径。
- **刻意排除**：读取路径（`readFile`/`stat`/`readdir`）不套重试 —— 它们的失败已在各处降级为「空 / 跳过」，既不留需要人工处置的状态，也不改变语义；`mkdir`（`#savingQueue` 与 `snapshot.createSnapshot`）不套重试 —— 建目录失败是干净失败，没有任何残留，重试只会延长 fail-closed 的报错时间。

### 4.6 换行符（不新增归一逻辑）

| 路径 | 结论 |
|---|---|
| `parseEntryFile`（entry frontmatter/正文） | 已归一 CRLF 与孤立 CR → LF |
| `splitLines`（索引解析，唯一的按行拆分入口） | 已归一 |
| `truncateIndexForInjection`（注入） | 已归一（`\r` 不进 system prompt） |
| 会话 JSONL（`session-search`）、git 配置输出（`paths`）、`.dream-meta.json` | `JSON.parse` 容忍尾随 `\r`；git 输出走 `trim()` |
| `.backups/` 快照 | 字节复制，不改行尾 |
| 写入侧 | `serializeEntryFile` 与索引写回恒输出 LF；CRLF 文件首次写入会被整份转成 LF（既有决定） |

本设计的交付：**回归测试 + README 口径**，不改代码。

### 4.7 不变量清单（测试逐条钉住）

1. win32 上任意 key 派生出的名字：不含 `/` 或 `\`、不以 `.`/空格结尾、非保留设备名。
2. `resolveMemoryDir` 的结果恒在 `memoryDir` 之下（穿越兜底）。
3. POSIX 上 `projectDirName` 的输出与改动前逐字节一致（除 entry 文件名设备名变换）。
4. 锁路径要么不存在、要么完整 JSON、要么极短暂的 0 字节；不存在第四种状态。
5. `open(wx)` 驱动的互斥：并发 `withLock` 的最大同时持有数为 1。
6. 重试只吞瞬时 errno；`ENOENT`、`EISDIR` 等立即上抛。

## 5. 测试计划

### 5.1 Linux CI 可跑（随 `npm test`）

| 对象 | 断言 | 测试文件 |
|---|---|---|
| `projectDirName` win32 分支（平台注入 + `path.win32`） | §4.1 例子表逐条；§4.7 不变量 1 在恶意 key 语料（`..`、设备名、结尾点空格、UNC、盘符、长 key、混合分隔符）上成立 | `tests/paths.test.ts`（扩充） |
| `projectDirName` POSIX 回归 | 既有全部期望不变（含 `keeps backslashes literal`） | `tests/paths.test.ts` |
| `resolveMemoryDir` 兜底 | 越界时抛错；正常路径不变 | `tests/paths.test.ts` |
| `gitToplevel`（cdup） | 真临时仓库：子目录、仓库根、linked worktree 三种情形都解析到 `resolve(repoRoot)`；非仓库返回 `null` | `tests/paths.test.ts` |
| `expandTilde` | win32 认 `~\`；POSIX 不认 `~\`；两端都认 `~` / `~/` | `tests/config.test.ts`（扩充） |
| `entryFileName` 保留名 | `con`/`NUL`/`com1`/`lpt9`/`nul.tar.gz`/`aux.md` → `_` 前缀；`CONSOLE`/`nul2` 不受影响；确定性不变 | `tests/filename.test.ts`（扩充） |
| `#entryFiles` 设备名过滤（win32 注入） | win32 上 `con.md` 不入清单；POSIX 上仍入清单 | `tests/memory-store-read.test.ts`（扩充） |
| `isTransientFsError` / `withFsRetry` | 瞬时集合逐 errno；win32 才含 `EPERM`/`EACCES`；重试 N 次后成功；耗尽后原样抛原始错误；非瞬时（`ENOENT`）立即抛且只调用一次；注入 `sleep` 断言退避序列 | `tests/fs-retry.test.ts`（新增） |
| `fs-lock` 空记录 | 0 字节锁 → 等待到期后 `abandoned=false`；等待窗口内记录出现 → 尊重它（不双持有）；`tryWithLock` → `null`；`readLockStatus` 仍报 `unreadable`；垃圾/错形状语义不变 | `tests/fs-lock.test.ts`（扩充） |
| `fs-lock` 互斥 | 既有「并发 5 个调用者最大同时持有数 = 1」在 `open(wx)` 下仍成立 | `tests/fs-lock.test.ts`（保持） |
| CRLF 回归 | CRLF 索引的往返写（解析不误报 unrecognized、删除不留死链）；CRLF entry 的 list/search/replace/remove；CRLF 内容注入前 `\r` 已剔除；孤立 CR 同效 | `tests/entry-index.test.ts`、`tests/memory-store-*.test.ts`、`tests/inject.test.ts`（按缺口补） |

### 5.2 既有用例的语义变更（明确列出）

| 用例 | 变更 |
|---|---|
| `fs-lock.test.ts`「leaves no temporary files behind…」 | 临时文件机制已删除 → 改为断言「acquire/fail 之后目录里最多只有 `.lock`」 |
| `fs-lock.test.ts`「serialises overlapping…」的注释 | 注释里的「link 失败 → 读取」改为「`open(wx)` 失败 → 读取」 |
| `fs-lock.test.ts`「fails immediately on an unreadable or foreign lock record」 | 语义不变（垃圾/错形状仍立即报遗弃）；**新增** 0 字节的独立用例 |
| `readLockStatus` 系列 | 语义不变（`empty` 仍报 `unreadable`） |

### 5.3 测试可移植性改造（让真机能跑全量套件）

| 项 | 内容 |
|---|---|
| 权限类用例 | `memory-store-index.test.ts` 的两处 `chmod(dir, 0o500)` 用例在 win32 上 `skipIf`（Windows 的只读语义不同，且非管理员下行为不一致）；同 inode 用例依赖 `link` → win32 上 `skipIf` |
| 硬编码 POSIX 期望 | `paths.test.ts` 的 `"/mem"`、`"/home/..."`、`"/custom/root"` 等**进入真实文件系统运算或与 `join()` 结果比较**的期望改为按平台构造或分平台双期望；`agent-runner.test.ts` / `config.test.ts` / `dream.test.ts` 里的路径字面量只是「mock 入参 = 断言值」的纯透传比较（不经 `join`/`resolve`），平台无关 —— 保留原样，执行时逐条核对确认 |
| git 隔离 | `GIT_CONFIG_GLOBAL=/dev/null` → 临时空配置文件（`mkdtemp` 下建一个空文件）；`GIT_CONFIG_NOSYSTEM=1` 保持 |
| 跳过清单 | 所有 `skipIf(win32)` 用例在验收清单里列出，真机输出必须显示「跳过 N 条」且这些条目在清单里有名字 |

### 5.4 真机验收套件

见 `pi-memory/docs/superpowers/verification/2026-10-03-windows-support-acceptance.md`。覆盖：全量套件绿（含跳过清单）、`local/`/`git/` 两类目录名、Git Bash 与 PowerShell 身份一致、`~\` 展开、0 字节锁处置、**非 NTFS 卷上的锁**（`open(wx)` 的核心证明）、CRLF 存盘往返、大小写撞名、**`FileShare.None` 占住 `MEMORY.md` 触发瞬时 `EPERM` 重试**、快照与 `sessions/` 目录、`/memory` 状态行。

### 5.5 验收流程

1. 本设计给出编号清单与预期输出（PowerShell + git-bash 两套命令）。
2. 用户在 Windows 机器执行并回贴原始输出。
3. 差异逐条归因（**实现缺陷** / **环境差异** / **文档需要补充**），修完复跑。
4. 把结论回填验收清单的「实测」栏与本文档 §8 的记录表。偏差未闭环前不得宣称完成。

## 6. 文档与发布清单

| 文件 | 改动 |
|---|---|
| `README.md` / `README.zh.md` | ① 新增 Windows 小节：支持状态、命名规则（含 `C_3a__Users__...` 形态与 `local/` 旧布局迁移命令）、`~\`、锁可在任意卷（NTFS/ReFS/exFAT/网络盘）、行尾口径（写恒 LF、读容错）、已知限制（历史/外部创建的设备名文件在 Windows 上不可见） ②「名字面向 POSIX 文件系统」那条改为平台感知的描述 ③ `memoryDir` 配置行补 `~\` ④ `⚠️ Breaking changes` 加一条：Windows 上 `local/` 目录名形态变化（旧嵌套布局变孤儿目录，给手工 `mv` 迁移）+ 保留设备名的 entry 文件派生名加 `_` 前缀（新建文件才受影响） |
| `docs/superpowers/specs/2026-10-03-windows-support-design.md` | 本文档 |
| `docs/superpowers/verification/2026-10-03-windows-support-acceptance.md` | 真机验收清单 |
| 版本号 / CHANGELOG / npm 发布 | **不在本次范围**（D11）：验收通过后按 `docs/guides/release.md` 单独走；`⚠️ Breaking changes` 条目在 bump 之前单独提交 |

## 7. 风险与已知限制

| 风险 | 影响 | 处置 |
|---|---|---|
| 0 字节 `.lock` 窗口（新引入） | 持有者崩溃 → 等待者耗满 5s 才报错 | 错误文案给清除指引；`/memory unlock` 可清；验收清单第 5 条覆盖 |
| win32 上瞬时的 `EPERM` 真为永久权限错误 | 重试 6 次后才报错（~900ms 延迟） | 只影响失败路径的延迟，不影响正确性；fail-closed 保持 |
| POSIX 侧创建的保留设备名文件（历史版本或手工） | Windows 上不可见（已 skip）；不会被读取阻塞 | Ruling 5 的跳过是护栏；写进 README 已知限制 |
| `local/` 命名形态变化 | Windows 用户旧嵌套目录变孤儿 | README 给 `mv` 迁移命令；`git/` 目录完全不受影响 |
| `--show-cdup` 在极老 git（<1.5.4）上不可用 | toplevel 解析失败 → 退回 `local/<cwd>` 身份 | 15 年前的功能，接受；验收清单第 3 条在真机确认输出形态 |
| 真机验收依赖用户机器 | 无法自动回归 | D1 的既定取舍；验收记录留档 |

## 8. 验收记录表

| # | 条目 | 命令 | 预期 | 实测输出 | 结论 |
|---|---|---|---|---|---|
| 1 | 全量套件 | `npx vitest run`（pi-memory 目录） | 全绿 + 跳过清单与 `skipIf(win32)` 条目一致 | （待填） | （待填） |
| 2 | `local/` 目录名 | 见验收清单 | 单层 `C_3a__...` | （待填） | （待填） |
| 3 | Git Bash vs PowerShell 身份一致 | 见验收清单 | 同一个 `Dir:` | （待填） | （待填） |
| 4 | `git/` 目录名与 Linux 一致 | 见验收清单 | `github.com__owner__repo` | （待填） | （待填） |
| 5 | 0 字节锁处置 | 见验收清单 | 可操作错误 → `/memory unlock` 恢复 | （待填） | （待填） |
| 6 | 非 NTFS 卷上的锁 | 见验收清单 | 写入成功 | （待填） | （待填） |
| 7 | 瞬时 `EPERM` 重试 | 见验收清单 | 句柄释放后写入成功，无残留锁 | （待填） | （待填） |
| 8 | CRLF 往返 | 见验收清单 | 索引计数不误报、记忆仍可见 | （待填） | （待填） |
| 9 | 大小写撞名 | 见验收清单 | 两个文件、不互相覆盖 | （待填） | （待填） |
| 10 | 保留设备名 entry | 见验收清单 | 文件名为 `_con.md`，可正常读取 | （待填） | （待填） |
| 11 | 快照与 `sessions/` | 见验收清单 | `.backups/` 生成并裁剪、sessions 落入项目目录 | （待填） | （待填） |
