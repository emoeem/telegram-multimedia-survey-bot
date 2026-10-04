# 项目所有者 / 授权管理员

这个目录是**内部资料**。

不要发送给：

- 客户
- 部署服务人员
- Telegram 群组
- 公开网盘

## 第一次使用

厂商授权中心上线并完成 D1 migration 后，只做一次：

```bash
bash 00-初始化授权中心.sh
```

它会生成本地：

```text
.license-admin.env
```

并把授权中心管理令牌写入厂商 Cloudflare Worker Secret。

**这个文件绝对不能发送出去。**

## 新客户：30 天月付

执行：

```bash
bash 01-一键发放授权.sh
```

输入：

```text
客户名称：客户甲
授权期限：30
授权中心地址：直接回车
```

脚本会创建一个 **timed 30-day license**。

它会显示：

```text
客户：客户甲
授权编号：LIC-XXXXXXXX

授权密钥：
TSB-XXXXX-XXXXX-XXXXX-XXXXX
```

只把“授权密钥”发给这个客户的部署人员。

然后把：

```text
delivery/01-发给部署服务人员/
```

整个目录发给部署人员。

## 你现在有一个客户要部署一个月

直接按下面做：

### ① 发放 30 天授权

```bash
cd /home/emo/code/telegram-bot
bash delivery/02-给项目所有者/01-一键发放授权.sh
```

输入客户名称。

授权期限输入：

```text
30
```

记录脚本返回的：

- 授权编号
- 授权密钥
- 到期日期

### ② 把资料给部署人员

发送：

```text
delivery/01-发给部署服务人员/
```

另外安全发送：

```text
客户名称
管理员 Telegram 数字 ID
Telegram Bot Token
授权密钥
```

### ③ 等待部署人员完成

部署人员完成后会回传：

```text
deployment-manifest.json
Worker URL
验收结果
```

你把这些记录到：

```text
续费与升级记录.md
部署验收记录.md
```

### ④ 客户每月付款

客户付款后，在**厂商授权中心 Bot**发送：

```text
/license_extend <授权编号> 30
```

例如：

```text
/license_extend LIC-12345678 30
```

完成后检查：

```text
/licenses
```

确认新的到期日期。

**不需要重新部署客户 Worker。**

### ⑤ 客户不付款

不需要进入客户 Cloudflare。

等限时授权到期即可。

如果需要立即停止：

```text
/license_suspend <授权编号>
```

恢复：

```text
/license_resume <授权编号>
```

永久作废才使用：

```text
/license_revoke <授权编号>
```

## 授权规则

| 类型 | 含义 |
|---|---|
| timed | 到期后停止正常使用 |
| perpetual | 永久使用，但升级权益单独计算 |
| max activations | 同一授权允许激活的部署数量 |

本项目当前客户按月收费时使用：

```text
timed
30 天
max activations = 1
```

提前续费也安全：系统从“当前到期日”和“当前时间”两者较晚者开始增加 30 天，因此不会覆盖客户剩余时间。

## 安全

绝对不能发送：

```text
.license-admin.env
LICENSE_ADMIN_TOKEN
厂商 Cloudflare API Token
其他客户授权密钥
```

授权密钥只给对应客户部署使用。

## 记录

每个客户必须保存：

- 客户名称
- 授权编号
- Worker URL
- Installation ID
- Bot 名称
- 管理员 Telegram ID
- 当前版本
- 当前到期日期
- 每次续费日期
- 每次升级记录
