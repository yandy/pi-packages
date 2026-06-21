# Fix pi Extension Config: Global + Project Merge

## 背景

pi extension 的配置文件有两种级别：
- **全局配置**：`${AgentDir}/<config-file>.json`
- **项目配置**：`${cwd}/${CONFIG_DIR_NAME}/agent/<config-file>.json`

应确保项目配置覆盖全局配置的同名字段，且路径不能写死 `.pi` 或 `~/.pi/agent/`，
因为换肤发行版可能通过 `piConfig.configDir` 修改配置目录名，AgentDir 也可通过环境变量覆盖。

## 前置条件

1. `@earendil-works/pi-coding-agent` ≥ 0.79.9（`CONFIG_DIR_NAME` 从该版本开始 barrel export）
2. 使用 TDD（先写测试、确认失败、再实现）

## 实施步骤

### Step 1: 升级 pi-coding-agent 到 ≥ 0.79.9

```bash
npm install @earendil-works/pi-coding-agent@latest --save-dev
```

当前 `CONFIG_DIR_NAME` 和 `getAgentDir` 均从 `@earendil-works/pi-coding-agent` 导出：

```ts
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
```

### Step 2: 编写测试（RED）

创建或更新测试文件（以 `vitest` 为例）：

```ts
// tests/config.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".myapp",
  getAgentDir: () => "/home/user/.myapp/agent",
}));

let loadConfig: (cwd?: string) => YourConfigType;

beforeEach(() => {
  vi.resetModules();
  mockReadFileSync.mockReset();
});

async function importModule() {
  const mod = await import("../src/config.js");
  loadConfig = mod.loadConfig;
}

describe("loadConfig", () => {
  it("loads global config from AgentDir/<config-file>.json", async () => { ... });
  it("loads project config from cwd/CONFIG_DIR_NAME/agent/<config-file>.json", async () => { ... });
  it("project config overrides global config at section level", async () => { ... });
  it("returns empty config when neither global nor project config exists", async () => { ... });
  it("uses global config when project config is absent", async () => { ... });
  it("caches config per cwd", async () => { ... });
});
```

关键测试用例：

1. **全局配置加载** — mock `readFileSync` 在 `${mockAgentDir}/<config-file>.json` 返回 JSON，验证配置正确
2. **项目配置加载** — mock 在 `${cwd}/${mockConfigDirName}/agent/<config-file>.json` 返回 JSON
3. **合并覆盖** — 全局设 `section: { a: 1, b: 2 }`，项目设 `section: { a: 3 }`，结果应为 `{ a: 3, b: 2 }`
4. **缺失容错** — 两者都不存在时返回 `{}`
5. **仅有全局** — 项目不存在时正确加载全局
6. **缓存** — 同一 cwd 重复调用只读一次文件

```bash
npx vitest run tests/config.test.ts   # 期望 FAIL
```

### Step 3: 实现代码（GREEN）

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

interface YourConfigType {
  // 你的配置类型...
}

let cachedConfig: YourConfigType | null = null;
let cachedCwd: string | null = null;

function readJsonFile(path: string): YourConfigType | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as YourConfigType;
  } catch {
    return null;
  }
}

function mergeConfigs(base: YourConfigType, override: YourConfigType): YourConfigType {
  const merged: YourConfigType = {};
  for (const section of ["yourSection"] as const) {
    if (base[section] || override[section]) {
      merged[section] = { ...base[section], ...override[section] };
    }
  }
  return merged;
}

export function loadConfig(cwd?: string): YourConfigType {
  const dir = cwd || process.cwd();
  if (cachedConfig && cachedCwd === dir) return cachedConfig;

  const agentDir = getAgentDir();
  const globalConfig = readJsonFile(resolve(agentDir, "<config-file>.json")) || {};
  const projectConfig =
    readJsonFile(resolve(dir, CONFIG_DIR_NAME, "agent", "<config-file>.json")) || {};

  cachedConfig = mergeConfigs(globalConfig, projectConfig);
  cachedCwd = dir;
  return cachedConfig;
}
```

要点：
- `readJsonFile` 用 try/catch 安全读取，文件不存在返回 `null`
- `mergeConfigs` 遍历每个配置节（section），展开合并，override 覆盖 base
- 全局路径 `${getAgentDir()}/<config-file>.json`
- 项目路径 `${cwd}/${CONFIG_DIR_NAME}/agent/<config-file>.json`
- `<config-file>` 替换为你的配置文件名（如 `web-tools.json`）

### Step 4: 验证

```bash
npm test                # 全部测试通过
npm run typecheck       # 无类型错误
npm run lint            # 无 lint 错误
```

## 路径对照表

| 层级 | 路径格式 | 示例 |
|------|----------|------|
| 全局 | `${getAgentDir()}/<name>.json` | `~/.pi/agent/web-tools.json` |
| 项目 | `${cwd}/${CONFIG_DIR_NAME}/agent/<name>.json` | `<project>/.pi/agent/web-tools.json` |

换肤发行版（`piConfig.configDir = ".myapp"`）下自动变为：
- 全局：`~/.myapp/agent/web-tools.json`
- 项目：`<project>/.myapp/agent/web-tools.json`
