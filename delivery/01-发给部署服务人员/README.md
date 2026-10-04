# Telegram Multimedia Survey Bot
# 部署服务人员交付说明

> **版本：Web Admin 一键部署**
>
> 这份目录可以直接发给部署服务人员。
> 正常部署不需要源码、不需要手工创建 Cloudflare 资源，也不需要操作授权中心。

## 你要做什么

你只负责三件事：

1. 向客户收集部署所需资料。
2. 在项目方提供的 Web 管理后台创建客户并启动部署。
3. 部署完成后完成基础验收，把结果交回项目方/客户。

**正常情况下不要运行本目录里的「客户部署包」。**
它只是 Web Runner 不可用时的备用人工部署方案。

## 一、部署前向客户收集

请让客户提供：

- 客户名称
- 客户管理员 Telegram 数字 ID
- Telegram Bot Token
- 客户 Cloudflare Account ID
- 客户 Cloudflare API Token

### Telegram 管理员 ID

必须是数字，例如：

123456789

不是：

@username

多个管理员用逗号分隔：

123456789,987654321

### Cloudflare

客户必须提供**自己的** Cloudflare Account ID 和部署专用 API Token。

不要使用项目方自己的 Cloudflare 凭据。

API Token 只用于创建/管理该客户自己的 Worker、D1、KV、Queue 等资源。

## 二、进入 Web 管理后台

使用项目方提供的管理后台地址。

当前生产后台：

https://telegram-multimedia-survey-bot.pd2335346.workers.dev/admin/control

登录后进入：

**控制中心 → ＋ 新建客户**

## 三、创建客户

按客户资料填写：

| 字段 | 填写内容 |
|---|---|
| 客户名称 | 客户名称 |
| 客户管理员 Telegram ID | 数字 ID，可多个 |
| 授权天数 | 按购买周期填写，默认 30 天 |
| Telegram Bot Token | 客户 BotFather 创建的 Token |
| Cloudflare Account ID | 客户自己的 Account ID |
| Cloudflare API Token | 客户部署专用 Token |
| Worker Name | 通常留空，让系统自动生成 |

确认无误后点击：

**创建并部署**

## 四、点击后系统自动完成

你不需要手工执行任何 Cloudflare 创建命令。

系统会依次完成：

创建授权 → 创建 Customer Deployment → 创建 Deployment Task → Runner 领取任务 → 创建客户资源 → 执行 migration → 部署 Worker → 设置 Webhook/Commands → Worker 上线

页面会显示：

- Worker 名称
- Worker 状态
- 部署任务状态
- 部署日志
- 授权状态
- 授权到期时间
- 最近心跳时间

### 正常结果

部署任务应变成：

**succeeded / 成功**

Customer Worker 应变成：

**online / 在线**

## 五、部署验收

部署成功后进行最小验收：

1. 打开 Worker 的 /health
2. Telegram 给 Bot 发送 /start
3. 管理员测试 /create
4. 创建一个测试问卷
5. 发布测试问卷
6. 普通 Telegram 账号执行 /surveys
7. 完成一次填写
8. 检查答卷
9. 检查导出

至少完成一次完整链路：

创建 → 发布 → 填写 → 查看答卷 → 导出

## 六、交付结果

部署完成后，把以下信息交给项目方：

- 客户名称
- Worker 名称
- Worker URL
- Installation ID（如页面/部署清单提供）
- 部署是否成功
- 基础验收结果
- 异常日志（如果有）

如果项目方要求保存完整部署清单，再提供：

deployment-manifest.json

## 七、绝对不要发送或泄露

以下内容不能发送给其他客户，也不要进入聊天记录、截图或公开仓库：

- 客户 Telegram Bot Token
- 客户 Cloudflare API Token
- 项目方 Runner Token
- 项目方 Cloudflare 凭据
- LICENSE_ADMIN_TOKEN
- 其他客户的 License Key
- .customer-secrets.tmp
- 项目方授权中心管理凭据

**部署人员不需要知道项目方 Runner Token。**

## 八、客户续费

部署人员**不负责续费**。

客户每月续费由项目方在 Web Admin 控制中心执行：

**客户 → 续费 30 天**

续费后：

- 不重新部署 Worker
- 不重新创建 D1
- 不重新创建 KV
- 不重新创建 Queue
- 不重新设置 Webhook
- 不重新生成授权密钥

## 九、客户暂停 / 恢复

这些操作由项目方在 Web Admin 控制中心完成。

部署人员不要通过重新部署来代替授权管理。

## 十、客户升级

正常升级同样由 Web Admin 发起。

部署人员只有在项目方明确要求时才参与升级验收。

不要自行删除客户原有：

- Worker
- D1
- KV
- Queue
- Installation ID

## 十一、部署失败怎么办

先不要删除任何 Cloudflare 资源。

在控制中心查看：

**Deployment Tasks → 失败任务 → Error / Runner Log**

把以下信息发给项目方：

- 客户名称
- Worker 名称
- Task ID
- 错误信息
- Runner 日志
- 失败发生在哪一步

**不要为了“重来一次”直接删除客户资源。**

## 十二、备用人工部署包

只有以下情况才使用：

- 项目方明确要求人工部署；
- Deployment Runner 暂时不可用；
- 客户要求在自己的电脑上完成部署；
- 正在排查 Runner 问题。

备用文件位于：

客户部署包/

备用流程：

00-安装依赖.cmd → npx wrangler login → 02-正式部署.cmd

人工部署时必须登录**客户自己的 Cloudflare 账号**。

详细备用说明见：

客户部署包/README.md

## 最重要的原则

**正常情况下，你不需要碰代码、不需要碰 migration、不需要手工创建 Cloudflare 资源。**

你的标准工作流只有：

收集客户资料 → Web Admin → 新建客户 → 创建并部署 → 等待成功 → 验收 → 交付结果

如果遇到任何部署异常：

**停止删除/重建操作，保留现场，把错误信息交给项目方。**
