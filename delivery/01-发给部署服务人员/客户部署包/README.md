# 客户部署包（备用方案）

> **注意：这不是正常部署入口。**
>
> 正常部署请使用项目方 Web Admin：
>
> https://telegram-multimedia-survey-bot.pd2335346.workers.dev/admin/control
>
> 进入「控制中心 → ＋ 新建客户 → 创建并部署」。
>
> 本目录只用于 Deployment Runner 不可用、客户明确要求本地部署，或项目方进行故障排查时。

## 一、使用前确认

使用本备用方案前，先确认项目方已经明确要求人工部署。

你需要从项目方取得：

- 客户名称
- 客户管理员 Telegram 数字 ID
- Telegram Bot Token
- 项目方发放的该客户授权密钥

客户需要使用自己的 Cloudflare 账号。

**不要使用项目方的 Cloudflare 登录凭据或 API Token。**

## 二、安装

双击：

00-安装依赖.cmd

等待依赖安装完成。

## 三、登录客户 Cloudflare

打开 PowerShell：

npx wrangler login

浏览器登录：

**客户自己的 Cloudflare 账号**

## 四、正式部署

双击：

02-正式部署.cmd

按提示填写：

1. 客户名称
2. 管理员 Telegram 数字 ID
3. Cloudflare Account ID
4. 项目方提供的授权密钥
5. Telegram Bot Token
6. Cloudflare API Token

脚本会自动执行客户资源创建、数据库 migration、Worker 部署、Webhook 和 Bot Commands 配置。

不要手工重复创建 D1、KV、Queue。

## 五、部署验收

打开：

https://<worker>.workers.dev/health

然后：

/start

管理员：

/create

普通用户：

/surveys

完成一次：

创建 → 发布 → 填写 → 查看答卷 → 导出

## 六、回传项目方

只回传：

- Worker URL
- Worker 名称
- deployment-manifest.json
- Installation ID
- 验收结果
- 必要的错误日志

不要回传：

- Bot Token
- Cloudflare API Token
- LICENSE_KEY
- .customer-secrets.tmp
- LICENSE_ADMIN_TOKEN

## 七、升级

升级前必须得到项目方明确指示。

保留原来的：

- Worker
- D1
- KV
- Queue
- Installation ID
- 授权关系

不要删除客户旧资源后重新创建。

## 八、问题处理

如果部署失败：

1. 不要删除 Cloudflare 资源。
2. 保存终端错误。
3. 保存 deployment-manifest.json。
4. 将错误交给项目方。

## 九、续费

备用部署包不负责续费。

客户续费由项目方在 Web Admin 控制中心处理。

续费后不需要重新运行本部署包。
