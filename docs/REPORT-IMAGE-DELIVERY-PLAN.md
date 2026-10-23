# 公开报告投递改造：把 PDF 改成手机友好的多张图片

> 交付性质：**方案文档**，不含实现。给下一位实现者看的施工图。
> 调研时间：2026-10-22 · 仓库：`telegram-bot` · 生产 Worker：`v3-prod`

---

## 0. 结论先行

**可行性：可行，而且比你预想的简单——代码里已经有 70% 了。**

三句话：

1. **不需要新做一个机器人。** 现成的「公开报告投递」链路已经能发 PNG 相册，只是它经常失败，失败后降级发 PDF——你看到的那张 PDF 就是这个降级产物。
2. **不建议从 PDF 反推图片。** PDF 是 A4（210×297mm）版式，切成手机比例必然切断行。正确做法是**跳过 PDF 直接出图**：同一份数据用「固定画布分页 HTML」渲染，一页就是一图。这套东西仓库里已经写好了（`response-report/*`）。
3. **真正要修的是稳定性。** 生产数据：`published` 8 条 / `failed` 30 条，最近一次发布在 2026-10-22，四次里失败三次。根因是**公开相册为了渲染又开了一个浏览器会话**，撞上 Cloudflare Browser Rendering 的额度墙。

推荐路线（下文 §4 详述）：

| 阶段 | 做什么 | 改动量 | 解决什么 |
| --- | --- | --- | --- |
| **P0** | 归档渲染那次会话**顺带**产出 PNG 页，公开投递直接读 KV | 中（~250 行） | 30 次失败的根因；不再有 PDF 降级 |
| **P1** | 控制中心加「投递形态」设置（图集 / PDF / 两者） | 小（~80 行） | 让你能按群配置 |
| **P2** | 版式从 900×1200 重排到 1080×1920 | 大（需改 CSS + 高度估算） | 真正的「手机满屏」体验 |
| **P3** | 历史 PDF 批量转图（离线脚本，`pdftoppm`） | 小（~120 行） | 已归档的旧报告 |

下面逐条给证据。

---

## 1. 现状实测（不是推测）

### 1.1 仓库里其实有两套报告模板

这是理解整件事的关键——系统里存在两条互不相干的报告渲染路径：

| # | 模板 | 长什么样 | 用途 |
| --- | --- | --- | --- |
| A | `src/services/report/web.ts` → `renderReportPdf()` | 响应式网页，A4 纵向，靠浏览器自动分页 | **归档频道**的 ZIP 里的 `report.pdf` |
| B | `src/services/response-report/html.ts` → `renderResponseReport()` | **固定 900×1200 画布**，自己算分页，一页一个 `<section class="page">` | **公开群**的 PNG 相册 |

模板 B 就是你要的东西：它已经把内容切成一页一块了。

证据（`src/services/response-report/html.ts:103`）：

```css
.page{ width:900px; height:1200px; padding:28px 48px 30px;
       display:flex; flex-direction:column; overflow:hidden; break-after:page }
.page-content{ height:1058px; padding-top:12px; overflow:hidden }
```

`overflow:hidden` + 固定高宽 = **天然的一页一张图**，不需要切。

### 1.2 公开群现在发的是图，不是 PDF——但经常退回 PDF

`src/services/public-report.service.ts` 的主路径就是发相册：

```ts
// :325  正常路径：PNG 页 → sendPhotoAlbum（每批最多 10 张）
const { artifact } = await renderPublicReportArtifact(...);
if (artifact.format !== "png" || artifact.pages.length === 0) throw new Error("公开报告没有生成图片页面");
await sendToTarget(delivery, artifact.pages.map(p => p.bytes), textCaption);

// :379  降级路径：渲染失败 → 发归档时存下的 PDF
} catch (error) {
  if (!isTransientRenderError(error)) throw error;
  const pdf = await env.MEDIA_KV?.get(`public-report-pdf:${responseId}`, ...);
  textCaption = "📋 问卷报告（浏览器渲染额度受限，本次以 PDF 文件发布）";
  await sendDocument(env.BOT_TOKEN, ..., `report-${responseId}.pdf`, ..., "application/pdf", ...);
}
```

**你看到的「之前一个 PDF」，就是 `:379` 这条降级分支。** 它只在浏览器渲染爆掉时触发。

### 1.3 生产数据：投递链路有一半以上在失败

```
$ wrangler d1 execute DB --remote --command "SELECT report_publication_status, COUNT(*) FROM survey_responses GROUP BY 1"
failed    30
private  2085
published  8
```

近 12 条投递记录（都发往 `-1004497177255` / thread `6016`，即「天地一家大爱盟」）：

| 答卷 | 状态 | 时间 |
| --- | --- | --- |
| 3766 | failed | 2026-10-22 10:51 |
| 3757 | failed | 2026-10-22 10:29 |
| 3734 | failed | 2026-10-22 08:47 |
| 3732 | **published** | 2026-10-22 08:39 |
| 3577 | published | 2026-10-18 |
| 3566 | published | 2026-10-17 |
| 3511 | failed | 2026-10-17 |
| 3173 | published | 2026-10-12 |

**所以「改成图片」这件事，优先级低于「先让它别失败」** ——现在有四分之三的情况群里什么都没收到。

### 1.4 为什么失败：两次浏览器会话抢同一个额度

一次答卷提交会触发两个都要浏览器的任务：

```
提交答卷
  ├─ 归档投递  report-delivery-worker → renderReportPdf()      ← 会话 #1
  └─ 公开投递  public-report          → renderResponseReport(png) ← 会话 #2
                                       失败重试 2 次 → 会话 #3、#4
```

代码里为此打了三层补丁，全是同一个病：

- `public-report.service.ts:39` `waitForSiblingReportDelivery()` —— 干等最多 90 秒，等归档那次渲染结束
- `public-report.service.ts:70` `waitUntilBrowserAcquisitionAllowed()` —— 轮询 `puppeteer.limits()` 等到允许再开
- `public-report.service.ts:55-58` 重试 2 次，间隔 25s / 30s，第二次换 `probe-fullpage` 策略

三层都在缓解同一个结构性问题：**同一个账号、同一份数据，开了两次浏览器**。

---

## 2. 技术判断：为什么不要「把 PDF 裁成图片」

你的原话是「把这些 pdf 的内容裁剪成多张适合手机查看的图片」。这个思路直接，但在这套系统里是次优解，三个理由：

### 理由一：PDF 是 A4，手机不是

实测现有产物（`tests/fixtures/情景-沉沦的欲望.pdf`）：

```
Page size: 595 x 842 pts (A4)
$ pdftoppm -png -r 150 -f 1 -l 1 ...
→ PNG 1240 x 1755, 66,337 B
```

A4 比例 1:1.414。主流手机比例 1:2.16（1080×2340）。**A4 整页塞进手机，要么左右留黑边，要么上下裁掉内容，要么缩小到正文 10pt→8.5pt，字小到要捏屏幕。**

要真正适合手机，必须「按手机比例重新分页」——而这一步 PDF 里没有信息帮你做（PDF 只有绝对定位的绘制指令，不知道哪里是段落边界）。**你只能重新排版，那就等于回到出 HTML。**

### 理由二：PDF 已经被缩过一次

`renderReportPdf()` 用 `page.pdf({format:"A4", margin:0})`，而 CSS 画布是 900×1200。A4 在 96dpi 下是 794×1123px：

```
A4 宽 794 px ÷ 内容宽 900 px = 0.882  →  排版时整体缩到 88.2%
```

**PDF 里的字已经缩到 88%，再从 PDF 栅格化出来就是二次采样。** 直接截 900×1200 的图是 100%。

### 理由三：多一次 PNG 编解码，多一次失真

```
路线甲（推荐）: HTML → page.screenshot(png) → Telegram        1 次编码
路线乙（PDF）  : HTML → PDF(矢量) → pdftoppm → PNG → Telegram  2 次编码 + 1 次重采样
```

### 那什么时候该用 PDF→图？

**只有一种情况：历史资产。** 已经躺在 KV / R2 里的旧 `report-*.pdf`，原始数据可能已删、模板已改，这时用离线脚本批量转是合理的。§7 给方案，但那是**一次性迁移工具，不该跑在线上**。

---

## 3. 「适合手机查看」的具体规格

这一节是实现者最需要的硬指标。以下数值需要实测确认（标 ⚠️ 的），但方向和取舍已经定了。

### 3.1 画布尺寸

| 方案 | 画布 | 手机上占屏 | 页数变化 | 改动 |
| --- | --- | --- | --- | --- |
| 现状 | 900×1200（3:4） | 约 62% | 基准 | 无 |
| **P1 提清晰度** | 1350×1800（dpr 1.5） | 62% | 不变 | 一行 |
| **P2 真竖屏** | 1080×1920（9:16） | ~92% | 减少约 40% | 改 CSS + 高度估算 |

说明：

- `deviceScaleFactor` 现在写死 1（`response-report.service.ts:166`）⚠️ **调大会不会触发 `TargetCloseError` 必须实测**——`capturePngPages` 的注释已经写了「screenshot 一旦超出视口重栅格化就会被杀」，提高 DPR 属于同一类风险。
- 1080 宽的副作用：正文按 1080/900 = 1.2 倍重排后，每页可容纳内容约 1.7 倍 → **页数从 20+ 降到 12 左右**，直接缓解相册分批问题（见 §3.3）。

### 3.2 Telegram 的硬限制

| 限制 | 数值 | 出处 |
| --- | --- | --- |
| 相册张数 | **2–10** | `src/bot/telegram.ts:648`（自己写的校验） |
| 单张图片 | ≤ 10 MB | Telegram Bot API `sendPhoto` |
| 宽+高 | ≤ 10000 | 同上 |
| 宽高比 | ≤ 20:1 | 同上 |
| 现有页大小目标 | 单页 ≤ 5 MB 目标，10 MB 硬上限 | `response-report.service.ts:22-24` |

### 3.3 页数问题：长问卷会刷屏

`tests/unit/services/response-report.service.test.ts:228` 断言 `pages.length > 20`——**一份长问卷就是 20 多页**。

`sendPhotoAlbum` 每批最多 10 张，现有代码按 10 张分批（`public-report.service.ts:316` 的 `offset += 10`），于是：

```
20 页 → 2 个相册 → 2 组消息
30 页 → 3 个相册 → 3 组消息
```

在群里就是连着刷屏。**这是 P2 的主要收益**：重排到 1080 宽后页数降 40%，多数问卷能压进 1 个相册。

其他可选手段（择一，不要全上）：

- 长问卷自动切「精简版」（只发摘要 + 评分 + 代表性回答），完整版留在归档
- 用 `link_preview` 合并成一条卡片 + 相册
- 超过 N 页时改发 PDF + 前 3 页预览图（hybrid，兼顾可读与完整）

**需要产品决策：长问卷是「全都要看」还是「看重点」。** 这个决定影响 P2 是否值得做。

### 3.4 PNG 还是 JPEG：会被 Telegram 二次压缩

Telegram 对 `sendPhoto` 上传的图**一律转成 JPEG**（PNG 不保留）。文字密集页转 JPEG 会出现彩色噪点，小字发糊。

三个选项：

| 做法 | 清晰度 | 可滑动预览 | 备注 |
| --- | --- | --- | --- |
| `sendPhoto` + PNG 源 | 中（被转 JPEG） | ✅ | 现状 |
| `sendPhoto` + 自己先转高质量 JPEG(q92) | 中上（少一次代际损失） | ✅ | 推荐，需 `@jsquash/jpeg` 之类 WASM 或在浏览器里 `toDataURL` |
| `sendDocument` + PNG | 最高 | ❌ 要逐张点开 | 适合追求存档质量 |

**建议：主发 `sendPhoto`（保证体验），同时把 PNG 原图塞进归档 ZIP（保证质量）。** 归档那边已经在发 ZIP，加 4 个文件不增加消息数。

---

## 4. 推荐方案（P0）

### 4.1 核心思路：一次浏览器会话，两种产物

```
提交答卷
  └─ 归档投递（唯一一次浏览器会话）
       ├─ 渲染 A：report/web.ts      → report.pdf  → KV + ZIP   [不变]
       └─ 渲染 B：response-report/*  → 页 PNG 数组 → KV         [新增]
                                                      ↓
公开投递（零浏览器）
  └─ 从 KV 读 PNG 页 → sendPhotoAlbum 分批 → 完事
```

**收益：**

1. 公开投递不再需要浏览器 → 那三层补丁（干等 / 轮询额度 / 重试）全部可删
2. `report_publication_status='failed'` 的 30 条根因消失
3. 不再有 PDF 降级 —— 因为不再有「渲染失败」这个前置条件
4. 成本下降：每次提交从 2–4 次浏览器会话降到 1 次

**代价：** 归档投递的耗时增加约 20–40%（同一会话里多渲染一次分页 HTML）。归档本来就是异步的，可接受。

### 4.2 数据流与落点

```
report-delivery-worker.service.ts   ← 改这里
  ├─ 已有: renderReportPdf() → pdf.bytes
  │        env.MEDIA_KV.put(`public-report-pdf:${responseId}`, pdf.bytes, {ttl: 7d})
  └─ 新增: renderResponseReportPagePngs(browser, report)
           env.MEDIA_KV.put(`public-report-pages:${responseId}`, JSON 清单+base64, {ttl: 7d})

public-report.service.ts            ← 改这里
  └─ 删掉 renderPublicReportArtifact / waitForSiblingReportDelivery /
        waitUntilBrowserAcquisitionAllowed / 重试策略
     改为: 从 KV 读页 → 发相册
```

KV 单值上限 25 MB，所以**必须分 key 存**：

```
public-report-pages:${responseId}:manifest   → {pages:3, totalBytes:1234567, format:"png"}
public-report-pages:${responseId}:1          → PNG 字节
public-report-pages:${responseId}:2
public-report-pages:${responseId}:3
```

若总大小超阈值（建议 20 MB），manifest 里标 `oversized:true`，公开投递改发 PDF（保留现有降级，但触发条件从「渲染失败」变成「体积过大」）。

### 4.3 关键实现细节（踩坑提示）

1. **`buildResponseReportBundle` 需要 `BotContext`**（含 browser），而归档 worker 有 `env.BROWSER`。现有 `renderPublicReportArtifact` 里已经把 `env` 强转成 `BotContext`（`public-report.service.ts:306` 的 `as unknown as BotContext`）。这个 cast 要一起搬过去，别重新造。

2. **`assertNoVisualOverflow` 必须跑**（`response-report.service.ts:40`）。它检查 `.page-content` 有没有超高——分页估算（`PAGE_CONTENT_HEIGHT = 742`）和 CSS 实际高度（`1058px`）本来就不一致，靠浏览器里的 `repaginateRenderedReport()` 二次校正。跳过这步会出截断页。

3. **`repaginateRenderedReport` 会改 DOM**（挪 `.question-block`、必要时 `zoom` 缩放）。它跑完才知道真实页数，所以**必须先 repaginate 再决定截几张**。现有代码顺序是对的，别改。

4. **PNG 捕获策略**：`capturePngPages` 有两条路：
   - `set-viewport`：滚动到每页位置截图，`captureBeyondViewport:false`（默认，稳）
   - `probe-fullpage`：整页截图（快，但会触发 `TargetCloseError`）
   合并到归档会话后，**默认用 `set-viewport`**，因为不再有重试预算。

5. **`report` 对象要留给公开投递用**：caption 里的问卷名、填写者、完成时间都来自 `buildResponseReportBundle().report`。现在它是现算的，合并后要么一起存 KV（推荐，存 JSON 元数据），要么公开投递再查一次 DB。

### 4.4 幂等与重试

现状：公开投递失败会重试，重试可能重复发（代码注释已指出「部分成功时不重试，否则已经收到的群会再收一遍」）。

合并后需要：

- manifest 里记 `deliveredChatIds: string[]`
- 每次发送前检查，已发过的不再发（按 `chatId + threadId`）
- 全部发完才把 `report_publication_status` 置 `published`

---

## 5. P1：设置项怎么加

复用你系统里已有的模式（跟「报告归档频道」那张卡片一模一样）。

### 5.1 数据模型

`system_settings` 表加一行，key 用 `report_publication_format`：

| 取值 | 行为 |
| --- | --- |
| `images`（默认） | 发 PNG 相册 |
| `pdf` | 发 PDF 文件 |
| `both` | 相册 + PDF（PDF 作为一条 document 消息跟在相册后） |

实现上照抄 `report_channel_id` 那条路：
- `src/services/system-settings.service.ts` 的 `SYSTEM_SETTING_KEYS` + `SYSTEM_SETTING_DEFAULTS`
- `src/http/control-api.ts` 的 GET/PUT 端点（参考本仓库已有的 `cert-share` 端点写法）
- `admin/src/routes/ControlCenterPage.tsx` 的卡片

### 5.2 建议同时暴露的开关

| 设置 | 作用 | 默认 |
| --- | --- | --- |
| `report_publication_format` | images / pdf / both | images |
| `report_image_max_pages` | 超过 N 页切精简版 | 12 |
| `report_image_scale` | 900×1200 / 1350×1800 | 1350×1800（见 §3.1 风险） |

---

## 6. 「做一个机器人」这件事

**不需要新机器人。** 理由：

1. 现有 Worker 已经有 BOT_TOKEN、有 Browser Rendering 绑定、有 KV、有 D1、有发布目标表、有控制中心 UI
2. 新 bot 要重新解决：BOT_TOKEN 管理、群管理员权限、额度、部署、计费、客户分发
3. 你要的「裁剪 + 发图」是这条流水线的**末端环节**，不是独立服务

**唯一值得独立出来的**：如果你想把「PDF → 手机图」当成一个**给别人用的工具**（比如客户自己上传 PDF），那可以做成一个单独的小 Worker（无 D1、无 bot、纯 HTTP：上传 → 转换 → 返回 ZIP）。见 §7.2。

---

## 7. P3：历史 PDF 批量转图

### 7.1 在线（不推荐，仅作兜底）

Cloudflare Workers 里做 PDF 栅格化的技术选型：

| 方案 | 可行性 | 结论 |
| --- | --- | --- |
| `pdfjs-dist` + Canvas | ❌ Workers 无 DOM/Canvas/OffscreenCanvas | 不可行 |
| `mupdf-js`（WASM） | ✅ 能跑 | ❌ **AGPL**，商用需买授权 |
| **`@hyzyla/pdfium`（WASM）** | ✅ 纯软件光栅化，不依赖 Canvas | ✅ **PDFium 是 BSD-3**，可行 |
| `@resvg/resvg-wasm` | ✅ 仓库已在用（`result-visual-wasm.ts`） | 只吃 SVG，不吃 PDF |

结论：如果非要在 Worker 里转，用 PDFium WASM。但**内存与 CPU 都是瓶颈**（128 MB / 请求），一份 20 页 A4 @150dpi ≈ 20 × 1240×1755×4B ≈ 174 MB，**必然 OOM**。必须逐页流式处理 + 降 DPI。

### 7.2 离线脚本（推荐）

本机已有工具链，零成本：

```
$ which pdftoppm qpdf
/usr/bin/pdftoppm
/usr/bin/qpdf
```

建议脚本 `scripts/pdf-to-phone-images.mjs`（或 .py，仓库两个语言都有先例）：

```bash
# 1) 按条带切：A4 高 842pt，切成 2 条 421pt，比例变成 1:0.707 → 每条 1240×878
#    这样每屏显示内容少、字更大，比整页缩到手机上好读
pdftoppm -png -r 150 -x 0 -y 0   -W 1240 -H 878  input.pdf page
pdftoppm -png -r 150 -x 0 -y 878 -W 1240 -H 878  input.pdf page

# 2) 切缝避让：pdftoppm 是硬切，会切到行。
#    更好的做法：先用 pdftotext -bbox 拿到每行的 y 坐标，找最近的空白行当切点
pdftotext -bbox input.pdf - | grep -o 'yMin="[0-9.]*"'
```

**关键提醒：硬切一定会切断行。** 要用 `pdftotext -bbox` 找行间空白作为切点，这是这类脚本唯一的技术难点。如果只是偶尔转几份，也可以人工在 PDF 阅读器里看切点。

更省事的替代：如果这些历史 PDF 对应的答卷数据还在 DB 里（`survey_responses` 有 2085 条），**直接用数据重新渲染比转 PDF 好**——`renderResponseReport(format:"png")` 本地跑一遍 playwright 就行，不需要 Workers。

---

## 8. 测试与验收

### 8.1 必须有的测试

| 测试 | 断言 |
| --- | --- |
| `public-report-kv.test.ts` | 从 KV 读页 → 发相册，不碰浏览器（mock 里 `puppeteer.launch` 被调用即失败） |
| `page-batching.test.ts` | 23 页 → 3 次 `sendMediaGroup`，批次为 10/10/3 |
| `album-limits.test.ts` | 单批 >10 张时报错；1 张时走 `sendPhoto` 而非 `sendMediaGroup` |
| `oversized-fallback.test.ts` | manifest 标 oversized → 发 PDF，不发相册 |
| `idempotency.test.ts` | 同一 `responseId` 重投 → 已发过的 chat 不重复发 |
| `regression` | 现有 `tests/unit/services/public-report-targets.test.ts` 全绿 |

### 8.2 验收（对着生产机跑）

```bash
# 1) 造一条答卷，勾「愿意公开」
# 2) 观察 D1
wrangler d1 execute DB --remote --command \
  "SELECT id,report_publication_status FROM survey_responses ORDER BY id DESC LIMIT 3"
#    期望: published，且 report_published_at 非空

# 3) 观察群里
#    期望: 一条相册（或按页数分批），无 PDF 文件，caption 含问卷名/填写者/完成时间

# 4) 反例：把 report_publication_format 设成 pdf
#    期望: 收到 PDF，且状态 published
```

### 8.3 回归风险清单

| 风险 | 缓解 |
| --- | --- |
| 归档投递变慢 → 队列堆积 | 监控 `report_deliveries` 的 `status='pending'` 数量 |
| KV 写入放大（每次提交多 5–20 个 key） | 7 天 TTL；KV 免费额度 1000 写/天（付费 1M），按当前提交量够 |
| `TargetCloseError` 仍可能发生 | 保留「归档投递失败则公开投递也标记 failed」的联动，不再单独重试 |
| 提高 DPR 触发截图失败 | 灰度：先只对 `survey_id` 白名单开启 |

---

## 9. 工作量估算

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| P0 | 合并渲染、KV 存页、公开投递瘦身、测试 | **1.5–2 天** |
| P1 | 设置项（service + API + 控制中心卡片 + 测试） | **0.5 天** |
| P2 | 版式重排 1080×1920（CSS + 高度估算 + 分页测试全改） | **2–3 天**（含调版） |
| P3 | 历史 PDF 离线转换脚本 | **0.5 天** |
| 合计 | | **4.5–6 天** |

**建议先只做 P0+P1**：解决 30 次失败 + 拿到设置能力，1 天半到 2 天半。P2 等你确认「长问卷要全看还是看重点」再动。

---

## 10. 明确不做的事

- ❌ 不在 Worker 里跑 PDF 栅格化（内存必爆，见 §7.1）
- ❌ 不用 MuPDF（AGPL）
- ❌ 不新建独立 bot（除非 §6 那种「给别人用的工具」）
- ❌ 不改归档 ZIP 的结构（`public-report-pdf:` 这个 key 继续保留，供 P1 的 `pdf` 模式用）
- ❌ 不动 `response-report/*` 的分页算法（P0 阶段）。它虽然估算和实际不一致，但有 `repaginateRenderedReport` 兜底，动了会连带视觉基线 173 张全重拍

---

## 11. 给实现者的第一小时

按这个顺序读代码，比从头看快得多：

1. `src/services/public-report.service.ts` —— 完整读一遍（400 行，是这次改造的主战场）
2. `src/services/response-report.service.ts:150-215` —— `renderPngReport` + `renderResponseReport`，理解 900×1200 和 `capturePngPages`
3. `src/services/report-delivery-worker.service.ts:200-330` —— 归档投递，理解 PDF 从哪来、KV 怎么写
4. `src/bot/telegram.ts:590-675` —— `sendPhoto` / `sendPhotoAlbum`，注意 2–10 张的校验
5. `src/services/report/web.ts` vs `src/services/response-report/html.ts` —— **对比这两套 CSS**，这是整件事的核心认知

然后跑一遍现有测试建立基线：

```bash
pnpm typecheck && pnpm test        # 基线：164 文件 / 1116 用例
```

---

## 附录 A：本次调研的实测数据

```
# 生产投递状态
failed 30 / private 2085 / published 8

# 发布目标
id=2  「天地一家大爱盟」 chat -1004497177255  thread 6016  enabled  is_default
id=1  「E2E 测试发布目标（归档频道）」 chat -1004489719605  disabled

# 样例 PDF 栅格化
Pages: 3 · Page size: 595 x 842 pts (A4) · 16,279 B
pdftoppm -png -r 150 → 1240 x 1755, 66,337 B / 页

# 现有分页画布
.page 900×1200 · .page-content 1058px · 估算常量 PAGE_CONTENT_HEIGHT=742
长问卷实测 >20 页（tests/unit/services/response-report.service.test.ts:228）
```

## 附录 B：相关文件索引

| 文件 | 作用 |
| --- | --- |
| `src/services/public-report.service.ts` | 公开投递（改造主战场） |
| `src/services/report-delivery-worker.service.ts` | 归档投递（PDF 来源） |
| `src/services/response-report.service.ts` | PNG 分页渲染 |
| `src/services/response-report/html.ts` | 900×1200 分页模板 |
| `src/services/response-report/pagination.ts` | 分页估算 |
| `src/services/report/web.ts` / `report/pdf.ts` | A4 响应式模板 + PDF 输出 |
| `src/bot/telegram.ts` | `sendPhoto` / `sendPhotoAlbum` / `sendDocument` |
| `src/db/repositories/publication-target.repository.ts` | 发布目标表 |
| `tests/unit/services/public-report-targets.test.ts` | 现有测试 |
