# Dead Code Cleanup Plan

**日期**: 2026-07-02
**状态**: 待执行
**优先级**: 低（代码质量改进）

## 问题背景

审计发现 `pi-container-sandbox` 包中存在大量死代码和过度导出。最严重的案例是 `toContainerPath` 函数——它完全未被使用，却有一个包含 5 个测试用例的测试套件。这分散了维护精力并增加了认知负担。

## 审计发现

### A. 完全死代码（0 内部调用者 + 0 外部导入）
这些函数/类型从未被任何代码使用，可以完全删除：

| 导出 | 文件:行号 | 说明 |
|------|----------|------|
| `toContainerPath` | src/paths.ts:9 | 从未被调用，但有 5 个测试用例 |
| `parseSizeTier` | src/tiers.ts:16 | 从未被调用，但有 6 个测试用例 |

### B. 不必要的导出（有内部调用者，但无外部导入）
这些函数在文件内部被使用，但不需要 `export`，可以改为文件私有：

| 导出 | 文件:行号 | 内部调用者 |
|------|----------|-----------|
| `resolveExtraMountPath` | src/paths.ts:42 | `hostToContainer`, `getExternalPath` |
| `requestPathApproval` | src/paths.ts:175 | `ensureExternalReadApproved` |
| `execStream` | src/ops.ts:27 | `createContainerBashOps` |
| `expandEnvEntry` | src/runtime.ts:78 | `DockerRuntime._expandEnv` |
| `DEFAULT_SBX_CONFIG` | src/config.ts:43 | `loadSbxConfig` |

### C. 不必要的导出常量（仅在本文件内使用）
这些常量在文件内部使用，但不需要 `export`：

| 导出 | 文件:行号 | 说明 |
|------|----------|------|
| `SKILLS_ROOT` | src/paths.ts:7 | 在 `paths.ts` 内部多处使用 |

### D. 不必要的导出类型（仅在本文件内使用）
这些接口/类型仅用于类型注解，可以改为文件私有：

| 导出 | 文件:行号 | 说明 |
|------|----------|------|
| `BuildImageOpts` | src/runtime.ts:21 | 仅 `runtime.ts` 内部使用 |
| `ExecOpts` | src/runtime.ts:45 | 仅 `runtime.ts` 内部使用 |
| `ExecResult` | src/runtime.ts:55 | 仅 `runtime.ts` 内部使用 |
| `TierSpec` | src/tiers.ts:1 | 仅 `tiers.ts` 内部使用 |
| `MountConfig` | src/config.ts:9 | 仅 `config.ts` 内部使用 |
| `ImageConfig` | src/config.ts:15 | 仅 `config.ts` 内部使用 |
| `RuntimeConfig` | src/config.ts:20 | 仅 `config.ts` 内部使用 |
| `HostConfig` | src/config.ts:33 | 仅 `config.ts` 内部使用 |

### E. 仅被测试使用的导出
这些类型仅被测试文件导入，可以考虑保留（因为测试需要访问）或重构测试以避免依赖：

| 导出 | 文件:行号 | 测试使用者 |
|------|----------|-----------|
| `SbxHandle` | src/ops.ts:14 | tests/_helpers.ts |

### F. 已确认存活（有外部导入）
以下导出被其他文件导入，**不应删除**：

- `CONTAINER_ROOT` — 被 `index.ts` 使用
- `hostToContainer` — 被 `src/ops.ts` 使用
- `isInsideContainer` — 被 `src/ops.ts` 使用
- `getExternalPath` — 被 `index.ts` 使用
- `PathApprovalStore` — 被 `index.ts` 使用
- `ensureExternalReadApproved` — 被 `index.ts` 使用
- `createReadOps`, `createWriteOps`, `createEditOps`, `createContainerBashOps` — 被 `index.ts` 使用
- `extractCommandName`, `execCapture`, `createHostBashOps` — 被其他文件使用
- `discoverSkillMounts`, `discoverDockerfiles`, `imageRef` — 被 `index.ts` 使用
- `SbxSession`, `getSbx`, `setSbx`, `clearSbx` — 被 `src/commands/sandbox.ts` 或 `index.ts` 使用
- `SbxConfig`, `loadSbxConfig`, `getSbxConfigPath`, `saveSbxConfig`, `PACKAGE_DOCKER_DIR` — 被其他文件使用
- `SizeTier`, `TIER_SPECS` — 被其他文件使用
- `Runtime`, `DockerRuntime`, `deriveContainerName`, `MountSpec`, `SandboxOptions` — 被其他文件使用
- `createSandboxCommandHandlers` — 被 `index.ts` 使用
- `shq`, `containerToHost`, `isReadOnlyMount`, `isAllowedExternalResource`, `expandPath` — 被其他文件使用

## 清理方案

### 方案 A：保守清理（推荐）
删除完全死代码，移除不必要的 `export` 关键字，但保留函数本身。

**优点**: 最小化改动，降低风险
**缺点**: 仍然保留未使用的函数

### 方案 B：激进清理
删除完全死代码（包括函数和测试），移除不必要的 `export`，并删除仅被测试使用的类型。

**优点**: 彻底清理
**缺点**: 改动较大，可能影响测试覆盖

### 方案 C：混合清理（推荐）
- 删除 A 类（完全死代码）及其测试
- 移除 B/C/D 类的 `export` 关键字
- 保留 E 类（仅测试使用）
- 消除 G-L 类的冗余逻辑

**优点**: 平衡清理力度和稳定性
**缺点**: 中等改动量

## 推荐方案：C（混合清理）

### 执行步骤（TDD 流程：Red → Green → Refactor）

#### 步骤 1: 删除死代码 + 合并薄包装

**1.1 删除 `toContainerPath`（死代码）**
- [ ] 确认现有测试覆盖 `hostToContainer` 的所有场景
- [ ] 删除 `toContainerPath` 测试（tests/paths.test.ts）
- [ ] 删除 `toContainerPath` 函数（src/paths.ts:13-37）
- [ ] `npm test` → 应全部通过（证明无外部依赖）

**1.2 删除 `parseSizeTier`（死代码）**
- [ ] 确认现有测试覆盖 `TIER_SPECS` 的使用场景
- [ ] 删除 `parseSizeTier` 测试（tests/tiers.test.ts）
- [ ] 删除 `parseSizeTier` 函数（src/tiers.ts:16-19）
- [ ] `npm test` → 应全部通过

**1.3 合并 `ensureExternalReadApproved` + `requestPathApproval`（薄包装）**
- [ ] **Red**: 写测试覆盖合并后的函数行为（成功返回 void，失败抛异常，包含 `pi-clipboard-` 白名单检查）
- [ ] 合并两个函数为一个 `ensureExternalReadApproved`
- [ ] 删除重复的 `pi-clipboard-` 检查（保留 `isAllowedExternalResource` 中的）
- [ ] **Green**: `npm test` → 新测试应通过
- [ ] 删除旧的 `requestPathApproval` 测试
- [ ] **Refactor**: `npm test` → 全部通过

**1.4 `allow`/`paths revoke` 命令改用 `expandPath()`**
- [ ] **Red**: 写测试覆盖 `allow` 命令处理 `~` 路径的场景
- [ ] 修改 `commands/sandbox.ts` 的 `allow` 和 `paths revoke` 改用 `expandPath()`
- [ ] **Green**: `npm test` → 新测试应通过
- [ ] **Refactor**: `npm test` → 全部通过

#### 步骤 2: 移除不必要的 `export` 关键字

**2.1 函数/常量**
- [ ] `resolveExtraMountPath`: 移除 `export`（src/paths.ts:42）
- [ ] `execStream`: 移除 `export`（src/ops.ts:27）
- [ ] `expandEnvEntry`: 移除 `export`（src/runtime.ts:78）
- [ ] `DEFAULT_SBX_CONFIG`: 移除 `export`（src/config.ts:43）
- [ ] `SKILLS_ROOT`: 移除 `export`（src/paths.ts:7）
- [ ] `npm test` → 应全部通过（如失败则恢复 export 并检查测试依赖）

**2.2 类型**
- [ ] 移除类型导出：`BuildImageOpts`, `ExecOpts`, `ExecResult`, `TierSpec`, `MountConfig`, `ImageConfig`, `RuntimeConfig`, `HostConfig`
- [ ] `npm test` → 应全部通过（如失败则说明测试依赖这些类型，保留或调整测试）

#### 步骤 3: 提取辅助函数消除重复（TDD 重构）

**3.1 提取 `isContainerPath()`**
- [ ] **Red**: 写测试
  ```typescript
  describe("isContainerPath", () => {
    it("returns true for /workspace prefix", () => {
      expect(isContainerPath("/workspace/foo")).toBe(true);
    });
    it("returns true for /skills prefix", () => {
      expect(isContainerPath("/skills/my-skill")).toBe(true);
    });
    it("returns false for other paths", () => {
      expect(isContainerPath("/home/user/file")).toBe(false);
    });
  });
  ```
- [ ] 运行测试 → 应失败（函数不存在）
- [ ] **Green**: 实现 `isContainerPath(p: string): boolean`
- [ ] 运行测试 → 应通过
- [ ] **Refactor**: 用 `isContainerPath()` 替换 `hostToContainer` 和 `isInsideContainer` 中的重复检查
- [ ] `npm test` → 全部通过

**3.2 提取 `findMount()`**
- [ ] **Red**: 写测试
  ```typescript
  describe("findMount", () => {
    it("finds exact match", () => {
      const mounts = [{ source: "/host/path", target: "/container/path", mode: "ro" }];
      expect(findMount("/container/path", mounts)).toEqual(mounts[0]);
    });
    it("finds prefix match", () => {
      const mounts = [{ source: "/host/path", target: "/container/path", mode: "ro" }];
      expect(findMount("/container/path/sub/file", mounts)).toEqual(mounts[0]);
    });
    it("returns undefined for no match", () => {
      const mounts = [{ source: "/host/path", target: "/container/path", mode: "ro" }];
      expect(findMount("/other/path", mounts)).toBeUndefined();
    });
  });
  ```
- [ ] 运行测试 → 应失败
- [ ] **Green**: 实现 `findMount(containerPath: string, mounts: MountSpec[]): MountSpec | undefined`
- [ ] 运行测试 → 应通过
- [ ] **Refactor**: 用 `findMount()` 替换 `isReadOnlyMount` 和 `getExternalPath` 中的循环
- [ ] 删除 `resolveExtraMountPath`（被 `findMount` 替代）
- [ ] 更新 `hostToContainer` 使用 `findMount()`
- [ ] `npm test` → 全部通过

#### 步骤 4: 提取 UI 共享逻辑（可选，改动较大）

**4.1 提取 `selectAndBuildDockerfile()`**
- [ ] **Red**: 写测试覆盖 Dockerfile 选择 + 构建流程
- [ ] 提取共享函数到 `commands/sandbox.ts` 或新文件
- [ ] 让 `build` 命令和 `session_start` 都调用它
- [ ] **Green**: `npm test` → 通过
- [ ] **Refactor**: 删除重复代码

**4.2 提取 `formatResources()`**
- [ ] **Red**: 写测试覆盖资源格式化
- [ ] 提取共享函数
- [ ] 让 `status` 和 `session_start` 都调用它
- [ ] **Green**: `npm test` → 通过
- [ ] **Refactor**: 删除重复代码

#### 步骤 5: 最终验证
- [ ] 运行完整测试套件：`npm test`
- [ ] 运行 lint：`npm run lint`
- [ ] 构建项目：`npm run build`
- [ ] 检查是否有 TypeScript 编译错误
- [ ] 代码覆盖率不应降低
- [ ] 更新文档（如有）

---

### 预期收益
- 删除 2 个死函数 + 11 个死测试用例
- 合并 2 个薄包装函数（`ensureExternalReadApproved` + `requestPathApproval`）
- 移除 13 个不必要的导出
- 提取 2 个辅助函数消除 5 处重复模式（`isContainerPath`, `findMount`）
- 复用 `expandPath()` 替代 2 处手写 `~` 展开
- 减少代码认知负担
- 更清晰的 API 边界

### 风险评估
- **步骤 1**: 低风险 — 删除零调用者代码 + 薄包装合并，行为不变
- **步骤 2**: 低风险 — 仅移除 `export` 关键字，函数本身保留
- **步骤 3**: 中风险 — 提取辅助函数需要更新多个调用点，需仔细测试
- **步骤 4**: 低风险 — 纯 UI 逻辑提取，行为不变
- **回滚方案**: Git revert 即可恢复

### 时间估算（TDD 流程）
- 步骤 1: 30 分钟（删除死代码 + 合并薄包装 + `~` 展开复用，含写测试）
- 步骤 2: 15 分钟（移除导出）
- 步骤 3: 45 分钟（提取辅助函数，每个函数含 Red-Green-Refactor 循环）
- 步骤 4: 30 分钟（UI 逻辑提取，可选）
- 步骤 5: 10 分钟（最终验证）
- **总计**: 130 分钟（不含步骤 4 为 100 分钟）

## 注意事项

1. **不要删除** `CONTAINER_ROOT` — 它被 `index.ts` 使用
2. **保留** `SbxHandle` — 虽然仅被测试使用，但重构测试的成本可能不值得
3. **优先执行** 步骤 1（删除死代码），步骤 2（移除导出）可以延后
4. 如果未来需要 `toContainerPath` 或 `parseSizeTier`，可以通过 Git 历史恢复
