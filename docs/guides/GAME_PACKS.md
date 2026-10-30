# 小游戏扩展包（quest pack）

> 2026-10-29 落地。数据驱动的小游戏：**导入一个 ZIP = 生成一个新的剧情小游戏，全程不改代码**。
> 格式规范（含护栏与打包命令）的唯一权威文档：仓库根 [`packs/README.md`](../../packs/README.md)；
> 面向创作者的逐步教程（模版/字段速查/报错对照）：[`packs/AUTHORING.md`](../../packs/AUTHORING.md)；
> 手写示例包：[`packs/quest-example-lost-study/`](../../packs/quest-example-lost-study/)。

## 一句话架构

扩展包 ZIP（manifest.json + quest.json + assets/）→ 管理端「任务包 → 导入扩展包」
（`POST /api/admin/task-packs/import`，`src/http/admin/pack-import.ts`）→ 图片入素材库
（内容寻址去重）→ 生成 `game_type="quest"` 的任务包（内容进 `settings_json.content`）。
运行时走通用插件管线（`src/game-plugin/plugins/quest/`，服务端权威计分，配置永不下发）。

## 关键文件

| 文件                                             | 职责                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `packs/README.md`                                | **格式规范**（manifest / quest.json 字段、护栏、导入、打包命令）  |
| `src/game-plugin/plugins/quest/content.ts`       | quest.json 解析与校验（导入器与引擎共用一把尺子）                 |
| `src/game-plugin/plugins/quest/engine.ts`        | 服务端引擎：分支/道具/评分/幂等，视图不下发跳转表                 |
| `src/http/admin/pack-import.ts`                  | ZIP 解压、校验、资产入库、建包、审计（纯解析函数可单测）          |
| `admin/src/game-plugins/plugins/quest/index.tsx` | 答题端视图：galgame 对话框 + 选项 + 道具栏                        |
| `src/http/survey/media.ts`                       | 媒体公开性第 6 路挂载：启用中的 task_packs settings_json URL 引用 |

## 设计约束（改代码前必读）

1. **数据即游戏**：新剧情 = 新数据行。改内容 = 重新导入；不要手改 `settings_json.content`（无结构校验，坏包按「放弃」结算）。
2. **服务端权威**：跳转表 / requireItem / 分值只存在于服务端；`view.payload` 只发当前节点 + 可见选项 + 已获道具。
3. **首次经过结算**：同一选择重复经过不计分、不重复发道具（剧情回路刷不了分）。
4. **同 id 重复导入 = 新建新包**（不覆盖旧包），删除旧包走任务包管理；审计 `task_pack.import`。
5. 媒体公开性：扩展包插画按「启用中的包引用」放行，停用包的插画随之不可读（边缘缓存最长滞后一天，与 survey-scope 取舍一致）。

## 测试

- `tests/unit/game-plugin/quest.test.ts`：内容校验矩阵、引擎（门控/加分/幂等/不泄露/评级）、ZIP 解析（缺文件/坏版本/悬空引用）。
- `tests/unit/http/survey-media-visibility.test.ts`：第 6 路挂载的真 SQL 用例（启用公开 / 停用拒绝）。
