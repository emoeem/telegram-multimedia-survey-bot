# 中国大陆中继（Vercel）

把这个目录作为**独立 Vercel 项目的 Root Directory** 部署：Vercel 的香港/新加坡边缘
节点在国内可达，请求回源到 Cloudflare Worker；Worker 侧只认带 `x-relay-token` 的
流量，所以这个中继必须配置 `RELAY_SECRET`（与 `wrangler secret put RELAY_SECRET`
写入的值相同）。

完整步骤、验证方法和注意事项见 [docs/ops/CN_ACCESS_VERCEL_RELAY.md](../docs/ops/CN_ACCESS_VERCEL_RELAY.md)。

改上游域名：编辑 `vercel.json` 里的 `dest`（默认 `https://emoe.eu.cc/$1`）。
客户部署/预发环境请指向各自的 Worker 域名。
