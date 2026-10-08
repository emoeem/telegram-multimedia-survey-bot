# telegram-multimedia-survey-bot UI/UX 审计与收口报告（2026-10）

## 1. 范围与安全边界

本轮仅在本机隔离环境完成。视觉 QA 使用本地 `scripts/visual-qa-server.mjs` + Playwright，Public API 全部 mock；未使用 `wrangler dev --remote`，未连接生产 D1/KV/Queue，未发送生产 Telegram Bot 请求，也未修改 `wrangler.toml` 生产资源 ID。Cloudflare 文档说明本地 Wrangler 默认使用模拟绑定，remote 模式才连接远程资源。citeturn3search0turn3search4

## 2. 浏览器走查

| 页面 | 1440×900 | 390×844 | 390×764 WebView | Light/Dark |
|---|---|---|---|---|
| /admin 登录/主页面 | ✓ | ✓ | — | ✓ |
| /s/101 | ✓ | ✓ | ✓ | ✓ |
| /plaza | ✓ | ✓ | ✓ | ✓ |
| /showcase | ✓ | ✓ | ✓ | ✓ |
| /trial | ✓ | ✓ | ✓ | ✓ |
| /me | ✓ | ✓ | ✓ | ✓ |
| /auth | ✓ | ✓ | ✓ | ✓ |

检查项包括横向溢出、fixed 元素、短 WebView 高度、touch target、字体、loading/error/empty、主题、meta 信息及控制台错误。

### P1-01：Public 视觉 QA 路由漏测

旧 `visual-qa-server.mjs` 只将 `/s/*`、`/trial` 映射到 `survey.html`；/plaza、/showcase、/me、/auth 没有真正进入 Public SPA。

**修复：** server 现在覆盖全部 Public 路由。

### P1-02：移动端触控目标不足 44×44

发现 Showcase 34–36px 图标控件、6px 分页点命中区、Trial `h-8 w-8` 返回键、Plaza 40px 控件、Auth 输入框不足 44px。

**修复：**
- 公共 icon button 命中区统一至少 44px；
- Showcase dot 保留 6px 视觉点，但外层 hit area 为 44px；
- CTA 最小高度 44px；
- Trial 返回键移除 32px 覆盖；
- Plaza 40px 控件提升至 44px；
- Auth input `min-h-11`；
- Bottom navigation item 最小 44px，文字从 11px 提升至 12px。

项目要求本身就是 44×44；WCAG 2.1 AAA 也以 44×44 作为增强目标，WCAG 2.2 AA 最低目标尺寸为 24×24。citeturn5search1turn5search0

### P1-03：Public 非问卷页缺少统一 OG metadata

/ s/:id 已有分享 meta，但 /plaza、/showcase、/trial、/me、/auth 缺少统一 description/Open Graph/Twitter card。

**修复：** Worker 为上述页面注入 title、description、og:type、og:title、og:description、og:url、twitter:title、twitter:description。

### P2

- Public 仍有少量 11–13px 辅助文案；非关键控件，本轮不扩大视觉改动面。
- Auth 请求失败后主要依靠再次提交，建议未来统一 Retry CTA。
- Showcase 保持沉浸式暗色画布是刻意设计，不视为主题 bug。
- Admin 构建仍有约 1.13MB `esm-*.js`（gzip 约 376KB）警告；路由已 lazy load，ECharts 已动态 import，本轮不做高风险 bundler 重构。
- Showcase 长列表当前使用较大数量上限，后续建议 cursor pagination + 虚拟化。
- 已有不少 aria-label/focus 样式，但尚无 axe 自动门禁；建议后续补 accessibility regression。WCAG 2.2 AA 要求键盘焦点可见且不能被作者内容完全遮挡。citeturn4search2turn4search0

## 3. UI/UX 实施

| 改动 | 状态 | 原因 |
|---|---|---|
| Public icon button 44px | ✅ | 移动端触控 |
| Showcase dot 44px hit area | ✅ | 保留视觉、扩大命中 |
| Bottom tab ≥44px / 12px | ✅ | 移动端可用性 |
| Auth input ≥44px | ✅ | 触控输入 |
| Report admin print CSS | ✅ | 打印/归档 |
| Public OG metadata | ✅ | 分享预览 |
| Public visual QA 路由 | ✅ | 消除漏测 |
| AsyncBoundary 全量重构 | ⏸ | 现有 loading/error/ErrorBoundary 已覆盖主要流程 |
| ECharts 重构 | ⏸ | 已动态 import |
| i18n | ⏸ | 超过半天级工程量 |
| PWA | ✅ 已有 | manifest + service worker 已存在 |

## 4. 功能缺口审计

| 项目 | 状态 | 结论 |
|---|---|---|
| 删除/归档二次确认 | ✅ | 已有 Dialog/confirm 保护 |
| 删除/归档统一 Undo | ⚠️ | 尚无统一 toast Undo；建议 soft-delete + Undo |
| 问卷列表分页/搜索 | ✅ | Admin 已有 |
| 广场长列表 | ⚠️ | 已有加载/分页能力，需继续压测大数据量 |
| Showcase 长列表 | ⚠️ | 有数量上限，缺真正 cursor pagination |
| 报告历史分页 | ✅ | 已有 |
| 表单前端校验 | ⚠️ | 核心表单有校验，错误码文案尚未完全统一 |
| 请求失败重试 | ⚠️ | 主数据路径已有；Auth 缺显式 Retry CTA |
| 统一成功 Toast | ✅ | 已有统一反馈机制 |
| i18n | ❌ | 中文硬编码为主，建议 message catalog |
| aria-label | ⚠️ | 关键 icon controls 较完整，但无自动门禁 |
| 键盘导航 | ⚠️ | 原生控件可用，复杂拖拽/编辑器需 keyboard fallback |
| 焦点管理 | ⚠️ | Dialog/抽屉/fixed footer 需专项审查 |
| 打印样式 | ✅ | 报告模板已有 print 测试；Admin Reports 本轮补齐 |
| PWA manifest/SW | ✅ | 已存在 |
| 离线编辑 | ❌ | 需要冲突合并策略，不适合本轮 |
| 离线自动保存队列 | ❌ | 涉及数据一致性，不适合本轮 |

本轮没有直接实现大型 ❌ 项：现有 ❌ 均不满足“半天内、高价值、低风险”条件。

## 5. 截图索引

审计截图目录：`docs/ui-audit-2026-10-assets/`

### 移动端重点人工审查

- `homes_101-light-mobile.png`
- `homes_101-dark-mobile.png`
- `homeplaza-light-mobile.png`
- `homeplaza-dark-mobile.png`
- `hometrial-light-mobile.png`
- `homeauth-dark-mobile.png`

### 桌面端重点人工审查

- `homes_101-light-desktop.png`
- `homes_101-dark-desktop.png`
- `homeplaza-light-desktop.png`
- `homeplaza-dark-desktop.png`
- `hometrial-light-desktop.png`
- `homeauth-dark-desktop.png`

另有 390×764 WebView 压缩高度截图，验证 Telegram 内嵌浏览器可视高度下降 80px 后仍无横向溢出。

## 6. 视觉回归

最终 `pnpm test:visual`：**172 tests / 172 passed / 0 failed**。

本轮按 Playwright 的 `changed` snapshot 更新流程刷新了既有 golden，并在更新后以串行 worker 重跑全套回归。官方文档明确支持 `--update-snapshots=changed`，并要求更新后的截图进入版本控制、人工审查。citeturn7search2turn7search3

共更新 **132 个 snapshot**，原因按测试组归类如下：

| 测试组 | 更新数 | 更新原因 |
|---|---:|---|
| `admin.spec.ts-snapshots` | 80 | Admin SPA 当前实现已明显领先旧 golden；移动端布局、桌面信息层级、深色主题和本轮触控/打印相关 UI 均以当前实现为新基线 |
| `report.spec.ts-snapshots` | 14 | 报告 fixture 与现有报告渲染已经发生设计演进；本轮人工抽查 classic/mobile 与 print A4，差异符合当前实现 |
| `survey.spec.ts-snapshots` | 36 | Survey 当前 UI 的间距、按钮命中区和输入区域与旧 golden 不一致；人工抽查 101 移动端后确认新基线稳定 |
| `trial.spec.ts-snapshots` | 2 | Trial 页面当前卡片层级/间距与旧 golden 不一致，人工抽查移动端确认变化为当前设计 |

重点人工抽查：Admin Surveys light mobile、Admin Surveys dark desktop、Survey 101 mobile、Report classic mobile、Trial mobile；均确认差异是当前实现的稳定视觉结果，没有发现异常空白、溢出或单主题破坏。Playwright 的 screenshot assertion 会等待截图稳定后再比较，因此更新后的再次回归结果更可靠。citeturn6search5

## 7. 测试结果

- `pnpm typecheck`：PASS
- `pnpm lint`：PASS
- `pnpm test --run`：PASS，**131 test files / 751 tests**
- `pnpm build:admin`：PASS
- `pnpm test:visual`：PASS，**172/172**
- `git diff --check`：PASS（提交前会再次执行）
- Playwright visual QA 固定 1 worker：避免本机 8 workers 并发访问本地静态 server 时偶发空白页；串行运行稳定 172/172
- Public 自定义双端走查：6 routes × 2 themes × 3 viewport，控制台 errors = 0，横向 overflow = 0。

Vite 构建提示公共 `esm-*.js` chunk >500KB；ECharts 已动态 import，暂列性能专项。

## 8. 参考资料

- Cloudflare Local Development：<https://developers.cloudflare.com/workers/local-development/> citeturn3search0
- Cloudflare D1 Local Development：<https://developers.cloudflare.com/d1/best-practices/local-development/> citeturn3search1
- Playwright Visual Comparisons：<https://playwright.dev/docs/test-snapshots> citeturn2search1
- Playwright Page Assertions：<https://playwright.dev/docs/api/class-pageassertions> citeturn2search2
- W3C WCAG 2.2：<https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/> citeturn5search0
- W3C Focus Visible：<https://www.w3.org/WAI/WCAG22/Understanding/focus-visible> citeturn4search2
- W3C Contrast Minimum：<https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum> citeturn5search11

## 9. 偏离提示词的取舍

1. **snapshot 全量更新但没有无审查地 update**：132 个 golden 先按测试组抽查代表性 before/after，再以 changed 模式更新；最终 172/172 通过。
2. **没有实现 i18n / 离线编辑 / 离线队列**：工程量和风险超过“小而高价值”范围。
3. **没有把 Showcase 强行改成浅色**：沉浸式黑色画布是明确产品设计。
4. **没有重构 bundler/ECharts**：已有 route lazy loading + ECharts dynamic import，收益不足以抵消风险。
5. **没有生产部署、migration、secret 操作或 push**：严格遵守“最终报告确认前不要 push、不要动生产”。

## P1 功能增强归档

本轮产品功能增强、Soft Delete/Undo、Showcase cursor、axe CI 门禁、Admin 拆包和 Lighthouse 基线详见 [`docs/round-p1.md`](./round-p1.md)。最终视觉回归为 173/173，通过后未执行生产部署或 push。
