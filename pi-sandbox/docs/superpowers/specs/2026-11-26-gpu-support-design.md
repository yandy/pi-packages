# pi-sandbox GPU 支持设计

## 1. 目标与背景

Linux 受限命令需要在不切换到 `danger-full-access` 的情况下使用宿主 GPU。当前 bwrap 以 `--dev /dev` 创建私有设备视图，隐藏宿主 GPU 节点；landlock 只允许写 `/dev/null`，GPU 设备无法以读写方式打开。

Linux 与 WSL **直接自动支持 GPU，不增加配置项或放行开关**。bwrap 与 landlock 在每次受限命令构造时发现并授权常见 GPU 设备；没有匹配设备时保持现有 argv 与行为。

## 2. 范围

### 目标

- 同时支持 Linux（含 WSL）的 bwrap 与 landlock runner。
- `read-only` 与 `workspace-write` 都允许 GPU 设备访问；两种模式的普通文件写边界保持不变。
- 自动支持 NVIDIA、AMD、Intel 与 WSL GPU 转发节点。
- 无匹配设备的主机不增加设备授权，不影响 runner 探测与命令启动。
- 设备路径在每次受限命令构造时重新发现，不缓存发现结果。
- 自定义 bwrap 兼容 `runnerCommand` 使用同一份 GPU bwrap profile。
- 设备发现只用于实现与测试隔离，不暴露为用户配置。

### 非目标

- 不新增 `gpu` 配置、设备路径清单或禁用 GPU 的开关。
- 不透传整个宿主 `/dev`。
- 不支持规定节点之外的专用加速器；后续可按同一发现机制扩展。
- 不安装或配置 GPU 驱动、CUDA、ROCm，不修改环境变量或动态库路径。
- 不提供显存、算力、GPU 进程间隔离或设备 cgroup。
- 不改变 macOS、原生 Windows 与 `danger-full-access` 的行为。

## 3. 平台差异

- **macOS**：Seatbelt 不创建私有 `/dev`，当前 profile 以 `(allow default)` 为基础，只额外拒绝文件写入；Metal 所需的 IOKit / Mach 服务没有被该规则撤销。不存在 Linux 的设备节点遮蔽问题，不增加 GPU 设备列表或 Seatbelt 例外，也不触发 Linux 设备发现。
- **原生 Windows**：`windows-acl` 不做设备命名空间隔离，因此没有同类节点遮蔽。Low integrity 本身并不排斥 GPU（Chromium 的 GPU 进程也运行在 Low integrity），但当前 runner 还使用 `WRITE_RESTRICTED`，第三方驱动设备对象的 DACL 兼容性没有端到端验证。首版不做泛化的设备 ACL 授权，也不触发 Linux 设备发现；若实际出现 CUDA / Direct3D 初始化失败，需按具体错误单独设计。
- **WSL**：使用 Linux runner，存在与原生 Linux 相同的 bwrap / landlock 问题；除 NVIDIA / DRM 节点外，还需透传 WSL 的 `/dev/dxg`。

## 4. 安全语义

Linux 与 WSL 的受限命令自动获得检测到的宿主 GPU 访问能力，无需配置。普通文件系统写授权不变，但 GPU 驱动设备不再被隔离；受限进程可以影响同设备上的其他工作负载。

`read-only` 的“只读”仍描述普通文件系统写权限；GPU 设备访问是独立授权，不表示 GPU 硬件或驱动状态只读。

本功能不提供显存、算力或 GPU 进程间隔离。只有基础设备视图、不授予 GPU 设备访问的旧行为不再是可配置选项。

## 5. 设备发现

发现器只读取宿主 `/dev` 的当前目录项，输出稳定排序的绝对路径，不递归扫描：

| 厂商/用途 | 目录项 |
|---|---|
| NVIDIA 计算卡 | 匹配 `^nvidia\d+$`，如 `nvidia0`、`nvidia1` |
| NVIDIA 驱动 | `nvidiactl`、`nvidia-uvm`、`nvidia-uvm-tools`、`nvidia-modeset` |
| NVIDIA capabilities | `nvidia-caps` 目录 |
| AMD compute | `kfd` |
| AMD / Intel DRM | `dri` 目录 |
| WSL GPU 转发 | `dxg` |

其他相似名称（如 `nvidia`、`nvidia0-extra`、`kfd0`、`dri0`、`dxg0`）不匹配。`/dev` 不可读时返回空列表，不使沙箱启动失败。

目录授权覆盖其当前内容；bwrap 在每次命令时重新 bind，landlock 在每次命令时重新安装规则。设备在发现后、runner 安装前消失时：bwrap 用 `--dev-bind-try` 跳过缺失源，landlock 保持现有 fail-closed 启动失败行为，绝不裸跑。

## 6. Runner 映射

### bwrap

保留现有 `--dev /dev`，随后立即为每个发现路径追加：

```text
--dev-bind-try <path> <path>
```

设备 bind 必须位于 `--dev /dev` 之后，否则会被私有设备视图覆盖；必须使用允许设备访问的 `--dev-bind-try`，而不是普通 `--bind`。runner 功能探测继续使用无 GPU 的最小 profile，GPU 是否存在不影响 bwrap/landlock 选型。

### landlock

把发现路径追加到 `readWrite`，保留 `readOnly:["/"]` 与既有 `/dev/null`、临时目录、工作区授权。`read-only` 与 `workspace-write` 都追加 GPU 路径，普通文件授权规则不变。旧内核 ABI 的 full/partial 判定不变。

### 结构约束

- 设备发现放在独立模块，profile 构造器保持纯净：只消费 `RunnerPolicy` 中已发现的设备列表，不直接读宿主文件系统。
- `confine()` 对 bwrap、landlock 与自定义 bwrap runner 在每次调用时发现设备；seatbelt 与 windows-acl 不发现。
- `RunnerHooks` 提供发现器注入点，仅供确定性测试；生产缺省读取真实 `/dev`。
- bwrap 与 landlock 共用同一份发现结果，避免不同 runner 的设备集漂移。
- `danger-full-access` 不经过 `confine()`，不触发设备发现。

## 7. 方案比较

| 方案 | 取舍 | 结论 |
|---|---|---|
| Linux/WSL 自动识别，无配置 | 开箱可用，配置层不变；所有 Linux/WSL 受限会话都会获得检测到的 GPU 访问 | 采用 |
| 全局 `gpu` 开关 | 可恢复旧设备边界；增加不必要的配置与平台语义 | 不采用 |
| 用户逐项配置设备路径 | 授权最精确；多卡、驱动辅助节点和目录配置繁琐 | 不采用 |
| `--dev-bind /dev /dev` 透传全部设备 | 实现最短；向受限进程开放所有宿主设备，授权过宽 | 不采用 |

## 8. 测试与文档

- 发现器：覆盖全部匹配规则、排除相似名称、稳定排序、空目录与读取失败。
- bwrap profile：设备 bind 紧跟 `--dev /dev`，源目一致，使用 `--dev-bind-try`；空清单保持旧 argv。
- landlock profile：两种受限模式都追加 `--rw`，空清单保持旧 argv。
- `confine()`：每次调用重新发现，自定义 runner 同享设备清单，非 Linux runner 不发现，测试注入不依赖真实宿主 GPU。
- shell / 工具接线：默认测试夹具注入空设备发现器；生产路径能把发现设备送入实际 spawn argv；`danger-full-access` 不发现。
- 运行完整单元、集成、类型检查与 lint；有真实 GPU 的环境额外执行 `nvidia-smi` 或对应厂商工具做端到端验收。
- 更新 `README.md` 与 `README.zh.md`：自动支持行为、设备集合、双 runner、`read-only` 语义、安全代价与平台差异；配置示例不增加字段。
