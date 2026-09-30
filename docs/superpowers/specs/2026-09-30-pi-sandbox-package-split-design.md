# pi-sandbox 独立包拆分设计（pi-container-sandbox 恢复容器实现）

日期：2026-09-30
状态：已与用户逐节确认

## 1. 背景与问题

PR #136（提交 `7083d0d`）把 `pi-container-sandbox` 的 2.0 实现整体换成了**进程级沙箱**（bwrap / landlock / seatbelt），并保留了原包名。结果是包名与实际语义脱节：包里已经没有容器，`pi-container-sandbox` 这个名字会误导使用者。

用户决策：**让新实现回到与自身语义一致的包名，旧实现回到旧包。**

- 新实现 → 新包 `pi-sandbox`（进程级沙箱）
- 旧实现（容器运行时）→ 恢复到 `pi-container-sandbox`

两包**并存**，定位互补：需要容器级强隔离（独立文件系统/网络命名空间）用 `pi-container-sandbox`；需要轻量、路径透明的进程沙箱用 `pi-sandbox`。

### 前置事实（勘察结论）

| 项 | 事实 |
|---|---|
| 当前 main | `7083d0d`（工作区干净） |
| 旧实现最后快照 | `98d1536`（`7083d0d` 的父提交） |
| npm 已发布 | `@yandy0725/pi-container-sandbox` ≤ `1.1.2`（`1.1.2` = 容器实现，即 `98d1536` 的内容；从未发布过 2.0.0） |
| npm 包名 | `@yandy0725/pi-sandbox` 未被占用（registry 404） |
| 本机凭据 | 无 npm 登录态（`npm whoami` → `ENEEDAUTH`） |
| 新实现耦合 | `index.ts` / `src/**` / `tests/**` 中**没有**任何硬编码的包名或目录名（仅 README 的标题与安装命令出现包名） |

## 2. 已确认决策

| 编号 | 决策 | 理由 |
|---|---|---|
| **D1** | `pi-sandbox` 首发版本 **1.0.0** | 新包名 = 新 lineage；"替换容器实现"这层语义由包名变更本身表达，不让新包继承另一个包的版本历史 |
| **D2** | `pi-container-sandbox` **严格恢复**：内容与 `98d1536` 逐字节一致 | 已发布的 `1.1.2` 就是该内容，严格恢复不产生需要发版的差异；旧用户不受任何影响 |
| **D3** | 本次交付**到 PR 为止**：分支 + commit + push + `gh pr create`，不合并不发版 | npm publish 基本不可逆，发版单独决策 |
| **D4** | **不做** npm registry 弃用标记 | 两包并存，旧包不是"废弃"而是"容器场景专用"；要给全部用户打警告与定位冲突。将来若要做，机制是 `npm deprecate @yandy0725/pi-container-sandbox@* "<msg>"`（npm 无 archive 语义，deprecate 不删除任何版本、可逆；本机需先 `npm login`） |
| **D5** | 旧包 README **不加**交叉指引 | 属于 D2 的一部分；指引写在新包 README 的「迁移」一节 |

**明确排除（非目标）**：旧包任何文件改动、旧包新版本发布、registry 侧弃用标记、为 deprecate 新增 CI workflow、把两包合并到一个可切换的包、`pi-permission-system` 的任何改动。

### 命名决策记录

| 候选 | 结论 | 理由 |
|---|---|---|
| `pi-sandbox` | **采用** | 机制名，对其它包的生死免疫；短、易记；语义由 README 首行说明 |
| `pi-process-sandbox` | 未采用 | 与 `pi-container-sandbox` 成对、自描述更好，代价是长 8 字符；作为后续若需明确对称时可改（本次不取） |
| `pi-permission-sandbox` | 否决 | ① 语义轴错位：本包核心是隔离机制（runner + 写围栏），三档 mode / 提权只是旋钮；② 名字挂在被淘汰者的词根上——只在 `pi-permission-system` 消失后才读得通，而在它消失前（用户本机即两包同装，`/permission` vs `/permission-system`）持续误导；③ 若将来能力不并入本包，"permission" 前缀会永久带来错误暗示 |

背景：`pi-permission-system`（0.2.0，213 文件 / ~38k 行，本机在用）拟淘汰，其能力在用户判断中已被本沙箱的三档模式 + 提权审批覆盖（决策 A）。这恰好支持用机制名：命名不挂靠另一个包的存废。淘汰动作为**独立任务**，不在本次范围。

## 3. 拆分机制

```
git mv pi-container-sandbox pi-sandbox          # 新实现整棵树搬到新包名（git 识别 rename，--follow 可追溯）
git checkout 98d1536 -- pi-container-sandbox    # 容器实现整棵树回到原路径
rm -f pi-sandbox/docs/superpowers/specs/2026-0[678]-*.md   # 见下方「spec 归属」：13 份容器期 spec 随 mv 误入新包，必须移除（保留 2026-09-29-process-sandbox-design.md）
```

**spec 归属（易错点）**：`git mv` 搬的是整棵树，旧包的 13 份容器期 spec 会被一并搬进 `pi-sandbox/`。它们描述的是容器架构（镜像构建、mounts、path-translation、podman 支持……），与 `pi-sandbox` 无关，且已被 `git checkout 98d1536 -- pi-container-sandbox` 恢复到旧包，因此必须从新包删除。新包最终**只保留 1 份 spec**：`2026-09-29-process-sandbox-design.md`。

选它的理由（对比两个被否方案）：

- **否决：先 `git checkout 98d1536 -- pi-container-sandbox` 再人工删新实现独有文件。** `git checkout <commit> -- <path>` 只恢复/覆盖，**不删除**该路径下"新实现新增"的文件（`src/bash-ops.ts`、`src/confine.ts`、`src/escalation.ts`、`src/fence.ts`、`src/permission.ts`、`src/policy.ts`、`src/runners.ts`、`src/tools.ts`、8 个测试文件、2.0 spec 等）。漏删任何一个都会让"严格恢复"变成假命题，且无法用一条 diff 断言所有权。
- **否决：`git archive` / `read-tree` 导出快照再拼装。** 唯一优点是"不碰工作区"，代价是临时目录 + 手工复制，收益不足以抵消复杂度。
- **采用：整目录 `mv` 后恢复旧路径。** `mv` 把新实现的树整体搬走，旧路径随即为空，`git checkout` 填充回来的就是 `98d1536` 的**精确**内容；不需要任何人工枚举。

## 4. 新包 `pi-sandbox` 的身份与内容

搬迁后改动**仅限**下列文件，`index.ts`、`src/**`、`tests/**`、`tsconfig.json`、`vitest.config.ts`、`.gitignore` 保持零改动（`git mv` 之外不得触碰）。

| 文件 | 改动 |
|---|---|
| `package.json` | `name` → `@yandy0725/pi-sandbox`；`version` → `1.0.0`；`repository.directory` → `"pi-sandbox"`；`description` 去掉容器语义 → `pi coding-agent extension: process-level sandbox (bwrap / landlock / seatbelt) — workspace writable, everything else readable, fail-closed`；新增 `keywords: ["pi-package"]`（`pi-package-spec.md` 要求项，原包一直缺失）；`files`、`deps`（`@deepseek-ai/node-addon-system@^0.1.2`、`typebox@1.1.38`）、`peerDependencies`、`scripts`、`pi` 字段不变 |
| `README.md` / `README.zh.md` | 标题、`pi install` 命令、自引用改为 `pi-sandbox`；删除 "No containers since 2.0" / "2.0 起不再使用容器" 这类相对旧包的措辞；「Migrating from 1.x」改写为「从 `@yandy0725/pi-container-sandbox@1.x`（容器实现）迁移到本包」，结尾 "If you need container-grade isolation, stay on 1.x" 改为指向已恢复容器实现的 `pi-container-sandbox`；并在迁移节补一条与 `pi-container-sandbox` 的互斥说明（两包都接管 `bash`/`write`/`edit` 且共用 `sandbox.json`，schema 不同） |
| `docs/superpowers/specs/2026-09-29-process-sandbox-design.md` | 随实现迁到本包；文首加「2026-09-30 落地修订」段：设计本体（沙箱机制与 Ruling 1–19）不变，但原文 §1 的两条打包决策（"保留包名 `@yandy0725/pi-container-sandbox`，发 2.0.0"、"完全替换 pi-container-sandbox，不并存容器引擎"）已被 D1/D5 取代。**Ruling 与 §编号不重编**（`index.ts`、`src/tools.ts`、`src/config.ts` 等源码注释引用 spec §5 / §9 / Ruling 10 / Ruling 19） |
| `docs/superpowers/specs/` 下 13 份容器期 spec | **删除**（随 `git mv` 误入新包；见 §3「spec 归属」） |

配置路径与命令名不变：全局 `~/.pi/agent/sandbox.json` + 项目 `<project>/.pi/sandbox.json`（新实现本来就用 `sandbox.json`，无配置迁移），`/permission` 命令名不变。

## 5. 旧包恢复的等价性断言（不可协商）

"严格恢复"必须可机器判定，不接受"看起来回来了"：

- **A1**：`git diff 98d1536 -- pi-container-sandbox` 输出为空。

- **A2**：新包树与 `7083d0d` 的旧包树相比，差异必须**恰好**是 §4 的清单（4 改写 + 13 删除 = 17 个路径）：

```bash
# 提交前（索引树）
git add -A && git diff --name-only 7083d0d:pi-container-sandbox "$(git write-tree):pi-sandbox"
# 提交后（权威）
git diff --name-only 7083d0d:pi-container-sandbox HEAD:pi-sandbox
```

> 形式说明：**不能**用 `git diff 7083d0d -- pi-sandbox`——`7083d0d` 中不存在 `pi-sandbox/` 路径，那样会把全部文件当成新增。上述两形式已实测：在当前未改动工作区执行等价命令返回 0 行，对 `98d1536:pi-container-sandbox` 执行返回 50 行（= 新实现相对容器实现的全部差异）。

A1 同时钉住下列内容确实回来了（`7083d0d` 中它们被删除，恢复后必须位于 `pi-container-sandbox/`）：`docker/cn.Dockerfile`、`docker/gh.Dockerfile`、`scripts/build-image.ts`、`src/runtime.ts`、`src/container-cli.ts`、`src/path-translation.ts`、`src/paths.ts`、`src/skills.ts`、`src/session.ts`、`src/ops.ts`、`src/commands/sandbox.ts`、`tests/_helpers.ts`、`tests/fixtures/available-skills-golden.xml`、13 份容器期 spec、`package.json` 的 `build-image` script 与 `docker/` files 条目、旧版 README×2。

## 6. 根级注册点（穷举）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `package.json` | `workspaces` 增加 `"pi-sandbox"`（置于 `pi-permission-system` 之后，字母序） |
| 2 | `vitest.config.ts` | `projects` 增加 `"pi-sandbox"`（同上位置；`pi-container-sandbox` 保留） |
| 3 | `.github/workflows/test.yml` | paths-filter 增加 `pi-sandbox: - "pi-sandbox/**"` |
| 4 | `.github/workflows/publish.yml` | `case` 增加 `pi-sandbox-v*) dir=pi-sandbox` |
| 5 | `README.md` | `pi-container-sandbox` 行还原为 `Docker sandbox extension`；新增 `pi-sandbox` 行 |
| 6 | `README.zh.md` | `pi-container-sandbox` 行还原为 `Docker 沙箱扩展`；新增 `pi-sandbox` 行（进程级沙箱扩展描述） |
| 7 | `docs/guides/testing.md` | 参考行 `pi-container-sandbox/tests/config.test.ts`（`vi.stubEnv` + 双目录 `mkdtempSync` 模式）→ `pi-sandbox/tests/config.test.ts` |
| 8 | `package-lock.json` | 重新生成，并刷新 `node_modules/@yandy0725/*` 符号链接 |

已核实无其它注册位：`dependabot.yml` 只扫仓库根、`.pi/npm/` 是已安装产物、`docs/prompts/`、`.superpowers/` 无包清单。

## 7. 验证计划

本任务是**纯结构性搬迁**，不引入新行为，因此 TDD 不适用；验证由等价性断言 + 既有测试套件 + 打包面断言组成。

| # | 断言 | 命令 / 判据 |
|---|---|---|
| V1 | 旧包与 `98d1536` 逐字节一致 | `git diff 98d1536 -- pi-container-sandbox` 为空（A1） |
| V2 | 新包差异集恰好为 §4 清单 | `git diff --name-only 7083d0d:pi-container-sandbox "$(git write-tree):pi-sandbox"`（`git add -A` 后）输出 = 17 行：`package.json`、`README.md`、`README.zh.md`、`docs/superpowers/specs/2026-09-29-process-sandbox-design.md` + 13 份容器期 spec（删除）；提交后改用 `HEAD:pi-sandbox` 复核（A2） |
| V3 | 新包 devDeps 与根一致 | `npm run check:dev-deps` |
| V4 | lockfile 与 workspaces 同步、链接刷新 | 用 CI `lockfile-sync` 的同一条命令重生（`npm install --package-lock-only --ignore-scripts --no-audit --no-fund`）后，`git diff --exit-code -- package-lock.json` 为空——即分支内提交的 lockfile 与 CI 重生结果一致；`ls -l node_modules/@yandy0725/` 同时存在 `pi-sandbox` 与 `pi-container-sandbox` 链接 |
| V5 | 全仓质量门禁 | `npm run typecheck && npm run lint && npm test` |
| V6 | publish 分派无前缀互吞 | 用 shell 复现 `case` 匹配：`pi-sandbox-v1.0.0` → `dir=pi-sandbox`，`pi-container-sandbox-v1.1.3` → `dir=pi-container-sandbox` |
| V7 | 打包面 | `npm pack --dry-run -w pi-sandbox`（= `index.ts` + `src/`）、`npm pack --dry-run -w pi-container-sandbox`（**`docker/` 回到包内**，`build-image` script 复原） |
| V8 | 注册完整性 | `node -e` 断言 workspaces、vitest projects、test.yml filter、publish.yml case 中两包并存 |

`pi-sandbox/tests/integration.test.ts` 与旧包容器相关测试按各自既有逻辑 skip（本机有 bwrap/landlock 与 podman 时照常实跑）。

## 8. 交付流程

1. 分支 `feat/pi-sandbox-package-split`（本 spec 所在 worktree），分支内提交序列：
   1. `docs(pi-sandbox): 拆分包设计 spec（pi-sandbox@1.0.0，pi-container-sandbox 恢复容器实现）`（本文件，已提交）
   2. `feat(pi-sandbox): 进程级沙箱拆为独立包 pi-sandbox@1.0.0，pi-container-sandbox 恢复容器实现`（实现；PR squash 合并后 main 上即单个 commit）
3. `git push -u origin` + `gh pr create`（PR 描述记录 A1/A2 断言结果与 V1–V8 证据）
4. **停止**：不 merge、不发版（D3）

PR 合并后的后续动作（由用户决定，不在本次范围）：

- `pi-sandbox` 首次发布：`gh release create pi-sandbox-v1.0.0 --target <commit>` 即可触发 npm publish —— **首次发布无需 `npm version`**（`1.0.0` 已写在 `package.json`），但必须确认根 `package-lock.json` 中该 workspace 的版本条目已是 `1.0.0`（V4 覆盖；#136 曾因 lockfile 漂移触发 CI 失败）
- 如需 registry 侧弃用提示：`npm deprecate @yandy0725/pi-container-sandbox@* "<msg>"`（D4，本机需先 `npm login`）
- `pi-permission-system` 的淘汰（独立任务，非本次范围）：其能力已被本沙箱三档模式 + 提权审批覆盖（命名决策记录里的决策 A）；届时需单独设计 registry 弃用与能力取舍，本次不得改动该包 |

## 9. 风险与回滚

| 风险 | 处置 |
|---|---|
| 恢复不完整（新实现文件残留在旧包） | 方案 A 从结构上消除该可能（整树搬走再恢复），A1 断言兜底 |
| `git mv` 后 `node_modules` 符号链接指向错误包 | V4 断言 + 重新安装/重生成 lockfile |
| lockfile 漂移导致 CI `lockfile-sync` 失败 | 用 CI 相同命令生成（V4）并断言 `git diff --exit-code` |
| `publish.yml` 分派错误导致发错包 | V6 断言两条 tag 的映射 |
| 新包 `files` 漏包导致安装后缺文件 | V7 断言 |

回滚：分支未合并时删除 worktree 与分支即可；合并后 `git revert` 单个 commit（无历史重写、无外部副作用——本次不发版、不动 registry）。

## 10. 影响面清单

新增：`pi-sandbox/`（**29** 个跟踪文件：28 个搬迁/改写 + 1 份 2.0 spec）、`docs/superpowers/specs/2026-09-30-pi-sandbox-package-split-design.md`（本文件）。

修改：根 `package.json`、`vitest.config.ts`、`package-lock.json`、`README.md`、`README.zh.md`、`docs/guides/testing.md`、`.github/workflows/test.yml`、`.github/workflows/publish.yml`。

恢复（= `98d1536` 内容）：`pi-container-sandbox/**`（**47** 个跟踪文件 = 32 代码/配置/资源 + 2 份 README + 13 份容器期 spec）。
