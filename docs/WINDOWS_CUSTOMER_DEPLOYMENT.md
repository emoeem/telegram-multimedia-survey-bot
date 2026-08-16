# Windows 客户部署、授权与升级手册

## 日常部署先看这里

首次给客户部署时，不需要先阅读这份完整参考。直接发送
`delivery/01-发给部署服务人员/`，部署人员只做三件事：双击
`00-安装依赖.cmd`，运行 `npx wrangler login`，再双击 `02-正式部署.cmd`。
授权方先在 `delivery/02-给项目所有者/` 双击 `01-一键发放授权.cmd`，把显示的
密钥交给部署人员即可。以下内容仅供首次搭建、升级和故障排查时查阅。

本文档面向软件销售方和 Windows 客户，适用于当前的 Telegram
多媒体问卷机器人项目。

## 1. 你卖的是什么

当前授权模型是“客户独立部署授权”，不是公共机器人里的会员或用户席位。

每个客户拥有：

- 一个由客户在 BotFather 创建的 Telegram Bot。
- 一个客户专用 Cloudflare Worker。
- 一个客户专用 D1 数据库。
- 一个客户专用 KV Namespace。
- 一个客户专用 Queue。
- 客户自己的问卷、答卷、媒体引用和管理员名单。

软件销售方保留：

- 厂商授权中心 Worker。
- 许可证创建、延期、暂停、恢复和吊销能力。
- 软件版本登记和升级权益判断。
- 软件源码或发布包的后续版本。

客户普通用户只能浏览和填写该客户 Bot 内的问卷。写入
`ADMIN_IDS` 的 Telegram 数字 ID 才能创建、导入、编辑、发布、管理和
导出问卷。

## 2. 可销售的授权类型

简单授权命令：

```text
/license_create 30 客户名
/license_create 365 客户名
/license_create forever 客户名
```

- `30`：从创建时间开始可使用 30 天。
- `365`：从创建时间开始可使用 365 天。
- `forever`：永久使用，并包含永久升级。
- 简单格式默认只允许激活一个客户部署。

高级格式：

```text
/license_create timed <使用天数> <设备数> <客户名>
/license_create perpetual <升级天数|forever> <设备数> <客户名>
```

“永久使用、有限升级”示例：

```text
/license_create perpetual 365 1 客户名
```

这表示软件使用权永久有效，但只能运行发布日期不晚于升级截止日期的版本。

## 3. 托管部署与客户独立部署

### 客户独立部署

推荐的当前销售方式。客户使用自己的 Cloudflare 账号和 Bot Token。

优点：

- 客户数据和资源相互隔离。
- 厂商不需要承担所有客户的 Cloudflare 用量。
- 客户可以掌握自己的 Bot 和数据。
- 许可证可以控制使用期限、激活数量和升级权益。

注意：

- 客户必须有 Cloudflare 账号。
- 客户需要保留部署目录，后续升级时复用。
- 若交付完整可修改源码，客户理论上可以删除授权校验。

### 厂商托管

厂商也可以代客户持有 Cloudflare 资源，但必须仍为每个客户建立独立资源，
不要让客户共用厂商问卷数据的 D1、KV 和 Queue。

托管模式下，Cloudflare 费用、数据管理、备份和故障处理都由厂商负责。

## 4. Windows 环境要求

客户电脑建议准备：

- Windows 10 或 Windows 11。
- Node.js 当前 LTS 版本，安装时勾选加入 `PATH`。
- Git for Windows；如果使用完整 ZIP 发布包，Git 不是必需的。
- Cloudflare 账号。
- Telegram 账号。
- 项目发布包。

不要求：

- Python。
- WSL。
- Linux。
- Docker。
- VPS 或常驻服务器。

PDF 转 JSON 是厂商或高级用户工具，才需要 Python 和 PyMuPDF。

## 5. 首次初始化厂商授权中心

此部分只由软件销售方执行一次。客户不要执行。

### 5.1 安装依赖并应用数据库 migration

在项目目录打开 PowerShell 或命令提示符：

```powershell
npm install
npx wrangler login
npm run migrate:remote
```

`0008_software_licensing.sql` 会创建许可证、激活记录和版本登记表。

### 5.2 创建授权中心管理令牌

双击：

```text
scripts\setup-license-admin.cmd
```

或执行：

```powershell
npm run license-admin:setup
```

脚本会：

1. 生成高强度管理令牌。
2. 保存到本地 `.license-admin.env`。
3. 写入厂商 Worker 的 Cloudflare Secret `LICENSE_ADMIN_TOKEN`。

`.license-admin.env` 已加入 `.gitignore`，不要提交、发送给客户或放进发布包。

需要主动更换令牌时：

```powershell
node scripts/setup-license-admin.mjs --rotate
```

更换后，旧令牌会立即失效。

### 5.3 部署厂商授权中心

```powershell
npm run typecheck
npm test
npm run migrate:remote
npm run deploy
```

厂商 Worker 的 `wrangler.toml` 必须保持：

```toml
LICENSE_ENFORCEMENT = "disabled"
```

这表示厂商授权中心自身不依赖另一张许可证。客户部署配置才使用
`LICENSE_ENFORCEMENT = "required"`。

## 6. 为客户准备 Telegram Bot

1. 在 Telegram 中打开官方 `@BotFather`。
2. 发送 `/newbot`。
3. 设置显示名称和以 `bot` 结尾的用户名。
4. 保存 BotFather 返回的 Bot Token。
5. 不要把 Bot Token 发到群聊、工单截图或公开仓库。

Bot Token 只在部署时输入，自动部署工具不会把它写进
`wrangler.toml` 或 `deployment-manifest.json`。

## 7. 获取管理员 Telegram 数字 ID

`ADMIN_IDS` 要填写数字 ID，不是 `@username`。

可选方法：

1. 使用可信的 Telegram ID 查询机器人获取数字 ID。
2. 让管理员向已经运行的 Bot 发送消息，再从受控的 Worker 日志读取
   `from.id`。
3. 使用 Telegram Bot API 的更新数据读取 `message.from.id`。

多个管理员用英文逗号分隔：

```text
123456789,987654321
```

写入名单的人可以创建、导入、编辑、发布和导出问卷，也能访问管理员功能。

## 8. Cloudflare 认证方式

自动部署工具支持两种方式。

### 方式 A：Wrangler 浏览器登录

```powershell
npx wrangler login
```

部署工具询问 Cloudflare API Token 时可直接回车。

### 方式 B：API Token

在当前 PowerShell 会话设置：

```powershell
$env:CLOUDFLARE_API_TOKEN = "你的 Cloudflare API Token"
$env:CLOUDFLARE_ACCOUNT_ID = "你的 Cloudflare Account ID"
```

Token 必须能管理本次使用的 Workers、D1、KV 和 Queues 资源。Cloudflare
后台权限名称可能调整，应按当前控制台显示授予最小必要权限。

不要把 API Token 写进项目文件或发送给软件销售方。

## 9. Windows 一键部署客户实例

### 9.1 先预演

在项目根目录执行：

```powershell
scripts\deploy-customer.cmd --dry-run
```

按提示输入：

- 客户名称。
- 管理员 Telegram 数字 ID。
- 授权期限。
- Cloudflare Account ID，可留空。
- Telegram Bot Token。
- Cloudflare API Token，可留空。

授权期限可以输入：

```text
30
365
forever
existing
```

- 输入天数或 `forever`：工具通过厂商授权中心自动创建许可证。
- 输入 `existing`：工具会继续询问现有许可证密钥。

`--dry-run` 只显示计划并生成测试配置，不会创建资源、发放真实许可证、
部署 Worker 或设置 Webhook。

### 9.2 正式部署

双击：

```text
scripts\deploy-customer.cmd
```

或执行：

```powershell
npm run customer:deploy
```

工具自动完成：

1. 创建或复用客户专用 D1。
2. 创建或复用客户专用 KV。
3. 创建或复用客户专用 Queue。
4. 生成客户专用 `wrangler.toml`。
5. 写入 `ADMIN_IDS`、`APP_VERSION` 和授权配置。
6. 通过临时 Secret 文件上传 Bot Token、Webhook Secret 和许可证密钥。
7. 对客户 D1 应用全部远程 migration。
8. 部署客户 Worker。
9. 调用 Telegram `setWebhook`。
10. 输出 Worker 地址、Webhook 地址、管理员 ID 和安装 ID。

生成目录：

```text
customer-deployments\<worker-name>\
```

其中：

- `wrangler.toml`：客户资源绑定和非敏感配置。
- `deployment-manifest.json`：部署状态、资源 ID、Worker 地址和稳定安装 ID。
- `.pending-license.json`：仅在发证后、部署成功前临时存在。
- `.customer-secrets.tmp`：仅在 Wrangler 部署期间临时存在。

最后两个文件都已加入 `.gitignore`。部署成功后会自动删除。

### 9.3 命令行完整示例

不建议把真实 Secret 直接写在命令历史中。下面只展示参数结构：

```powershell
node scripts/deploy-customer.mjs `
  --customer-name "客户甲" `
  --admin-id "123456789" `
  --license-period 365 `
  --worker-name "survey-customer-a"
```

敏感值优先使用交互输入或环境变量：

```powershell
$env:TELEGRAM_BOT_TOKEN = "..."
$env:CLOUDFLARE_API_TOKEN = "..."
scripts\deploy-customer.cmd
```

## 10. 失败后如何继续

不要删除已经生成的客户部署目录。

使用相同：

- 客户名称。
- Worker 名称。
- `--deployment-dir`。

重新运行部署脚本。工具会：

- 复用已创建的 D1、KV 和 Queue。
- 复用 `deployment-manifest.json` 中记录的资源。
- 复用未完成部署时暂存的许可证，避免重复发证。
- 已成功部署过的实例会保留 Cloudflare 中现有的 `LICENSE_KEY` Secret，
  升级时不会自动创建新许可证。
- 重新执行未完成的 migration、部署和 Webhook 步骤。

示例：

```powershell
scripts\deploy-customer.cmd `
  --customer-name "客户甲" `
  --worker-name "survey-customer-a" `
  --deployment-dir "customer-deployments\survey-customer-a"
```

## 11. 首次验收

部署完成后按顺序测试。

### 健康检查

浏览器打开：

```text
https://<客户 Worker 地址>/health
```

应返回：

```json
{
  "ok": true,
  "environment": "production",
  "version": "0.3.0",
  "licenseEnforcement": "required"
}
```

### 管理员测试

1. 向客户 Bot 发送 `/start`。
2. 发送 `/create`，应能创建问卷。
3. 发送 `/import`，应提示上传 `survey.json`。
4. 发送 `/my_surveys`，应看到自己的问卷。
5. 创建并发布一个最小测试问卷。

### 普通用户测试

使用不在 `ADMIN_IDS` 中的账号：

1. 发送 `/start`。
2. 发送 `/surveys`，应能浏览和填写问卷。
3. 发送 `/create`，应提示没有创建权限。
4. 发送 `/import`，不应进入导入状态。

## 12. 问卷答案和导出权限

客户管理员和问卷所有者可以查看答卷详情和导出结果。

当前支持：

```text
/export <内部编号> csv
/export <内部编号> xlsx
/export <内部编号> zip
```

问卷详情菜单也提供 CSV、Excel、ZIP 和 JSON 按钮。

- CSV、Excel 用于结构化答卷。
- ZIP 用于包含更多导出文件的压缩包。
- 单份答卷可从答卷详情中导出 PDF。
- 图片形式的答卷导出目前不是独立格式，需要后续增加专用渲染。
- 普通参与者不能查看其他人的答卷。

## 13. PDF 转 JSON

### Windows 环境准备

最简单的方式：双击 `scripts\pdf-to-survey-easy.cmd`。首次使用会自动创建 Python 环境和安装 PyMuPDF；把 PDF 文件拖进窗口并按回车。完成后只上传提示路径中的 `survey.json`，不要上传 `document.json`。

如需手动安装或指定输出目录，再使用以下方式：

安装 Python 3 后，在项目目录执行：

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install pymupdf
```

转换：

```powershell
.\.venv\Scripts\python.exe scripts\forms_pdf_to_survey.py `
  "C:\Users\你的用户名\Downloads\表单.pdf" `
  -o "C:\Users\你的用户名\Downloads\form-import"
```

输出目录包含：

- `survey.json`：上传给机器人。
- `document.json`：PDF 文字、位置和图片提取明细。
- `import-report.json`：识别统计和警告。
- `assets`：提取出的原始图片，用于排查。

新版 `survey.json` 会内嵌已经关联的图片，不需要单独上传 `assets`。

机器人导入步骤：

1. 管理员向 Bot 发送 `/import`。
2. 收到上传提示后，把 `survey.json` 作为 Telegram 文件发送。
3. 不要发送本地文件路径文本。
4. 导入完成后查看自动修复警告。
5. 在 `/my_surveys` 中预览并检查低置信度题目。

PDF 识别修复规则：

- 两个明确的短选项被换行合并时，自动拆成两个选项。
- 只有一个长选项且无法可靠恢复时，自动转成文本题。
- 原识别内容会保留到题目说明。
- 不会凭空添加“是”“否”或“其他”。

## 14. 许可证日常管理

查看授权：

```text
/licenses
```

延长限时授权：

```text
/license_extend <授权编号> <天数>
```

暂停：

```text
/license_suspend <授权编号>
```

恢复：

```text
/license_resume <授权编号>
```

永久吊销：

```text
/license_revoke <授权编号>
```

吊销不能恢复。客户临时欠费或需要暂停服务时，优先使用暂停。

## 15. 更换 Cloudflare 账号或重新部署

`INSTALLATION_ID` 是许可证激活设备标识。

同一客户正常升级时：

- 保持原部署目录。
- 保持原 `INSTALLATION_ID`。
- 保持原许可证密钥。

客户更换 Cloudflare 账号或需要全新部署时：

1. 从 `/licenses` 查看许可证。
2. 找到旧安装 ID。
3. 执行：

```text
/license_deactivate <授权编号> <旧安装ID>
```

4. 使用新安装 ID 部署。

如果许可证只允许一个激活，而旧安装未停用，新部署会返回
`activation_limit_reached`。

## 16. 发布和升级

### 厂商发布新版本

1. 修改代码和 migration。
2. 更新 `package.json` 和部署配置中的 `APP_VERSION`。
3. 运行全量测试。
4. 应用厂商 D1 migration。
5. 在授权中心登记版本和实际发布日期：

```text
/release_add 0.3.0 2026-08-15
```

6. 部署厂商授权中心。
7. 向有升级权益的客户提供新发布包。

未登记的软件版本会被授权中心拒绝，防止绕过升级期限判断。

### 客户升级

客户在原项目和原部署目录执行升级脚本或重新运行部署工具：

```powershell
npm install
npm run typecheck
npm test
scripts\deploy-customer.cmd `
  --customer-name "原客户名称" `
  --worker-name "原 Worker 名称" `
  --deployment-dir "原部署目录"
```

必须保持：

- 原许可证密钥。
- 原 `INSTALLATION_ID`。
- 原 D1、KV 和 Queue 绑定。

工具会先应用新 migration，再部署新 Worker 版本。

## 17. 数据备份与迁移

发布高风险 migration 或客户升级前，应先备份客户 D1。

最低要求：

- 记录客户 Worker、D1、KV 和 Queue 名称。
- 保存客户部署目录。
- 保存客户 Bot 用户名和管理员 ID。
- 定期导出重要问卷和答卷。
- 不把客户数据复制到厂商公共 D1。

Cloudflare 的备份、导出和恢复能力可能随账号套餐变化，应以客户账号当前
控制台和 Wrangler 功能为准。

## 18. 安全要求

- 不提交 `.dev.vars`、`.license-admin.env` 或任何 Secret。
- 不提交 `customer-deployments`。
- 不在命令截图中显示 Bot Token、API Token 或许可证密钥。
- 不把厂商 `LICENSE_ADMIN_TOKEN` 交给客户。
- 每个客户使用独立 Bot Token 和独立 Cloudflare 资源。
- 厂商授权中心使用 `LICENSE_ENFORCEMENT = "disabled"`。
- 客户 Worker 使用 `LICENSE_ENFORCEMENT = "required"`。
- 问卷访问密码与软件许可证是两个不同概念。
- 问卷访问密码只限制参与者进入某一份问卷。
- 软件许可证控制整个客户部署是否可以继续处理 Telegram Webhook。

## 19. 常见错误

### `this question type requires at least two options`

重新使用当前版本导入原 `survey.json`。导入器会自动修复明确的短选项合并，
并把无法可靠恢复的题目转成文本题。

### `activation_limit_reached`

许可证激活数量已满。先停用旧安装，或创建允许更多激活的许可证。

### `version_not_registered`

当前 `APP_VERSION` 没有在授权中心通过 `/release_add` 登记。

### `updates_expired`

客户的永久授权仍可使用旧版本，但不包含当前新版本的升级权益。可以延长
升级期限，或让客户继续运行其权益范围内的版本。

### `license_expired`

限时授权已到期。使用 `/license_extend` 延长。

### `license_suspended`

许可证被暂停。确认付款或风险状态后使用 `/license_resume`。

### `license_unavailable`

检查：

- 客户 Worker 是否配置 `LICENSE_ENFORCEMENT = "required"`。
- `LICENSE_SERVER_URL` 是否是厂商授权中心地址。
- `LICENSE_KEY` 是否作为 Cloudflare Secret 上传。
- `INSTALLATION_ID` 是否存在且保持不变。
- 厂商授权中心是否可访问。

### `没有创建问卷的权限`

检查该用户的数字 Telegram ID 是否写入客户配置的 `ADMIN_IDS`，然后重新
部署客户 Worker。

### Webhook 没有响应

检查：

- Bot Token 是否正确。
- Worker 地址是否可以访问 `/health`。
- Telegram Webhook URL 是否以 `/telegram/webhook` 结尾。
- Webhook Secret 是否已经上传。
- Worker 日志是否有授权拒绝或数据库错误。

## 20. 当前产品边界

- 当前许可证控制的是客户独立部署，不是公共 Bot 用户会员。
- 完整源码交付后，客户可以修改或删除授权校验，无法做到绝对防破解。
- 更强的商业保护需要只交付构建产物，或把关键能力保留为厂商托管服务。
- 客户使用期限到期后，Worker 会停止处理 Telegram Webhook，但客户
  Cloudflare 账号中的资源不会被自动删除。
- 图片形式的答卷导出尚未作为独立格式实现。
- 自动部署目前面向 Cloudflare Workers，不包含其他云平台适配。

## 21. 销售交付清单

交付客户前确认：

- 客户 Bot Token 已取得。
- 客户管理员数字 ID 已确认。
- 授权期限和价格已确认。
- 客户 Cloudflare 账号可用。
- 已先执行一次 `--dry-run`。
- 正式部署已完成。
- `/health` 正常。
- 管理员可 `/create` 和 `/import`。
- 普通用户不能 `/create` 或 `/import`。
- 测试问卷可以发布、填写和导出。
- 客户部署目录已安全保存。
- 没有向客户交付 `.license-admin.env`。
