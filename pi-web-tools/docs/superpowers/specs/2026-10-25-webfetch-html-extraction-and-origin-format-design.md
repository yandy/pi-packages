# webfetch：HTML 正文抽取与 origin 格式设计

**状态：待批准（批准前不写任何实现代码）**

## 意图与缘由

`webfetch` 的 local 实现当前把整份 HTML 直接丢给 turndown，于是 SPA 页面的水合 JSON、内联 CSS、`<title>` 全都变成"正文"；同时它不看 content-type，对 `text/plain` 的源码/纯文本也做标签处理，会把内容改坏；二进制响应则返回解码乱码。使用者（编码 agent）要的是**可读正文**，现在拿到的常常是几百 KB 里 80% 的噪声，白白占上下文。

这次把 local 改成「先按 content-type 分类，再做最小必要变换」，并把输出格式收敛成 `markdown`（清洗后的正文）与 `origin`（原样）两种。

## 目标 / 非目标 / 反目标

**目标**

- HTML → 只保留正文容器的 markdown，不含 script/style/`<title>`/页面骨架
- 非 HTML 内容不再被破坏（源码、diff、原始 markdown 原样）
- 二进制响应明确报错，而不是返回乱码
- `origin` 提供"我要原始 body"的确定语义
- 通过真实页面验证：`https://github.com/Comfy-Org/comfy-skills/` 的输出从 61,792 chars 降到正文量级

**非目标**

- 不做正文摘要、不做可读性评分排序、不引入 headless 浏览器
- 不改造 `isThinContent` / thin 阈值（本次冻结）
- 不做二进制落地下载（不属于 webfetch 契约）
- 不发版（版本号与 npm 发布走独立流程）

**反目标（技术上成功也算失败）**

- 把正常文本页误判成二进制并拒绝
- 把已经是纯文本的内容再加工一次（这是当前 bug 的成因）
- 为了清洗而在输出里插入"已清理 N 项"之类噪声
- 让 `origin` 的输出被任何后处理改动（除既有 100k 截断）

## 约束

- 依赖方向：local 只做 HTTP + DOM/文本处理，不依赖 deepseek
- 现有 provider 路由结构、deepseek 请求与计费、100k 截断、工具输出的 `URL`/`Content-Type` 头保持不变
- 不得新增需要编译/原生模块的依赖
- 测试须遵守仓内规范（`docs/guides/testing.md`）：无真实网络、文件系统与 env 隔离
- `@mixmark-io/domino` 已是 `turndown` 的硬依赖（`turndown@7.2.4 → @mixmark-io/domino ^2.2.0`），提升为显式 dependency 不引入新安装

## 问题实测（设计依据）

测量对象 `https://github.com/Comfy-Org/comfy-skills/`：290,385 bytes HTML、16 个 `<script>`。

| 口径 | 数值 |
|------|------|
| 现实现 markdown 输出 | 61,792 chars / 476 行 |
| `isJunkLine` 判为垃圾 | 270 行（207 空行 + 63 行以 `{` 开头）= 49,248 chars |
| 剩余"有意义" | 12,069 chars → 不触发 thin 兜底 |
| 仅删 script/style | 16,955 chars（−73%） |
| 再只取 `<article>` | 5,326 chars |
| 再只取 `<main>` | 10,020 chars |

根因三条：

1. turndown 默认 `_remove` 为空数组，`<script>`/`<style>` 的文本节点被当正文输出，并对 `_`/`[` 做转义，于是 `featureFlags` 数组变成 `featureFlags\[...\]`。
2. turndown 的 `RootNode` 包裹整份输入后解析，`<head>` 里的 `<title>` 成为正文首行。
3. 没有正文定位，页面骨架全量保留。

同源的附带问题（管线默认"body 一定是 HTML"）：

| 输入 | `format: markdown`（turndown） | `format: text`（stripTags） |
|------|------|------|
| `const xs: Array<string> = []` | `const xs: Array = \[\]` | `const xs: Array = []` |
| `if (a <b && c> d) {}` | `if (a **d) {}**` | `if (a  d) {}` |
| `#include <vector>` | `#include ` | `#include ` |
| 三行 C++ 源码 | 并成一行 | 保留换行 |

二进制：`assets/logo.png` 612,980 bytes → `response.text()` 得 579,260 个替换字符 → turndown 481,599 chars，截断到 100k 后全是 `�PNG IHDR…`。

## Approaches（已与维护者逐一比较，选定 D）

| 方案 | 内容 | 取舍 |
|------|------|------|
| A | 只给 turndown 加 `remove([...])` 白名单 | 最小改动、减 73%；但 `remove` 是整节点丢弃，无法表达"只保留 main 子树"，页面骨架仍在 |
| B | domino 预处理 + 正文定位 | 同时解决泄漏与骨架；domino 零新增安装 |
| C | `@mozilla/readability` | 文章页质量最好，但需 DOM + turndown 两层依赖，且丢纯列表/表格型页面 |
| **D（选定）** | **B + 非 HTML 按 content 四类分流 + 二进制前置拒绝 + `format` 收敛为 markdown/origin** | 覆盖面完整；代价是 `format` 破坏性变更与一条新的报错路径 |

一并否决的细节选择：`remove` 白名单与正文定位"双层保险"（第二套事实来源，无收益）；`node-html-markdown` 替换 turndown（规则更少、迁移面更大）；文本白名单判二进制（误杀代价更高）；保留 `format: text`（价值被清洗后的 markdown 覆盖）与 `format: html`（与 `origin` 重合）；改造 `isThinContent`（会连带改 4 个既有用例）；只让 markdown 拒二进制（二进制与 format 无关）；删除容器内 `<nav>`（实测仅省 4.8%，且可能删掉页内 TOC）。

## 维护者已决定的规则

| 决策 | 结论 |
|------|------|
| `format` 枚举 | 只保留 `markdown`（默认）与 `origin`；删除 `text`、`html` |
| `origin` 语义 | 原样返回 response body：不清洗、不美化、不转换 |
| 二进制判定位置 | **前置**；`markdown` 与 `origin` 都拒绝 |
| 非 HTML 分类 | 二进制→报错；HTML（含 `text/plain` 伪装嗅探）→清洗+定位；JSON→pretty-print；其余文本→原样 |
| HTML 嗅探 | content-type 非 HTML 但 body 以 `<!doctype html`/`<html` 开头 → 仍按 HTML 处理 |
| 正文定位优先级 | `main` → `article` → `[role=main]` → `body`，逐级回退；容器文本为空则继续回退 |
| 同选择器多个命中 | 拼接**所有**非空匹配（`\n\n` 连接），不只取第一个；单匹配时与只取第一个字节一致 |
| 二进制是否终止链式回落 | **终止**。deepseek 取不到二进制正文，回落只会花掉一次计费调用并埋掉清晰错误 |
| 未知 `format` 值 | 显式报错 `Unknown format: X. Available: markdown, origin`；不静默归一化旧值，也不触发回落 |
| `origin` 是否解析 DOM / 填 title | 不解析。`title` 只在 HTML→markdown 路径产生，`origin` 是字节透传 |
| `<title>` | 不进正文，改为 `result.title`（输出里的 `Title:` 行） |
| `isThinContent` / 阈值 | 冻结不动 |
| 依赖 | `@mixmark-io/domino` 提升为显式 dependency |
| 版本号 | 本次不改 |

## 目标流程

```
format ∈ { "markdown", "origin" }，默认 "markdown"

webFetch:
  0. format 不在枚举内 → 抛 Unknown format（参数错误，不回落）
  链式 canFallback = format !== "origin" 且 有 key 且 local 错误不是 terminal
     terminal：Unsupported content type、Unknown format
     可回落：网络错误 / 超时 / 非 2xx / thin 内容

localFetch:
  1. GET；origin 发 Accept: */*；markdown 发 text/html, text/plain, application/json
  2. !response.ok → 读 body 前 500 字符，抛 HTTP <status>
  3. isBinaryContentType(content-type) → 抛 terminal 错误（含 media type + content-length），两个 format 一致
  4. format === "origin" → body 原样（不解析、不填 title）
  5. format === "markdown":
     a. isHtmlContentType || looksLikeHtml(body) → htmlToMarkdown(body)
     b. isJsonContentType → JSON.stringify(JSON.parse(body), null, 2)（解析失败退回原样）
     c. 其余 → body 原样
  统一 applyTruncation（100,000 chars）

htmlToMarkdown:
  doc = domino.createDocument(html)
  title = doc.title.trim() || undefined
  删 REMOVE_SELECTORS（script, style, noscript, template, svg, iframe, canvas）
  for selector of [main, article, [role=main]]:
      matches = querySelectorAll(selector) 中 textContent 非空的项
      if matches.length > 0 → 返回 matches
  都没命中 → [body]
  content = matches.map(m => turndown(m)).join("\n\n")
```

## 分支细则

**二进制判定（黑名单）**：前缀 `image/`、`audio/`、`video/`、`font/`、`model/`；具体类型 `application/pdf`、`zip`、`gzip`/`x-gzip`、`x-tar`、`x-bzip2`、`x-7z-compressed`、`x-rar-compressed`、`octet-stream`、`wasm`、`x-protobuf`、`protobuf`、`epub+zip`；前缀 `application/vnd.`（Office/OpenDocument 等 zip 容器）。文本豁免优先：`text/*`、`*+json`、`*+xml`、以及文本型 `application/*` 白名单（json/javascript/typescript/sql/graphql/yaml/toml/sh/php/ndjson/csv/rtf/xml）。错误形如 `Unsupported content type: image/png, 612980 bytes. webfetch only returns text; download the file with another tool.`，不附带正文。该类错误为 **terminal**：链式模式下不回落 deepseek，实现上需一个可判别的错误类别（专用错误类或 `terminal` 标志），而非看错误文案字符串。

**未知 format**：`Unknown format: X. Available: markdown, origin`，同样是 terminal 错误、不回落。

**HTML**：移除集只含"文本会泄漏但对读者无意义"的元素，不做语义清洗（不删 nav/aside/header/footer）。

**多匹配拼接**：同一选择器命中多个元素时全部转换后以 `\n\n` 连接。理由：文档索引页、博客列表、HN 这类页面常有 10~20 个 `<article>` 卡片而没有 `<main>`，只取第一个会丢掉整页其余内容。副作用是多 card 页面输出更长，但内容不丢；单匹配场景与只取第一个完全一致。

**JSON**：美化；`JSON.parse` 失败则原样，不报错。

**其余文本**：原样返回，这是修复而非新能力。

## 影响面

破坏性：`format` 从 `["text","markdown","html"]` 变为 `["markdown","origin"]`；`text` 的"HTML→纯文本"能力消失，`html` 由 `origin` 等价替代。按仓惯例属 minor，但本次不发版。

用户可见变化：① HTML 输出只含正文容器（可多容器拼接）且无 script/style/title 文本；② local 的 markdown 成功时也会出现 `Title:` 行（`origin` 不填）；③ 纯文本/源码/diff/原始 markdown 原样；④ JSON 在 markdown 下美化、origin 下原样；⑤ 二进制报错，且**配了 key 也不会消耗 deepseek 调用**；⑥ 未知 format 值报错；⑦ 原先靠水合 JSON 撑胖的空壳页会判 thin 并真正触发 deepseek 兜底（仅配了 key 时）；⑧ `origin` 永不回落，`provider: "deepseek"` + `origin` 自动走 local。

不变：provider 路由结构、deepseek 请求/计费、100k 截断、`isThinContent`/`isJunkLine` 规则、输出头部。

依赖：`@mixmark-io/domino` 由传递依赖提升为显式 dependency。

## 测试计划

包内单测（`tests/web_fetch.test.ts`、`tests/tools.test.ts`）：清洗（script/style/noscript/template/svg 不出现）；`<title>` 只进 `result.title`、缺失时为 undefined；正文定位四级回退 + 空容器继续回退 + 容器外 nav/footer 不出现 + **同选择器多匹配全部拼接**；JSON 两 format 表现；纯文本原样（`Array<string>`、`#include <vector>`）；伪装 HTML 嗅探；二进制两 format 都报错；**链式模式下二进制与未知 format 都不调用 deepseek**；`origin` HTML body 逐字节一致且不填 title；路由（origin 不回落、deepseek+origin 走 local）；schema `format` enum 只有两项。

端到端（人工验证，不进 CI）：对该 GitHub URL 断言从 61,792 → 正文量级、关键噪声词零命中、title 被抽出。

## 留给实现者的部分

顺序：本设计获批 → `supo-writing-plans` 出计划 → 按计划 TDD 实现。

实测过的三个陷阱：domino 的 `querySelectorAll` 返回的 NodeList **不可迭代**，必须 `Array.from`；正文定位必须逐个 `querySelector` 试探，逗号选择器按文档顺序返回会破坏优先级（实测 `main, [role=main]` 在 `<div role=main>` 先出现时返回 div）；`@mixmark-io/domino` 的 `lib/index.d.ts` 声明的是 `module 'domino'` 而非包名，需自备类型 shim。

以下由实现者自行决定并记录：错误信息的具体措辞、`REMOVE_SELECTORS`/`BINARY_TYPES` 的具体清单维护方式、新增导出函数是否放入 `src/` 顶层、测试用例的组织方式、terminal 错误的具体表示（专用错误类 vs 标志位）。
