# 客户部署、授权与升级指南

本文档说明如何把「问卷平台」交付给客户（独立实例），以及后续如何更新升级、管理授权和保护数据。

## 一、架构总览

```
你的 Cloudflare 账号
├── 授权中心（你的主 Worker）
│   ├── 签发/吊销授权、登记版本
│   └── 所有客户实例启动时到这里校验授权
└── 客户 A 实例（独立 Worker）
    ├── 独立 D1 数据库（问卷/答卷数据）
    ├── 独立 KV / R2（缓存、媒体文件）
    ├── 独立 Telegram Bot
    └── 授权密钥（环境变量/Secret）
```

- 每个客户一套资源，**数据物理隔离**；
- 客户实例强制 `LICENSE_ENFORCEMENT=required`，离线 1 天宽限期后自动锁定；
- 普通用户可以创建问卷（体验/试用模式），但**永远看不到管理员内容**（用户目录、系统设置、审计、授权、他人答卷等）。

## 二、前置准备

1. Cloudflare 账号 + 一个 API Token（需要 Workers Scripts、D1、KV、Queues、R2 编辑权限）；
2. 客户自己的 Telegram Bot Token（@BotFather 创建）；
3. 初始化本地授权令牌（只需一次）：

```bash
npm run license-admin:setup
```

它会生成 `.license-admin.env`（本地，勿提交）并把 `LICENSE_ADMIN_TOKEN` 写入你的主 Worker Secret。

## 三、部署一个新客户

### 1. 签发授权

```bash
npm run license:issue
```

按提示输入客户名称、授权期限（默认 365 天，`forever` 为永久）、授权中心地址。完成后会得到一串授权密钥，**只显示一次**，复制保存。

### 2. 一键部署

```bash
CLOUDFLARE_ACCOUNT_ID=你的账号ID \
CLOUDFLARE_API_TOKEN=你的Token \
npm run customer:deploy
```

按提示输入：

- `customer-name`：客户名称（会生成 Worker 名，如 `customer-abc`）
- `bot-token`：客户 Bot Token
- `admin-id`：客户管理员 Telegram ID（可多个，逗号分隔）
- `license-key`：第 1 步签发的授权密钥
- `license-server-url`：你的授权中心地址（默认已填好）

脚本会自动完成：

1. 创建该客户专用的 D1 / KV / Queue / R2；
2. 生成独立 `wrangler.toml`（含 `ADMIN_IDS`、`INSTALLATION_ID`、授权中心地址）；
3. 把 `BOT_TOKEN`、`WEBHOOK_SECRET`、`LICENSE_KEY` 写入 Cloudflare Secret（不进代码）；
4. 执行数据库迁移并部署 Worker；
5. 自动设置 Telegram Webhook 和命令菜单；
6. 在 `customer-deployments/<客户>/deployment-manifest.json` 保存部署清单（升级时复用）。

部署后让客户管理员发 `/start`，普通用户发 `/surveys` 即可使用。

> 说明：把授权密钥给客户前，请先在你自己后台的「授权管理」页核对信息。

## 四、管理授权（Web 后台）

后台侧边栏新增「**授权**」页，可：

- 查看所有授权（客户、类型、状态、到期、升级有效期、激活数）；
- 签发新授权（限时/永久、天数、激活数上限、备注）；
- 暂停 / 恢复 / 吊销授权；
- 一键延期 30 天（或按天延期）；
- 查看每把授权的激活记录（安装 ID、版本、最近在线时间）；
- 注册新版本（发布后在此登记，客户升级时校验版本号）；
- 开通 / 回收「体验创作者试用」（用户可用机器人创建问卷，但看不到管理内容）。

吊销授权后，客户实例在下次校验时会被拒绝并进入宽限期。

## 五、更新升级

每次你改完代码后：

```bash
# 1. 在授权中心登记新版本（客户实例升级时会校验版本号）
npm run release

# 2. 批量升级所有客户实例（复用原资源/密钥/授权，自动执行数据库迁移）
CLOUDFLARE_ACCOUNT_ID=你的账号ID \
CLOUDFLARE_API_TOKEN=你的Token \
npm run customer:update
```

也可以单个更新：

```bash
CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx \
node scripts/deploy-customer.mjs --update-existing customer-deployments/<客户>
```

升级**不会**重建数据库、不换 Bot Token、不改 Webhook，只替换代码并迁移数据库，客户无感知。

## 六、安全说明

已经内置的保护：

- **数据隔离**：每个客户独立 D1/KV/R2，互不可见；
- **密钥管理**：Bot Token、Webhook 密钥、授权密钥全部是 Cloudflare Secret，不进代码/Git；
- **管理端认证**：后台仅 `ADMIN_IDS` 可进；浏览器登录链接 5 分钟有效、会话为 HMAC 签名的 7 天 Cookie；
- **问卷安全**：支持访问密码；答卷人身份由 Telegram 签名数据或机器人签发的参与者令牌认证；
- **媒体访问控制**：问题媒体仅限已发布问卷引用；答卷媒体仅答卷本人可访问；报告媒体带一次性令牌；
- **授权强制**：客户实例 `LICENSE_ENFORCEMENT=required`，未授权/过期/被吊销都会锁定，1 天宽限期；
- **审计日志**：授权签发、吊销、延期、版本登记、设置修改全部留痕。

建议额外做的：

- 在 Cloudflare 控制台给每个客户 Worker 开启 **WAF / 速率限制**，防止接口被刷；
- 授权中心建议使用独立域名/Worker，与主业务隔离；
- 定期轮换 `LICENSE_ADMIN_TOKEN` 和客户 Webhook Secret；
- 不要把 `.license-admin.env`、`customer-deployments/*/.customer-secrets.tmp` 提交到 Git。

## 七、体验/试用模式

- 未授权用户默认**不能创建问卷**；
- 在后台「授权」页的体验试用区，按用户 ID 开通试用（默认 30 天，可改）；
- 试用用户只能创建/管理自己的问卷，**看不到**管理员才有的内容（用户目录、系统设置、审计、授权、报告归档管理、他人答卷）。
