# P0 增长地基设计：内容分级、报告分享卡、身份统一

> 状态：已实施（2026-10-15）。三个迁移 0080/0081/0082 全部落地：
> 149 个测试文件 972 例全过，本地 D1 迁移 + wrangler dev 冒烟验证通过
> （分级门 451→确认→放行、列表过滤、分享卡 r18 teaser、OG 渲染、撤销 404、
> 身份链接后的读侧并集）。实施中的取舍见文末「实施记录」。
> 背景：产品定位修正为「Web 优先的多媒体互动小说/测验平台」。当前三个地基缺口：
> ① 全平台零内容分级字段（成人内容与全年龄内容共用所有公开面）；
> ② 报告——最有传播价值的内容——是全站唯一不能分享的页面（HMAC 门禁、无 OG、无分享按钮）；
> ③ 三套身份各有独立 participant_hash 且明确不合并（`src/http/me-api.ts:14-18`），进度、金币、收藏随身份切碎。
> 三个设计对应 P0 三项，迁移号从 0080 起排（当前最大 0079）。

---

## 0. 事实基础（设计依据的现状）

| 事实 | 出处 |
|---|---|
| `surveys` 表无任何分级字段；catalog/广场/showcase/抽卡池全部无过滤 | `db/migrations/0001`，`src/http/survey/catalog.ts:173-235` |
| participant_hash 是明文前缀串：`user_{users.id}` / `email_{email_accounts.id}` / `web_{participantKey}`，非哈希 | `src/http/survey/participant.ts:100-183` |
| 已有匿名浏览器→TG 用户的绑定表 `participant_links`（participant_key PK → user_id），bot deep link `link_<key>` 认领 | `db/migrations/0044_participant_links.sql`，`participant.ts:158-175` |
| 报告 token = `{expiresAt}.{HMAChex}`，签名输入 `"{responseId}:{expiresAt}"`，密钥 `WEBHOOK_SECRET`，30 天 | `src/services/report-access-token.service.ts` |
| 报告内容 = `result_profiles`（UNIQUE(response_id)，一卷一结果），报告页是纯 SSR HTML 无前端组件 | `0013_result_visuals.sql:53-71`，`src/http/report-api.ts:285-337` |
| OG 图与完成海报渲染管线现成：`survey-og-image.service.ts`（1200×630，KV 缓存 7 天）、`completion-poster.service.ts`（1080×1350，仅 bot 预览用） | 同名文件 |
| 金币账本：`coin_accounts` PK=participant_hash（余额是缓存），`coin_transactions.idempotency_key UNIQUE` 唯一事实源 | `db/migrations/0078_coin_economy.sql:18-44` |
| 收藏=抽取记录 `gacha_pulls`；解锁=`survey_unlocks` UNIQUE(survey_id, participant_hash) | `0078:102-111, 161-174` |

---

## 设计 A：内容分级与公开面隔离（0080_content_rating.sql）

### A1. 分级模型

只做两档，不做多级：`all`（全年龄）/ `r18`。枚举留在应用层，未来扩展 `mature` 等不改表。

```sql
-- 0080_content_rating.sql
ALTER TABLE surveys ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE gacha_pool_items ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE plaza_posts ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';
ALTER TABLE showcase_persons ADD COLUMN content_rating TEXT NOT NULL DEFAULT 'all';

CREATE TABLE participant_preferences (
  participant_hash TEXT PRIMARY KEY,
  age_verified_at TEXT,            -- r18 门确认时间戳，NULL = 未确认
  updated_at TEXT NOT NULL
);
```

默认 `all`，全部存量内容自动向后兼容。**存量治理是运营动作不是迁移动作**：上线后用管理端批量把已知的成人卷（如《情景-沉沦的欲望》类）标为 r18。

### A2. 写入路径

- 编辑器：问卷设置面板加「内容分级」开关（`admin/src` 编辑器设置区），走现有 `PUT /api/admin/surveys/:id` 更新链路；`status='published'` 且已有答卷的问卷改分级弹确认框（同结构保护的交互惯例）。
- 发布门禁：`publishSurvey()`（`src/services/survey.service.ts:112-123`）处校验 `content_rating ∈ {all, r18}`，非法值拒发。
- 投稿/抽卡入池：`submissions` 审核通过入池时，`content_rating` 从来源问卷继承（答卷报告类投稿取所属问卷的分级），管理员不可调低为 `all`（只能维持或下架）。

### A3. 读取路径与门禁

- **年龄确认**：`POST /api/me/preferences {ageVerified: true}` → 写 `participant_preferences.age_verified_at`；前端在 r18 入口（目录徽章点击、r18 问卷链接）弹一次确认门。匿名 key 也能确认（按浏览器记忆），换设备重确认——分级门是合规 UX 不是安全边界，服务器记录 attestation 即可。
- **目录**（`loadPublishedSurveyList`，`catalog.ts:173`）：SQL 加 `AND s.content_rating = 'all'`（未确认者）；已确认者返回全部 + 每项 `contentRating` 字段，列表页渲染 `18+` 徽章。KV 缓存键按查看者分桶：`survey-list:v4:{stamp}:{gated|full}`（现有 stamp 机制不变，`catalog.ts:162-171`）。
- **广场/展示区/抽卡池**：repository 查询同样追加分级过滤；r18 帖/人物/奖池对未确认者直接不可见（不是打码，是不可见）。抽卡抽取校验：`drawGacha` 入口检查池子分级与查看者 attestation。
- **问卷填写页**：r18 问卷的 `/s/:id` 与 definition API 在无 attestation 时先返回 451 + 前端确认门，确认后放行。

### A4. 传播安全（与设计 B 联动）

- r18 问卷的 OG 图：`survey-og-image.service.ts` 渲染时忽略封面，用中性底 + 标题 + `18+` 徽章——**链接在任何渠道 unfurl 都是安全的**。
- r18 报告分享卡只出 teaser 形态（见 B4）。

---

## 设计 B：报告分享卡（0081_report_shares.sql）

### B1. 模型： opting 一等公民化

分享是**参与者主动、逐份、可撤销**的动作，不是报告页的全局开关。

```sql
-- 0081_report_shares.sql
CREATE TABLE report_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,             -- 128bit 随机串，DB 可撤销，不用无状态 HMAC
  response_id INTEGER NOT NULL UNIQUE REFERENCES survey_responses(id),
  participant_hash TEXT NOT NULL,
  survey_id INTEGER NOT NULL,
  result_type TEXT,                       -- 冗余快照，防结果重算后卡片语义漂移
  result_title TEXT,
  survey_title TEXT,
  content_rating TEXT NOT NULL DEFAULT 'all',
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_report_shares_participant ON report_shares(participant_hash);
```

选 DB 随机 token 而非报告页的无状态 HMAC：分享链接要**永久 + 可撤销**，与 30 天过期的私有 token 语义相反。

### B2. API

| 端点 | 行为 |
|---|---|
| `POST /api/me/reports/:responseId/share` | 创建或返回已有分享（幂等）。校验：response 归属当前身份（走 C 的 hash 集合）。限流 5 次/天。返回 `{url: "/r/{token}", ogUrl}` |
| `DELETE /api/me/reports/:responseId/share` | `revoked_at` 置位；`/r/{token}` 此后 404 |
| `GET /r/:token` | 公开页 + OG meta（SSR，同现有报告页技术栈） |

### B3. 安全投影（核心约束）

`/r/:token` **不复用** `buildReportViewModel` 全量输出，新增 `buildShareCardViewModel`，白名单字段：

- 允许：问卷标题、result 标题/副标题、tags、封面类图片、完成日期、"N 题完成"；
- 禁止：任何答案原文、长文本回答、stats 数值字段（可能含敏感输入）、gallery 逐张图、参与者任何身份信息。

页面 CTA：问卷链接（「我也测测」）+「结局卡来自《XX》」。r18 卷的问卷链接照常（入口有 A3 门禁兜着）。

### B4. 两种卡形态

- **all**：完整结局卡。渲染管线复用 `completion-poster.service.ts` 的 HTML→puppeteer 截图（1080×1350 竖版）+ `survey-og-image.service.ts` 模式出 1200×630 OG 版，KV 缓存键 `share-card:v1:{token}:{fingerprint}`，TTL 7 天。
- **r18**：teaser 卡——结果标题替换为中性文案（如「达成隐藏结局」）+ 模糊艺术图 + `18+` 徽章。OG unfurl 永远安全。

### B5. 前端改动

- 报告页（`report-api.ts:330` 注入点）：加「分享结局卡」按钮 → 弹层确认（列明"将公开：结局名与卷名；不会公开你的答案"）→ 成功后给复制链接 + 卡片预览。
- 完成页（`SurveyApp.tsx` 交卷态）：加同款入口，取代现在"查看报告/下载 PDF"二选一的死胡同。
- `/me` 报告列表：已分享的卷显示「已分享 · 撤销」。

---

## 设计 C：身份统一（0082_identity_link_map.sql）

### C1. 关键判断：不做数据搬迁，做"映射 + 读侧并集"

participant_hash 全部是确定性前缀串，且 `user_{id}` / `email_{id}` 已指向真实账户行。因此**不需要重写 11 张历史表的外键**，只需要：

```sql
-- 0082_identity_link_map.sql
CREATE TABLE participant_hash_links (
  source_hash TEXT PRIMARY KEY,      -- 如 email_42 / web_aBcD...
  canonical_hash TEXT NOT NULL,      -- 如 user_7
  method TEXT NOT NULL,              -- 'tg_init' | 'email_code' | 'claim_code' | 'admin'
  created_at TEXT NOT NULL
);
CREATE INDEX idx_phl_canonical ON participant_hash_links(canonical_hash);
```

规则：

- **canonical 永远是人**（`user_{users.id}`），邮箱/匿名 hash 是 source。TG 用户与邮箱账户之间也建立 users↔email_accounts 关联（`email_accounts` 加 `user_id` 列，NULL=未关联）。
- `resolveParticipant()`（`participant.ts:100-183`）解析出原始 hash 后，经 `canonicalizeHash(hash)`（查 links 表，KV 缓存 5 分钟）得到 canonical hash 返回；新增 `hashesFor(hash)` 返回 `[canonical, ...sources]` 供读侧并集。
- **读侧并集**：me-api、金币、成就、解锁、收藏、答卷历史的查询从 `WHERE participant_hash = ?` 改为 `WHERE participant_hash IN hashesFor(?)`。历史数据原地不动、语义立即可见。
- **写侧归一**：新写入（新答卷、新交易）一律落 canonical hash；source hash 从此只读。
- **解绑**：删除 link 行 + `email_accounts.user_id` 置 NULL，数据各自回到原 hash 视图，无损。

### C2. 金币合并（唯一需要搬的数据）

余额是缓存、流水是事实源，所以合并 = 一笔特殊交易，不碰任何历史流水：

```
linkUserAccounts(canonical, source):
  1. BAL = source 余额（coin_accounts）
  2. D1 batch 原子执行：
     - source 账户 balance → 0（CHECK 允许）
     - canonical 账户 balance += BAL，total_earned += BAL
     - coin_transactions 插入 {participant: canonical, amount: +BAL,
        kind: 'merge_in', idempotency_key: 'merge:{source_hash}'}   -- UNIQUE 天然幂等
  3. 签到/挑战/解锁/收藏/成就：不搬，读侧并集已覆盖
     （UNIQUE(participant_hash, day) 等约束下并集查询天然去重语义正确）
```

`survey_unlocks` 并集查询意味着：邮箱身份买过的卷，绑定 TG 后依然已解锁，不重复收费。

### C3. 绑定流程（三补全）

1. **匿名 → 邮箱**（最高频，Web 核心场景）：登录邮箱账户时，前端把 localStorage 的 `x-participant-key` 一并提交 → `POST /api/auth/link` `{method: 'claim_code'}` → `web_{key}` 映射到 `email_{id}` 的 canonical（若该邮箱已有 user 则到 `user_{id}`）。「换设备/清缓存前的进度找回」从此有解。
2. **匿名 → TG**：现有 `participant_links` + deep link 流程保留，新增落一条 `participant_hash_links(web_key → user_id)`，两条表短期并存（`participant_links` 逐步退役只读）。
3. **邮箱 ↔ TG**：设置页「绑定 Telegram」→ TG WebApp 校验通过后 `email_accounts.user_id = user.id` + 落 link 行。反向同理。

防滥用：link 操作限频（每 canonical 3 次/天）；`merge:{source_hash}` 幂等键保证同一 source 只被吸收一次；解绑后重新绑定不允许再次触发余额转移（幂等键已存在 → 0 转移，避免刷币）。

### C4. 明确不做

- 不改 participant_hash 的字符串格式（全部历史数据以此键存储）；
- 不做反向拆分迁移（canonical 数据迁回 source）；
- 不合并 trial 排行榜历史（`task_runs` 并集查询会让排行榜变成"人"而不是"身份"——**排行榜刻意保留按身份展示**，与现有语义一致，是否切换为按人由 P1 再议）。

---

## 实施顺序与涉及面

| 步骤 | 内容 | 主要文件 |
|---|---|---|
| 1 | 0080 迁移 + 编辑器分级开关 + catalog/plaza/showcase/gacha 过滤 + 年龄确认 API | `src/http/survey/catalog.ts`、`src/http/plaza-api.ts`、`src/http/showcase-api.ts`、`src/services/coin/gacha.service.ts`、admin 编辑器 |
| 2 | 0081 迁移 + share API + `/r/:token` SSR 页 + 安全投影 + 两形态卡片渲染 | `src/http/me-api.ts`、新 `src/http/share-api.ts`、`completion-poster.service.ts`、`survey-og-image.service.ts`、`report-api.ts` |
| 3 | 0082 迁移 + `canonicalizeHash/hashesFor` + 各读接口并集改造 + 金币合并交易 + 绑定 API | `src/http/survey/participant.ts`、`src/http/me-api.ts`、`src/services/coin/*.ts`、新 `src/services/identity-link.service.ts` |

三步相互独立可分开发布；A 先行因为它解锁 B 的 r18 形态与公开面安全。

## 开放决策点（评审时定）

1. **r18 门要不要对未登录匿名用户也记 attestation**：本设计记（participant_preferences 主键即匿名 hash）——如认为匿名不该记，改 localStorage 即可，但换设备会重复弹门。
2. **分享卡默认公开时长**：本设计永久（可撤销）。若担心已删问卷的分享残留，可在问卷删除/归档时级联 revoke。
3. **金币合并是否需要用户显式确认**：本设计在绑定确认弹层里明示「金币将合并」，不单独二次确认。
4. **排行榜是否切换为按人**：留到 P1，本设计保留按身份。


---

## 实施记录（与设计稿的差异）

1. **列表过滤放在服务侧**而不是按查看者分桶缓存：单一 KV 条目省 KV 写预算
   （免费版 1,000 写/天），代价是已确认年龄者拿到的列表上限仍是 200 条的
   全量投影。列表投影版本升到 v4。
2. **`user_*` hash 直通**：canonicalizeHash 对 `user_*` 前缀零查询返回；
   `web_*`/`email_*` 走 KV 负缓存（`idlink:v1:{hash}`，5 分钟）——未绑定用户
   的稳态成本是一次 KV 读。
3. **归属查询用 SQL 侧并集**（`HASH_SET_SQL` 常量）：作答/提交/续答的折叠
   路径不加往返。排行榜（task_runs top20）保持按身份，未切按人。
4. **邮箱登录自动认领**：EmailAuthScreen 的请求现在携带 `x-participant-key`，
   register/login 成功后服务端静默认领（失败不阻断登录）。
5. **年龄确认随认领迁移**：claimParticipantKey 把 source 的 attestation 行
   移到 canonical（canonical 已有则不动）。
6. **分享撤销后重建换新 token**（旧链接立即失效）；撤销后的 `/r/:token`
   返回 404（对爬虫/平台预览表现为失效）。
7. 金币合并幂等键 `merge:{source_hash}`：解绑重绑不二次吸收（防刷币），
   零余额也落一行 merge_in 占住幂等键。
8. 已知边界：目录缓存里的 contentRating 依赖 updated_at 翻新——生产唯一写
   路径（编辑器 PATCH）总是 bump updated_at，直连 SQL 改分级不会翻新缓存
   （本地冒烟时踩过，生产无此路径）。


---

## P1/P2 实施记录（2026-10-16 上线）

**P1（留存变现闭环）**
- 0083 系列模型：`survey_series` + `surveys.series_id/series_order`。作者 API
  （/api/admin/series：建系列、挂/摘章节、含草稿章节视图）；公开 API
  （/api/series 书架、/api/series/:slug 详情）。详情含续读推导（按查看者答卷
  状态）、章节金币解锁状态（复用 unlock.service 并集判定）、关注状态。
  SPA：/series 书架与连载页（章节 ✓已完成/继续/🔒/18+），「我的」页有入口。
- 0084 追更：`series_follows` + `notifications`。发布挂载系列的问卷时，经
  SELF binding fire-and-forget 调内部端点（HMAC-SHA256 验签）：全部关注者插
  站内通知，绑定 TG 身份的关注者逐个私聊兜底（上限 50 人、3 秒超时、失败
  静默）。「我的」页新增通知区块（未读红点，打开即清）。
- 结局收集生成器：编辑器「生成结局奖池」按钮 → `POST /api/admin/surveys/:id/
  result-pool`，把结果规则的 resultTypes 变成 `ending-{surveyId}` 奖池的第一方
  结局卡（草稿态，价格/上架在抽卡管理页调）。

**P2（引擎升级与拉新）**
- flags 引擎：`condition_json` 新增 `flagRules`（答案命中给 flag 累计分）与
  `flagJumps`（门槛达标向前跳）。零迁移——flags 永远由已保存答案确定性重放，
  续答不丢路线。服务端 engine、SPA 跳题、发布图谱校验三处同构实现；
  flagJumps 目标进入可达性近似（不会误报不可达）。
- VN 播放模式：`theme.vn` 开启后叙事卡（note 节点）文字打字机逐字展现，
  点击补全，respect prefers-reduced-motion；不开启的问卷行为不变。
- 朋友互测：`POST /api/admin/surveys/:id/answer-key` 把一份已完成答卷设为
  答案钥匙（存 settings_json）；结果管线对照钥匙算默契得分注入
  `metadata.agreement` + stats「默契 N/M」；结局分享卡展示默契得分。
  钥匙答案本身永不下发。
- Wrapped 个人画像：0085 `profile_shares` + `POST/GET/DELETE
  /api/me/profile-share` + 公开页 `/u/:token`（含 og.png，KV+Browser Rendering
  缓存）。快照只含聚合数字（完成卷数/结局收集/成就/挑战分/起始日），
  「我的」页一键生成/复制/撤销。

**验证**：151 个测试文件 980 例全过（新增 flags 引擎 4 例、系列/追更 4 例）；
两端 tsc 干净、lint 干净、admin 构建通过；本地 D1 迁移 + wrangler dev 冒烟
（书架/详情/续读推导/关注/画像页与 OG 渲染）；生产已部署并验证
（/api/series 空 shelf 正确、/series 200、r18 门保持）。


---

## Web 原生化与注册墙（2026-10-16 第二批，已上线）

1. **树洞 Web 原生发帖**：plaza 的发帖/评论/配图上传/晒进度四处身份门从
   「仅 Telegram」放开为「任何有 users 行的身份」。邮箱注册/登录时自动创建
   合成 users 行（telegram id 段 1e12+accountId，与真实 TG id 隔离）并落
   0082 映射——Web 用户的 canonical 从此也是 user_{id}。
2. **trial 排行榜按人**：runs 本就按 user_id 去重；邮箱用户有了 users 行后
   自动入榜。「我的」标记按 user_id 判定（绑定前旧 hash 的局也算本人）。
3. **flags 可视化编排**：编辑器题目卡新增两处——单选题每个选项一行
   「命中 Flag（flag 名 + 分值）」；所有题型通用「剧情 Flag 跳转」行组
   （Flag ≥ 门槛 → 目标题）。条件四区段（选项跳转/answerRules/flagRules/
   flagJumps）集中构建互不覆盖；未完成的行只存本地草稿。
4. **填卷强制注册（产品决策）**：开卷/作答/提交/媒体上传四个写入口拒绝
   匿名浏览器 key（401 registration_required）；SPA 开卷收到该码时渲染登录门
   （去 /auth 注册登录后点「重试」续上）。Telegram 打开自动带身份不受影响；
   目录浏览、r18 年龄门、报告/分享均不受影响。
   注：账号即邮箱+密码（邮箱就是用户名），验证码依赖 RESEND 配置。

**验证**：980 例全过（防刷集成测试从匿名 key 改为铸造参与者 token，语义不变）；
两端 tsc / lint / admin 构建干净；本地冒烟（匿名开卷 401、匿名发帖 401、
已链接 key 的行为一致性）；生产已部署（版本 1da60c99）并验证墙生效。


---

## 编辑器创作侧补全（2026-10-16 第三批，已上线）

1. **进度条按路线语义**：routeProgress 从头重放真实跳转链（复用答题侧
   nextIndex），按路线作答步数计进度；线性问卷行为完全兼容。
2. **编辑器内试玩**：LivePreview「试玩」按钮 → TrialPlay 组件——直接复用
   服务端 engine.getNextQuestionAfterAnswers（跳转与玩家同源），从任意节点
   出发，足迹显示已走节点序列，支持回退，终局显示步数/去重节点数。
3. **VN 皮肤**：note 题新增 settings.speaker（服务端 settings 白名单同步
   放开「说话人」）；theme.vn 开启时场景背景 fixed 铺满视口、叙事卡改为
   底部对话框（名牌 + 打字机 + 继续）；主题面板新增「视觉小说模式」开关。
4. **单卷结局图鉴**（0086 ending_unlocks）：提交完成即判定落幂等解锁行；
   GET /api/survey/:id/endings 返回并集解锁进度与规则集总数；完成页图鉴卡
   （已解锁列表 + ？？？占位 + 重玩提示）。

Git：本批起恢复逐特性提交（基线收敛提交 + 每特性一笔）。
