#!/usr/bin/env node
/**
 * 边缘计费护栏：给 emoe.eu.cc 配一条 Rate limiting 规则 + 一条用量告警策略。
 *
 * 为什么需要它，而不是在 Worker 里加限流：
 *
 *   Worker 里的一切限流都发生在**请求已经计费之后**。Cloudflare 按到达边缘的
 *   请求收费，无论你的代码随后返回 429 还是 200。所以 Worker 层的计数器只能
 *   保护下游（D1 / R2 / DO），保护不了账单本身。
 *
 *   真正能在计费前拦住的是 zone 级的 Rate limiting：请求在 WAF 阶段被丢弃，
 *   不进入 Worker，自然不计请求数。这条规则和 Worker 内的 `20 次/分钟/IP`
 *   是两层，不是重复——后者挡的是"上传配额被刷"，前者挡的是"请求数被刷"。
 *
 * 为什么用脚本而不是手点：
 *
 *   规则本身要跟代码里的路径一起演进。问卷媒体端点的路径、投稿后端的中继路径
 *   一改，手点的规则就静默失效了——而且失效时不会有任何提示。脚本把规则和
 *   路径绑在同一个仓库里，改路径时顺手改这里，diff 里看得见。
 *
 * 权限要求（这是本项目唯一做不到自动化的部分——OAuth token 只有 zone:read）：
 *
 *   Zone   · Zone WAF              : Edit   ← 配 rate limiting
 *   Zone   · Zone Settings         : Read   ← 读 zone id（或直接传 ZONE_ID）
 *   Account· Account Settings      : Read   ← 配告警策略
 *   Account· Notifications         : Edit
 *
 * 用法：
 *
 *   # 只看会发什么请求，不动线上
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=ed19… CF_ZONE_ID=8ae2… node scripts/cf-edge-guard.mjs --dry-run
 *
 *   # 真正写入
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=ed19… CF_ZONE_ID=8ae2… node scripts/cf-edge-guard.mjs --apply
 *
 *   # 只配限流、不配告警（告警权限通常更难得）
 *   node scripts/cf-edge-guard.mjs --apply --only=ratelimit
 */

const API = "https://api.cloudflare.com/client/v4";

const TOKEN = process.env.CF_API_TOKEN ?? "";
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID ?? "ed1957935f0efde06a68432e5fc48d97";
const ZONE_ID = process.env.CF_ZONE_ID ?? "8ae276aa463633def4bf48699027681f";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const DRY_RUN = args.has("--dry-run") || !APPLY;
const only = [...args].find((a) => a.startsWith("--only="))?.slice("--only=".length);
const ONLY = only ? new Set(only.split(",")) : null;

/**
 * 需要护栏的路径。
 *
 * 只列**会写数据或花钱**的端点，不列页面 GET：
 *   - `/api/survey/<id>/media`      上传：写 R2、写 D1、烧 CPU 校验图片
 *   - `/api/survey/<id>/media/stream-ticket` 已停用（STREAM_DISABLED），但留着
 *                                   是对"以后有人打开"的兜底
 *   - `/api/submit`                 网页投稿：经中继打到另一个账号的 Worker，
 *                                   那边额度由中继侧承担
 *   - `/api/auth/...`               登录/注册：无限流时是撞库与邮箱农场的入口
 *
 * 刻意**不**包含 `/api/survey/:id` 这类只读问卷页：它们有边缘缓存且是正常
 * 浏览路径，10 次/分钟的规则会把真实用户挡在外面。
 */
const GUARDED_PATH_REGEX =
  "^/api/(survey/[0-9]+/media|submit|auth/)(.*)?$";

/**
 * 20 次 / 60 秒 / IP。
 *
 * 依据与取舍：一次正常答卷上传（3 张图 + 1 段音频）峰值约 4 次请求；网页投稿
 * 一次完整流程（取验证题 + 提交 + 失败重试一次）约 5-6 次。20 留了 3 倍以上
 * 余量，避免把"验证码输错三次的真实用户"误封 10 分钟——边缘封禁误伤的代价
 * 远大于放过一点脚本流量。
 *
 * 这条规则**不是**用来防总量打穿的：20/min 仍允许单 IP 每小时 1200 次。真正
 * 封顶的是 Worker 内的全局日上限（MEDIA_DAILY_UPLOAD_LIMIT=300 / 天）。两层
 * 分工是：边缘挡瞬时与请求计费，Worker 挡累计与存储写入。
 *
 * mitigation_timeout=600：超限后封 10 分钟。短于这个值等于没封——攻击者只要
 * 卡着窗口边缘打，限流水位以下的部分照样全部通过。
 */
const RATE_LIMIT_RULE = {
  action: "block",
  description: "billing guard: upload/auth/submit flood (20/min/IP)",
  expression: `(http.request.uri.path matches "${GUARDED_PATH_REGEX}")`,
  ratelimit: {
    characteristics: ["ip.src"],
    period: 60,
    requests_per_period: 20,
    mitigation_timeout: 600,
  },
  enabled: true,
};

/**
 * 告警：三个按量资源各一条 50% 阈值策略。
 *
 * 免费/付费额度是**静默**烧掉的——账单出来才知道已经晚了。50% 是留出反应
 * 时间的位置：到这个点，你有半天到一天决定是调上限、改代码还是接受成本。
 */
const ALERT_POLICIES = [
  {
    name: "survey-bot: Worker requests > 50%",
    alert_type: "billing_usage_alert",
    enabled: true,
    filters: { services: ["workers"], limit_type: "daily_requests", unit: "count" },
    mechanisms: { email: [{ id: process.env.CF_ALERT_EMAIL ?? "" }] },
    conditions: { ">": [{ threshold: 50 }] },
  },
  {
    name: "survey-bot: R2 storage > 50%",
    alert_type: "billing_usage_alert",
    enabled: true,
    filters: { services: ["r2"], limit_type: "storage_gb", unit: "gb" },
    mechanisms: { email: [{ id: process.env.CF_ALERT_EMAIL ?? "" }] },
    conditions: { ">": [{ threshold: 50 }] },
  },
  {
    name: "survey-bot: D1 rows written > 50%",
    alert_type: "billing_usage_alert",
    enabled: true,
    filters: { services: ["d1"], limit_type: "rows_written", unit: "count" },
    mechanisms: { email: [{ id: process.env.CF_ALERT_EMAIL ?? "" }] },
    conditions: { ">": [{ threshold: 50 }] },
  },
];

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: false, errors: [{ message: text.slice(0, 300) }] };
  }
  return { status: res.status, json };
}

function explain(result) {
  const err = result.json?.errors?.[0];
  if (!err) return `HTTP ${result.status}`;
  if (err.code === 10000) {
    return `HTTP ${result.status} Authentication error（缺权限，见文件头注释）`;
  }
  return `HTTP ${result.status} ${err.code}: ${err.message}`;
}

async function syncRateLimit() {
  console.log("\n── Rate limiting rule ─────────────────────────────");
  const current = await call("GET", `/zones/${ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint`);
  if (!current.json?.success) {
    console.log(`  读现状失败：${explain(current)}`);
    if (DRY_RUN) {
      console.log("  （dry-run 继续，展示将要 PUT 的 body）");
      console.log(JSON.stringify({ rules: [RATE_LIMIT_RULE] }, null, 2));
    }
    return false;
  }
  const existing = current.json.result?.rules ?? [];
  console.log(`  现有规则 ${existing.length} 条：${existing.map((r) => r.description ?? r.id).join(", ") || "（无）"}`);

  // 幂等：描述相同就覆盖，不叠加。重复跑脚本不该产生第二条一样的规则。
  const merged = [...existing.filter((r) => r.description !== RATE_LIMIT_RULE.description), RATE_LIMIT_RULE];

  if (DRY_RUN) {
    console.log(`  [dry-run] 将 PUT ${merged.length} 条规则，新增/更新的那条：`);
    console.log(JSON.stringify(RATE_LIMIT_RULE, null, 2));
    return true;
  }

  const put = await call("PUT", `/zones/${ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint`, { rules: merged });
  if (!put.json?.success) {
    console.log(`  写入失败：${explain(put)}`);
    return false;
  }
  console.log(`  ✓ 已写入，当前 ${put.json.result?.rules?.length ?? "?"} 条规则`);
  return true;
}

async function syncAlerts() {
  console.log("\n── Usage alert policies ───────────────────────────");
  if (!process.env.CF_ALERT_EMAIL) {
    console.log("  跳过：未提供 CF_ALERT_EMAIL（告警必须指定接收邮箱）");
    return false;
  }
  const current = await call("GET", `/accounts/${ACCOUNT_ID}/alerting/v3/policies`);
  if (!current.json?.success) {
    console.log(`  读现状失败：${explain(current)}`);
    if (DRY_RUN) console.log(JSON.stringify(ALERT_POLICIES, null, 2));
    return false;
  }
  const existing = current.json.result ?? [];
  let ok = 0;
  for (const policy of ALERT_POLICIES) {
    const same = existing.find((p) => p.name === policy.name);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${same ? "更新" : "创建"} ${policy.name}`);
      continue;
    }
    const res = same
      ? await call("PUT", `/accounts/${ACCOUNT_ID}/alerting/v3/policies/${same.id}`, policy)
      : await call("POST", `/accounts/${ACCOUNT_ID}/alerting/v3/policies`, policy);
    if (res.json?.success) {
      console.log(`  ✓ ${policy.name}`);
      ok += 1;
    } else {
      console.log(`  ✗ ${policy.name} — ${explain(res)}`);
    }
  }
  return ok > 0;
}

async function main() {
  if (!TOKEN) {
    console.error("缺少 CF_API_TOKEN。用带 Zone WAF:Edit 的 token 重跑。");
    process.exit(2);
  }
  console.log(`zone=${ZONE_ID} account=${ACCOUNT_ID} mode=${DRY_RUN ? "dry-run" : "APPLY"}`);

  const results = [];
  if (!ONLY || ONLY.has("ratelimit")) results.push(await syncRateLimit());
  if (!ONLY || ONLY.has("alerts")) results.push(await syncAlerts());

  if (DRY_RUN) {
    console.log("\n以上是 dry-run。加 --apply 才写入。");
    return;
  }
  console.log(`\n完成：${results.filter(Boolean).length}/${results.length} 项`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
