# Design: pi-memory 可读 memory 目录路径

**Date:** 2026-09-30
**Status:** approved

## Summary

当前每个项目的 memory 目录名是 `sha256(项目 git root 或绝对路径)[:12]`（如 `~/.pi/memory/14a3439e3a80/`），对人不可读，无法判断哪个目录属于哪个项目。

本设计把项目 memory 目录改为两级可读布局：

```
~/.pi/memory/
  git/<repo 身份>/       ← 有可用 remote 的 git 仓库
  local/<绝对路径>/       ← 非 git 目录、无 remote 的 git 仓库、local remote 的 git 仓库
```

`git/` 下的名字由 remote URL 归一化而来，因此同一仓库的不同 clone / worktree / 协议写法共享同一 memory 目录；`local/` 下的名字由项目根绝对路径拼接而来。

## Scope

### Deliverable

分支 `feat/memory-readable-paths` 完成代码、测试、文档后，**创建 GitHub PR** 提交变更（合并与否则由用户决定）；npm 版本发布不在本任务范围内。

### Files to modify

| File | Change |
|------|--------|
| `pi-memory/src/paths.ts` | 删除 `projectHash`；新增 `projectIdentity()`、`projectDirName()`；改写 `resolveMemoryDir()`；保留 `safeTopicPath()` 与 `gitToplevel()` 行为 |
| `pi-memory/tests/paths.test.ts` | 全部重写：mkdtemp 隔离 + 真实 `git init` / `git remote add` fixture，覆盖身份识别、目录命名、截断、组合 |
| `pi-memory/tests/index-wiring.test.ts` | 同步 `src/paths` module mock（去掉 `projectHash`，保留 `resolveMemoryDir` / `safeTopicPath`） |
| `pi-memory/README.md` | 更新简介、File layout、Branch-safe 描述；新增旧 hash 目录手动搬运说明与已知限制 |
| `pi-memory/README.zh.md` | 同上（中文） |
| `pi-memory/tests/manual-test-plan.md` | 更新 `<hash>` 相关描述 |

### 不涉及变更

- 版本号与 npm 发布：本次任务不动 `package.json` / `package-lock.json`，不做版本升级、不创建 GitHub Release；发布在后续独立会话按 `docs/guides/release.md` 执行（该变更为破坏性磁盘布局变更，发布时建议 minor 版本）
- `index.ts` 调用点（仍只调用一次 `resolveMemoryDir(config, ctx.cwd)`）
- `safeTopicPath()` 的安全校验语义
- memory 文件内部格式（`MEMORY.md`、topic 文件、`.dream-meta.json`）
- `memoryDir` 配置项语义（仍是 memory 数据根目录）
- session 持久化（`<项目记忆目录>/sessions/`）与 session-search 逻辑

## Design

### 1. 项目身份 `projectIdentity(cwd)`

```ts
export type ProjectKind = "git" | "local";

export interface ProjectIdentity {
  kind: ProjectKind;
  /** git: 归一化 remote（host/path）；local: 项目根绝对路径 */
  key: string;
}

export async function projectIdentity(cwd: string): Promise<ProjectIdentity>;
```

判定流程：

1. `git rev-parse --show-toplevel`（3s 超时，失败/超时/git 不存在 → 视为非 git）
2. 非 git → `{ kind: "local", key: resolve(cwd) }`
3. 是 git → 读取 remote URL：
   - 一次 `git config --get-regexp '^remote\..*\.url$'` 读取**原始配置**（每个 remote 取第一个 URL，与 git fetch 语义一致；`pushurl` 不匹配该 pattern）
   - 顺序：`origin` 优先，其余按名字字母序；依次归一化，**取首个可用者**
   - 无 remote 或全部不可归一化 → `{ kind: "local", key: toplevel }`
   - 用原始配置而非 `git remote get-url`，因此全局 `url.*.insteadOf` 重写不影响身份判定；同时也只需一次 git 调用
4. URL 判定与归一化 `normalizeRemoteUrl(url)`：
   - 含 `://` 的 scheme 形式用 WHATWG `URL` 解析（userinfo 按**最后一个** `@` 切分、端点由 `.hostname` 天然剔除、`.`/`..` 段被归一化）；scheme ∈ {`http`, `https`, `ssh`, `git`}，并接受 `git+ssh` / `git+https` 别名（先剥离 `git+` 前缀）
   - scp 式 `[user@]host:path`（user 可省略）：手工切分（git 私有伪 URL，无标准库解析器）——先按首个 `:` 切分（`:` 之前不得含 `/`，方括号 IPv6 字面量内的 `:` 不算），再在该 authority 内按最后一个 `@` 剥离 userinfo
   - host 统一重新归一化（`new URL("https://" + host).hostname`，失败则转小写）：因为 `ssh://`/`git://` 等非 special scheme 的 `URL.hostname` 是未归一化的 opaque host（不转小写、IDN 不转 punycode），该步骤使 `https://例子.com`、`ssh://例子.com`、`例子.com:...` 三种写法得到同一 key
   - 其他（`file://`、`git+file://`、本地路径、其他 scheme）→ 视为不可用 → `{ kind: "local", key: toplevel }`
   - 余下路径去掉首尾 `/` 与尾部的 `.git`（大小写不敏感）
   - 路径为空（如 `https://github.com/`）→ 视为不可用 → `local` + toplevel
   - 归一化结果：`{ kind: "git", key: "host/owner/.../repo" }`，保留 owner 之后的全部子路径（GitLab subgroup 等）

边界：`.git` 后缀只剥离末尾一次；`host` 一律小写（DNS 大小写不敏感）；端口丢弃（同 host 不同端口的仓库合并为同一 key）。

### 2. 目录名 `projectDirName(key)`

1. 按 `/` 分段（命名面向 POSIX 文件系统：`\` 视为普通字符；不做 Windows 设备名或结尾点/空格处理）
2. 丢弃空段（含 local 绝对路径的前导 `/`）与 `.` / `..` 段
3. 段内非法字符 → 小写十六进制转义 `_XX`：
   - 控制字符（`\x00-\x1f`）、`<` `>` `:` `"` `|` `?` `*`
   - `_` **不转义**（已确认取舍，见「已知限制」）
4. 用 `__` 连接各段
5. 长度（UTF-8 字节数）> 120 → 按 **grapheme cluster** 取前 100 字节（不切断多字节字符、代理对与 ZWJ/国旗等字素序列）+ `__` + `sha256(key)` 前 8 位
   - 实现注记（2026-09-30 复审后）：初版按「字符数」计数，CJK 路径可产出 284 字节的目录名（突破文件系统 255 字节上限）且可能截断出孤立代理项。数值 120/100 不变，单位改为字节。
6. 所有段都被丢弃（如 key 为 `/`）→ 目录名 `root`

示例：

| key | 目录名 |
|-----|--------|
| `github.com/yandy/pi-packages` | `github.com__yandy__pi-packages` |
| `gitlab.com/foo/bar/repo` | `gitlab.com__foo__bar__repo` |
| `/home/yandy/workspace/scratch` | `home__yandy__workspace__scratch` |
| `/home/yandy/proj/with:colon` | `home__yandy__proj__with_3acolon` |
| `github.com/a/<超长 owner/repo>`（>120） | `<前 100 字符>__<hash8>` |

### 3. 组装 `resolveMemoryDir(config, cwd)`

```ts
const { kind, key } = await projectIdentity(cwd);
return join(config.memoryDir, kind, projectDirName(key));
```

即 `~/.pi/memory/git/<dir>` 或 `~/.pi/memory/local/<dir>`。`memoryDir` 可配置，`git`/`local` 是它之下的固定两级。

### 4. 场景矩阵

| 场景 | kind | key | 结果示例 |
|------|------|-----|----------|
| 非 git 目录 `/home/yandy/scratch` | local | `/home/yandy/scratch` | `local/home__yandy__scratch` |
| git repo + `https://github.com/yandy/pi-packages.git` | git | `github.com/yandy/pi-packages` | `git/github.com__yandy__pi-packages` |
| 同上，remote 写成 `git@github.com:yandy/pi-packages.git` | git | 同上 | 同上（同目录） |
| 同上，remote 写成 `git://github.com/yandy/pi-packages.git` | git | 同上 | 同上（同目录） |
| git repo + `ssh://git@gitlab.com:2222/grp/sub/repo.git` | git | `gitlab.com/grp/sub/repo` | `git/gitlab.com__grp__sub__repo` |
| git repo + `file:///srv/repos/foo.git`（根 `/srv/repos/foo`） | local | `/srv/repos/foo` | `local/srv__repos__foo` |
| git repo + 无 remote（根 `/srv/repos/bar`） | local | `/srv/repos/bar` | `local/srv__repos__bar` |
| git repo 子目录中启动 | 同项目 | 同项目 | 同项目目录（toplevel 决定） |
| 同一仓库的 worktree | git | 同 remote | 同项目目录（共享记忆） |

### 5. 错误处理

- git 命令任何失败（不存在 / 非仓库 / 超时）→ 静默降级到 `local`，不抛出
- remote 列表为空 / URL 为空 / URL 不可归一化 → 降级到 `local` + toplevel
- 目录名始终是单一文件系统组件：不含 `/`，不含可独立成段的 `.` / `..`，无路径穿越风险
- `safeTopicPath()` 保持现状（topic 文件校验独立于项目命名）

## Migration & Compatibility

**不迁移。** 旧 `<hash>` 目录不被读取、不被移动、不被删除；新布局从空目录开始。

- 旧数据留在 `~/.pi/memory/<12-char-sha256>/`，需要的话可手动搬运到新路径
- 手动对照方法：`printf '%s' "$(git rev-parse --show-toplevel)" | sha256sum | cut -c1-12` 得到旧 hash（非 git 项目改为 `printf '%s' "$PWD"`），新名字由 `git remote get-url origin` 按规则推导；README 收录该操作
- 换 remote / remote 改名 / remote 协议不变但路径变化 → 记忆目录随之变化，旧目录成为孤儿（需手动合并）

### 已知限制

段内 `_` 不转义，理论上存在映射碰撞：`/home/a__b` 与 `/home/a/b` 都会得到 `home__a__b`，两个项目会共享同一 memory 目录。这是为可读性接受的取舍，README 中明确记录；不做转义或碰撞检测。

## Testing

全部按 `docs/guides/testing.md`：`mkdtemp(join(tmpdir(), ...))` 隔离 + `afterEach` 清理，禁止硬编码 `/tmp/...` 路径；git fixture 通过 `execFile("git", ["init"], { cwd })` + `git remote add` 构造，期望的 toplevel 用 `git rev-parse --show-toplevel` 现场取得（避免 macOS symlink 差异）。

| 用例组 | 覆盖 |
|--------|------|
| `projectIdentity` — 非 git | 普通目录 → local + `resolve(cwd)` |
| `projectIdentity` — git remote 协议 | https / http / scp 式 ssh / `ssh://` / `git://` → git + 同一 key |
| `projectIdentity` — URL 清洗 | 端口、userinfo（含密码含 `@`）、尾 `.git`、尾 `/`、host 大小写与 IDN punycode（https/ssh/scp 三形式一致）、方括号 IPv6 |
| `projectIdentity` — 多 remote | 有 origin 用 origin；无 origin 用字母序第一个 |
| `projectIdentity` — 降级 | 无 remote、`file://`、本地路径 remote → local + toplevel |
| `projectIdentity` — 常规 | 子目录启动与仓库根目录得到相同身份 |
| `projectDirName` | 层级拼接、非法字符 `_XX`、`.`/`..` 丢弃、反斜杠视为普通字符、空 key → `root` |
| `projectDirName` — 截断 | >120 字节时 ≤110 字节且以 `__<8 hex>` 结尾、按字节计数、不切断代理对与 grapheme（ZWJ/国旗）、确定性、不同长 key 不同名 |
| `resolveMemoryDir` | git / local 两类的完整组合断言（`join(memoryDir, kind, name)`） |
| `safeTopicPath` | 保留现有 4 个安全用例 |
| `index-wiring` | mock 面与新导出同步后，session_start wiring 测试保持通过 |
