# Windows ACL 沙箱真机验收清单（Task 17）

> 对应设计：`pi-sandbox/docs/superpowers/specs/2026-10-03-windows-acl-sandbox-design.md`（§10.2 真机套件、§10.4 验收流程、§13 验收记录）。
> 自动化真机套件是 `pi-sandbox/tests/win32/e2e.test.ts`（`describe.skipIf(process.platform !== "win32")`：在 Windows 上**真正执行**，在 Linux/macOS 上干净跳过）。
> 本清单只覆盖**代码无法自动判定**的条目；逐条把原始输出粘进「实测」，并把结论回填 spec §13 的验收记录表。
> 偏差归类口径（spec §10.4）：**实现缺陷** / **环境差异** / **文档需要补充**。偏差未闭环前不得把 Task 17 标记完成。

## 0. 环境与自动化前置

**Windows 机器准备（PowerShell）**

```powershell
git clone https://github.com/yandy/pi-packages.git C:\pi-packages
cd C:\pi-packages
git checkout pi-sandbox-windows-support      # 需为已推送的待验收提交
npm install                                  # 必须装上 koffi（windows-acl runner 的 FFI 依赖）
pi --version                                 # 需 >= 1.0.0（powershell 工具自该版本提供）

cd C:\pi-packages\pi-sandbox
npx vitest run tests/win32/e2e.test.ts       # 期望：18 个 win32 用例真正执行（不是 skip）+ 2 个全平台用例，全绿
npx vitest run                               # 期望：全量绿（integration 的 4 个受限 bash 用例在 win32 上按 Ruling 2 跳过）
```

**Windows 机器准备（git-bash）**

```bash
cd /c/pi-packages && git checkout pi-sandbox-windows-support && npm install
cd /c/pi-packages/pi-sandbox
npx vitest run tests/win32/e2e.test.ts
npx vitest run
```

**预期**：e2e 文件在 Windows 上报 **18 个 win32 用例**执行通过，外加 **2 个各平台用例**（`bash` 拒绝、拒绝断言守卫），共 20 通过、0 跳过；全量套件全绿——`tests/integration.test.ts` 的 4 个受限 `bash` 用例在 win32 上按 **Ruling 2**（win32 受限模式只支持 pwsh，`createSandboxBashOps` 在任何 spawn 前拒绝 bash）**跳过**，不是失败；win32 专属用例此时真实执行。

**前置：机器状态、`%TEMP%` 授权与复跑**

- 套件里两个用例会把**真实的 `%TEMP%`** 作为 `--temp` 授权（`canonicalPath(os.tmpdir())`）。首次授权在整棵 `%TEMP%` 树上**急切传播可继承的能力 ACE + Low 标签 + world `FILE_DELETE_CHILD` DENY**（设计 §4.7），且这些是 **standing（常驻、永不回收）** 的：套件/pi 退出后仍在。完整核对见第 15 条。
- 套件的 workspace、工作区外目标与私有授予 temp 都建在 `os.homedir()` 下的**每次运行独立目录**（`$env:USERPROFILE\pi-sandbox-e2e-<随机>`），只有必须落在真实 `%TEMP%` 里的两个目标建在 `tmpdir()` 内并在 `afterEach` 删除；套件另有硬断言保证 fixture 根不在 `os.tmpdir()` 内。因此**同一台机器上重复执行 `npx vitest run tests/win32/e2e.test.ts` 是安全的、结果一致**：`%TEMP%` 的常驻授权**不会**污染新 fixture（它们不在 `%TEMP%` 里），这正是本次修复要解决的 Critical。
- 如果机器在本清单执行前已被旧版本套件/其他工具授权过 `%TEMP%`：**不需要清理**，也不会让本套件假绿；但要理解「`%TEMP%` 子树里任何新目录都会继承能力 ACE」，即受限子进程能写 `%TEMP%` 全树是**设计行为**。若怀疑结果异常，先确认新 fixture 在 `os.homedir()` 下（`$env:USERPROFILE\pi-sandbox-e2e-*`），再核对第 15 条的 `icacls` 观察。
- 首次运行 `%TEMP%` 全树传播可能耗时数秒（大树更久），e2e 每个用例给了 180s 超时；不要把首次传播误判为挂起。

**前置：系统语言与拒绝方言（Important）**

- `DENIAL_SIGNATURES["windows-acl"]` 的四个方言（`access is denied` / `access to the path` / `permission denied` / `operation not permitted`）都是**英文**文本，且生产端 `classifyDenial` 只匹配 **stderr**。`cmd`、PowerShell/.NET 的消息来自系统/CLR 资源，在**本地化 Windows（zh-CN 等）上会被本地化**：沙箱**仍然拒绝**访问，但工具层可能不注入 `[sandbox: file access denied …]` 标记，denial-first 提权也不记账。这是**分类缺口，不是强制失效**。
- e2e 已把「主证据」与「方言」分离：非零退出（命令自身设置退出码时）+ 宿主文件仍在/未创建是 locale-independent 的硬断言；方言断言只在 Node 自有 errno 文本（`EPERM: operation not permitted` 等，恒英文）的用例上要求。`cmd`/PowerShell/.NET 删除用例在本地化系统上即使没有方言也通过。
- 因此第 6/7/10/13a 条在本地化 Windows 上**可能看不到拒绝标记或 `Access is denied.`**：把原始输出粘进「实测」，结论按**环境差异（方言本地化，已知取舍）**记录，不要记为「实现缺陷」或「强制失效」；边界证据用宿主文件状态 + 退出码。自动化用例一侧的方言原文记录点：若怀疑方言缺失，用 `npx vitest run tests/win32/e2e.test.ts --reporter=verbose` 复跑并回看对应用例输出（失败断言会把 `stderr+stdout` 原样打出）。

**实测（粘贴 `npx vitest run tests/win32/e2e.test.ts` 与全量尾部摘要）**：

```text

```

**验收会话的工作区**：新建一个专用目录并让 pi-sandbox 以它为 workspace（`pi` 从不 chdir，workspace = 启动 cwd）：

```powershell
mkdir C:\pi-sandbox-accept
cd C:\pi-sandbox-accept
pi -e C:\pi-packages\pi-sandbox             # 一次性加载本地待验收构建
```

git-bash：

```bash
mkdir -p /c/pi-sandbox-accept && cd /c/pi-sandbox-accept
pi -e /c/pi-packages/pi-sandbox
```

> 后面的「让 pi 执行」一律指：在该 pi 会话中把给出的命令原样交给模型，由模型调用 `powershell` 工具执行；把工具结果原文粘进「实测」。

---

## 1. `/permission` 状态行显示 `windows-acl (partial enforcement)`

**命令（PowerShell）**

```powershell
cd C:\pi-sandbox-accept
pi -e C:\pi-packages\pi-sandbox
# 进入会话后输入：/permission
```

**命令（git-bash）**

```bash
cd /c/pi-sandbox-accept
pi -e /c/pi-packages/pi-sandbox
# 进入会话后输入：/permission
```

**预期**：状态行含

```text
sandbox mode: workspace-write (config default)
runner: windows-acl (partial enforcement)
workspace: C:\pi-sandbox-accept
shell: powershell only (not activated)
```

其中 `runner:` 行必须逐字含 `windows-acl (partial enforcement)`；默认工具集（`powershell` 未启用）下 `shell:` 行含 `(not activated)`。

**实测**：

```text

```

## 2. 默认工具集下 `bash` 被拒绝并给出 settings 片段（fail-closed）

**前置**：`~/.pi/agent/settings.json` 保持默认（未启用 `powershell` 工具），重启 pi。

**命令**：在会话里对模型说

```text
用 bash 工具执行：echo hello
```

**预期**：工具调用被拒绝、**没有执行任何命令**，错误文案含：

```text
[sandbox: bash is not supported on Windows]
{ "defaultTools": ["-bash", "+powershell"] }
requires pi >= 1.0.0
```

同时激活期只出现一次提示（有 UI 走通知，无 UI 走 stderr）：`pi-sandbox: on Windows the confined shell is PowerShell only...`。

**实测**：

```text

```

## 3. 未激活的 `powershell` 覆盖注册被 pi 接受（启动无扩展错误）

**前置**：同上（`powershell` 未在 `defaultTools` 中激活）。

**命令**：启动 pi（第 1 条的 `pi -e ...`），观察启动输出 / `/permission`。

**预期**：扩展正常加载，无 `Extension error`、无工具注册冲突或 `registerTool` 报错；`/permission` 的 `shell:` 行为 `shell: powershell only (not activated)`。pi-sandbox 只在宿主提供 `createPowerShellToolDefinition` 时注册 `powershell` 覆盖；注册一个**未激活**的工具对 pi 无害。

**实测**：

```text

```

## 4. 启用 `powershell` 工具后受限执行可用

**命令（PowerShell / git-bash 相同）**：编辑 `~/.pi/agent/settings.json`：

```json
{ "defaultTools": ["-bash", "+powershell"] }
```

重启 pi，再输入 `/permission`；然后对模型说：

```text
用 powershell 工具执行：$PSVersionTable.PSVersion.ToString()
```

**预期**：`/permission` 的 `shell:` 行变为 `shell: powershell only`（无 `(not activated)` 后缀）；工具成功返回 PowerShell 版本。

**实测**：

```text

```

## 5. 受限 `pwsh` 在 workspace 内建文件成功

**前置**：第 4 条已启用 `powershell`，会话 cwd = `C:\pi-sandbox-accept`。

**命令（交给 pi）**

```powershell
Set-Content -LiteralPath .\accept-write.txt -Value ok; Get-Content -LiteralPath .\accept-write.txt
```

**预期**：工具返回 `ok`、退出码 0；宿主侧（不受限窗口）验证：

```powershell
Get-Content C:\pi-sandbox-accept\accept-write.txt     # ok
```

**实测**：

```text

```

## 6. 往 `C:\Windows\Temp` 写被拒且带拒绝标记

**命令（交给 pi）**

```powershell
Set-Content -LiteralPath C:\Windows\Temp\pi-sandbox-accept-denied.txt -Value nope
```

**预期**：命令非零退出；工具结果里出现沙箱拒绝标记（由 pi-sandbox 注入）：

```text
[sandbox: file access denied under workspace-write mode]
```

宿主侧验证文件**不存在**：

```powershell
Test-Path C:\Windows\Temp\pi-sandbox-accept-denied.txt   # False
```

**本地化偏差（已知）**：`[sandbox: …]` 标记由生产端 `classifyDenial` 匹配英文 Win32/CLR 消息文本后注入；本地化 Windows 上消息被本地化，标记可能不出现。此时以「命令非零退出 + 宿主 `Test-Path` 为 False」为边界证据，并把原始输出粘进「实测」，结论记为**环境差异（分类本地化缺口）**，不是实现缺陷。

**实测**：

```text

```

## 7. 删除工作区外文件被拒且宿主文件仍在

**准备（不受限 PowerShell 窗口，不是在 pi 里）**

```powershell
"must-survive" | Set-Content -LiteralPath "$env:USERPROFILE\pi-sandbox-accept-victim.txt"
Get-Content "$env:USERPROFILE\pi-sandbox-accept-victim.txt"    # must-survive
```

**命令（交给 pi，两条都执行）**

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\pi-sandbox-accept-victim.txt" -Force
cmd /c del /f /q "%USERPROFILE%\pi-sandbox-accept-victim.txt"
```

**预期**：

- `Remove-Item`：非零退出，工具结果含 `[sandbox: file access denied under workspace-write mode]`（拒绝标记）。
- `cmd /c del`：删除被拒、原始输出含 `Access is denied.`。注意：cmd 内建命令**可能**在拒绝时仍返回 ERRORLEVEL 0，而 pi 的拒绝标记只在**非零退出**时注入（`src/shell-ops.ts:142` 门控 + `src/confine.ts` 的 `classifyDenial` 同样要求非零退出）→ 此路径的判定证据是**宿主文件仍在**与 `Access is denied.` 文本；把 cmd 实际返回的退出码一并记录，若确为 0，记为「拒绝方言对 cmd 的覆盖受 exit-code 门控限制（已知取舍）」而非实现崩溃。
- **本地化偏差（已知）**：`Remove-Item` 的 `[sandbox: …]` 标记与 `cmd` 的 `Access is denied.` 文本都是英文方言；本地化 Windows 上可能看不到两者。判定证据仍是宿主文件仍为 `must-survive`（`Remove-Item` 另加非零退出）；cmd 的**真实退出码**一并记录。另注：`cmd` 内建命令的报错可能走 **stdout**，而生产端 `classifyDenial` 只搜 **stderr**——即使英文系统上 cmd 走了 stdout 也不会有标记，这与语言无关，是已知的覆盖缺口。
- 宿主侧再读一次仍为 `must-survive`。

**实测**：

```text

```

## 8. 读取工作区外系统文件成功

**命令（交给 pi）**

```powershell
Get-Content -LiteralPath C:\Windows\win.ini -TotalCount 1
```

**预期**：退出码 0，返回 `win.ini` 首行；无拒绝标记。读不受限是 `partial` 的已知结构性缺口之一。

**实测**：

```text

```

## 9. `%TEMP%`（授予的临时根）在 workspace-write 下可写

**命令（交给 pi）**

```powershell
Set-Content -LiteralPath "$env:TEMP\pi-sandbox-accept-temp.txt" -Value ok; Get-Content -LiteralPath "$env:TEMP\pi-sandbox-accept-temp.txt"
```

**预期**：返回 `ok`、退出码 0。宿主侧 `Test-Path "$env:TEMP\pi-sandbox-accept-temp.txt"` 为 True。

**实测**：

```text

```

## 10. `read-only` 拒绝 workspace 写；两个模式的 PowerShell 语言模式

**命令（在 pi 会话内）**

```text
/permission read-only
```

然后交给 pi：

```powershell
$ExecutionContext.SessionState.LanguageMode
Set-Content -LiteralPath .\read-only-denied.txt -Value nope
```

再切回：

```text
/permission workspace-write
```

并交给 pi：

```powershell
$ExecutionContext.SessionState.LanguageMode
```

**预期**：

| 模式 | 语言模式 | workspace 写 |
|---|---|---|
| `read-only` | 按 spec §10.2 预期为 `ConstrainedLanguage`；设计 §5 写明是「**可能**退化」（PowerShell 启动行为，不是 ACL 边界）——若观察到 `FullLanguage`，记录实测值并归为**环境差异**，不记为缺陷 | 非零退出 + `[sandbox: file access denied under read-only mode]`；宿主 `Test-Path .\read-only-denied.txt` 为 False |
| `workspace-write` | `FullLanguage` | 第 5 条已验证可写 |

可选佐证（read-only 下失败、workspace-write 下成功）：

```powershell
Add-Type -TypeDefinition 'public class X {}' -PassThru | Out-Null
```

> 语言模式是 PowerShell 启动行为（有可写 temp 才保持 FullLanguage），不是 ACL 边界的一部分。
>
> **本地化偏差（已知）**：read-only 的 `[sandbox: …]` 标记同样依赖英文方言；本地化 Windows 上可能不出现，边界证据是宿主 `Test-Path .\read-only-denied.txt` 为 False + 非零退出。

**实测**：

```text

```

## 11. 硬链接边界（已知缺口，记录为 partial 的正确行为）

**准备（不受限 PowerShell 窗口）**

```powershell
Set-Content -LiteralPath C:\pi-sandbox-accept\hardlink-target.txt -Value original
New-Item -ItemType HardLink -Path "$env:USERPROFILE\pi-sandbox-accept-hardlink.txt" -Target C:\pi-sandbox-accept\hardlink-target.txt
```

**命令（交给 pi，workspace-write）**

```powershell
Set-Content -LiteralPath "$env:USERPROFILE\pi-sandbox-accept-hardlink.txt" -Value modified
```

**预期**：**成功**（NTFS 硬链接是同一文件对象；工作区外的别名同样可写——spec §7 已知缺口 1）。宿主侧 `Get-Content C:\pi-sandbox-accept\hardlink-target.txt` 变为 `modified`。这不是缺陷，但必须在验收记录里写明「已知边界，符合设计」。

**实测**：

```text

```

## 12. 超时命令的孙进程随 runner 一起消失（Job teardown）

**前置**：第 4 条已启用 `powershell`。

**命令（交给 pi，明确要求 `timeout` 参数 = 5 秒）**

```text
用 powershell 工具执行下面的命令，工具的 timeout 参数设为 5（秒）：
powershell -NoProfile -Command "Start-Sleep -Seconds 300"; Start-Sleep -Seconds 300
```

**预期**：工具以 `timeout:5` 类的错误返回（pi 既有文案契约）；随后在**不受限**的 PowerShell 窗口核对：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*Start-Sleep -Seconds 300*' } |
  Select-Object ProcessId, Name, CommandLine
```

**预期**：结果为空（kill runner → Job 句柄关闭 → 整棵进程树消亡；spec §4.7）。任务管理器（详细信息 → 添加「命令行」列）同样应看不到该孙进程。

**实测**：

```text

```

## 13. 两个会话不越界（standing 授权不抬高别的会话）

### 13a. 同一 workspace：read-only 会话不被 workspace-write 的常驻授权抬高

**准备**：两个终端各启动一个 pi（同一个 `C:\pi-sandbox-accept`），都加载同一份构建：

```powershell
cd C:\pi-sandbox-accept
pi -e C:\pi-packages\pi-sandbox
```

- 会话 A：`/permission workspace-write`；交给模型：

  ```powershell
  Set-Content -LiteralPath .\session-a.txt -Value a; Set-Content -LiteralPath "$env:TEMP\session-a.txt" -Value a
  ```

  预期：都成功（A 会留下 workspace 与 `%TEMP%` 的常驻 ACE）。
- 会话 B：`/permission read-only`；交给模型：

  ```powershell
  Set-Content -LiteralPath .\session-b.txt -Value b
  Set-Content -LiteralPath "$env:TEMP\session-b.txt" -Value b
  Remove-Item -LiteralPath .\session-a.txt -Force
  ```

  预期：三条全部被拒（非零退出 + `[sandbox: file access denied under read-only mode]`）。read-only 的令牌不携带能力 SID，A 留下的常驻授权对 B **自动失效**（spec §5）；宿主侧 `session-a.txt` 内容仍为 `a`，`session-b.txt` 不存在。
  **本地化偏差（已知）**：三条的拒绝标记依赖英文方言，本地化 Windows 上可能不出现；边界证据是非零退出 + 宿主文件状态（`session-a.txt` 仍为 `a`、`session-b.txt` 不存在）。

### 13b. 不同 workspace：两个 workspace-write 会话各授各的，不能互写互删

**准备**：`C:\pi-sandbox-accept-1` 与 `C:\pi-sandbox-accept-2`，两个终端分别在其 cwd 启动 pi（都 `-e` 同一构建，都 `/permission workspace-write`）。

- 会话 A（cwd = accept-1）写入自己的文件：

  ```powershell
  Set-Content -LiteralPath .\own.txt -Value one
  ```

  预期：成功。
- 会话 B（cwd = accept-2）尝试跨写 / 跨删 A 的 workspace：

  ```powershell
  Set-Content -LiteralPath C:\pi-sandbox-accept-1\stolen.txt -Value two
  Remove-Item -LiteralPath C:\pi-sandbox-accept-1\own.txt -Force
  ```

  预期：两条都被拒（B 的令牌只携带 accept-2 的能力 SID，A 的常驻 ACE 对 B 无效）；宿主侧 `own.txt` 仍为 `one`、`stolen.txt` 不存在。

**实测（13a + 13b 的原始输出与宿主侧文件状态）**：

```text

```

## 14. 诊断技能目录：Windows 出现 / 非 Windows 不出现

**前置（重要）**：本行要求包内存在 `skills/diagnose-windows-sandbox-acl/SKILL.md`——该内容由第二部分计划 `docs/superpowers/plans/2026-10-03-windows-acl-diagnosis-skill.md` 交付（本清单写就时尚未落地）。若尚未执行第二部分，本行预期为 FAIL，记录为**已知缺口（交付顺序）**，不是 runner 缺陷；执行第二部分后复跑本行。

**命令（Windows）**：在中立 cwd 启动，避免项目级配置干扰（PowerShell / git-bash 相同）：

```powershell
cd C:\pi-sandbox-accept
pi -e C:\pi-packages\pi-sandbox -p "List the exact names of all skills available to you, verbatim, one per line."
```

```bash
cd /c/pi-sandbox-accept
pi -e /c/pi-packages/pi-sandbox -p "List the exact names of all skills available to you, verbatim, one per line."
```

**预期**：Windows 上输出包含 `diagnose-windows-sandbox-acl`。
**非 Windows 对照**（同一份构建，在 Linux/macOS 上执行同一命令）：输出**不含** `diagnose-windows-sandbox-acl`（`aclSkillPaths(platform)` 仅在 win32 返回路径，其余平台返回 `[]`，pi 侧是 mergePaths 追加语义）。
若 Windows 上未出现：先确认「非 Windows 对照」也正确，再检查相对路径解析（spec §4.10：pi 以扩展文件所在目录为 baseDir；失效时按设计回退 `import.meta.url` 绝对路径），归类为**实现缺陷**。

**实测（Windows + 非 Windows 两段输出）**：

```text

```

## 15. 常驻 ACL 残留核对（`icacls`：能力 SID、DENY、Low 标签；pi 退出后仍在）

**前置**：第 5、9 条已触发过 workspace 与 `%TEMP%` 的授权；**完全退出**所有 pi 进程。

**命令（不受限 PowerShell）**

```powershell
icacls C:\pi-sandbox-accept
icacls $env:TEMP
```

**命令（git-bash）**

```bash
icacls "C:\\pi-sandbox-accept"
icacls "$TEMP"
```

**预期**（workspace 根与 `%TEMP%` 根各一条 ACE 集合）：

| 观察点 | 预期 |
|---|---|
| workspace 根 | 一条允许 ACE 指向 `S-1-4-<x>-<y>`（工作区能力 SID），继承 `(OI)(CI)`，掩码为写+删除（icacls 可能显示为 `(M)` 或展开形式如 `(S,DE,DC,WD,AD,WEA,WA)`，不要求逐字一致） |
| `%TEMP%` 根 | 一条允许 ACE 指向 `S-1-4-<x>-<y>-1`（temp 能力 SID，第三级子授权 `-1` 域分离） |
| 两个根 | 一条 **DENY** ACE 指向 world（Everyone），掩码只有 `Delete child`/`DC`，继承只到容器（`(CI)`；icacls 渲染可能是 `Everyone:(DENY)(DC)` 或 `Everyone:(CI)(DENY)(DC)`，中文系统可能显示本地化的 Everyone 名称） |
| 两个根 | 一条强制标签行：`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（中文系统显示本地化名称，关键是指向 `S-1-16-4096`/Low 且带 `NW`） |

**关键说明（必须记录）**：这些 ACE/标签是 **standing（常驻）** 的——**pi 退出后仍然存在**，本包不回收；`read-only` 只让能力 ACE 失效（令牌不携带能力 SID），不会移除它们。首次授权会在 `%TEMP%` 全树急切传播（大树可能数秒），之后命中精确匹配快路径。外部性说明见 README 的 Windows 小节与 spec §7。

**实测（两条 icacls 的完整输出）**：

```text

```

## 16. （可选）收尾清理与记录

- 清理验收产生的普通文件即可（`pi-sandbox-accept-*`、`session-*`、`hardlink-*`）。
- **不要试图回滚常驻 ACL/标签**：清除可继承标签不会回退已传播到子对象的标签（spec §7）；如需人工处置，先在记录里说明命令与理由。
- 把第 1–15 条的原始输出与结论回填 spec §13 的「编号 / 命令 / 预期 / 实测输出 / 结论」表格，偏差按「实现缺陷 / 环境差异 / 文档补充」逐条闭环。
