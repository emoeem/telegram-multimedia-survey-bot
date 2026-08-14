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
/my_surveys
/admin
/export <survey_id>
/export <survey_id> xlsx
/export <survey_id> zip
/help
```

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

## 当前状态

项目已经具备可继续开发的 Serverless 骨架，但仍建议在真实部署前补齐：

- 真实 Cloudflare 资源 ID
- Webhook 完整联调
- `/admin` 管理面板
- 异步导出任务完整接入
- 更严格的文件上传大小和 MIME 校验
