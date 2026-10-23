# 免登录投稿并轨:部署与退役手册

并轨把免登录投稿(`/api/submit/*`,原独立 submission-bot Worker,另一个 Cloudflare 账号)迁进了本站 Worker。本手册是**上线切换的操作顺序**与**旧 Worker 的退役步骤**。设计细节见各源文件头注释(`src/http/submit-api.ts`、`src/services/submit/*`、migration 0088)。

> **一键执行**:下文第 1–5 步已固化成 `bash scripts/deploy-web-submissions-merge.sh`(分段确认、可 `--skip-data` / `--skip-relay` / `--verify-only`、幂等可重跑)。手册保留全部细节供逐段核对与故障排查;脚本只是它的自动化,不是另一套流程。

## 切换顺序(严格按序,任一步失败先回滚该步再重试)

前置:代码已合并(main 分支),CI 绿。

### 1. 跑 migration

```
pnpm exec wrangler d1 migrations apply DB --remote
```

建出 `web_submissions` / `web_submission_threads` / `web_submission_comments` / `web_rate_limits` 四张表。此步无破坏性(全部 CREATE IF NOT EXISTS),旧链路不受影响。

### 2. 迁移历史数据

```
# 在旧账号上下文导出(/home/emo/code/bot,账号 fb8f4c…):
cd /home/emo/code/bot
npx wrangler d1 export submission-bot-db --remote --output /tmp/submission-bot.sql --skip-confirmation

# 回本仓库转换:
cd /home/emo/code/telegram-bot
node scripts/migrate-web-submissions.mjs /tmp/submission-bot.sql web-submissions-import.sql
pnpm exec wrangler d1 execute DB --remote --file web-submissions-import.sql
```

迁移内容:网页投稿(含收件箱线程、评论区)、viewer/email/ip 提升为列。**旧附件保留 Telegram file_id 引用**(见第 4 步的 legacy token)。Telegram 向导投稿的历史数据不迁移——旧导出文件 `/tmp/submission-bot.sql` 本身就是存档,建议拷进备份桶。

### 3. 部署新 Worker + 中继

- 本站:`pnpm deploy`(push 到 main 自动走)。部署后 `/api/submit/*` 由本站服务,`SUBMISSION_BOT_API_ORIGIN` / `WEB_REVIEW_SECRET` 不再被读取。
- 中继:`cn-relay` 的两条 `/api/submit*` 直达路由已从 vercel.json 删除,按 `docs/CN_ACCESS_VERCEL_RELAY.md` 的流程重新部署 cn-relay(Vercel 上的项目)。**这步必须在 Worker 部署之后**:顺序反了的话,中继把 /api/submit 转发到已退役的旧 Worker。

### 4. 配置旧附件的只读 token(可选,建议配)

```
npx wrangler secret put SUBMISSION_BOT_LEGACY_TOKEN
# 值 = 旧机器人的 BOT_TOKEN(见 /home/emo/code/bot/wrangler.toml 的 secret)
```

用途:**只读** getFile + 文件下载,让管理端还能预览迁移过来的旧投稿附件(Telegram file_id 只在旧机器人账号下有效)。没有任何写能力。全部旧投稿审完/归档后可删除此 secret,管理端会明确报"旧投稿附件的读取通道未启用"。

### 5. 验证清单(逐条点一遍)

- [ ] `https://emoe.eu.cc/api/submit/form` 返回 `{"ok":true,"form":{...}}`(不再 502/HTML);
- [ ] `https://emoemok.top/api/submit/form` 同上(中继链路);
- [ ] 投稿中心 →「⚡ 免登录直投」:表单加载、验证题显示、提交成功拿到编号;
- [ ] 「我的投稿」:能看到刚提交的条目(pending),迁移来的旧投稿也在;
- [ ] 管理后台 →「网页投稿」:列表含新旧数据;detail 正文/附件正常;approve 后收件箱变已发布、收到"已通过"线程留言;reject 的理由出现在收件箱;
- [ ] 迁移来的旧投稿的附件预览正常(第 4 步的 token 生效);
- [ ] 邮箱通知(如运营配置了):approve/reject 后 Resend 发信正常。

### 6. 旧 Worker 退役(观察一周无回滚需求后)

在旧账号(/home/emo/code/bot)上:

1. `npx wrangler deployments list` 确认无近期流量错误;`wrangler tail` 观察 15 分钟(应只剩心跳);
2. 删除 webhook:`https://api.telegram.org/bot<TOKEN>/deleteWebhook`(旧 bot 从此不再收更新);
3. `npx wrangler delete --name submission-bot`(Worker);`npx wrangler d1 delete submission-bot-db`(D1,删除前确认 `/tmp/submission-bot.sql` 已妥善保存);
4. 保留旧 BOT_TOKEN 的秘密记录(= SUBMISSION_BOT_LEGACY_TOKEN,直到第 4 步的清理条件满足)。

## 回滚(任一验证失败时)

数据模型是"新增表",旧链路(代理/中继直达路由/旧 Worker)在退役前保持可用:

1. revert 本仓库的部署(`git revert` + 重部署,或 wrangler 回退版本);
2. 中继恢复两条 `/api/submit*` 路由(git 历史里有)并重新部署;
3. 新表数据不删——旧库仍是真相源,重复迁移会在下次切换时报主键冲突,按编号增量补即可。

## 行为差异备忘(相对旧链路)

| 方面             | 旧(submission-bot)      | 新(本站)                                                                |
| ---------------- | ----------------------- | ----------------------------------------------------------------------- |
| 附件存储         | 传 Telegram 换 file_id  | 本站媒体库(media_assets scope=web_submission,字节在 MEDIA/R2)           |
| 审核通知         | 机器人私聊管理员        | 管理后台 + 主 bot 给 ADMIN_IDS 发提醒                                   |
| approve 的"发布" | 发到 Telegram 频道      | 状态机 pending→published;可选向配置的 publishChannelId 推一条(默认不发) |
| 表单配置         | 旧 Worker 环境变量/命令 | 本站 system_settings 键 `web_submit_form`(JSON,管理端可写)              |
| 作者回复评论     | 以作者身份发到讨论组    | 迁移数据的旧评论仍可回复(经 legacy token);新链路无讨论组评论来源        |
