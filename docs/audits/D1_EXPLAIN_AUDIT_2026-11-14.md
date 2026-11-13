# D1 EXPLAIN 查询基线 · 2026-11-14

| 项       | 值                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已完成（判定：无「确认缺失的索引」，0097 索引迁移不产出）                                                                                                                                 |
| 日期     | 2026-11-14                                                                                                                                                                                |
| 适用版本 | 本地 D1 head `0096`；git `abb1ce5`                                                                                                                                                        |
| 相关     | 审计总纲 [COMPREHENSIVE_OPTIMIZATION_AUDIT_2026-11-06.md](COMPREHENSIVE_OPTIMIZATION_AUDIT_2026-11-06.md) §1C；批三报告 [WORK_REPORT_2026-11-14.md](../reports/WORK_REPORT_2026-11-14.md) |

审计 1C 的可执行子集：对五类点名热路径（问卷列表带题数统计 / 答卷列表按状态日期筛选 /
排行榜聚合 / 纸条与树洞列表 / report_deliveries 重试扫描）抽取仓内真实 SQL，在本地 D1
（迁移 0000→0096 全部应用后的 head）上逐条跑 `EXPLAIN QUERY PLAN`，记录是否走预期索引、
有无全表扫描；随后对唯一的全表扫描做索引救援实验，给出 0097 的「无缺口」判定与依据。

## 一、方法与复现命令

```bash
# 1) 本地 D1 应用迁移到 head
pnpm migrate:local          # 等价 wrangler d1 migrations apply DB --local

# 2) 单条 EXPLAIN（示例）
pnpm exec wrangler d1 execute DB --local --json \
  --command "EXPLAIN QUERY PLAN SELECT id FROM surveys WHERE deleted_at IS NULL LIMIT 1"

# 3) 批量 EXPLAIN（每条独立语句，参数以代表性字面量代入——查询计划只取决于
#    schema/索引形态，不取决于参数值）
pnpm exec wrangler d1 execute DB --local --json --file /tmp/d1_explain/queries.sql
```

**局限性（先读这个再读结论）**：本地库无生产数据分布，也未跑 `ANALYZE`（无
`sqlite_stat1`）。因此本基线验证的是**结构性**属性——「谓词是否存在可用索引承接」，
这是稳定的；而「planner 在多条可用索引中最终选哪条」会随统计信息变化（实测案例见
Q14/Q15 的 topic 索引未被选用）。生产端 D1 会自动维护统计（`PRAGMA optimize`），
慢查询若出现应先复核该条的实际计划再行动。

## 二、涉及索引盘点（判定依据）

判定引用到的既有索引（均为迁移产物，grep `CREATE INDEX db/migrations/*.sql` 全量核对）：

| 索引                                      | 列                                                                       | 来源             | 承接的查询                           |
| ----------------------------------------- | ------------------------------------------------------------------------ | ---------------- | ------------------------------------ |
| idx_surveys_status_published              | surveys(status, published_at DESC, id DESC)                              | 0051             | Q1 公开目录（含排序免 temp b-tree）  |
| idx_surveys_updated_at                    | surveys(updated_at DESC, id DESC)                                        | 0051             | Q2b 全站管理列表                     |
| idx_surveys_owner_id                      | surveys(owner_id)                                                        | 0001             | Q2 owner 维度列表                    |
| idx_questions_order                       | survey_questions(survey_id, "order")                                     | 0002             | 题数子查询（covering）               |
| idx_responses_survey_status_id            | survey_responses(survey_id, status, id DESC)                             | 0034             | Q3/Q4 答卷列表按状态日期             |
| idx_responses_survey_status_completed     | survey_responses(survey_id, status, completed_at DESC)                   | 0052             | Q2/Q21 计数（covering）              |
| idx_responses_active_participant          | survey_responses(survey_id, participant_hash) WHERE status='in_progress' | 0034             | Q31 填答入口点查                     |
| idx_survey_responses_user_status          | survey_responses(user_id, status)                                        | 0071             | Q22/Q23 我的答卷                     |
| idx_task_runs_leaderboard                 | task_runs(pack_id, mode, status, score DESC)                             | 0045             | Q5-Q8 单包榜与戳探针                 |
| idx_task_runs_user_pack_mode              | task_runs(user_id, pack_id, mode, status, score DESC)                    | 0055             | Q5 相关子查询（每人最优局）          |
| idx_task_packs_game_type                  | task_packs(game_type)                                                    | 0095             | Q6/Q7 玩法→包集合                    |
| idx_notes_pool                            | notes(status, expires_at, id)                                            | 0089             | Q9 抽取池 / Q16 管理列表             |
| idx_notes_owner_active                    | notes(owner_hash) WHERE status='active'                                  | 0089（部分唯一） | 1 人 1 张兜底 + getMyActiveNote      |
| idx_threads_drawer                        | note_threads(drawer_hash, last_message_at)                               | 0089             | Q9 子查询抽中集合                    |
| idx_messages_thread                       | note_messages(thread_id, id)                                             | 0089             | Q11/Q24（covering 全索引扫，见判定） |
| idx_plaza_posts_active_feed               | plaza_posts(status, id) WHERE deleted_at IS NULL                         | 0074             | Q12/Q13/Q14/Q15/Q32                  |
| idx_plaza_posts_topic                     | plaza_posts(topic, id DESC)                                              | 0068             | Q14/Q15 可用但未被 planner 选用      |
| idx_plaza_post_comments_post              | plaza_post_comments(post_id, …)                                          | 0046             | Q13/Q14 评论数子查询（covering）     |
| idx_report_deliveries_status              | report_deliveries(status, next_retry_at)                                 | 0027/0038        | Q17-Q20                              |
| idx_notifications_participant             | notifications(participant_hash, …)                                       | 0084             | Q28                                  |
| idx_render_jobs_status_created_at         | render_jobs(status, created_at)                                          | 0038             | Q29                                  |
| idx_survey_responses_gallery_cover_source | survey_responses(gallery_cover_source_asset_id)                          | 0051             | Q30                                  |
| idx_audit_logs_action                     | audit_logs(action)                                                       | 0071             | Q27                                  |
| idx_coin_txn_hash                         | coin_transactions(participant_hash, id DESC)                             | 0078             | Q34                                  |
| idx_answers_question_response             | answers(question_id, …)                                                  | 0038 系          | Q25（covering）                      |
| sqlite_autoindex_answers_1                | answers UNIQUE(response_id, question_id)                                 | 0004             | Q26 逐答案定位                       |

## 三、逐条判定表

`EXPLAIN QUERY PLAN` 原文逐行摘录（`SCAN` = 全表扫描；`SCAN … USING INDEX` = 全索引
扫描，仍线性但免读表；`SEARCH … USING INDEX` = 索引定位）。

### A. 问卷列表带题数统计

| #   | 查询（来源）                                                          | EXPLAIN 结果                                                                                                                                                                                                                          | 判定                                                                                                                     |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Q1  | 公开目录，题数+完成数相关子查询（src/http/survey/catalog.ts:218-234） | `SEARCH s USING INDEX idx_surveys_status_published (status=?)`；子查询1 `SEARCH q USING COVERING INDEX idx_questions_order`；子查询2 `SEARCH r USING COVERING INDEX idx_responses_survey_status_completed (survey_id=? AND status=?)` | **走索引**。published 索引同时满足 `ORDER BY published_at DESC, id DESC`（无 temp b-tree）；两个子查询均 covering 范围扫 |
| Q2  | 管理端列表（owner 维度）（src/http/admin/read.ts:307）                | `SEARCH s USING idx_surveys_owner_id (owner_id=?)`；子查询同 Q1；`USE TEMP B-TREE FOR ORDER BY`                                                                                                                                       | **走索引**。owner 段内按 updated_at 排序需 temp b-tree；owner 问卷数量级小，可接受                                       |
| Q2b | 管理端列表（全站，无 owner）                                          | `SCAN s USING INDEX idx_surveys_updated_at` + 同款子查询                                                                                                                                                                              | **走索引**。updated_at 索引提供顺序，`SCAN USING INDEX` 是覆盖顺序扫描非表扫                                             |
| Q1b | 目录搜索（LIKE '%q%'）                                                | `SEARCH s USING INDEX idx_surveys_status_published (status=?)`                                                                                                                                                                        | **走索引**。前导 `%` 的 LIKE 本就不可索引；在 status 段内 filter，`LIMIT 200` 封顶。预期行为                             |

### B. 答卷列表按状态/日期筛选

| #   | 查询（来源）                                   | EXPLAIN 结果                                                                                                           | 判定                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q3  | 答卷列表分页（src/http/admin/read.ts:874-881） | `SEARCH r USING INDEX idx_responses_survey_status_id (survey_id=? AND status=?)`；`SEARCH u USING INTEGER PRIMARY KEY` | **走索引**。`date(r.started_at)` 包裹列导致日期谓词不 sargable，但主谓词 (survey_id, status) 有索引承接，日期只在结果段内 filter。若未来出现不带 survey_id 的日期报表需求，需先改写为 `r.started_at >= ?` 边界形式才能吃到 (started_at) 索引——当前不存在该调用方，不新增 |
| Q4  | 同谓词 COUNT                                   | `SEARCH r USING INDEX idx_responses_survey_status_id (survey_id=? AND status=?)`                                       | **走索引**                                                                                                                                                                                                                                                               |

### C. 排行榜聚合（task_runs 按 pack / gameType+mode）

| #   | 查询（来源）                                                                       | EXPLAIN 结果                                                                                                                                                                                                                                                                                | 判定                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q5  | 单包榜，相关子查询取每人最优（src/db/repositories/task-run.repository.ts:289-301） | `SEARCH r USING INDEX idx_task_runs_leaderboard (pack_id=? AND mode=? AND status=?)`；子查询 `SEARCH r2 USING INDEX idx_task_runs_user_pack_mode (user_id=? AND pack_id=? AND mode=? AND status=?)`；两处 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`（finished_at 是排序尾列，不在索引内） | **走索引**。两处 temp b-tree 只排「每人最优后」的结果行（用户数量级）且受 LIMIT 约束为 top-N 堆排序；补 finished_at 尾列的收益为 log 因子级，不值得加写放大。见「五、0097 判定」候选 2 |
| Q6  | 玩法总榜 GROUP BY 单趟聚合（task-run.repository.ts:329-338）                       | `SEARCH r USING INDEX idx_task_runs_leaderboard`；`LIST SUBQUERY`→`SEARCH task_packs USING COVERING INDEX idx_task_packs_game_type`；`USE TEMP B-TREE FOR GROUP BY/ORDER BY`                                                                                                                | **走索引**（0095 已修 game_type 全扫）。GROUP BY user_id 无法借 pack_id 前导索引免排序，是源码注释（task-run.repository.ts:313-315）已认定的设计取舍                                   |
| Q7  | 玩法总榜戳探针 COUNT+MAX（task-run.repository.ts:379-383）                         | 同 Q6 的索引路径，无 temp b-tree                                                                                                                                                                                                                                                            | **走索引**。范围扫 + 聚合                                                                                                                                                              |
| Q8  | 单包榜戳探针（task-run.repository.ts:362-365）                                     | `SEARCH task_runs USING INDEX idx_task_runs_leaderboard (pack_id=? AND mode=? AND status=?)`                                                                                                                                                                                                | **走索引**                                                                                                                                                                             |

### D. 纸条与树洞列表

| #   | 查询（来源）                                                       | EXPLAIN 结果                                                                                                                                                                                      | 判定                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q9  | 抽纸条池 RANDOM 取 1（src/services/note-chat.service.ts:284-286）  | `SEARCH notes USING INDEX idx_notes_pool (status=? AND expires_at>?)`；NOT IN 子查询 `SEARCH note_threads USING INDEX idx_threads_drawer`；NOT EXISTS `MULTI-INDEX OR` 双臂走 note_block 唯一索引 | **走索引**。池扫描被 (status, expires_at) 前缀限定为活跃未过期段，0089 注释的设计意图实测成立                                                                                                                                                          |
| Q10 | **会话列表**（note-chat.service.ts:408-418）                       | `SCAN t`（note_threads 全表扫描）+ `SEARCH n USING INTEGER PRIMARY KEY` + temp b-tree 排序                                                                                                        | **全表扫描**。唯一真全扫。跨表 OR `(t.drawer_hash=? OR n.owner_hash=?)`——SQLite 的 multi-index OR 只适用于同表谓词。见「四、Q10 索引救援实验」：**任何 CREATE INDEX 都救不了**，修复只能改写 SQL（UNION 两臂），超出纯索引迁移范围 → 记建议，不入 0097 |
| Q11 | 会话未读数聚合（note-chat.service.ts:467-473）                     | `SCAN m USING INDEX idx_messages_thread`（covering 全索引扫）                                                                                                                                     | **全索引扫描**。线性于全库消息数。谓词绑定在 join 后（我的 thread 集合内数未读），无单表索引可承接；改写为先圈 thread 集合再按 thread_id IN 聚合才有效 → 记建议，不入 0097                                                                             |
| Q12 | 树洞列表 COUNT（src/db/repositories/plaza-post.repository.ts:153） | `SEARCH p USING INDEX idx_plaza_posts_active_feed (status=?)`                                                                                                                                     | **走索引**。partial 索引蕴含 deleted_at IS NULL；content_rating 在 status 段内 filter。候选 1，见「五」                                                                                                                                                |
| Q13 | 树洞列表行+评论数子查询（plaza-post.repository.ts:158-159）        | 同 Q12；`SEARCH u USING INTEGER PRIMARY KEY`；子查询 `SEARCH c USING COVERING INDEX idx_plaza_post_comments_post (post_id=? AND status=?)`                                                        | **走索引**。(status, id) 的 id 列同键按 rowid 序，反向扫即满足 `ORDER BY p.id DESC`（无 temp b-tree，实测一致）                                                                                                                                        |
| Q14 | 树洞列表 topic 筛选（plaza-post.repository.ts:148-149）            | `SEARCH p USING INDEX idx_plaza_posts_active_feed (status=?)`——**未用** idx_plaza_posts_topic (topic, id DESC)                                                                                    | **走索引（非最优）**。topic 索引存在且理论上可免排序直接定位；planner 在无统计下估猜选了 status 前导。不是缺失索引，是统计问题 → 记建议（观察/依赖 D1 的 PRAGMA optimize），不入 0097                                                                  |
| Q15 | 话题榜 GROUP BY topic（plaza-post.repository.ts:178-182）          | 同 Q14 + `USE TEMP B-TREE FOR GROUP BY/ORDER BY`                                                                                                                                                  | **走索引（非最优）**。同 Q14：planner 未选 topic 前导，GROUP 排序本可由 (topic) 索引序消除。统计问题 → 记建议                                                                                                                                          |
| Q16 | 纸条管理列表按状态（src/http/note-api.ts:160-162）                 | `SEARCH notes USING INDEX idx_notes_pool (status=?)` + `USE TEMP B-TREE FOR ORDER BY`（report_count DESC）                                                                                        | **走索引**。status 段内排序，`LIMIT 50` 封顶，段=该状态纸条数（量级小）                                                                                                                                                                                |
| Q35 | 会话列表拉黑双向过滤（note-chat.service.ts:442-444）               | `SCAN note_block USING COVERING INDEX sqlite_autoindex_note_block_1`                                                                                                                              | **全索引扫描（covering）**。`blocker_hash=? OR blocked_hash=?` 第二臂 blocked_hash 非前导列，无法 SEARCH；但 covering 免读表且 note_block 行数=拉黑对数（小），LIMIT 无但结果集天然小 → 可接受，不入 0097                                              |

### E. report_deliveries 重试扫描

| #   | 查询（来源）                                                                         | EXPLAIN 结果                                                                                                                                            | 判定                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q17 | cron 重试队列扫描（src/services/report-delivery.service.ts:180-186）                 | `SEARCH report_deliveries USING INDEX idx_report_deliveries_status (status=?)`                                                                          | **走索引**。`(next_retry_at IS NULL OR next_retry_at <= ?)` 未合并为单段 range，退化为 status 段内 filter；status='pending' 段行数=待投递数（队列量级小），`LIMIT 100` 封顶 |
| Q18 | 重试封顶 UPDATE（report-delivery.service.ts:152-157）                                | `SEARCH … USING INDEX idx_report_deliveries_status (status=? AND next_retry_at>? AND next_retry_at<?)`                                                  | **走索引**。IS NOT NULL + <= 被 planner 转成开区间 range，两列全命中                                                                                                        |
| Q19 | 卡死回收 UPDATE（report-delivery.service.ts:168-172）                                | `SEARCH … USING INDEX idx_report_deliveries_status (status=?)`                                                                                          | **走索引**。updated_at filter 在 delivering 段内                                                                                                                            |
| Q20 | 管理端投递列表三表 JOIN（src/db/repositories/report-delivery.repository.ts:230-239） | `SEARCH rd USING INDEX idx_report_deliveries_status (status=?)`；`SEARCH r / s USING INTEGER PRIMARY KEY`；`USE TEMP B-TREE FOR ORDER BY`（rd.id DESC） | **走索引**。status 段=该状态投递数，排序段小，`LIMIT 20`                                                                                                                    |

### F. 补充热路径（提交/删除/统计/通知/认领/账本）

| #   | 查询（来源）                                                     | EXPLAIN 结果                                                                                                                                                                                       | 判定                                                                                                                                                                     |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q21 | 问卷删除前置计数（src/db/repositories/survey.repository.ts:225） | `SEARCH survey_responses USING COVERING INDEX idx_responses_survey_status_completed (survey_id=?)`                                                                                                 | **走索引**                                                                                                                                                               |
| Q22 | 提交防重计数（response.repository.ts:268-271）                   | `SEARCH survey_responses USING INDEX idx_survey_responses_user_status (user_id=? AND status=?)`                                                                                                    | **走索引**。planner 选 user 前导（同用户答卷段通常小于同问卷完成段），非全扫；如需点查级可加 (survey_id, user_id, status)，但当前是范围扫且行数小 → 不加（避免过度索引） |
| Q23 | 我的进行中答卷（response.repository.ts:234-237）                 | `SEARCH survey_responses USING INDEX idx_survey_responses_user_status (user_id=? AND status=?)`                                                                                                    | **走索引**。同键索引内按 rowid 序，反向扫即满足 `ORDER BY id DESC LIMIT 1`（无 temp b-tree）                                                                             |
| Q24 | 会话最后一条消息（note-chat.service.ts:460-461）                 | `SEARCH m USING INTEGER PRIMARY KEY` + `LIST SUBQUERY: SCAN note_messages USING INDEX idx_messages_thread`                                                                                         | **全索引扫描**。每线程 MAX(id) 必须遍历全表才能得出；与 Q11 同源（listThreads 搭车查询），SQL 改写才有效 → 记建议，不入 0097                                             |
| Q25 | 每题答卷计数（question.repository.ts:391）                       | `SEARCH answers USING COVERING INDEX idx_answers_question_response (question_id=?)`                                                                                                                | **走索引**                                                                                                                                                               |
| Q26 | 报表统计聚合（src/services/statistics.service.ts:198-209）       | `SEARCH q USING INDEX idx_questions_order`；`SEARCH r USING COVERING INDEX idx_responses_status_updated (status=?)`；`SEARCH a USING sqlite_autoindex_answers_1 (response_id=? AND question_id=?)` | **走索引**                                                                                                                                                               |
| Q27 | 审计日志筛选（audit.repository.ts:63）                           | `SEARCH a USING INDEX idx_audit_logs_action (action=?)`                                                                                                                                            | **走索引**                                                                                                                                                               |
| Q28 | 通知未读计数（series-follow.service.ts:50）                      | `SEARCH notifications USING INDEX idx_notifications_participant (participant_hash=?)`                                                                                                              | **走索引**                                                                                                                                                               |
| Q29 | 渲染任务认领                                                     | `SEARCH render_jobs USING COVERING INDEX idx_render_jobs_status_created_at (status=?)`                                                                                                             | **走索引**                                                                                                                                                               |
| Q30 | 媒体引用计数（0051 语义）                                        | `SEARCH survey_responses USING COVERING INDEX idx_survey_responses_gallery_cover_source`                                                                                                           | **走索引**                                                                                                                                                               |
| Q31 | 填答入口点查（response.repository.ts:221-223）                   | `SEARCH survey_responses USING INDEX idx_responses_active_participant (survey_id=? AND participant_hash=?)`                                                                                        | **走索引**。partial 索引恰好承接 status='in_progress'                                                                                                                    |
| Q32 | 树洞被举报筛选 COUNT（plaza-post.repository.ts:146）             | `SEARCH p USING INDEX idx_plaza_posts_active_feed (status=?)`                                                                                                                                      | **走索引**。report_count>0 在 status 段内 filter                                                                                                                         |
| Q33 | 0096 帖子举报去重/列表                                           | `SEARCH plaza_post_reports USING INDEX sqlite_autoindex_plaza_post_reports_1 (post_id=?)`                                                                                                          | **走索引**。UNIQUE(post_id, reporter_user_id) 前导承接                                                                                                                   |
| Q34 | 金币账本流水（coin_transactions）                                | `SEARCH coin_transactions USING INDEX idx_coin_txn_hash (participant_hash=?)`                                                                                                                      | **走索引**                                                                                                                                                               |

## 四、Q10 索引救援实验（唯一全表扫描）

Q10 的谓词是跨表 OR：`(t.drawer_hash = ? OR n.owner_hash = ?)`。SQLite 的 OR 优化
（multi-index OR）只适用于**同一张表**上的谓词臂，跨表 OR 无法为两臂各建访问路径。
为把判断坐实，在本地库做实验（加临时索引→EXPLAIN→DROP，未留存任何变更）：

| 实验 | 变更                                                                              | Q10 计划                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基线 | —                                                                                 | `SCAN t`                                                                                                                                                                            |
| EXP1 | `CREATE INDEX idx_tmp_threads_drawer_status ON note_threads(drawer_hash, status)` | `SCAN t`（无变化）                                                                                                                                                                  |
| EXP2 | 再加 `CREATE INDEX idx_tmp_notes_owner ON notes(owner_hash)`                      | `SCAN t`（无变化）                                                                                                                                                                  |
| EXP3 | 改写为 `UNION ALL` 两臂（drawer 臂 + owner 臂）                                   | `MERGE (UNION ALL)`，两臂分别 `SEARCH t USING idx_tmp_threads_drawer_status` 与 `SEARCH n USING idx_tmp_notes_owner` + `SEARCH t USING sqlite_autoindex_note_threads_1 (note_id=?)` |

结论：**索引对 Q10 无效，UNION 改写有效**（实验索引已 DROP，`sqlite_master` 复查为空）。

改写要点（若后续立项）：

```sql
SELECT t.id AS threadId, n.owner_hash AS ownerHash
  FROM note_threads t JOIN notes n ON n.id = t.note_id
 WHERE t.drawer_hash = ?1 AND t.status = 'active'
UNION ALL
SELECT t.id AS threadId, n.owner_hash AS ownerHash
  FROM notes n JOIN note_threads t ON t.note_id = n.id
 WHERE n.owner_hash = ?1 AND t.status = 'active'
 ORDER BY threadId DESC LIMIT 100
```

- 现查询 `ORDER BY COALESCE(t.last_message_at, t.created_at) DESC` 需在两臂一并投影
  该排序键。上面简化为 threadId 只为看计划形态。
- **臂互斥前提**：`drawPoolWhere`（note-chat.service.ts:160）排除了抽自己的纸条，故
  同一 thread 的 drawer_hash ≠ owner_hash，两臂不会命中同一行，UNION ALL 无重复。
  若历史数据存在自抽 thread（规则变更前），须用 UNION（去重）而非 UNION ALL。
- 这是行为变更 + 需要两条新索引支撑，超出本线「纯 CREATE INDEX 增量」的迁移范围。

## 五、0097 判定：无确认缺失的索引（不产出迁移）

**结论：db/migrations/0097_add_indexes.sql 不产出。** 依据（每条都有上表实测支撑）：

1. 五类点名热路径共 34 条查询，33 条 `SEARCH … USING INDEX` 承接（含 covering 与范围
   扫描），唯一点名类别的全表扫描 Q10 已被实验证明**不可由索引修复**（第四节）。
2. 前期索引迁移已覆盖到位：0071（user_id 热路径）、0045/0055（榜单双索引）、0051
   （published/updated_at 目录索引）、0052（completed 计数）、0074（feed partial）、
   0089（notes 池）、0095（game_type）。本次审计未发现这些索引中任何一条被误删或失效。

评估过但**否决**的三个候选（写下来防止后续重复评估）：

| 候选                                                                        | 证据                                                            | 否决理由                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 树洞公开流覆盖索引 (status, content_rating, id) WHERE deleted_at IS NULL | Q12/Q13/Q32 的 content_rating='all' 全靠 status 段内逐行 filter | 非全扫（partial 索引 (status, id) 已承接主谓词与排序）；filter 行数=published 全量（当前千级内），加列省下的行 fetch 换不回每次发帖/举报/删除多维护一条索引的写放大。等真实数据量出现慢查询再立项 |
| 2. task_runs 榜单索引补 finished_at 尾列                                    | Q5 两处 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`             | 排序的是每人最优后的结果行（用户数量级）且受 LIMIT 约束为 top-N 堆排序；收益 log 因子级，代价是榜单双索引的重建与写放大                                                                           |
| 3. Q10 救援索引（任意形态）                                                 | 第四节实验 EXP1/EXP2 计划无变化                                 | 实证无效。给一个还不会用它的查询建索引 = 死索引，纯付写放大                                                                                                                                       |

**迁移单测**：因 0097 不产出而无对象。仓内先例为
`tests/unit/db/migrations-hot-path-indexes.test.ts`（内存 SQLite 应用迁移 + 断言索引
存在 + `EXPLAIN QUERY PLAN` 断言走新索引）——后续任何索引迁移照此模板补测。

## 六、N+1 静态检查（repositories 循环内 await prepare/run）

扫描方式：脚本跟踪 for/while/async-map 块的花括号深度，报告块内出现的
`await … .prepare/.run/.all/.first/.batch`；`src/db/repositories`、`src/services`、
`src/http` 三个目录全量。

**repositories：零真 N+1。** 5 处命中全是分块 `IN (...)` 批量模式
（media.repository.ts:200/268/356/582、question.repository.ts:120）——
media.repository.ts:187-194 的注释明确说明该模式正是历史 N+1 的修复产物。

services 邻域命中 6 处，逐处定性：

| 位置                                             | 形态                                                                                                 | 判定                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/services/survey.service.ts:19                | `batchChunked` 按 50 条分块 `db.batch`                                                               | 非 N+1（平台单批上限分块，survey.service.ts:13-16 注释已说明）                                                                                                                                                                                     |
| src/services/export-worker.service.ts:242        | 队列批内逐消息处理（4 处 await）                                                                     | 非 N+1（每条消息是独立 job，独立 ack/retry 语义，队列消费固有形态）                                                                                                                                                                                |
| src/services/profile-gallery.service.ts:234      | 逐媒体 R2 拷贝 + createMediaAsset + INSERT（await@254）                                              | 非 N+1（无重复读；每张图的 asset.id 依赖上一条 INSERT 结果，batch 化会破坏依赖链，不属低风险）                                                                                                                                                     |
| src/services/profile-gallery.service.ts:292      | 逐行 `store.delete`（KV/R2）+ `expireMediaAsset`（UPDATE）+ DELETE mapping（await@294-295）          | **真逐行写 N+1**（每行 2 条 D1 写 + 1 个存储删）。在删除清理路径上，batch 化需重排「删行→删存储」的失败语义，非明确低风险 → 记 risks                                                                                                               |
| src/services/database-maintenance.service.ts:200 | 仅对 missing 的索引逐条 `CREATE INDEX`                                                               | 低频维护任务自愈路径（缺才建、建一次），收益近零 → 不改                                                                                                                                                                                            |
| src/services/database-maintenance.service.ts:410 | 孤儿媒体清理：每 candidate `SELECT storage_key` → `DELETE` → `SELECT 1 … storage_key=?`（3 查询/行） | **真 N+1**。batch 化方案（IN 预取 storage_key + batch DELETE + IN 复用检查）会改变「逐行删行后即时复用检查」的时序语义（扫描期间并发写入同 storage_key 的行可能被误判复用/误删 blob）——删数据路径非低风险 → 记 risks，建议单独立项带回归测试后再改 |

## 七、建议队列（后续线，非本线动作）

1. **Q10 会话列表 UNION 改写**（全表扫描，note_threads 随玩法线性增长）：见第四节
   改写要点；需同步建 `note_threads(drawer_hash, status)` 与 `notes(owner_hash)`
   （非 partial 版）两条索引并按 0071 先例补迁移测试。
2. **Q11/Q24 未读数与最后消息的线性聚合**：listThreads 的三条搭车查询可合并为
   「先圈 thread 集合（走 idx_threads_drawer / notes owner 侧），再按 thread_id IN
   聚合」；note_messages 增长后收益显著。
3. **Q14/Q15 topic 索引未被选用**：planner 统计问题。观察生产慢查询；若坐实，方案是
   引导统计（D1 `PRAGMA optimize`）或改写谓词，而非再加索引（idx_plaza_posts_topic
   已存在）。
4. **Q3 的 date(r.started_at) 非 sargable**：当前有 (survey_id, status) 前导兜底不伤；
   若未来出现跨问卷按日期的报表，先改写为 `r.started_at >= ? AND r.started_at < ?`
   边界形式再谈索引。
5. **孤儿媒体清理与 gallery 过期清理的逐行写**（第六节两处 risks）：batch 化必须带
   并发语义回归测试，单独立项。

## 八、本次审计的自验

- `pnpm migrate:local`：0000→0096 全部 ✅（含本次新增确认的 0095/0096）。
- EXPLAIN 实测：37 条查询 + 4 条实验语句，全部真实执行于本地 D1 head
  （wrangler d1 execute DB --local，未加 --remote）。
- 实验索引清理复查：`SELECT name FROM sqlite_master WHERE name LIKE 'idx_tmp%'` → 空。
- `pnpm vitest run tests/unit/db tests/unit/repositories` 与 `pnpm typecheck`：结果见
  FixSummary（本次审计未改动任何 src/db/migrations 文件，跑这两项确认基线健康）。
