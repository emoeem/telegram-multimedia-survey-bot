# 工作报告 · 2026-10-31（归档图片修复 + 盖章强化 + 项目巡检 + changtu 规划）

| 项       | 值                                                                                          |
| -------- | ------------------------------------------------------------------------------------------- |
| 报告日期 | 2026-10-31                                                                                  |
| 项目     | telegram-multimedia-survey-bot                                                              |
| 生产版本 | 未部署（本轮 commit 不 push，待验收：`939b6af`→`9242f91`→`53c6201`）                        |
| 验证基线 | 双端 tsc ✓ · **220 文件 / 1596 用例全绿** · build:admin ✓ · lint/format ✓ · cert 视觉 7/7 ✓ |
| 截图存档 | `_review/stamp/`（盖章 5 步走查）· `_review/inspect-baseline.txt`（巡检基线）               |

---

## 一、任务1：归档频道图片灰块（根因 → 修复 → 验证）

### 1.1 三问三答（先复现后动手）

**a. 「未上传原图」是哪一步断了？**
哪一步都没断——`cert-share.ts:275` 的 `sources.length === 0` 分支：前端 FormData
里没有 `source0..N` 字段。触发条件是用户会话内没往卡上放照片（照片只存内存 +
objectURL，刷新即清空；截图里连续多条都是同一时段测试消息）。前端取图
`pickedPhotoBlobs` 已完整实现，无 TODO。**属设计分支，不是丢图**。已补一条
诊断日志（原图取回失败不再静默，巡检项）。

**b. 归档消息的图片源是什么？**
multipart **原始字节直传**（`sendPhoto`/`sendMediaGroup` 的 `attach://`），既不是
R2 直链也不是 TG file_id——不存在 URL 过期/跨 bot 失效问题。唯一旁路
`imagedelivery.net` 直链只随 HTTP 响应返回，不进 TG。

**c. 灰块是懒加载、404 还是没有 src？**
都不是——**TG 收下了字节（caption 完整 = 200）但解不出图**。根因（证据链）：
cert 前端导出 **WebP**（`PUBLISH_MIME="image/webp"`，quality 0.92）→
`readImage` magic-byte 放行 WebP → `telegram.ts` 二进制分支**硬编码
`type:"image/png"` + `.png` 文件名**。TG 按 multipart 声明选解码管线，
声明 PNG 的 WebP 字节 = 灰色占位。本链路测试盲区（0 覆盖）恰好在这。

### 1.2 修复（commit `939b6af`）

- `sendPhoto`/`sendPhotoAlbum` 新增 `BinaryPhoto { bytes, type? }`（缺省
  image/png 兼容报告页 PNG 调用方），文件名扩展名跟随 mime；
- `cert-share.ts` 全链路透传 `readImage` 检出的真实 mime（单张 + 相册三处）；
- 补两类单测：cert-share 断言 WebP 成品 → sender 收到 `image/webp`（相册
  三张全查 + 单张路径）；telegram 断言二进制分支的 Content-Type/文件名。

### 1.3 验证状态

单测/类型/构建全绿；**真实频道发图验证未执行**——本地 `.dev.vars` 的
BOT_TOKEN 是占位值（401），生产 token 在 Cloudflare secrets 里本地拿不到，
也没有现成测试频道。遗留验证步骤（部署后 5 分钟）：生产发一张带 WebP
成品的卡 → 灰块应变为正常图。若 TG 对 WebP photo 显示仍差（个别客户端），
备选方案见待确认决策 2。

## 二、任务2：盖章强化（commit `9242f91`）

### 2.1 配置（localStorage `cert-card-maker:stamp-cfg`，重开页面复用）

- **印章文字** ≤8 字（与既有 overlay 上限一致）；建议值 = 月日+「认证」，
  占位符写明可自定义（如「认证通过」）；
- **位置** 五预设：左上/右上/左下/右下/居中（`R.stampAnchor` 统一几何）；
- **透明度** 20–100%（默认 85%；旧 `seal()` 硬编码 0.5 → 新增 alpha 参数）；
- 「确认盖章」存配置 + 立即重绘 + 播放既有盖章反馈（动画/音效/震动）；
  「不用了」一键关闭。

### 2.2 烧录（canvas 合成，理由）

**选 canvas 前端合成**：0 依赖、0 包体、0 延迟、预览即所得；worker sharp
需要 @sharp/wasm 数 MB bundle + 上传往返，仅换一个本地 canvas 就能完成的事，
不值。烧录实现：配置启用时 `render()` 直接把章画进主 canvas——**预览与导出
是同一份像素（零偏差）**；「原图保留可重新盖章」由全量重绘天然保证（改配置
即重盖，版式+表单源数据可重放）。动效音效保留在确认瞬间。

### 2.3 验证（`_review/stamp/`，走查 5/5 PASS，无页面错误）

弹层打开 ✓ 配置存取（确认前 enabled=false / 确认后 true）✓ 卡面带章截图
（右上金色弧形章清晰）✓ 带章/无章像素差异 ✓ 刷新后配置复用 ✓。
附单测：五预设锚点都在卡面内、四角半径一致、未知位置回退右上。

## 三、任务3：项目巡检

**基线**：220 文件 / 1596 用例全绿（本轮新增 5 个用例后仍全绿，无存量红）。
视觉门禁抽测 cert-editor + scene-editor 7/7。

**必修项（已修，commit `53c6201`）**：

1. `cert/app.js` 注释漂移：声称的 `image-publish-parity.test.ts` 实为
   `image-publish.test.ts`（parity 护栏其实一直在，读 cert/app.js 源码断言常量
   同步）——修正指向；
2. `pickedPhotoBlobs` 静默吞错 → 补 `console.warn`（原图取回失败不再无声，
   与任务1 的「未上传原图」排查直接相关）。

**上轮遗留决策复查**：

| 决策                     | 状态                                     |
| ------------------------ | ---------------------------------------- |
| display:"classic" 逃生门 | 未实现，保持待确认（需求未再出现）       |
| `?ui=legacy` 旧壳删除    | 按计划下周期（本轮不动）                 |
| CI 视觉基线重建          | 已在上一轮完成（Visual baseline 工作流） |

**记录不修**：changtu 仓库残留 tmp/、单初始提交（见任务4 文档）；TG 对
WebP photo 的客户端兼容差异（待部署后真实验证再定）。

## 四、任务4：changtu 规划（`docs/changtu-usage-analysis.md`）

**一句话**：MIT 许可、零框架依赖、带 1768 行测试的中文竖版长图排版引擎
（文本 → PNG/WebP，自动分页，14 主题）。

**结论（明确选 c：组合）**：

- **集成**：`src/lib` 排版引擎（layout/draw/theme/background/parse +
  render-browser，浏览器路径零 npm 依赖，dist 主 JS 62.7KB）拷入 admin，
  加薄 React 包装 → 独立「文章长图」工具；导出复用 `/api/cert/share`
  通道（已支持 WebP + 多图 album，无需新后端）；长图导出可复用任务2
  盖章链路；
- **不搬**：`src/web` Web UI（与 admin 表单体系重复且单文件臃肿）、
  `src/cli` + Node 渲染（@napi-rs/canvas 会炸 Worker bundle）；
- **cert 保持独立**：「卡片」与「长文」互补不互替，cert 是离线单文件静态页，
  合并互相拖累；
- **许可证**：MIT，仅需保留版权声明，无法律风险。

实现与否见待确认决策 3（本工作流未实现，符合任务书「不强制」）。

## 五、待确认决策

1. **归档图片真实验证未闭环**：无生产 token/测试频道。部署后请发一张带
   WebP 成品的卡确认灰块消失；若个别客户端对 WebP photo 显示仍差，
   备选 = cert 前端导出切 PNG（体积↑上传慢，需用户取舍）。
2. **「未上传原图」文案**：保留（它是真实分支且语义准确），还是改成引导
   文案（如「未带原图 · 卡面图仍正常显示」）？倾向后者，未动。
3. **changtu 集成实现**：分析已给出接入点草图（`/tools/longform` +
   shareToChannel 复用 + 盖章链路通用化），工作量估 1-2 天，是否排期待定。
4. **盖章位置交互**：本轮是五预设（无自由拖拽）——任务书允许「角标预设或
   自由拖拽」二选一，预设实现简单且够用；若要拖拽再加（需 DOM overlay
   - 坐标回写，约半天）。
5. **TG sendPhoto 的 WebP 支持**：官方文档声明支持，但真实频道表现待
   验证（同决策 1）。

## 六、回滚说明

| 范围            | 操作                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务1 mime 修复 | `git revert 939b6af`——单 commit 自包含（telegram.ts + cert-share.ts + 两测试）；回滚后回到「WebP 声明 PNG」的旧行为                                                         |
| 任务2 盖章强化  | `git revert 9242f91`（render.js + app.js + index.html + styles.css + cert.html + 单测）；用户配置键 `cert-card-maker:stamp-cfg` 可留在用户 localStorage（无代码读取即无效） |
| 任务3 巡检      | `git revert 53c6201`（注释 + 日志，无行为影响）                                                                                                                             |
| 验证            | 回滚后 `pnpm typecheck && (cd admin && pnpm typecheck) && pnpm test && pnpm build:admin`                                                                                    |
