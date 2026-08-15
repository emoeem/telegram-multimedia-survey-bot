# Telegram Multimedia Survey Bot

基于 GitHub + Cloudflare Workers 的 Telegram 多媒体问卷平台。

不需要 VPS、个人服务器、Docker 常驻进程或 PostgreSQL 自建服务器。

## 架构

```text
Telegram -> Cloudflare Worker -> Survey Engine
                              -> D1 / Durable Objects / Queues
```

## 功能

- 一个 Bot 支持多个问卷
- Telegram 内创建问卷
- 草稿、发布、关闭、归档状态预留
- 单选、多选、文本、长文本、数字、评分、日期、时间、媒体题
- 题目媒体和回答媒体
- 上一题、中途恢复、修改答案
- 权限：ADMIN / OWNER / PARTICIPANT
- 结果查看、统计
- CSV / XLSX / ZIP 导出
- 限时/永久商业授权、设备激活限制和独立升级权益

## 技术栈

- TypeScript
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Durable Objects
- Cloudflare Queues
- GitHub Actions
- Telegram Bot API Webhook

## Cloudflare 准备

1. 创建 Worker。
2. 创建 D1 数据库。
3. 创建 KV Namespace。
4. 创建 Queue。
5. 创建 Durable Object。
6. 将真实 ID 填入 `wrangler.toml`。

常用命令：

```bash
npx wrangler login
npx wrangler d1 create telegram-survey-db
npx wrangler kv namespace create CACHE
npx wrangler queues create telegram-survey-export
```

## Telegram 准备

1. 向 @BotFather 创建 Bot。
2. 获取 Bot Token。
3. 生成 Webhook Secret。
4. 设置管理员 Telegram ID，逗号分隔。
5. 部署后设置 Webhook：

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker>.workers.dev/telegram/webhook&secret_token=<WEBHOOK_SECRET>
```

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm install
npm run typecheck
npm test
npm run dev
```

访问：

```text
GET http://127.0.0.1:8787/health
```

## Migration

本地：

```bash
npm run migrate:local
```

远程：

```bash
npm run migrate:remote
```

## 部署

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

GitHub Actions：

- 非 main 分支：typecheck + test
- main 分支：typecheck + test + D1 migration + deploy

需要配置 GitHub Secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

## 常用 Telegram 命令

```text
/start
/surveys
/create
/continue
/import
/my_surveys
/admin
/licenses
/license_help
/export <survey_id>
/export <survey_id> xlsx
/export <survey_id> zip
/help
```

创建问卷时：

- 所有题型都可在题目标题后添加图片、视频、音频或文件。
- 单选和多选可一次发送多行选项。
- 发送带说明文字的媒体时，说明文字会作为选项名称并自动绑定媒体。
- `/save` 保存后仍可继续编辑；`/continue` 可恢复最近的 D1 草稿。
- 在 `/my_surveys` 中可为问卷设置或清除访问密码。
- 题目编辑器支持选项增删、排序以及题目/选项附件管理。
- 问卷已有答卷后会锁定题目内容，复制为新问卷后可继续修改。
- 问卷详情提供预览、复制、CSV、Excel、ZIP 和 JSON 按钮。

## PDF 转 JSON

```bash
.venv/bin/python scripts/forms_pdf_to_survey.py \
  "/path/to/form.pdf" \
  -o /tmp/form-import
```

转换完成后，先向机器人发送 `/import`，收到“请直接发送 survey.json
文件”的提示后，再把 `/tmp/form-import/survey.json` 作为普通文件上传。
新版脚本会把已关联的图片直接内嵌到 JSON，不需要额外上传 `assets`
目录；`document.json` 和 `import-report.json` 用于排查识别结果，不需要
导入机器人。

## 商业授权

当前 Worker 可以作为厂商控制的授权中心。许可证密钥只保存 SHA-256
哈希，明文只在创建时通过 Telegram 显示一次。

授权规则：

- `timed`：在使用期限内运行，到期后停止处理 Telegram Webhook。
- `perpetual`：永久运行已获得升级权益的版本。
- `updates_until`：版本发布日期不晚于该日期时，永久授权才能运行该版本。
- `max_activations`：同一许可证允许同时激活的部署数量。
- 客户 Worker 每 6 小时在线校验一次，并在授权中心网络故障时提供默认
  24 小时宽限；明确的到期、暂停、吊销和设备停用不会使用宽限。

管理员命令：

```text
/licenses
/license_help
/license_create timed 30 1 客户名称
/license_create perpetual 365 1 客户名称
/license_create perpetual forever 1 客户名称
/license_extend <授权编号> <天数>
/license_updates <授权编号> <天数|forever>
/license_deactivate <授权编号> <设备ID>
/license_suspend <授权编号>
/license_resume <授权编号>
/license_revoke <授权编号>
/release_add <版本号> [YYYY-MM-DD]
/releases
```

吊销不可恢复。需要临时停止客户使用时，应先使用 `license_suspend`。

### 客户部署

厂商自己的授权中心部署保持：

```toml
LICENSE_ENFORCEMENT = "disabled"
```

交付给客户的 Worker 设置：

```toml
[vars]
APP_VERSION = "0.2.0"
LICENSE_ENFORCEMENT = "required"
LICENSE_SERVER_URL = "https://telegram-multimedia-survey-bot.pd2335346.workers.dev"
INSTALLATION_ID = "每个客户部署固定且唯一的随机 ID"
LICENSE_GRACE_SECONDS = "86400"
```

授权密钥不要写入仓库，使用 Cloudflare Secret：

```bash
npx wrangler secret put LICENSE_KEY
```

可使用下面的命令生成稳定的安装 ID，并将结果写入客户的
`INSTALLATION_ID`：

```bash
openssl rand -hex 16
```

### 发布升级

每次发布新版本时：

1. 更新 `package.json` 和 `wrangler.toml` 中的版本号。
2. 在授权中心发送 `/release_add 0.3.0 2026-08-15` 登记实际发布日期。
3. 完成测试和 migration 后部署，再把该版本交付给有升级权益的客户。

未登记的版本会被拒绝运行，这可以防止忘记计算升级权益。`0008`
migration 已登记初始商业版本 `0.2.0`，发布日期为 2026-08-15。

### 销售边界

授权中心应始终保留在厂商控制的 Cloudflare 账户中。若向客户交付完整、
可修改源码，客户有能力删除客户端校验，因此纯源码销售无法提供强制授权
保护。需要更强约束时，应只交付构建产物，或把不可替代的核心能力保留为
厂商托管服务。

## 成本说明

不要假设“完全免费”。部署前必须核对以下服务的当前免费额度和付费规则：

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Durable Objects
- Cloudflare Queues
- Cloudflare KV
- GitHub Actions

## 安全注意事项

- 不要提交 `.dev.vars`、Bot Token、Webhook Secret。
- 使用 Cloudflare Secrets 保存生产敏感值。
- 不把用户完整答案写入日志。
- 匿名问卷的原始身份不应出现在结果和导出中。

## 部署前检查

- 应用全部 D1 migrations。
- 使用真实 Telegram Bot 做 Webhook、媒体上传和大问卷导入联调。
- 根据实际配额决定是否把大型导出进一步迁移到 Queue。
- 根据业务要求增加更严格的文件大小和 MIME 校验。
