# 金币经济、问卷解锁、报告抽卡与投稿生态

> 状态：核心闭环已实现并通过真实 SQL 语义测试与本地 Worker 端到端验证；
> 明确标注"暂未实现"的条目见文末。

## 1. 总览

围绕既有问卷平台新增一套用户激励与内容共享系统：

```
签到 / 挑战 / 投稿奖励 ──→  金币账本（唯一事实来源）──→ 问卷解锁 / 报告抽卡
        ↑ 管理员配置（coin_config）      ↑ 管理员调账（审计）   ↑ 奖池版本快照
```

- **身份**：一切按 `participant_hash` 归属（匿名/邮箱/Telegram，与成就、
  挑战 `task_runs` 一致）。金币不要求重复注册；投稿要求非匿名身份（问责）。
- **技术栈**：零新依赖、零新绑定。媒体复用 `KVMediaStore` + `media_assets`；
  限流复用 `rate_limits` 原子限流器；审计复用 `audit_logs`。

## 2. 数据模型（db/migrations/0078_coin_economy.sql）

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `coin_accounts` | 余额缓存 + 累计收/支 | `CHECK(balance >= 0)` |
| `coin_transactions` | 唯一事实来源流水 | `UNIQUE(idempotency_key)`；`balance_after` 同事务子查询回读 |
| `coin_checkins` | 签到日历 | `UNIQUE(participant_hash, day)` |
| `coin_challenges` / `coin_challenge_claims` | 挑战定义/领取 | `UNIQUE(challenge, 参与者, 周期键)` |
| `survey_coin_access` | 问卷金币解锁配置 | **缺行 = 免费问卷（现状不变）** |
| `survey_unlocks` | 解锁记录 | `UNIQUE(survey_id, participant_hash)` |
| `gacha_pools` / `gacha_pool_items` / `gacha_pool_versions` | 奖池/内容/版本快照 | 版本快照用于事后审计"当时概率" |
| `gacha_pulls` | 抽取记录（即收藏） | `UNIQUE(idempotency_key)`；记录 `pool_version` |
| `submissions` | 投稿状态机 | 部分唯一索引按 (参与者, 内容哈希) 去重 |
| `coin_config` | 运营配置（键 → JSON） | 业务代码只读默认值兜底，参数不写死 |

## 3. 账务安全（需求 3.2）

- **原子性**：所有金币变动与业务行（解锁、抽取、签到日历…）放在同一个
  D1 batch（隐式事务）里，要么全生效要么全回滚。
- **余额守卫**：扣款采用"前置守卫"——流水 INSERT 与余额 UPDATE 都带
  `balance >= ?` 条件，余额不足时两条语句同时落空（batch 结果 `meta.changes=0`
  检出），不存在"流水记了、余额没扣"的半笔账。已在本地 D1 与
  node:sqlite 测试双重验证。
- **幂等**：`idempotency_key` 唯一约束。签到（`checkin:{hash}:{day}`）、
  挑战（`challenge:{id}:{hash}:{周期}`）、投稿奖励（`submission:{id}`）、
  抽卡（`pull:{key}` / `pull:{key}#n`）、解锁（`unlock:{客户端键}`）、
  调账（随机 + 审计）。重复请求返回既有结果，绝不重复发放/扣款。
- **非负**：`CHECK` 约束 + 调账端点预检 + 扣款守卫三层。
- **管理员调账**：必须填原因；写入 `coin_transactions(kind='admin_adjust')`
  与 `audit_logs`；不提供任何修改/删除流水的接口，纠错走反向流水。

## 4. 签到与挑战（需求 4.x）

- 日界 = UTC + `timezoneOffsetMinutes`（默认 +8），服务端计算，不信任客户端。
- 阶梯奖励在 `coin_config.checkin.ladder`（默认 1/3/7 天 → 5/8/15）。
- 挑战进度全部由服务端按真实记录计算：`completed_surveys`、
  `checkin_streak`、`submissions_approved`、`gacha_pulls`、`plaza_posts`；
  客户端不可上报进度。领取时服务端重算，未达标拒绝。
- 挑战定义由管理员插入 `coin_challenges`（代码级默认无内置任务，避免
  "为了发币而发币"）。

## 5. 问卷解锁与动态定价（需求 5.x）

- 访问类型：免费（缺省，行为与现状完全一致）/ 密码（既有机制，未动）/
  金币解锁（作者显式启用）/ 活动价（`fixed_price=0` 即限时免费）。
- **金币门不替代密码门**：两者都启用时需先解锁再输码；金币支付不会绕过
  密码、作者权限或任何既有访问控制。
- 定价：`clamp(round(base × (1 + hotWeight·ln1p(近30天完成量)) × quality),
  min, max)`，系数/上下限/刷新间隔全部在 `coin_config.pricing`；
  价格带缓存，刷量被 `ln1p` 平滑。
- 解锁后永久有效（`survey_unlocks` 行），涨价不重复收费；重复购买幂等；
  失败不扣款。题目与 `POST /responses` 都在服务端做门禁（402）。
- 作者与管理员访问自己的问卷不受门禁影响。
- 作者侧配置入口：**暂未实现**（见 §9），当前由管理员通过
  `PUT /api/admin/coins/config` 之外直接操作 `survey_coin_access`（SQL），
  或后续在编辑器中补一个开关。

## 6. 报告抽卡（需求 6.x）

- 奖池由管理员创建（`POST /api/admin/gacha/pools`），内容来自**审核通过的
  投稿**（`POST /api/admin/submissions/:id/pool`）。绝无自动收集。
- 每次内容变更生成新 `gacha_pool_versions` 快照；抽取记录 `pool_version`，
  概率公示直接由同一快照计算，展示与算法同源。
- 抽取：服务端 `crypto.getRandomValues` 加权抽取；保底（`pity_at`，自上次
  SSR 起计数，达成必得 SR/SSR）；库存用守卫语句防并发超发，多连部分失败
  时按单元价差额自动补偿退款（幂等键 `pull:{key}:refund`，可审计）。
- 抽中内容权限：`gacha_pulls` 即凭证；`access_type` 支持永久/限时策略
  （当前默认 permanent，30 天查看窗逻辑已内置）。报告类内容走**短时签名
  URL**（7 天）展示，不透出原始答题数据与作者账号信息。
- 只消耗站内金币；无现金下注/兑换/用户间交易。

## 7. 投稿中心（需求 7.x / 8 / 9）

- 类型：`text` / `image` / `audio` / `survey_report` / `profile_card`，
  每类独立表单；`multipart` 走文件上传，JSON 走文本。
- 状态机：`pending → approved → in_pool`（或 `changes_requested / rejected /
  withdrawn / removed`）。
- 分层检测（已实现一、二层）：
  1. 字段/长度/大小限制；MIME 字节签名验证（`verifyUploadContent`，防伪造）；
     SHA-256 内容哈希 + 部分唯一索引去重（同一参与者同一内容仅一条活跃投稿）。
  2. 每人每日投稿上限 + 原子限流；重复内容直接拒绝并提示。
  3. 内容安全：**人工审核兜底**（默认全部 pending；`autoApproveText` 默认
     关）。未伪造 AI 审核结果；外部审核适配器留待后续（在
     `submission.service` 的 review 前插入）。
- 奖励：通过时 `类型基础奖励 × 质量档(1..3)`，受每日上限封顶；幂等键保证
  重复审核不重复发放；异常纠错走管理员反向流水。
- 媒体：KV 随机对象键（`media:submission:{uuid}`），读取端点按投稿状态
  授权（撤回/下架立即 404，仅作者与管理员可看非公开内容）。
- 隐私：`authorization_json` 记录明示授权（`confirmOwn` 必须显式 true，
  后端强制）；撤回即停展示；已被抽走的内容按授权条款保留必要审计；
  报告类内容只公开展示版本，绝不含其他答题者数据。

## 8. 动画与交互（需求 10.x）

- 全部纯 CSS（`admin/src/index.css` 的 `coin-*` 命名空间），无新依赖。
- 抽卡揭示层与解锁门：**业务请求在点击确认那一刻发出**；"跳过动画/收下"
  只移除视觉层，不会取消请求或重复提交；请求先行保证动画脚本失败时业务
  照常。全局 `prefers-reduced-motion` 规则自动关闭动画。
- 动画期间按钮禁用防重复点击。

## 9. 明确未实现 / 后续工作

- **作者侧"启用金币解锁"开关 UI**：数据模型与门禁已就绪，编辑器开关是
  一个小表单（当前可用管理端 SQL 配置）。
- **挑战定义管理 UI**：表与 API 已就绪，需一个管理界面（当前 SQL 插入）。
- **抽卡内容编辑器**（标题/简介/预览图精修）、奖池概率的细粒度 UI。
- 第三层内容安全的外部审核适配器（图像/音频机器审核）。
- 补签（需求 4.1 的可选项，默认关闭——按"不实现即关闭"处理）。
- 图片缩略图生成（Workers 无原生图像处理；可接 Cloudflare Image Resizing）。
- 音频时长探测（当前只限制字节大小与魔数）。

## 10. 运维要点

- 迁移：`pnpm migrate:remote`（0078，纯新增表/索引，对既有数据零影响）。
- 免费额度：所有读路径最多增加一次索引点查（`isCoinAccessEnabled`，仅
  解锁问卷才继续）；D1 行数增长主要来自流水，可按 `created_at` 归档。
- 管理页：`/admin/coin-economy`（审核 / 奖池 / 配置 / 调账与流水）。
- 用户页面：`/coins`（余额签到任务明细）、`/gacha`（奖池/收藏）、
  `/submissions`（投稿）；`/me` 顶部金币卡。
