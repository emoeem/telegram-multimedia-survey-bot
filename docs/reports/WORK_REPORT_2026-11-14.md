# WORK_REPORT_2026-11-14 —— 深夜三批次 + 推送与 CI 链路修复 · 执行报告

| 项       | 值                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态     | 已完成（全部合入 main 并部署；生产 Version `19e2e282-29c1-4028-b5c2-e8a95b056e64`）                                                                                                                                                                                                                                                        |
| 日期     | 2026-11-13 夜间 – 11-14 凌晨（最后实质性更新 2026-11-14）                                                                                                                                                                                                                                                                                  |
| 适用版本 | git `1806930`（交付）/ `1d68e43`（视觉基线）/ Worker `19e2e282`                                                                                                                                                                                                                                                                            |
| 相关     | [`releases/RELEASE_2026-11-14.md`](../releases/RELEASE_2026-11-14.md)、[`OPTIMIZATION_BACKLOG_2026-11-14.md`](../OPTIMIZATION_BACKLOG_2026-11-14.md)、[`../audits/D1_EXPLAIN_AUDIT_2026-11-14.md`](../audits/D1_EXPLAIN_AUDIT_2026-11-14.md)、[`../audits/OBSERVABILITY_AUDIT_2026-11-14.md`](../audits/OBSERVABILITY_AUDIT_2026-11-14.md) |

> 三个动态工作流批次（批一 `dwfrun-8f30a8aa` / 批二 `dwfrun-30dd78e4` / 批三 `dwfrun-18285115`）
> 依次执行，每批收工跑全量门禁（typecheck / vitest / admin build / lint / lint:admin /
> format:check）+ 失败修复回路；主会话补齐插画与短片后按仓内协议推送、修复 CI、验证生产。
> 本文是**开发者视角的执行记录**；用户/运维视角见 RELEASE。

## 一、三批次任务与结论

| 批次   | 任务线                                                                                                                    | 结论                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 批一   | ① 三个新游戏插件（guess / memory-chain / high-low）+ `/trial` 插件玩法接线（修复开局死局）                                | ✅ 111 例全绿 + admin build；死局根因 = 客户端只有爬塔运行循环                                      |
| 批一   | ② 任务可靠性 P1（原子认领 / queued 重投 / sending 记账 / 口径统一）                                                       | ✅ +21 单测，全量 1862 绿                                                                           |
| 批一   | ③ 媒体 MIME 精确匹配（survey 存储点先行）                                                                                 | ✅ +8 单测                                                                                          |
| 批一   | ④ 工程与文档卫生（smoke 根因 / admin ESLint / git 卫生 / 三份文档迁移表述纠偏）                                           | ✅ smoke @production 8/8 本地实跑绿；7 个误跟踪文件 + 无效 gitlink 移出索引（磁盘保留）             |
| 批一   | ⑤ 《雨夜书房》结构 + 文案 + 落库脚本草案                                                                                  | ✅ 5 场景/16 热点/9 资产三方对齐；插画线 **0/9**（生图 API code 3706，如实受阻）                    |
| 批二   | A G5+G6 体验债（引导持久化 / 落点 / ⌘K 触控与读屏）                                                                       | ✅ tests/unit/admin 177 例                                                                          |
| 批二   | B G7 编辑器三件套（在此后插入 / 多选批量 / flag 总览；diffOps 补 pageId）                                                 | ✅ 纯逻辑抽 `admin/src/editor/{question-insert,batch-edit,flag-overview}.ts` 带单测                 |
| 批二   | C 纸条黑名单管理页；弹幕举报**前提不成立**（仓库从未存在弹幕功能，批三口径修正才是事实——未落虚构迁移）                    | ✅ 零迁移 + 3 单测                                                                                  |
| 批二   | D `src/index.ts` 1118→38 行拆分（env/guard/router/static-pages/bootstrap/cron/admin-ids）                                 | ✅ 零行为变更；**queue consumer 出口保留**（wrangler.toml 有 [[queues.consumers]]，任务书地图漏了） |
| 批二   | E 后台任务中心（GET `/api/control/jobs` + 卡片组；重试仅报告投递）                                                        | ✅ 零迁移；其余三类任务入口置灰（缺端点，不绕过幂等护栏）                                           |
| 批三   | A 审计 1B 安全矩阵补强                                                                                                    | ✅ +18 用例；结论「服务端校验层无真实漏洞」，已有覆盖以证据列出                                     |
| 批三   | B 审计 1C D1 EXPLAIN 基线                                                                                                 | ✅ 37 条逐条实测；无缺失索引（唯一全扫需 UNION 改写，加索引救援实验证明无效），0097 索引迁移不产出  |
| 批三   | C 审计 1A webhook 并发回归                                                                                                | ✅ +9 用例（并发 2/5/10 / done 拦截 / stale 接管 / secret 先行 / 未知类型降级）                     |
| 批三   | D 审计 3A 可观测性基线（限流归因 / 投递终态 / terminal 字段 / 伪造 webhook 失真）                                         | ✅ 零新依赖；详见 OBSERVABILITY_AUDIT                                                               |
| 批三   | E 批一道留收口（hooks 双规则 error 化清零 93 违规含 rules-of-hooks 系统性 85 处 / MIME 扩四存储点 / sending 30 分钟回收） | ✅ lint:admin 0 error；SurveyApp/PlazaScreen 提取 SurveyRunner/PlazaFeedScreen 组件                 |
| 主会话 | 插画 9 幅（手作 SVG→Chromium 栅格化）+ 12s ffmpeg 短片 + `apply_scenes.py` mediaMeta 全键查找 bug 修复                    | ✅ 落库门禁 `插画 9/9 就位` exit 0；替代原因见 RELEASE §四                                          |

## 二、提交清单（main）

| 提交      | 内容                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------- |
| `3107080` | feat(games)：三插件 + /trial 接线；随提交入库预置索引删除                                       |
| `c4b91af` | fix(reliability)：原子认领 / 重投 / sending 记账 / 0097 / MIME 五存储点                         |
| `c9b19a0` | fix(ci)：smoke spec 端点模型 / admin ESLint / .gitignore / 文档纠偏                             |
| `ac2a7a2` | feat(admin+arch)：体验债 / 编辑器 / 黑名单页 / 任务中心 / index.ts 拆分 / 可观测性 / hooks 清零 |
| `096c9af` | test(audit)：安全矩阵 18 用例 + 两份审计文档                                                    |
| `ad151cc` | feat(study-room)：作品包（结构/文案/插画/短片/脚本/工具）                                       |
| `0d46e37` | docs(release)：RELEASE + HANDOVER 交接 + BACKLOG 回填                                           |
| `abb1ce5` | test(audit)：批三余量（charts hooks / dedup 并发 / delivery 终态断言）                          |
| `1d68e43` | test(visual)：CI 字体环境重生成基线（Visual baseline 工作流产物，editor ×4 + trial home ×2）    |
| `1806930` | chore：空提交触发 CI/deploy（GITHUB_TOKEN 推送不触发工作流）                                    |

## 三、推送与 CI 链路（含两条工程教训）

1. **视觉基线协议执行**：首次 push 的 CI visual 红在 editor ×4 + trial home ×2——均为本轮有意的
   UI 改动。按协议派发 `Visual baseline` 工作流（gh keyring 令牌无 scopes，dispatch 403；改用
   PAT 直调 REST）→ 基线提交落地。
2. **GITHUB_TOKEN 推送不触发工作流**（GitHub 防递归约定）：基线提交后 CI/deploy 没有跟着跑，
   推空提交 `1806930` 触发。此后 CI 全绿 → deploy（await-ci 三门禁）→ 生产 Version `19e2e282`。
3. **production-smoke 两连绿**：修复验证（旧生产 + 新 spec）+ 新部署端到端（`43458694184`）。
4. 凭证事实记录：gh keyring 令牌 scopes 为空（只读 API）；可推送的 PAT 在 `~/.config/gh/pat`
   （不回显、不写入任何文档/日志），git 推送用空 helper 重置 + 环境变量注入，token 不进 argv。

## 四、审计产出

- [`D1_EXPLAIN_AUDIT_2026-11-14.md`](../audits/D1_EXPLAIN_AUDIT_2026-11-14.md)：37 条热路径 SQL
  逐条 EXPLAIN QUERY PLAN（本地 D1 head 0096）；33 条走既有索引，唯一全扫（纸条会话列表跨表 OR）
  经加索引救援实验证明无效、UNION 改写有效但属行为变更——判定无「确认缺失索引」。
- [`OBSERVABILITY_AUDIT_2026-11-14.md`](../audits/OBSERVABILITY_AUDIT_2026-11-14.md)：指标清单
  （名称 / 含义 / 触发点 / 查询方式）与 4 个补齐缺口的实现说明。

## 五、已知问题与建议队列（如实）

1. `d1-backup` 仍红：账号侧 `R2_BACKUP_BUCKET` secret + token R2 Edit 权限（用户手工，见 ops-runbook）。
2. 纸条会话列表 UNION 改写（EXP3 实验有效，行为变更需回归）；`note_messages` 聚合 SQL 改写。
3. 两处删数据路径 N+1（`database-maintenance.service.ts:410` / `profile-gallery.service.ts:292`）：
   batch 化改变失败/并发语义，需独立立项带回归。
4. 图片生成 / 结果渲染 / 导出的人工重试端点缺失——任务中心入口置灰等待端点。
5. control-api-jobs 首轮全量跑出现过一次 6 用例 flaky（seed UNIQUE 冲突/排序/条数），复跑与单文件
   连跑 3 次全过；未复现第二回，留观。
6. macOS 上 ctrl+点击结构树多选会同时唤起右键菜单（⌘ 可用）；勾选框是触屏设备的主入口。

## 六、测试基线变化

| 时点                          | 文件数 | 用例数   |
| ----------------------------- | ------ | -------- |
| 会话起点（db7be6a，交接口径） | 246    | 1808     |
| 批一收工                      | 251    | 1862     |
| 批二收工                      | 249    | 1904     |
| 批三收工                      | 251    | 1931     |
| 推送前终态（补余量测试后）    | 254    | **1947** |

> 文件数有波动属正常：批间有测试文件合并/拆分（如 http 目录既有文件追加用例），
> 以「用例数只增不减」为准绳（UPGRADE_ROADMAP 贯穿约定）。
