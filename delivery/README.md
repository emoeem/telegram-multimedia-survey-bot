# Telegram Multimedia Survey Bot · 交付包

这个目录只分两份，**不要混发**。

| 目录 | 给谁 | 用途 |
|---|---|---|
| `01-发给部署服务人员` | 部署人员 | 给客户创建 Cloudflare Worker、D1、KV、Queue 并完成 Telegram Bot 部署 |
| `02-给项目所有者` | 项目所有者 / 授权管理员 | 发许可证、续费、暂停、恢复、保存客户资料 |

## 最简单的工作方式

### 首选：Web 管理后台一键部署

正常情况下，项目所有者**不需要再运行授权脚本，也不需要手工登记 Worker**。

打开：

`/admin/control`

点击：

**控制中心 → ＋ 新建客户**

填写：

1. 客户名称
2. 客户管理员 Telegram ID
3. 授权天数（默认 30 天）
4. Telegram Bot Token
5. 客户 Cloudflare Account ID
6. 客户 Cloudflare API Token
7. Worker 名称（可选）

点击：

**创建并部署**

系统会自动：

`创建 30 天授权 → 创建 Customer Deployment → 创建 Deployment Task → Runner 自动领取 → 创建 D1/KV/Queue → 执行 migration → 部署 Worker → 设置 Webhook/Commands → Worker 上线`

部署完成后，控制中心会持续刷新状态并显示 Worker、授权到期时间和部署日志。

> Runner 必须保持在线：`pnpm deployment:runner`。首次配置时只需要给控制中心和 Runner 配置同一个 `CONTROL_PLANE_RUNNER_TOKEN`。

### 备用：人工部署包

如果 Web Runner 不在线、客户需要自行部署，才使用：

1. 把整个 `01-发给部署服务人员` 文件夹发给部署人员。
2. 部署人员在客户自己的 Cloudflare 账号中运行：
   `00-安装依赖.cmd` → `npx wrangler login` → `02-正式部署.cmd`
3. 部署完成后，把 `deployment-manifest.json` 和 Worker URL 回传。
4. 项目所有者在控制中心登记 Worker。

### 每月续费

客户付款后，项目所有者在**自己的授权中心 Bot**发送：

```text
/license_extend 授权编号 30
```

系统会把现有到期日向后延 30 天。即使客户提前续费，也不会把剩余天数覆盖掉。

**不需要重新部署 Worker，不需要重新发授权密钥，不需要让客户重新登录 Cloudflare。**

如果客户没有续费，限时授权到期后客户 Worker 会停止正常业务处理；明确到期不会因为网络宽限而继续获得授权。

## 安全边界

部署人员和客户只能接触自己的 Cloudflare 账号。

**绝对不要发送：**

- `.license-admin.env`
- `LICENSE_ADMIN_TOKEN`
- 厂商 Cloudflare API Token
- 其他客户的授权密钥
- 厂商授权中心的管理凭据

项目所有者只把“授权密钥”交给对应客户的部署人员。

详细说明：

- 部署人员：`01-发给部署服务人员/部署服务人员操作说明.md`
- 项目所有者：`02-给项目所有者/给项目所有者内部说明.md`
