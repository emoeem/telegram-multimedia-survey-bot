# D3 写侧 `{assetId}` staging 实测 runbook

> 对应 `docs/UPGRADE_ROADMAP_2026-10-28.md` 阶段 D 第 3 步。
> **红线：push main = 生产 deploy（deploy.yml 等 ci 绿后自动发布）。写侧代码只存在于
> `feat/media-assetid-write` 分支，全部验证清单通过并另行确认后才合入 main。**

## 0. 改造内容速览（本分支）

| 写入点                                       | 旧行为                                                                    | 新行为                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 场景编辑器·从库选图（`SceneEditorPage.tsx`） | 只把 URL 字符串写进 `settings.scene`，**不挂 question_media**（既有缺口） | 存 `{assetId}` + 调 attach API 补登记 `question_media`（补上禁令 3 的缺口）                                                                           |
| 场景编辑器·上传                              | multipart → 端点挂表，URL 写进配置                                        | 同前挂表，配置改存 `{assetId}`                                                                                                                        |
| BGM 上传（`SurveyDetailPage.tsx`）           | 端点返回 url，存 `theme.audio.url` 字符串                                 | 存 `{assetId}`（`media/audio` 端点本就返回 `mediaAssetId`）；手工外链仍是字符串                                                                       |
| theme 整体（`normalizeSurveyTheme`）         | 媒体白名单只收字符串，`{assetId}` 会被**剥掉**                            | `safeMediaRef` 双读：字符串白名单原样、`{assetId}` 校验后原样保留                                                                                     |
| theme 素材公开性                             | 靠 media 端点第四路 settings_json URL 字符串匹配                          | PATCH theme 时事务性重建 `media_refs`（`ref_type='survey_theme'`）+ media 端点**第五路** JOIN 已发布问卷。URL 形态旧数据走第四路，两形态并存          |
| 玩家端渲染                                   | —                                                                         | 场景配置经 `resolveHotspotSceneRefs`、theme 经 `resolveThemeMediaRef`/`resolveBgmUrl`/`resolveSprite`/`resolveSurveySfxUrls` 派生 URL；消毒层不吞对象 |

单测：201 文件 / 1459 用例（新增媒体可见性第五路 3 个真 SQL 用例、theme 结构化 4 个、hotspot 结构化 2 个）。

三条禁令未触碰：`scene` 不进 `EDITABLE_TYPES`；热点 id 不变；场景媒体现在**强制**挂 `question_media`（选图即登记）。

## 1. 前置（需要你手工做，我无法代做）

```bash
# 1) 切 Cloudflare 账号到 staging（本机 OAuth 当前指生产账号 pd2335346）
npx wrangler login        # 登录 3353745917@gmail.com（staging 账号）
npx wrangler whoami       # 确认显示 staging 账号 3353745917 / fb8f4c599afffea6f419532f2d95ab54
```

> staging 是**独立 Cloudflare 账号 + 独立 D1/KV/Queue**，灌样例数据不会碰生产。
> 完成全部实测后记得 `wrangler login` 切回生产账号。

## 2. 部署 staging（切好账号后我来执行）

```bash
# staging 库迁移对齐（staging toml 自带 migrations_dir）
pnpm exec wrangler d1 migrations apply telegram-survey-staging-db --remote
# 部署本分支构建产物（-c wrangler.staging.toml，不触发任何生产流程）
pnpm deploy:staging
curl -s https://telegram-multimedia-survey-bot-staging.3353745917.workers.dev/health
```

staging admin 登录走 Telegram `/admin_login` magic link（测试旁路需 `ENVIRONMENT=development`
而 staging toml 是 `staging`，不生效——按 `docs/web-admin-phase-1.md` 首次部署手册确认 secrets 齐全）。

## 3. 灌样例问卷（两形态各一份）

```bash
# A) 旧字符串形态（回归样本）：kv:// → /api/survey/media/<id> 落库
python3 scripts/hotspot/import_hotspot_survey.py \
  --config wrangler.staging.toml \
  --kv-namespace 49f04a9f635d44f4b179b1883be4b59e \
  --apply

# B) 同样灌 galgame 卷（theme BGM/背景/立绘的字符串形态样本）
python3 scripts/galgame/import_galgame_survey.py \
  --config wrangler.staging.toml \
  --kv-namespace 49f04a9f635d44f4b179b1883be4b59e \
  --apply
```

两个 importer 的 `--config/--kv-namespace/--public-base` 是本分支新加的；不带这些参数 =
写生产（默认值保持旧行为，会在输出里显式提醒「🎯 目标环境：生产」）。

## 4. 验证清单

| #   | 项                      | 方式                                           | 通过标准                                                                                                        |
| --- | ----------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | 旧字符串问卷视觉一致    | staging 打开 A 卷答题页                        | 场景图/热点/BGM 渲染与改造前一致（读侧双读，理论零变化）                                                        |
| 2   | 新写 `{assetId}` 全链路 | admin 后台场景编辑器：从库选图 → 保存 → 答题页 | 配置 JSON 里是 `{"assetId":n}`；场景图/内层图/BGM 正常渲染                                                      |
| 3   | 发布后无 404            | `curl -sI <staging>/api/survey/media/<id>`     | 新旧两卷全部素材 200（`question_media` 与 `survey_theme` 两路 linkage）                                         |
| 4   | 草稿不公开              | 未发布的新卷素材                               | 404                                                                                                             |
| 5   | 素材库引用数/删除保护   | 素材库页查看引用计数；尝试删除被引用素材       | 计数正确；删除被拦                                                                                              |
| 6   | 导出→导入往返           | 后台导出 JSON → 新建导入 → 发布                | 场景配置原样（`{assetId}` 随 settings 透传）；⚠️ 已知既有不对称：**导出不带 theme**（与本次改造无关，单独记录） |
| 7   | 弱引用同步识别对象形态  | 触发一次维护（或等 cron）后查 `media_refs`     | `{assetId}` 问卷有 `survey_settings` 行（`syncWeakMediaRefs` 双读）                                             |
| 8   | 编辑器预览              | 场景编辑器打开新写配置                         | 画布/检查器缩略图正常（`transformConfigForPreview` 双读）                                                       |

自动化部分（3/4/7）我写脚本跑；UI 项（1/2/5/6/8）给你逐项点验。

## 5. 已知 staging 差异（不阻塞验证）

- **无 R2 `MEDIA` 绑定** → 媒体全落 staging KV（`createMediaStore` 走 `KVMediaStore` 分支）。
  这正好实测 fallback 路径；R2 晋级逻辑（生产）无法在 staging 观测。
- **无 RATE_LIMIT DO** → 限流退 KV 计数器。
- **assets 是 SPA fallback 且非 worker-first** → 不要直接浏览器导航 `/s/:id`（可能命中
  HANDOVER.md:100 记录的黑屏形态）；验证走 `/admin` 与显式 API 路径。

## 6. 通过后（另行确认再执行）

1. 合入 main（触发生产 deploy）。
2. 生产冒烟：`python3 scripts/galgame/verify_production.py`（问卷 118）+ 等 nightly production-smoke。
3. 路线图 D3 勾选 → D6（删字符串兼容分支与正则兜底）排到两个版本周期后。

回滚预案：staging = 切回 main 重新 `pnpm deploy:staging`；生产 = revert + redeploy。
存量字符串数据读侧双读保证零影响（唯一新增行为是 theme 保存时多写 `media_refs` 行，
对字符串形态只是把第四路隐式匹配变成显式登记，公开性结论不变）。
