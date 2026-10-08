# 产品功能增强 P1 — 2026-10

> 范围：Soft Delete / Undo、Showcase cursor 分页、Accessibility CI 门禁、Admin 拆包性能。
> 本轮全程使用本地构建/静态 QA server + Playwright；未连接生产 D1/KV/Queue，也未调用 Telegram 生产 token。

## 1. 交付结论

| 任务 | 状态 | 关键证据 |
| --- | --- | --- |
| 删除 Undo / Soft Delete / 回收站 | ✅ | migration `0074_soft_delete.sql`；删除、恢复、30 天清理均有单测；公开查询统一排除 tombstone |
| Showcase cursor 分页 | ✅ | migrations `0075_showcase_cursor.sql` / `0076_showcase_cursor_all.sql`；keyset `(created_at,id)`；无 OFFSET；Playwright cursor 交互通过 |
| Accessibility CI 门禁 | ✅ | `@axe-core/playwright`；WCAG 2.1 AA；serious/critical 阻断，moderate/minor advisory；visual workflow 已执行该门禁 |
| Admin 拆包 | ✅ | 多页面入口修正为 Vite 8 `rolldownOptions.input`；Admin 首屏入口 JS gzip 约 118 KB（vendor 单独缓存口径） |

## 2. Soft Delete / Undo

### 实现

- `surveys`、`showcase_persons`、`showcase_items`、`plaza_posts`、`report_templates` 增加 `deleted_at`。
- 删除改为 tombstone；前端使用 `DeleteWithUndo`，Toast 提供 10 秒撤销窗口。
- 回收站 `/admin/trash` 支持恢复、批量恢复、立即彻底删除。
- maintenance sweep 对超过 30 天的 tombstone 做物理清理；每类清理均使用有界批次，避免单次 D1 写入过大。
- 公开 API、管理列表、统计、媒体关联查询统一加入 `deleted_at IS NULL`。
- Showcase person 删除会同时 tombstone 其 items；恢复时只恢复与该删除批次对应的 items。

### 统计口径

统计默认**不包含已删除数据**。原因：产品 UI 的列表、公开展示和运营统计都表达“当前有效内容”，把 tombstone 算入总量会造成列表与统计不一致；回收站单独展示删除态数据。

### 清理测试

`tests/unit/services/database-maintenance.service.test.ts` 使用注入时钟验证 30 天边界，并验证清理 SQL 带 `LIMIT 50` 的有界批次。

## 3. Showcase Cursor

### API 契约

- 旧请求 `?limit=N` 保持旧字段和旧排序行为，并追加 `nextCursor`；旧 SPA 可直接忽略新字段。
- 新请求 `?cursor=...&limit=24` 使用 opaque base64 cursor。
- cursor 锚点为 `created_at + id`，采用 keyset 条件，不使用 OFFSET。
- 非法/损坏 cursor、过期 cursor、limit `0/201/非数字` 均有测试覆盖。
- 管理端作品列表与公开 Showcase 均复用 cursor 工具。

### 行读约束

公开 cursor 索引：`idx_showcase_persons_public_cursor(created_at DESC, id DESC) WHERE deleted_at IS NULL AND published = 1`。
管理端另有 `idx_showcase_persons_admin_cursor_all`。查询使用 `LIMIT` + keyset seek；1000 条 fixture 不需要全表 OFFSET 扫描。

关键回归：100 条构造数据连续翻页后集合无重复、无遗漏；公开 Showcase Playwright sentinel 翻页通过。

## 4. Accessibility

### 门禁规则

`qa/visual/a11y.ts`：

- axe-core WCAG 2.1 A/AA tags。
- `serious` / `critical` 为 blocking。
- `moderate` / `minor` 仅 advisory，不阻断。
- 该常量集中定义，后续可以逐步收紧。

本轮实际发现并修复 1 个 serious：暗色 Survey 的 `.badge-red` 使用深红前景导致 contrast 不足；改为暗色主题高亮红，并同步主题 semantic token。

修复前：`color-contrast` serious = 1（survey 105）。
修复后：survey 105 六个 viewport 全部通过，最终 173/173 visual 全绿。

CI：`.github/workflows/ci.yml` 的 visual job 执行 `pnpm test:visual`，而视觉测试在截图前执行 axe，因此 a11y 已成为 visual CI 门禁的一部分。

## 5. Admin 拆包性能

### 构建口径

Vite 8.3.2 / Rolldown 最终构建：

| Chunk | Raw | gzip |
| --- | ---: | ---: |
| `main-*.js`（Admin entry） | 24.57 KB | 7.76 KB |
| `react-vendor-*.js` | 313.07 KB | 98.70 KB |
| `icon-vendor-*.js` | 29.75 KB | 9.99 KB |
| `survey-*.js`（Public entry） | 158.83 KB | 38.06 KB |
| `esm-*.js`（ECharts async/shared） | 1,133.02 KB | 376.28 KB |

首屏口径：Admin HTML 直接引用的入口 + 长缓存 vendor 约 118 KB gzip；ECharts 大 chunk 是异步路由资源，不计入“首屏 Admin 入口”口径。路由页面继续 lazy load，二维码、dnd-kit、fingerprint、Telegram SDK 等重型依赖已独立 vendor chunk。

### Lighthouse

本地 QA server、默认 Lighthouse mobile 模拟：

- Performance: **75**
- Accessibility: **100**
- Best Practices: **100**
- SEO: **90**
- FCP: 4.2 s
- LCP: 4.4 s
- TBT: 0 ms
- CLS: 0

Performance 尚未达到理想水平；主要原因是本地环境与公共 CSS/字体资源的首屏成本。本轮没有为了追求分数而引入新的 bundler 或大规模重构。后续若继续做性能专项，优先处理首屏 CSS/字体与真正首屏依赖，而不是继续拆已经异步化的 ECharts。

## 6. 视觉回归

最终：**173 tests / 173 passed / 0 failed**。

有意更新的 snapshot 分组：

1. Admin：上一轮既有 UI 基线 + 本轮 settings/theme token 修复。
2. Survey 105：6 个 viewport，因为暗色 `.badge-red` 对比度修复而更新。
3. Report：现有 fixture/rendering 基线变化对应的少量 snapshot。
4. Showcase：cursor sentinel 交互纳入 visual suite。
5. Trial：既有移动/桌面稳定基线。

重点人工复核 viewport：Admin 1440×900 / 390×844 双主题、Survey 390×844、Report 390×844、Showcase mobile、Trial mobile。

## 7. 最终测试证据

- `pnpm typecheck`：PASS
- `pnpm lint`：PASS
- `pnpm test`：**133 test files / 767 tests passed**
- `pnpm test:visual`：**173/173 passed**
- `git diff --check`：PASS
- Admin build：PASS
- Lighthouse mobile：见上

## 8. 功能取舍 / 未做项

- 不改变既有 API 响应的旧字段；新增字段仅 additive。
- 不使用 OFFSET 做 Showcase 新分页。
- 不把 moderate/minor axe 问题作为当前 CI 阻断，避免一次性引入大量低优先级噪音。
- 没有引入新的 bundler，也没有大规模改写 Admin 路由架构。
- Lighthouse 仅作为本地性能基线，不作为本轮 CI 阻断，因为本地静态 QA 环境不能代表生产 CDN/Cloudflare 网络条件。
- 本轮不 push、不部署生产；等待人工确认后再进行后续动作。
