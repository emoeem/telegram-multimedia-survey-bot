# 邮件送达（验证码）配置与排障

> 2026-10-17：QQ 邮箱用户反馈收不到验证码，排查结论与修复记录。

## 根因（已确认）

生产 `MAIL_FROM` 使用 Resend 的**测试发件域**（`onboarding@resend.dev`）。
该域**只能给 Resend 账号本人的邮箱发信**；发往其他任何地址时 Resend 返回
403 拒绝：

```
You can only send testing emails to your own email address (xxx@qq.com).
To send emails to other recipients, please verify a domain at resend.com/domains,
and change the `from` address to an email using this domain.
```

这解释了「管理员自测能收到、其他用户收不到」：管理员自己的邮箱就是 Resend
账号本人，其余地址全部在发信侧就被拒了（旧代码把失败静默吞掉，界面仍显示
「已发送」）。

## 修复状态（2026-10-17 已完成）

- 域名 `emoemok.top` 已在 Resend 验证（DKIM `resend._domainkey`、SPF 与
  反馈 MX `send.emoemok.top` 三条记录齐备）；
- Worker secret `MAIL_FROM` 已更新为 `no-reply@emoemok.top`；
- 验证：向非账号本人地址（公共测试邮箱）请求验证码，Resend 接受
  （`ok:true, sender:"no-reply@emoemok.top"`），旧配置下的 403 拒绝消失。
- 建议（可选增强）：在 DNS 添加 `_dmarc.emoemok.top` → `v=DMARC1; p=none`
  提升 QQ/163 的收信评分。

## 正确的生产配置（新部署照此执行）

1. 在 [resend.com/domains](https://resend.com/domains) 添加一个自己的域名
   ——建议用**子域**隔离发信声誉，例如 `mail.<你的域名>`；
2. 按 Resend 给出的清单在域名 DNS 添加记录（SPF `TXT` + DKIM `TXT`，
   建议再加 DMARC：`_dmarc` 的 `v=DMARC1; p=none`），等待验证通过；
3. 更新 Worker secret：

   ```bash
   npx wrangler secret put MAIL_FROM
   # 例如：no-reply@mail.<你的域名>
   ```

4. 验证：注册页用一个**非账号本人**的邮箱（如 QQ 邮箱）请求验证码，
   应能收到；若仍失败，`npx wrangler tail` 里 `Resend email failed` 会带
   出 Resend 的具体拒绝原因。

## 代码侧保障（已上线）

- 发信失败返回 `502 email_send_failed`，不再静默成功；
- Worker 日志记录 Resend 响应体（具体拒绝原因）；
- 成功响应带 `sender`（From 地址）；注册页在验证码步骤展示
  「查垃圾邮件箱 / 把发件人加白名单 / 换邮箱或改用 Telegram」指引。

## 中国邮箱（QQ / 163 / 126）特有注意事项

- 这些邮箱对第三方验证码邮件拦截激进：**即使发信侧全部正确**，也可能进
  垃圾箱或静默拦截；域名必须配齐 SPF/DKIM/DMARC；
- 建议发件人使用品牌名显示（如 `问卷平台 <no-reply@mail.x.com>`），
  纯英文地址 + 无链接的纯文本正文对评分更友好（当前实现即纯文本、
  无链接）；
- 用户侧白名单操作：QQ 邮箱 → 设置 → 反垃圾 → 白名单，加入 From 地址。
