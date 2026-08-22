# Telegram Multimedia Survey Bot

一个运行在 Cloudflare Workers 上的 Telegram 多媒体问卷平台。用户可以直接在 Telegram 中创建、发布和填写问卷，并异步生成统计报表与导出文件；项目不需要常驻 VPS、Docker 进程或自建 PostgreSQL 服务器。

本项目适合需要低运维成本、支持图片/视频/音频题目，并希望通过 Telegram 完成问卷收集的个人、团队和小型组织。欢迎通过 Fork + Pull Request 参与开发。

> 当前项目仍在持续迭代中。生产部署前请先在测试环境验证数据库迁移、Webhook 和导出任务。不要把任何真实 token、密码、客户数据或 Cloudflare Secret 提交到 Git。

不需要 VPS、个人服务器、Docker 常驻进程或 PostgreSQL 自建服务器。

## 架构

```text
Telegram -> Cloudflare Worker -> Survey Engine
                              -> D1 / Durable Objects / Queues
```

## 当前功能

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

### 贡献者可以从哪里开始

- `src/`：Worker、Telegram Bot、问卷引擎、数据库仓储和后台任务
- `db/migrations/`：Cloudflare D1 数据库迁移
- `tests/unit/`：单元测试
- `scripts/`：PDF 导入、授权管理和部署辅助脚本
- `docs/`：Windows 部署和交付说明

提交代码前请运行 `npm run typecheck`、`npm run lint` 和 `npm test`。请通过 Pull Request 合并到 `main`，不要直接推送主分支。

## 技术栈

- TypeScript
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Durable Objects
- Cloudflare Queues
- GitHub Actions
- Telegram Bot API Webhook

## Cloudflare 准备

部署需要一个 Cloudflare 账号，并启用 Workers、D1、KV、Queues、Durable Objects 和 Browser Rendering。先创建资源，再把资源 ID 填入 `wrangler.toml`；仓库中的账号/资源 ID 只能作为示例，部署自己的实例时应替换为自己的值。

常用命令：

```bash
npx wrangler login
npx wrangler d1 create telegram-survey-db
npx wrangler kv namespace create CACHE
npx wrangler queues create telegram-survey-export
```

首次部署还需要在 `wrangler.toml` 中确认 Worker 名称、D1 `database_id`、KV `id`，以及 Queue 名称。Durable Objects 的 class 配置已经写在文件中，迁移标签不要随意删除或重用。

## Telegram 准备

1. 向 @BotFather 创建 Bot。
2. 获取 Bot Token。
3. 生成 Webhook Secret。
4. 设置管理员 Telegram ID，逗号分隔。
5. 部署后设置 Webhook：

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<worker>.workers.dev/telegram/webhook&secret_token=<WEBHOOK_SECRET>
```

真实的 `BOT_TOKEN`、`WEBHOOK_SECRET`、`ADMIN_IDS` 和授权密钥应通过 Cloudflare Secret 或本地未跟踪的 `.dev.vars` 配置，不能写进源码、README、Issue 或 Pull Request。

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

部署完成后，可访问 `https://<worker>.workers.dev/health` 检查 Worker 是否正常，再设置 Telegram Webhook。若使用自定义域名，请把 Webhook URL 换成自定义域名地址。

GitHub Actions：

- 非 main 分支：typecheck + test
- main 分支：typecheck + test + D1 migration + deploy

需要配置 GitHub Secrets：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

GitHub Actions 只应使用仓库 Secrets 注入凭据；不要把 token 放在 workflow 文件或命令行参数中。公开仓库建议启用 Dependabot、Secret scanning 和主分支保护。

## 常用 Telegram 命令

```text
/start
/surveys
/create
/continue
/import
/my_surveys
/passwords
/admin
/licenses
/license_help
/export <survey_id>
/export <survey_id> xlsx
/export <survey_id> zip
/help
```

创建问卷时：

- `/create`、`/continue` 和 `/import` 仅对该部署的管理员开放；普通参与者只能填写问卷。
- 所有题型都可在题目标题后添加图片、视频、音频或文件。
- 单选和多选可一次发送多行选项。
- 发送带说明文字的媒体时，说明文字会作为选项名称并自动绑定媒体。
- `/save` 保存后仍可继续编辑；`/continue` 可恢复最近的 D1 草稿。
- 发送 `/passwords` 可通过问卷菜单设置、修改或清除访问密码，无需记忆内部编号。
- 题目编辑器支持选项增删、排序以及题目/选项附件管理。
- 问卷已有答卷后会锁定题目内容，复制为新问卷后可继续修改。
- 问卷详情提供预览、复制、CSV、Excel、ZIP 和 JSON 按钮。

## PDF 转 JSON

最简单的方式：

```bash
bash scripts/pdf-to-survey-easy.sh
```

首次运行会自动创建独立环境并安装所需组件；把 PDF 文件路径粘贴进去即可。完成后只需向机器人上传脚本提示的 `survey.json`，不要上传 `document.json`。

Windows 用户双击 `scripts\pdf-to-survey-easy.cmd`，再把 PDF 拖进弹出的窗口按回车。

仍可使用以下高级命令指定输出位置：

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

Windows 示例和完整排错说明见
`docs/WINDOWS_CUSTOMER_DEPLOYMENT.md`。

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

日常操作不需要阅读完整技术文档：

```text
授权方（Linux）：bash scripts/setup-license-admin.sh（只需第一次）
授权方（Linux）：bash scripts/issue-license.sh（每个客户一次）
部署者：delivery\01-发给部署服务人员\客户部署包\00-安装依赖.cmd
部署者：在 PowerShell 执行 npx wrangler login
部署者：delivery\01-发给部署服务人员\客户部署包\02-正式部署.cmd
```

发授权脚本只显示给部署者的许可证密钥；部署脚本只接受该密钥，绝不会要求厂商
管理令牌。详细但精简的操作卡见 `delivery/02-给项目所有者/` 和
`delivery/01-发给部署服务人员/`。

完整销售、部署、续费和升级流程见
`docs/WINDOWS_CUSTOMER_DEPLOYMENT.md`。

厂商自己的授权中心部署保持：

```toml
LICENSE_ENFORCEMENT = "disabled"
```

交付给客户的 Worker 设置：

```toml
[vars]
APP_VERSION = "0.3.0"
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
migration 已登记初始商业版本 `0.2.0` 和当前版本 `0.3.0`，发布日期均为
2026-08-15。

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
