# pi-memory Windows 真机验收清单

> 对应设计：`pi-memory/docs/superpowers/specs/2026-10-03-windows-support-design.md`（§5.4 真机验收套件、§5.5 验收流程、§7 风险与已知限制、§8 验收记录表）。
> 验收对象：分支 `pi-memory-windows-support` 的最新提交（clone 后先 `git log -1 --oneline` 记下 SHA，粘进第 1 条的「实测」）。
> 本清单只覆盖**代码无法自动判定**、必须在真 Windows 上跑的条目；win32 纯逻辑（目录名派生、重试 errno 集合、锁的空记录语义等）已由 Linux CI 上带平台注入的单测覆盖。
> 每条给出可粘贴的命令与预期：把**原始输出**（含报错全文）粘进「实测」，再写一行结论（通过 / 偏差）。偏差按 §5.5 归类为**实现缺陷** / **环境差异** / **文档需要补充**，结论回填 spec §8 记录表。偏差未闭环前不得宣称完成。

## 前置准备（Windows）

**共同约定**

- 仓库路径按 `C:\pi-packages` 写；你若 clone 在别处，替换文中所有该前缀。
- **验收只在 PowerShell 上进行**：Git Bash 不在支持面内，本清单不提供 bash 命令（第 3 条不再做「两个 shell 对比」，改为验证「从子目录启动得到同一记忆目录」）。
- 本清单一律用 `pi -ne -e <pi-memory 目录>` 启动：`-ne` 关掉机器上已配置的其它扩展（避免与已安装的 `@yandy0725/pi-memory` 重复注册 `memory` 工具与 `/memory` 命令），`-e` 显式加载**本次待验收的本地构建**（pi 按包的 `pi.extensions` 加载其 `index.ts`）。
- 模型：dream 是每个会话的必跑任务，`defaults.model` / `dream.model` 必须能解析；否则 `/memory` 显示 `Memory: misconfigured`。那是配置问题，先修好再验收。
- 默认 `memoryDir` 是 `$env:USERPROFILE\.pi\memory`；若你改过它，把各条 `Dir:` 的根换成你的配置值。
- 「交给 pi」= 在该目录里启动上面的 pi，把给出的那段话原样发给模型，由模型调用 `memory` 工具。让模型把工具返回原文贴出来（add 成功是 `Saved "<name>" (<file>).`，界面通知是 `Saved: <name>`），但**判定以磁盘上的实际文件与 `/memory` 输出为准**。

**PowerShell**

```powershell
git clone https://github.com/yandy/pi-packages.git C:\pi-packages   # 已 clone 过则跳过
cd C:\pi-packages
git checkout pi-memory-windows-support
npm install
git log -1 --oneline
node -v

# 全量套件（= 第 1 条；把尾部摘要与跳过清单留给第 1 条的「实测」）
cd C:\pi-packages\pi-memory
npx vitest run
```

```powershell
# 验收用的两个目录（第 2 条 / 第 5、8、9、10、11 条）
New-Item -ItemType Directory -Force "$env:USERPROFILE\pi-memory-probe" | Out-Null
New-Item -ItemType Directory -Force "C:\pi-accept\proj" | Out-Null
```

第 1 条给出全量套件的预期结果与跳过清单。第 3、4 条在 `C:\pi-packages` 里做，第 6 条在 `C:\pi-accept\vol` 里做。

## 1. 全量套件（Windows 上可跑、跳过清单可预测）

**命令（PowerShell）**

```powershell
cd C:\pi-packages\pi-memory
npx vitest run
```

**再看跳过的是哪几条（在 `pi-memory` 目录里跑）**

```powershell
npx vitest run --reporter=json --outputFile=vitest-win32.json
node -e "const r=require('./vitest-win32.json');for(const f of r.testResults)for(const a of f.assertionResults)if(a.status==='skipped')console.log(a.fullName)"
Remove-Item vitest-win32.json
```

**预期**

- 尾部摘要：`Test Files  29 passed (29)`、`Tests  626 passed | 3 skipped (629)`。
  （Linux 基线是 `28 passed | 1 skipped (29)` / `627 passed | 2 skipped (629)`；Windows 上 `tests/fs-retry.win32.test.ts` 从「整体跳过」变为**真实执行**（+2 例），而 3 条平台门用例转为跳过（−3 例），所以 `626 + 3 = 629`，与 Linux 总数一致。
  ℹ️ 这两个数字是 2026-10-04 首次真机运行后校正的：总数从 630 变为 **629**（Ruling 12 回退到 `--show-toplevel` 时删掉了 MSYS 仿真用例），跳过从 4 条变为 **3 条**。）
- 跳过用例**恰好**是下面 3 条（`describe` 与 `it` 名逐字一致；JSON 的 `fullName` 用空格连接两段）：

  1. `tests/memory-store-index.test.ts`
     `removeEntry` > `fails the removal when the entry file cannot be deleted`
  2. `tests/memory-store-index.test.ts`
     `unlinkStrict / sameFile` > `rethrows any error that is not ENOENT`
  3. `tests/memory-store-index.test.ts`
     `unlinkStrict / sameFile` > `detects two names that point at the same inode`

- 这三条都是 POSIX 权限/同 inode 语义（Windows 的 `chmod`/硬链接语义不同）。
- 若总数不是 629、或跳过清单多/少了条目：原样粘贴并归类（多半是本机工作树还有别的改动，或依赖安装不完整）。
- 首次真机运行（2026-10-04）在**本条目**发现 3 条测试自带的平台假设（`readdir` 顺序 / 内部 `join` 出的默认 sessions 目录 / 大小写不敏感 FS 下的同名派生），已在分支上修好——它们都是**测试缺陷**，产品行为正确；修完本条目应当全绿。

**实测（默认 reporter 的尾部摘要 + 跳过清单原文）**：

```text

```

## 2. `local/` 目录名是单层可读分量

**在哪做**：`$env:USERPROFILE\pi-memory-probe`（**非** git 仓库）。

**命令（PowerShell 里启动 pi）**

```powershell
cd $env:USERPROFILE\pi-memory-probe
pi -ne -e C:\pi-packages\pi-memory
# 在 pi 里输入：/memory
```

**预期**：`Dir:` 以 `\local\C_3a__Users__<你的用户名>__pi-memory-probe` 结尾；`local\` 之后只有**一个**路径分量：

```text
Dir: C:\Users\<user>\.pi\memory\local\C_3a__Users__<user>__pi-memory-probe
```

失败形态（改动前的行为）：`...\local\C_3a\Users\<user>\pi-memory-probe` —— `C:` 的冒号被转义后 `\` 仍被当成分隔符，目录被拆成多级嵌套。

**实测**：

```text

```

## 3. 从仓库子目录启动得到同一个记忆目录（`--show-toplevel` 求根）

**在哪做**：`C:\pi-packages`（git 仓库）与其子目录 `C:\pi-packages\pi-memory`。

**命令（PowerShell：先仓库根，再子目录）**

```powershell
cd C:\pi-packages
node -e "console.log('toplevel =', JSON.stringify(require('child_process').execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()))"
pi -ne -e C:\pi-packages\pi-memory
# 在 pi 里输入：/memory —— 记下 Dir:

cd C:\pi-packages\pi-memory
pi -ne -e C:\pi-packages\pi-memory
# 在 pi 里输入：/memory —— 这一次的 Dir: 必须与上一条逐字相同
```

**预期**

| 观察点 | 期望 |
|---|---|
| `toplevel` | 原生 Windows 形态（如 `"C:/pi-packages"`）；**不应**是 `/c/...` 或 `/cygdrive/c/...`（那是 cygwin/MSYS 构建的 git，见下） |
| 两次 `/memory` 的 `Dir:` | **逐字相同** |

`Dir:` 应形如：

```text
Dir: C:\Users\<user>\.pi\memory\git\github.com__yandy__pi-packages
```

若子目录启动时 `Dir:` 与仓库根启动不同（例如退化成 `local\` 分类），判定失败。
若 `toplevel` 输出的是 POSIX 形态（`/c/...`、`/cygdrive/c/...`）—— 说明 PATH 上的 `git` 是 cygwin/MSYS 构建，`resolve()` 会得到 `C:\c\...` 这类错前缀，此时记忆目录会多出一份：**归因为环境差异**（spec Ruling 12 / §7 明确接受该限制），处置是把 Git for Windows 的 `git.exe` 放到 PATH 前面，**不要记为实现缺陷**。

**实测（`toplevel` 输出 + 两次 `Dir:`）**：

```text

```

## 4. `git/` 目录名与 Linux 一致

**在哪做**：第 1–3 条使用的 `C:\pi-packages` 就是 `https://github.com/yandy/pi-packages.git` 的克隆，无需再 clone 一份。

**命令（PowerShell）**

```powershell
cd C:\pi-packages
git remote get-url origin
git log -1 --oneline
pi -ne -e C:\pi-packages\pi-memory
# 在 pi 里输入：/memory
```

**预期**：`origin` 是 `https://github.com/yandy/pi-packages.git`，`Dir:` 以 `\git\github.com__yandy__pi-packages` 结尾：

```text
Windows: C:\Users\<user>\.pi\memory\git\github.com__yandy__pi-packages
Linux:   /home/<user>/.pi/memory/git/github.com__yandy__pi-packages
```

Linux 对照值由控制器在 Linux 上对同一仓库（同一 `origin`）跑出并提供；两边末两段（`git` + `github.com__yandy__pi-packages`）必须逐字相同。这条性质意味着：把同一个 `memoryDir`（同步盘/网络盘）在两端共享时，同一仓库会落到**同一个**项目记忆目录。若你的克隆 `origin` 不是这个 URL（例如用了 fork），按实际 remote 推导并注明实际值。

**实测（Windows `Dir:` + Linux 对照值）**：

```text

```

## 5. 0 字节 `.lock` 的处置（等待 → 可操作错误 → `/memory unlock` 恢复）

**在哪做**：`C:\pi-accept\proj`（非 git）。

**① 取 `Dir:`**

```powershell
cd C:\pi-accept\proj
pi -ne -e C:\pi-packages\pi-memory
# 在 pi 里输入：/memory
# 记下 Dir:（形如 C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj）
```

**② 在另一个「不受限」的 PowerShell 窗口造一个 0 字节锁**（`$dir` 换成 ① 的 `Dir:`）

```powershell
$dir = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj"
New-Item -ItemType Directory -Force $dir | Out-Null
$lock = Join-Path $dir ".lock"
Remove-Item -LiteralPath $lock -ErrorAction SilentlyContinue
New-Item -ItemType File -Path $lock | Out-Null
(Get-Item -LiteralPath $lock).Length      # 期望 0
```

**③ 回到 pi，把下面这段发给模型**

```text
用 memory 工具执行一次 add：name = "lock-probe"，content = "0-byte lock probe"。只做这一次调用。
```

**预期**：工具调用约 5 秒后（默认 `lock.timeoutMs` = 5000，不要中断）失败，错误原文含：

```text
Memory lock at <dir>\.lock is still being written (0 bytes) — if no other process is writing, delete the file or run /memory unlock
```

**④ 在 pi 里输入 `/memory`**

**预期**：状态行出现，逐字为：

```text
Lock: unreadable — run /memory unlock
```

**⑤ 在 pi 里输入 `/memory unlock`** → 弹出的确认框选确认。

**预期**：通知 `Memory lock removed.`

**⑥ 再让模型跑一次同样的 add**

```text
用 memory 工具执行一次 add：name = "lock-probe"，content = "0-byte lock probe"。只做这一次调用。
```

**预期**：成功 —— 工具返回 `Saved "lock-probe" (<file>).`，界面通知 `Saved: lock-probe`。

**⑦ 主证据（PowerShell）**

```powershell
$dir = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj"   # 同 ①
Test-Path (Join-Path $dir ".lock")                                 # 期望 False
Get-ChildItem -Force $dir | Select-Object -ExpandProperty Name     # 期望有 MEMORY.md、<name>.md、.backups
```

**判定**：核心是「0 字节锁 → 等满 5 秒后给出可操作错误 → `/memory` 报 `unreadable` → `unlock` 后恢复写入」，不是崩溃、静默跳过或永久堵死。

**实测**：

```text

```

## 6. 非 NTFS 卷上的锁（`open(wx)` 的核心证明：负对照证明该卷不支持硬链接）

**在哪做**：`C:\pi-accept\vol`。需要你对机器上的**非 NTFS 卷**有写权限（Dev Drive/ReFS 分区、exFAT/FAT32 U 盘、或网络共享盘）。

**① 找卷**

```powershell
Get-Volume | Select-Object DriveLetter, FileSystemLabel, FileSystem, DriveType | Format-Table -AutoSize
# 网络盘/映射盘不在 Get-Volume 里，用这个看（把选中的盘符填进 $vol）：
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Description
```

**② 负对照：先证明该卷不支持硬链接**（`D:` 换成你选定的卷；按 MS 文档，`CreateHardLinkW` 在 ReFS 上不受支持，exFAT/FAT32 也一定不支持，但**以本步的实际结果为准**）

```powershell
$vol = "D:"
[IO.File]::WriteAllText("$vol\hl-src.txt", "x")
Remove-Item "$vol\hl-dst.txt" -ErrorAction SilentlyContinue
node -e "require('fs').linkSync(process.argv[1], process.argv[2])" "$vol\hl-src.txt" "$vol\hl-dst.txt"
```

**预期**：抛错（`EPERM` / `ENOTSUP` / `ENOSYS` 一类，原文贴进实测）。**若这条命令没有报错**（说明该卷支持硬链接，负对照不成立），换一个卷重做本项（exFAT/FAT32 U 盘最稳妥），不要用这个卷的结论。命令块里先用 `Remove-Item` 删掉目标文件，是为防止上一次运行残留的 `hl-dst.txt` 让 `linkSync` 以 `EEXIST` 失败而被误读成「该卷不支持硬链接」（负对照假通过）。**若机器上没有任何非 NTFS 卷**（没有 ReFS/Dev Drive、没有 exFAT/FAT32 格式的 U 盘、也没有网络共享盘）：本项记「**不适用（无非 NTFS 卷）**」，并在实测里贴 ① 的输出作为证明，**不要记为失败或实现缺陷**。
测完清理：`Remove-Item "$vol\hl-src.txt","$vol\hl-dst.txt" -ErrorAction SilentlyContinue`。

**含义**：硬链接是改动前那把锁的原语，它在这样的卷上取不到锁 → 记忆完全不可写。负对照失败即证明旧实现与这个卷无缘，下面要证明新实现可以。

**③ 只对这个项目把 `memoryDir` 指到该卷**（用**项目级**配置，不动你的全局 `memory.json`）

```powershell
$proj = "C:\pi-accept\vol"
New-Item -ItemType Directory -Force "$proj\.pi" | Out-Null
[IO.File]::WriteAllText("$proj\.pi\memory.json", '{ "memoryDir": "D:\\pi-memory-accept" }')
Get-Content -LiteralPath "$proj\.pi\memory.json"
```

注意 JSON 里的反斜杠要写两次（`D:\\pi-memory-accept`）。

**④ 启动 pi 并写入**

```powershell
cd C:\pi-accept\vol
pi -ne -e C:\pi-packages\pi-memory
# 启动时若询问是否信任该目录，选信任（等价于命令行加 -a：信任本目录的 .pi/ 配置）
# 在 pi 里输入：/memory
```

**预期**：`Dir:` 是 `D:\pi-memory-accept\local\C_3a__pi-accept__vol`（即该卷下一个**新建**的项目目录，说明配置生效）。

**交给 pi**

```text
用 memory 工具执行一次 add：name = "reflock-probe"，content = "non-NTFS volume write probe"。只做这一次调用。
```

```text
用 memory 工具执行一次 search：query = "non-NTFS volume"。把结果原文贴出来。
```

**⑤ 主证据**

```powershell
Get-ChildItem -Force D:\pi-memory-accept\local\C_3a__pi-accept__vol | Select-Object Name, Length
Get-Content -LiteralPath D:\pi-memory-accept\local\C_3a__pi-accept__vol\MEMORY.md
Get-Content -LiteralPath D:\pi-memory-accept\local\C_3a__pi-accept__vol\reflock-probe.md
Test-Path D:\pi-memory-accept\local\C_3a__pi-accept__vol\.lock    # 期望 False（写入后锁已释放）
```

**预期**：`memory add` 成功（`Saved "reflock-probe" ...`）；该卷上生成了 `MEMORY.md`、entry 文件与 `.backups\`；`memory search` 命中这条记忆；写入结束后没有残留 `.lock`。

**若 ④ 的 `Dir:` 仍以 `C:\Users\...\.pi\memory` 开头**（项目级配置没生效）：改成临时修改全局配置 —— 先备份 `$env:USERPROFILE\.pi\agent\memory.json`，把 `memoryDir` 改成 `D:\\pi-memory-accept`，**重启 pi** 后重做 ④⑤；测完把全局配置改回。把这一过程也记进实测。

**收尾**：本项用的是项目级配置，删掉 `C:\pi-accept\vol` 即可，不影响后续条目。

**实测**：

```text

```

## 7. 瞬时共享冲突下的重试（真机）

**在哪做**：`C:\pi-packages\pi-memory`。

**命令（PowerShell）**

```powershell
cd C:\pi-packages\pi-memory
npx vitest run tests/fs-retry.win32.test.ts --reporter=verbose
```

**预期**：`Test Files 1 passed (1)`、`Tests 2 passed (2)`，两条**都真实执行**（不是 skip）—— 无需额外命令，`--reporter=verbose` 下也应看到：

```text
withFsRetry against a real Windows sharing violation > crosses a short exclusive hold
withFsRetry against a real Windows sharing violation > fails closed after the budget when the hold outlasts it
```

语义：该文件用 .NET 的 `FileShare.None` 占住目标文件（600ms / 8000ms）—— 第一条证明短冲突会被退避重试跨过去，第二条证明超出预算后仍按 fail-closed **原样**报错（errno 是 `EPERM`/`EACCES`/`EBUSY` 之一）且不会无限等。它依赖 `powershell.exe`（Windows 自带）。首次运行会为等独占释放而多花几秒，不要中断。

**实测**：

```text

```

## 8. CRLF 往返（记事本/编辑器存过的 `MEMORY.md`）

**在哪做**：`C:\pi-accept\proj` 的记忆目录（第 5 条已产生过记忆，本项基于它继续）。

**前提**：该目录里至少已有一条记忆（第 5 条成功后就有）。

**① 在 pi 里 `/memory`**，记下 `Dir:`、`Entries:` 与 `Index:` 行的数字（尤其是 `unrecognized lines`）。

**② 把 `MEMORY.md` 的行尾改成 CRLF**（二选一）

- 记事本：`notepad "<Dir>\MEMORY.md"`，不修改内容，直接 Ctrl+S 保存并关闭（记事本保存的就是 CRLF）。
- 或 PowerShell 精确改行尾：

```powershell
$idx = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj\MEMORY.md"   # ← 换成你的 Dir:
$text = [IO.File]::ReadAllText($idx)
[IO.File]::WriteAllText($idx, ($text -replace "\r?\n", "`r`n"))
[IO.File]::ReadAllText($idx).Contains("`r`n")     # 期望 True（确认已改成 CRLF）
```

**③ 回到 pi**：`/memory`；再用 `memory search`（把下面这段发给模型）

```text
用 memory 工具执行一次 search：query = "lock-probe"，把结果原文贴出来。
```

（若第 5 条没有产生 `lock-probe`，换成你目录里已有的任意一条记忆的名字。）

**预期**

- `Index:` 行的 `unrecognized lines` 与 ① 相同（CRLF 不会被误报成无法识别的行）、`lines` 不变、`Entries:` 不变。
- `bytes` 会因为多了 `\r` 而变大 —— 它是文件原始字节数，属正常，不是误报。
- `memory search` 仍能找到 `lock-probe`（记忆没丢）。

**④ 再写入一次**（把这段发给模型）

```text
用 memory 工具执行一次 add：name = "crlf-probe"，content = "CRLF round trip probe"。只做这一次调用。
```

**预期**：成功，`Saved "crlf-probe" ...`。

**⑤ 检查文件已回到纯 LF**（写入侧恒输出 LF，首次写入会把 CRLF 整份转成 LF）

```powershell
$idx = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj\MEMORY.md"   # 同 ②
[IO.File]::ReadAllText($idx) -match "`r"     # 期望 False
Get-Content -LiteralPath $idx -Raw           # 顺带贴出来：crlf-probe 与旧条目都在，且行尾是 LF
```

**判定**：核心是「CRLF 的索引既不被误报、也不丢记忆；一次写入后文件恢复为纯 LF」。若你也把某个 entry 文件另存成了 CRLF，下一次 `replace` 会把它写回 LF（同一口径，可选验证）。

**实测**：

```text

```

## 9. 大小写撞名不互相覆盖

**在哪做**：`C:\pi-accept\proj`。

**命令（PowerShell 启动 pi）**

```powershell
cd C:\pi-accept\proj
pi -ne -e C:\pi-packages\pi-memory
```

**交给 pi（两条分开跑，各自等工具返回）**

```text
用 memory 工具执行一次 add：name = "Foo Bar"，content = "acceptance probe: Foo Bar"。只做这一次调用。
```

```text
用 memory 工具执行一次 add：name = "FOO BAR"，content = "acceptance probe: FOO BAR"。只做这一次调用。
```

```text
用 memory 工具执行一次 list，把结果原文贴出来。
```

**主证据（PowerShell）**

```powershell
$dir = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj"   # ← 你的 Dir:
Get-ChildItem -Force $dir -Filter *.md | Select-Object -ExpandProperty Name
Get-Content -LiteralPath (Join-Path $dir "Foo-Bar.md") -Raw
Get-Content -LiteralPath (Join-Path $dir "FOO-BAR-2.md") -Raw
```

**预期**

- 目录里出现**两个**文件：`Foo-Bar.md` 与 `FOO-BAR-2.md`。
  （Windows 文件系统大小写不敏感：第二次 add 想派生 `FOO-BAR.md`，写前的磁盘探测发现该名字已被 `Foo-Bar.md` 占用，于是改用 `-2` 后缀。）
- `list` 里两条都在，名字分别是 `Foo Bar` 与 `FOO BAR`，分别指向 `Foo-Bar.md` 与 `FOO-BAR-2.md`。
- 两份文件的内容各自是上面写入的正文，**互不覆盖**。
- 索引里对应两行，指向两个不同文件。

若第二次 add 覆盖了第一条（只剩一个文件、`list` 只有一条），判定失败。

**实测**：

```text

```

## 10. 保留设备名 `CON` 不再写进控制台

**在哪做**：`C:\pi-accept\proj`。

**交给 pi**

```text
用 memory 工具执行一次 add：name = "CON"，content = "acceptance probe: reserved device name"。只做这一次调用。
```

```text
用 memory 工具执行一次 search：query = "reserved device name"，把结果原文贴出来。
```

**主证据（PowerShell）**

```powershell
$dir = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj"   # ← 你的 Dir:
Get-ChildItem -Force $dir -Filter *.md | Select-Object -ExpandProperty Name
Get-Content -LiteralPath (Join-Path $dir "_CON.md") -Raw
Get-Content -LiteralPath (Join-Path $dir "MEMORY.md") -Raw
```

**预期**

- 生成的文件名是 **`_CON.md`**（在原名前加 `_`；大小写保留你输入的样子。判定基准是「第一个 `.` 之前的部分」：`CON.md` 在 Windows 上等价于 `CON` 设备；spec §8 表里写的 `_con.md` 是同一规则的小写示意）。
- `Get-Content "_CON.md"` 读到完整 frontmatter 与正文 `acceptance probe: reserved device name` —— 写入落到**真实文件**，而不是控制台设备。
- `list` / `search` 都能看到这条记忆，索引行形如 `- [CON](_CON.md) — …`。

**实测**：

```text

```

## 11. 写前快照与 `sessions/` 的位置

**在哪做**：`C:\pi-accept\proj`（第 5、8、9、10 条已经产生过多次写入）。

**命令（PowerShell 启动 pi）**

```powershell
cd C:\pi-accept\proj
pi -ne -e C:\pi-packages\pi-memory
```

**先制造一次新写入（发给模型）**

```text
用 memory 工具执行一次 add：name = "snapshot-probe"，content = "acceptance probe: snapshot"。只做这一次调用。
```

**主证据（PowerShell）**

```powershell
$dir = "C:\Users\<user>\.pi\memory\local\C_3a__pi-accept__proj"   # ← 你的 Dir:
Get-ChildItem -Force (Join-Path $dir ".backups") | Select-Object Name, Mode
# 只数「非 migrate-」的目录：
(Get-ChildItem -Force (Join-Path $dir ".backups") -Directory | Where-Object { $_.Name -notlike "migrate-*" }).Count
# 看最新一份快照的内容：
$newest = Get-ChildItem -Force (Join-Path $dir ".backups") -Directory | Where-Object { $_.Name -notlike "migrate-*" } | Sort-Object Name | Select-Object -Last 1
Get-ChildItem -Force $newest.FullName | Select-Object -ExpandProperty Name
# 顺带看 sessions 有没有出现在项目记忆目录下：
Get-ChildItem -Force $dir | Select-Object -ExpandProperty Name
```

**预期**

- `.backups\` 下存在形如 `2026-10-04T01-23-45-678Z-write` 的目录：ISO 时间戳里的 `:` 与 `.` 被换成 `-`，后缀是写入原语的标签（普通写入 `write`，dream 整轮 `dream`，重建索引 `index`）。
- **非 `migrate-`** 目录数量 ≤ `lock.snapshotKeep`（默认 5）：每个写原语写前都拍一份，超出后按名字（即时间）序裁掉最旧的。你此前在本项目目录里的写入（第 5 条 1 次、第 8 条 1 次、第 9 条 2 次、第 10 条 1 次，加上本次）刚好能观察到裁剪生效。
- 最新 `-write` 快照里含 `MEMORY.md`（以及本次写入涉及的 entry 文件）的副本。
- `migrate-*` 目录（1.x 迁移留下的整目录快照）**不计入数量、也永不被裁剪**，看到它们不影响判定。

**`sessions/`（条件项，默认不出现）**

- 只有在你**开启了会话持久化**（`dream.sessionPersistence.enabled` 或 `defaults.sessionPersistence.enabled` 为 `true`；默认 `false`）并且**真的跑过**一回 dream（`/dream`）或 extract（`extractMemories.enabled = true` 后的一轮）时，`sessions\` 才会出现。
- 出现时它应在**项目记忆目录** `<Dir>\sessions\` 下（也就是上面 `$dir` 的列表里），而不是你的工作副本 `C:\pi-accept\proj\sessions` 下 —— headless 子会话的 cwd 被设为记忆目录，所以持久化会话落在记忆目录里。
- 若你没有开启持久化、或没跑过 dream/extract：本项记「**不适用（未开启会话持久化 / 未跑过 dream-extract）**」，并在实测里贴 `Get-ChildItem -Force $dir` 的输出证明没有 `sessions`，**不要记为失败**。

**实测（`.backups` 列表、计数、最新快照内容、`$dir` 列表）**：

```text

```

## 偏差归类与回填

把第 1–11 条的原始输出与结论回填 `pi-memory/docs/superpowers/specs/2026-10-03-windows-support-design.md` §8 记录表（列：编号 / 条目 / 命令 / 预期 / 实测输出 / 结论）。每条偏差按下面的口径三选一，写清证据与最小复现命令：

| 归类 | 判据 | 处置 |
|---|---|---|
| **实现缺陷** | 你的输入与清单一致、命令路径都走到了，结果仍与预期不符 | 回到对应 Task 修代码/测试；修完复跑该条与第 1 条 |
| **环境差异** | 机器状态导致（未装 powershell（第 7 条需要它）/ 没有非 NTFS 卷 / 本地化或版本差异 / 你改过 `memoryDir`、`lock.snapshotKeep`、模型配置） | 记录实际值与原因；必要时同步修正 README 或本清单的说明，不改代码 |
| **文档需要补充** | 本清单步骤缺前置条件、命令不能直接粘贴、措辞有歧义 | 直接改本文件并注明改动 |

**收尾清理（可选）**：验收产生的普通文件可删（`C:\pi-accept`、`$env:USERPROFILE\pi-memory-probe`、记忆目录里的验收条目与 `.backups`、第 6 条卷上的目录与 `hl-src.txt`）。`.backups` 是回滚点，删前确认不需要恢复。第 6 条若临时改过全局 `memory.json`，记得改回并重启 pi。
