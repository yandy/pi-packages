# pi-sandbox：vcpkg 与 Playwright 存储档案设计

日期：2026-11-27
状态：已实现
前置设计：`2026-11-27-tool-storage-design.md`

## 1. 意图

在现有内置工具存储机制中增加 `vcpkg` 与 `playwright` 两个档案，使 vcpkg manifest 常用流程和 Playwright 浏览器安装在 `workspace-write` 下可以直接使用原生存储路径，无需重定向环境变量或手工配置额外可写根。

## 2. 目标与边界

- 复用现有 PATH/固定入口检测、纯路径 catalog、目录物化及 `extraRoots` 授权管线。
- 覆盖 Linux、macOS、Windows 默认路径和公开环境变量覆盖。
- vcpkg 只开放缓存与具名工作目录，不开放整个 `VCPKG_ROOT`，不开放 classic 模式的 `installed/`。
- Playwright 只开放下载浏览器的存储根，不开放系统 Chrome/Edge 安装前缀、包管理器全局安装目录或用户配置。
- 不执行工具，不解析项目依赖配置、vcpkg 配置或 CLI 参数，不新增配置字段和权限模式。

## 3. 方案比较

### A. 扩充现有静态档案（采用）

新增两个 profile 及既有 catalog 测试、检测测试和中英文 README 条目。改动局限于声明路径与固定检测入口，自动获得创建、危险路径检查、缓存、状态展示和所有后端的一致性。

### B. 仅文档化手工 `sandbox-writable.json`

实现最少，但每个用户都要预先创建并配置目录，不能达到默认放行目标。

### C. 开放整个工具根

直接开放 `VCPKG_ROOT` 会连带开放 ports、scripts、工具和版本控制元数据；开放整个 Playwright 包根会连带开放可执行包内容。均超出存储授权边界，排除。

## 4. 检测入口

| 档案 | PATH 入口 | 工作区固定入口 |
|---|---|---|
| vcpkg | `vcpkg` | 无 |
| playwright | `playwright` | `node_modules/.bin/playwright`、`node_modules/.bin/playwright.cmd`、`node_modules/.bin/playwright.ps1` |

Playwright 不把通用启动器 `npx`、`pnpx`、`bunx` 或 `uvx` 当作检测信号，避免为未使用 Playwright 的项目创建浏览器目录。本地固定入口覆盖依赖安装后的常见 `npx playwright ...`；PATH 入口覆盖全局 Node/Python CLI。

## 5. vcpkg 路径

平台缓存基目录：

- Windows：`%LOCALAPPDATA%\vcpkg`。
- Linux/macOS：绝对 `$XDG_CACHE_HOME/vcpkg`，否则 `~/.cache/vcpkg`；macOS 不改用 `~/Library/Caches`。

| 存储 | 解析规则 |
|---|---|
| binary cache | `$VCPKG_DEFAULT_BINARY_CACHE`；否则平台缓存基目录下 `archives/` |
| registries cache | `$X_VCPKG_REGISTRIES_CACHE`；否则平台缓存基目录下 `registries/` |
| downloads | `$VCPKG_DOWNLOADS`；否则已设置 `$VCPKG_ROOT` 时为其 `downloads/`；未设置 root 时为平台缓存基目录下 `downloads/`，覆盖只读 bundle |
| build trees | 已设置 `$VCPKG_ROOT` 时为其 `buildtrees/` |
| package trees | 已设置 `$VCPKG_ROOT` 时为其 `packages/` |

不生成 `installed/` 候选，不推断 PATH 中 vcpkg 可执行文件所在的实例根。`VCPKG_ROOT` 被可执行文件内建实例根覆盖、CLI 指定其他 root、只读 bundle 与实际 env 不一致等情况，仍由 `sandbox-writable.json` 补充。工具特定相对路径按现有规则相对 workspace 解析；XDG 相对值忽略。

## 6. Playwright 路径

| 平台 | 默认浏览器存储 |
|---|---|
| Linux | 绝对 `$XDG_CACHE_HOME/ms-playwright`，否则 `~/.cache/ms-playwright` |
| macOS | `~/Library/Caches/ms-playwright` |
| Windows | `%LOCALAPPDATA%\ms-playwright` |

`PLAYWRIGHT_BROWSERS_PATH` 覆盖默认根；相对值按 Playwright 规则以 `INIT_CWD` 为基准，未设置时以 workspace 为基准。值为 `0` 表示包内 `.local-browsers`，其实际位置取决于具体 Playwright 包根，因此不生成自动候选；workspace 内安装已由工作区授权覆盖，包外 hermetic 安装仍需显式授权。

## 7. 测试与文档

- catalog golden vectors 覆盖两个档案的三平台默认路径、vcpkg root/独立覆盖、Playwright XDG 与 `INIT_CWD`。
- 边界测试覆盖未设置 `VCPKG_ROOT`、`PLAYWRIGHT_BROWSERS_PATH=0`、相对路径和不激活通用启动器。
- 检测测试覆盖 PATH 与本地 Playwright 固定入口，并确认检测不执行入口。
- 既有物化、围栏和各后端 `extraRoots` 测试继续作为统一回归网，不复制每个档案的真机矩阵。
- `README.md` / `README.zh.md` 增加两个档案、主要覆盖变量及 classic/hermetic 排除边界。
- 验证命令：`npm test -w pi-sandbox`、`npm run typecheck -w pi-sandbox`、`npm run lint -w pi-sandbox`。

## 8. 官方依据

- vcpkg 环境变量：https://learn.microsoft.com/en-us/vcpkg/users/config-environment
- vcpkg binary cache：https://learn.microsoft.com/en-us/vcpkg/users/binarycaching
- vcpkg 目录清理与平台缓存：https://learn.microsoft.com/en-us/vcpkg/about/faq
- vcpkg 实际 root/downloads/buildtrees/packages/registries 解析：https://github.com/microsoft/vcpkg-tool/blob/main/src/vcpkg/vcpkgpaths.cpp
- Playwright 浏览器路径：https://playwright.dev/docs/browsers#managing-browser-binaries
- Playwright `PLAYWRIGHT_BROWSERS_PATH` 与 `INIT_CWD` 解析：https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/registry/index.ts
