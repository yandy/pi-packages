# pi-sandbox：内置常用工具存储目录设计

日期：2026-11-27
状态：已批准
前置设计：`2026-10-14-extra-writable-dirs-design.md`、`2026-10-24-writable-dirs-file-design.md`、`2026-10-14-env-redirect-guideline-design.md`

## 1. 背景与意图

`workspace-write` 默认只开放 workspace 与 tmp。pip、uv、npm、pnpm 等工具正常安装依赖时会写用户级 cache、store、registry、构建缓存或运行时存储；模型为了避开拒绝，可能把这些目录重定向到 workspace/tmp。这样既破坏全局存储复用，也绕过了拒绝后提权流程。

目标是让常用工具原生命令在 `workspace-write` 下直接工作，无需用户逐个维护 `sandbox-writable.json`，也无需模型修改环境变量、CLI flag 或配置文件。授权对象是工具的**持久化存储**，不只是名称中带有 cache 的目录。

denial-first 仍是所有未覆盖写入的默认协议：不开放任意命令的主动提权，避免所有调用都预先申请 `danger-full-access`。

## 2. 目标、非目标与反目标

### 目标

- 默认启用内置工具存储档案；按 PATH 和项目 wrapper 检测相关工具，零配置覆盖常见使用方式。
- 同一档案声明 Linux、macOS、Windows 路径及公开环境变量覆盖。
- 自动创建缺失的存储目录，支持首次使用；只创建具体存储根，不重写工具环境。
- shell 与 write/edit、bwrap、landlock、seatbelt、windows-acl 共用现有 `extraRoots` 授权管线。
- 保留全局关闭开关、状态可见性和自定义 `sandbox-writable.json`。
- 单个目录初始化失败只收窄授权，不让无关命令失去沙箱或全部无法执行。

### 非目标

- 不解析 shell 命令，不按每条命令动态收缩权限；检测只决定档案是否进入会话级静态并集。
- 不执行 `npm config get`、`uv cache dir`、`go env` 等外部工具，不读取工具配置文件来推导路径。
- 不支持 CLI 参数、项目配置或 `go env -w` 等持久配置里的自定义存储路径；这些仍由用户显式加入 `sandbox-writable.json`。
- 不开放用户配置、凭据、全局安装前缀、PATH 上的 bin/shim 目录。
- 不引入主动提权、存储级审批参数或新的权限模式；既有 denial-first 不变。
- 不改变 read-only、danger-full-access、网络、GPU、拒绝分类或 Windows ACL 回收语义。
- 不追求首版覆盖所有语言与包管理器；档案必须可独立扩充。

### 反目标

- 不开放整个 home、`~/.cache`、`~/.local/share`、`%LOCALAPPDATA%` 或工具用户目录来减少维护成本。
- 不把提示词当作安全边界；现有缓存重定向禁令继续作为行为约束，但不替代文件系统强制。
- 不为 CMake 等常规构建没有全局依赖存储的工具虚构目录。

## 3. 方案比较

### A. PATH/项目入口检测 + 静态档案并集（采用）

检测已安装工具及当前 workspace 的 Maven/Gradle wrapper，首次实际 `workspace-write` 调用前创建相应存储根。之后 shell 与文件工具共享这些根。

优点：无 shell 解析、无外部进程、全后端一致、支持首次使用、不会为完全无关的工具创建目录。代价是同一进程中所有受限调用都能写已启用档案，不是逐命令最小权限。

### B. 全部档案始终启用

实现最简单，但会为未安装工具创建大量目录；Windows 上还会增加 ACL 授权与递归传播成本。排除。

### C. 按命令动态授权

理论上权限最窄，但 shell 复合命令、alias、函数、脚本、Corepack、`npx`/`uv run` 使可靠识别不可行；还会使 write/edit 与 shell 的权限语义分叉。排除。

### D. 提示词或主动提权替代内置授权

现有提示词已经禁止 ENV/flag/config 重定向；继续加强措辞不能提供强制保证。允许模型预见到写入就主动提权会破坏 denial-first，重新产生审批泛滥。排除其作为本需求的替代；提示词继续覆盖未内置工具。

## 4. 核心模型

新增 `src/tool-storage/`，将职责分为三层：

```ts
type ToolStorageProfile = {
  id: "pip" | "uv" | "npm" | "corepack" | "pnpm" | "yarn" | "bun" | "go" | "maven" | "gradle";
  roots(context): ToolStorageRoot[];
};

type ToolStorageRoot = {
  profile: ToolStorageProfile["id"];
  path: string;
};

type ToolStoragePlan = {
  profiles: string[];
  roots: ToolStorageRoot[];
};
```

1. **解析**：纯函数按注入的 platform、环境变量、home、workspace、path API、UID 计算候选路径；不碰真实环境。
2. **检测**：只在 PATH 或 workspace 固定入口上检测，不执行工具；每个 workspace 的形成一次 plan。
3. **物化**：仅实际 `workspace-write` 调用执行安全校验、创建、`realpath`、去重并返回授权根；`/permission` 只读 plan，不创建目录。

plan 中的每个候选都是可自动创建的具名存储根；不存在 `create=false` 的授权根。pnpm 的 XDG 锁只在合格父目录已存在时生成候选，物化的是其具名子目录，而不是不可创建的父根。

生产环境按 canonical workspace 缓存 plan，但**不缓存物化后的存在性结论**。每次调用都重新执行 lstat/stat、mkdir（如缺失）、realpath 与危险目标检查：目录在进程运行期间被删除时会在下次调用重建，符号链接换绑也不会沿用旧授权拼写。PATH、环境变量或工具安装状态变化在 pi 重启后生效；测试使用显式注入，不读宿主真实 HOME/PATH。

## 5. 工具检测

### PATH

不 spawn `which`/`where`，只检查候选文件：

- POSIX 按 `PATH` 分隔符搜索无扩展名入口，并要求文件可执行。
- Windows 使用 `PATHEXT`（缺省 `.COM;.EXE;.BAT;.CMD`），匹配 `npm.cmd`、`uv.exe` 等；不执行文件。
- 不解析 alias、shell function 或命令文本。

| 档案 | 检测入口 |
|---|---|
| pip | `pip`、`pip3`、`python`、`python3`；Windows 另含 `py`（覆盖 `python -m pip`） |
| uv | `uv` |
| npm | `npm`、`npx` |
| corepack | `corepack`、`pnpm`、`yarn`（包管理器 shim 也依赖 Corepack 存储） |
| pnpm | `pnpm`、`pnpx`、`corepack` |
| yarn | `yarn`、`yarnpkg`、`corepack` |
| bun | `bun`、`bunx` |
| go | `go` |
| maven | `mvn`，或 workspace 根存在 `mvnw` / `mvnw.cmd` |
| gradle | `gradle`，或 workspace 根存在 `gradlew` / `gradlew.bat` |

Corepack 会同时激活 pnpm/yarn 档案，以覆盖 `corepack pnpm ...`、`corepack yarn ...`，无需解析命令。检测只激活固定档案，项目不能借此声明任意路径。

## 6. 首版存储档案

下表省略共同的环境变量展开细节。`HOME` 表示 `os.homedir()`；Windows 缺省 `LOCALAPPDATA=HOME/AppData/Local`、`APPDATA=HOME/AppData/Roaming`。XDG 变量仅在接受绝对路径时生效。

### 6.1 Python

| 档案 | Linux | macOS | Windows | 覆盖 |
|---|---|---|---|---|
| uv cache | `$XDG_CACHE_HOME/uv`，否则 `~/.cache/uv` | 同 Linux（uv 在 Unix 统一采用 XDG 约定） | `%LOCALAPPDATA%\uv\cache` | `UV_CACHE_DIR` |
| uv managed Python | `$XDG_DATA_HOME/uv/python`，否则 `~/.local/share/uv/python` | 同 Linux | `%APPDATA%\uv\data\python` | `UV_PYTHON_INSTALL_DIR` |
| pip cache | `$XDG_CACHE_HOME/pip`，否则 `~/.cache/pip` | `$XDG_CACHE_HOME/pip`，否则 `~/Library/Caches/pip` | `%LOCALAPPDATA%\pip\Cache` | `PIP_CACHE_DIR` |

只授予 uv 的 `python/` 子目录，不授予 persistent data 根：该根还包含 tools 与认证数据。uv 的 tools、Python/tool executable 目录、`~/.local/bin` 均排除；显式安装工具或可执行入口的请求仍可能被拒。

### 6.2 JavaScript

| 档案 | Linux | macOS | Windows | 覆盖 |
|---|---|---|---|---|
| npm cache | `~/.npm` | `~/.npm` | `%LOCALAPPDATA%\npm-cache` | `npm_config_cache` / `NPM_CONFIG_CACHE` |
| Corepack 存储 | `~/.cache/node/corepack` | 同 Linux | `%LOCALAPPDATA%\node\corepack` | `COREPACK_HOME` |
| pnpm store | `$PNPM_HOME/store`；否则 `$XDG_DATA_HOME/pnpm/store`；否则 `~/.local/share/pnpm/store` | 前两项相同；否则 `~/Library/pnpm/store` | `%LOCALAPPDATA%\pnpm\store` | `PNPM_HOME`、`XDG_DATA_HOME` |
| pnpm cache | `$XDG_CACHE_HOME/pnpm`，否则 `~/.cache/pnpm` | XDG 相同；否则 `~/Library/Caches/pnpm` | `%LOCALAPPDATA%\pnpm-cache` | `XDG_CACHE_HOME` |
| pnpm state | `$XDG_STATE_HOME/pnpm`，否则 `~/.local/state/pnpm` | 同 Linux | `%LOCALAPPDATA%\pnpm-state` | `XDG_STATE_HOME` |
| Yarn Classic cache | `$XDG_CACHE_HOME/yarn`，否则 `~/.cache/yarn` | `~/Library/Caches/Yarn` | `%LOCALAPPDATA%\Yarn\Cache` | `YARN_CACHE_FOLDER` |
| Yarn Berry 全局存储 | `~/.yarn/berry` | 同 Linux | 同 Linux（按 Yarn 的 HOME 展开） | `YARN_GLOBAL_FOLDER` |
| Bun package cache | `~/.bun/install/cache` | 同 Linux | 同 Linux | `BUN_INSTALL_CACHE_DIR` |

Yarn Berry 默认 `enableGlobalCache=true`；项目关闭全局缓存时 `.yarn/cache` 本就在 workspace 内，但默认 mirror 仍可能使用 globalFolder，因此保留 Berry 档案。`YARN_CACHE_FOLDER` 同时作为 Classic 与显式 Berry cache 覆盖处理。

pnpm 的 `global/`、`bin/`，npm 的全局 prefix，Yarn/Bun 的全局安装与 bin，以及所有用户配置和认证文件均排除。Bun 可选 global virtual store 位于 cache 下的 `links/`，随 cache 根覆盖，不另开全局安装目录。

pnpm 非 tmp 的锁目录另行纳入，不开放锁根本身：

- POSIX 只有已设置且已存在、归当前用户所有且权限合格的 `XDG_RUNTIME_DIR` 才需要额外根；否则 pnpm 使用已开放的 `/tmp`。
- POSIX 目录名带 `-<uid>`，Windows 不带 UID。
- Windows 根为 `%LOCALAPPDATA%`，POSIX 根为合格的 `$XDG_RUNTIME_DIR`。
- 具名子目录为 `pnpm-store-operation-locks`、`pnpm-dir-locks`、`pnpm-verify-deps-install-locks`、`pnpm-modules-swaps`、`pnpm-wasm-sqlite`。

只创建这些具名子目录；若 `XDG_RUNTIME_DIR` 不存在或不合格，不创建它，回退路径 `/tmp` 已由默认策略覆盖。

### 6.3 Go 与 JVM

| 档案 | Linux | macOS | Windows | 覆盖 |
|---|---|---|---|---|
| Go module cache | 首个 `GOPATH` 下的 `pkg/mod`，缺省 `~/go/pkg/mod` | 同 Linux | 同 Linux | `GOMODCACHE`、首项 `GOPATH` |
| Go build cache | `$XDG_CACHE_HOME/go-build`，否则 `~/.cache/go-build` | `~/Library/Caches/go-build` | `%LOCALAPPDATA%\go-build` | `GOCACHE` |
| Maven local repository | `~/.m2/repository` | 同 Linux | 同 Linux | 不解析 `settings.xml` / CLI 属性 |
| Maven Wrapper distributions | `~/.m2/wrapper/dists` | 同 Linux | 同 Linux | `MAVEN_USER_HOME` 只改变 wrapper 根 |
| Gradle 存储 | `~/.gradle` 下述子目录 | 同 Linux | 同 Linux | `GRADLE_USER_HOME` |

`GOCACHE=off` 不生成候选；相对路径或非绝对 `GOCACHE` 不创建。Go 的 `bin/`、Maven/Gradle 安装目录均排除。Maven 的 `MAVEN_USER_HOME` 不冒充 Maven 自身的 localRepository 配置。

Gradle 只开放 `caches/`、`daemon/`、`jdks/`、`wrapper/dists/`。不开放 `GRADLE_USER_HOME` 根、`init.d/` 或 `gradle.properties`。后续版本若出现新的必要子目录，应单独扩充档案，不扩大为整根授权。

### 6.4 首版不纳入

- **CMake**：常规 configure/build 写项目 build tree；`export(PACKAGE)` 自 3.15 起默认不写用户 package registry。因此没有默认档案。显式启用 registry 的项目可使用 `sandbox-writable.json` 授权 POSIX `~/.cmake/packages`；Windows 注册表写入不属于现有文件根授权模型。
- **Cargo**：正常构建除 registry/git 子目录外还会写 `CARGO_HOME/.package-cache`。现有管线只支持目录根；开放整个 `CARGO_HOME` 会连带开放 `bin/`。首版不纳入，待有文件级或排除子路径能力后再评估。
- 语言版本管理器的 shims、系统包管理器、语言运行时安装前缀、全局 CLI 工具目录均不作为存储档案处理。

## 7. 路径与安全约束

### 路径来源

只使用固定默认路径与父进程公开环境变量。工具特定的非 XDG 路径覆盖若是相对路径，按 workspace 解析；落在 workspace/tmp 内的结果无需额外授权。XDG 相对值按规范忽略。

不读取 `.npmrc`、`uv.toml`、`pnpm-workspace.yaml`、`.yarnrc.yml`、`bunfig.toml`、Maven `settings.xml` 或 Go 持久环境配置。自定义配置造成的路径差异由 `sandbox-writable.json` 补充。

### 自动授权必须 fail-closed

候选在创建与授权前必须通过：

1. 规范化后是绝对目录路径；不是文件系统根。
2. 不是 home、home 的祖先、pi agent 目录及其内部或祖先。
3. 不是 `LOCALAPPDATA`、`APPDATA`、XDG 根等共享基目录本身。
4. 不落在已知凭据/配置目录（如 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config`、`~/.pi`）内，也不包含这些目录。
5. 已存在符号链接先 `realpath`，对真实目标重新执行上述检查；非目录目标拒绝。

与手工 `extraWritableDirs` 的 agent 目录 warn-only 不同，自动档案命中危险落点必须告警并丢弃，不能保留授权。所有路径比较在 Windows 上大小写不敏感，并统一分隔符。

### 目录物化与失败

- 只有生效模式为 `workspace-write` 时才创建；read-only、danger-full-access、`/permission` 均不写宿主。
- 每次调用对 plan 的全部候选重新检查；缺失时使用宿主扩展进程的 `mkdirSync(path, {recursive:true})`，只创建最终具名存储根及必要父目录，不修改工具环境。
- 创建后 `statSync().isDirectory()` + `realpathSync.native`，再 canonical 去重。已物化根被删除后于下次调用重建，绝不把不存在根交给 bwrap/windows-acl。
- 创建、校验或 realpath 失败：经现有配置告警通道按根报告一次，省略该根，其余根和命令仍 confined 执行。真正需要该目录的命令可在沙箱内失败，再走既有 denial-first；后续调用可重试物化。
- Windows runner 对最终授予根仍按既有规则 fail-closed；本设计不隐藏 ACL 错误，不在命令可能已运行后重试。
- Windows 首次给已有大存储树授权时，`grantWrite` 会在**独立 runner 进程**同步传播 ACE/Low 标签，可能明显延长当次命令，但不阻塞 pi 扩展进程的事件循环；后续调用命中精确 ACE 快路径。物化侧只创建目录，不遍历存储树，也不另加目录大小上限或递归扫描。

## 8. 配置与状态

`~/.pi/agent/sandbox.json` 新增：

```json
{
  "toolStorage": true
}
```

- 默认 `true`；`false` 完全关闭内置档案。
- 仅接受 boolean；非法值告警并回落默认。
- 仍是 global-only，项目级同名文件静默忽略。
- `sandbox-writable.json` 语义不变；自定义根与内置根取 canonical 并集。
- 配置缓存与 plan 缓存均在重启后刷新。

`/permission` 增加一行，不创建目录：

```text
tool storage: auto (corepack, npm, pnpm)
tool storage: auto (none detected)
tool storage: off
```

非 `workspace-write` 下追加 `(inactive: <mode>)`。该行展示检测到的档案名，不把很长的路径列表塞进状态输出。

## 9. 现有代码接线

- `src/config.ts`：`SandboxConfig` / `DEFAULT_SANDBOX_CONFIG` 增加 `toolStorage` 并校验。
- `src/tool-storage/catalog.ts`（新增）：档案与纯路径解析。
- `src/tool-storage/detect.ts`（新增）：PATH/wrapper 检测与 plan 缓存。
- `src/tool-storage/materialize.ts`（新增）：安全校验、目录物化与逐次复检。
- `src/tool-storage/index.ts`（新增）：供工具与状态命令使用的编排入口。
- `src/tools.ts`：bash/powershell/write/edit 在解析当次 mode 后调用同一 helper，得到 `config.extraWritableDirs + materializedToolRoots`。
- 测试注入拆成两个独立缝：`_extraRoots` 只替换手工配置根，`_toolStorageRoots` 只替换内置物化根；两者都存在时才做并集断言。既有无关用例显式注入 `_toolStorageRoots: []`（或 `toolStorage:false`），包括直接调用 `createSandboxTools` 的 smoke/forwarding/prompt 测试，绝不回退真实 PATH/HOME。只有专门的真实集成用例启用生产检测。
- `index.ts`：`/permission` 使用只检测、不物化的 plan 显示档案；相关单测通过临时 PATH/HOME 与显式关闭配置隔离宿主。
- `src/policy.ts`、`src/fence.ts`、`src/runners.ts`、`src/win32/*` 无需新授权语义；最终内置根就是现有 `extraRoots`。
- `src/tools.ts` 的 ENV 重定向禁令及 denial-first 提示保持不变。

自定义 `runnerCommand` 也经现有 bwrap profile 获得相同根，不形成例外。

## 10. 测试与验收

### 单元测试

`tests/tool-storage.test.ts`：

- 每个档案在 linux/darwin/win32 的默认路径 golden vectors。
- XDG 与工具环境变量优先级；pnpm 的 PNPM_HOME/store 分支、macOS 特殊路径、uv Windows APPDATA。
- Go 多 GOPATH 取首项、GOCACHE=off、Maven wrapper 与 Maven repository 路径分离。
- pnpm 锁的 UID 后缀、Windows 无后缀、XDG_RUNTIME_DIR 缺失/不合格不创建。
- PATH 检测不 spawn；POSIX 可执行位、Windows PATHEXT；Corepack 联动与 wrapper 文件检测。
- 未检测工具不创建目录；同一 workspace 只生成一次 plan。
- 缺失目录递归创建、已存在目录复用、realpath 去重、并发调用幂等。
- 文件系统根、home/祖先、agent 目录、共享基目录、凭据目录、非目录和危险 symlink 全部拒绝且告警。
- 单根创建失败只省略该根；read-only/danger/status 零写入。

### 现有层回归

- `tests/config.test.ts`：默认值、true/false、非法值、项目级忽略、配置错误隔离。
- `tests/tools.test.ts`：四工具获得内置根与手工根并集；只读/全权不物化；分别注入 `_extraRoots` / `_toolStorageRoots`，并审计所有既有 `createSandboxTools` 调用都显式关闭或替换生产检测，不读真实 PATH/HOME。
- `tests/index-smoke.test.ts`：状态行 auto/none/off 与 inactive；不创建目录；PATH/HOME 均隔离。
- `tests/runners.test.ts` / `tests/fence.test.ts`：既有 extraRoots 全后端测试作为回归网，无需复制每个档案的矩阵。

### 真机集成

- Linux bwrap：将 HOME/PATH 隔离到临时目录，放置假工具入口；首次命令前目标不存在，调用后可写，workspace 外普通文件仍不可写，read-only 不创建。
- macOS seatbelt：同型最小用例，验证 Library 路径与 XDG 覆盖。
- Windows ACL：CI/真机验证内置根获得独立 capability SID、首次创建与写入成功、关闭 `toolStorage` 后被拒、配置收窄立即失效；重点覆盖 pnpm 具名锁目录而非整个 LocalAppData。
- 不做会下载大量真实依赖的验收；路径正确性由官方文档 golden vectors 与假写入探针验证。

命令链：`npm test -w pi-sandbox`、`npm run typecheck -w pi-sandbox`、`npm run lint -w pi-sandbox`，并跑 Windows CI。

## 11. 文档与安全说明

`README.md` / `README.zh.md`：

- 三档模式表补充内置工具存储根；配置表加入 `toolStorage`。
- 用按平台的档案表替代当前“先手动 mkdir 再写 sandbox-writable.json”的常见工具主流程；手工文件保留给自定义路径。
- 说明检测时机、首次创建、重启刷新、全局安装/bin/config/credentials 仍拒绝。
- 明确 store/cache/managed runtime 是同用户信任域的一部分；受限进程写入后可能被后续非受限工具复用。
- Windows 常驻 ACE、Low 标签和递归传播说明扩展到自动档案；已有大缓存的首次授权可能耗时，传播在独立 runner 中执行且后续有精确 ACE 快路径；自动根与手工根一样在移出授权后通过新令牌失效，但 ACL 不回收。
- pnpm store 的完整性检查不能使不可信写者变安全；默认启用意味着用户接受该信任边界。

## 12. 官方依据

- uv storage：https://docs.astral.sh/uv/reference/storage/
- pip cache：https://pip.pypa.io/en/stable/topics/caching/
- npm config：https://docs.npmjs.com/cli/v12/using-npm/config/#cache
- Corepack：https://github.com/nodejs/corepack#environment-variables
- pnpm store/locks：https://pnpm.io/settings/store#storedir
- pnpm cache/state/global：https://pnpm.io/settings/other
- Yarn Berry：https://yarnpkg.com/configuration/yarnrc#cacheFolder 与 `#globalFolder`
- Yarn Classic：https://classic.yarnpkg.com/en/docs/cli/cache
- Bun cache：https://bun.com/docs/pm/global-cache
- Go cache：https://go.dev/cmd/go/ 与 https://go.dev/src/cmd/go/internal/cache/default.go
- Maven repository：https://maven.apache.org/guides/mini/guide-configuring-maven.html#configuring-your-local-repository
- Maven Wrapper：https://maven.apache.org/tools/wrapper/
- Gradle directories：https://docs.gradle.org/current/userguide/directory_layout.html
- CMake export：https://cmake.org/cmake/help/latest/command/export.html#exporting-packages
