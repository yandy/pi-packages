# pi-sandbox：`sandbox.json` 只支持全局配置设计

日期：2026-10-14
状态：已实现
落点：`pi-sandbox/src/config.ts`、`src/tools.ts`、`index.ts`、`tests/config.test.ts`、`tests/index-smoke.test.ts`、`README.md`、`README.zh.md`

## 1. 背景

原任务是在 workspace-write 下把 `<workspace>/.pi` 变成只读子树（写 `.pi` 需提权）。调查配置解析路径时发现更直接的攻击面：**项目级 `sandbox.json` 本身就是“模型可写的配置层”**——它位于工作区内、对受限模型可写，却参与决定后续进程的沙箱行为。用户据此改为本次目标：`sandbox.json` 只支持全局配置，项目级文件不再支持。

## 2. 决策依据

工作区对受限模型可写，所以 `<cwd>/.pi/sandbox.json` 可被模型写入，其中两个字段直接是逃逸面：

- `mode: "danger-full-access"` —— 下一个读盘者的所有工具调用不再受限；
- `runnerCommand` —— `confine()` 把它直接拼进 spawn argv（`src/confine.ts`，`[...runnerCommand, ...bwrapProfileArgs, "--", ...argv]`），下一个读盘进程的每条 bash 都以模型指定的程序为前缀**裸跑**，即未受限代码执行。

“是否同会话立即生效”取决于配置缓存，而不是文件本身：

- pi-sandbox 的配置缓存是模块级单值（改前为 per-cwd Map，`src/config.ts`）；写 `.pi/sandbox.json` 的动作本身会在写入前完成一次 `configForCall`（`src/tools.ts`），因此同一模块实例、同一 cwd 的子会话读到的是**写入前**的配置。
- 但子会话与父会话共享模块实例只是因为 pi SDK 的扩展工厂缓存按 cwd 命中（`dist/core/extensions/loader.js` 的 `useExtensionCacheCwd` / `loadExtensionsCached`；jiti `moduleCache: false`，缓存命中即同一模块实例）。任何新进程、不同 specifier/构建（父 `-e` 本地 vs 子 npm 包，escalation 转发 spec 已记录过同类现象）、或进程内任意一次“不同 cwd 的扩展加载”（`clearExtensionCache`）之后，新实例都会重新读盘。
- 真正绕开配置缓存的**同会话**通道是 pi 核心的项目设置：子会话 `SettingsManager.create` 默认 `projectTrusted = true`（`dist/core/settings-manager.js:153`），且 pi-subagents 子会话 `loader.reload()` 不带 `resolveProjectTrust`（`src/lifecycle/create-subagent-session.ts:187`），于是 `<cwd>/.pi/settings.json` 的项目 scope packages/extensions 会在宿主进程内加载执行（见 §5，另立任务）。

结论：把项目级配置层整体移除，比“保留它再想办法保护 `.pi`”更小、更彻底——配置面消失后，模型写什么都不进入解析。

## 3. 决策

- 只读 `~/.pi/agent/sandbox.json`（`getAgentDir()`）。
- `<cwd>/.pi/sandbox.json` **静默忽略**：不解析、不校验、不告警（用户明确选择静默；对比过“忽略 + 告警”方案，认为噪音不值得）。
- 全局文件的行为全部不变：非法 `mode` 警告并回落 `workspace-write`；`runnerCommand`/`runnerFailureSignatures` 必须配对，否则 fail-safe 回落默认（I2）；缺失/损坏 → 默认；1.x `image`/`runtime`/`host` 段仍“忽略并告警”。
- API 变化（破坏性）：删除 `getSandboxConfigPath`；`loadSandboxConfig()`/`getSandboxConfig()` 去掉 cwd 参数；配置缓存由 per-cwd Map 变为单值（`resetSandboxConfigCache()` 保留）。

## 4. 备选与被否

1. **保留项目级 + 对现存项目文件告警**：仍允许模型改写配置（只是用户可见），且“下个会话生效”的窗口不变；否。
2. **保留项目级 + 让 `<workspace>/.pi` 只读**：跨四个 runner 实现排除，landlock 的 allow-list 语义在结构上无法表达“可写工作区里排除子目录”；且这只是给“项目可写的配置参与解析”打补丁；否（该调查过程与 landlock 结论保留在本次讨论记录中，不单独成 spec）。
3. **本次一并改 pi-container-sandbox**（它仍读项目级 `.pi/sandbox.json`）：不同包、不同 schema；否，本次只改 pi-sandbox，README 的互斥说明同步注明差异。

## 5. 残留（不在本次范围）

- pi 核心 / pi-subagents 的项目设置信任继承：程序化创建的子会话默认信任项目，会加载 `<cwd>/.pi/settings.json` 的项目 scope 扩展/包（§2 证据链）。要在 pi-sandbox 范围内根治需要“`.pi` 只读”或上游修信任继承；建议单独任务或上游 issue。
- 其它项目级输入：`.pi/skills`、`.pi/agents/*.md`、`AGENTS.md`。
- Windows 的 `windows-acl` 与 landlock 后端本就存在的结构性缺口不变。

## 6. 验证

- `tests/config.test.ts` 新增静默忽略回归：项目文件写 `mode: danger-full-access` + `runnerCommand` + 非法 `probeTimeoutMs`，断言配置等于默认/全局值、`console.warn` 一次都未被调用；另有“只有项目文件时保持默认”与“项目文件不进入 fail-safe 路径”两条。
- `tests/index-smoke.test.ts` 的 I2（坏配置不 throw）与 Ruling 19（`/permission` 状态）用例改走隔离的全局配置。
- `npm test -w pi-sandbox`、`npm run typecheck -w pi-sandbox`、`npm run lint -w pi-sandbox` 全绿；根 `npm test` 确认无包外调用点。
