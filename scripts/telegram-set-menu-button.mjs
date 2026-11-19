#!/usr/bin/env node
// 设置 Telegram 聊天菜单按钮（setChatMenuButton）。
//
// Bot 输入框左侧的「菜单按钮」默认展开命令列表；本脚本把它换成 web_app 类型，
// 点一下直接进 Mini App 应用中心（PUBLIC_ORIGIN + /app，P0-M1 上线的四功能区
// 页面），给「/start 键盘」之外的第二个常驻入口。
//
// 用法：
//   BOT_TOKEN=... PUBLIC_ORIGIN=https://emoemok.top node scripts/telegram-set-menu-button.mjs
//   BOT_TOKEN=... PUBLIC_ORIGIN=https://emoemok.top node scripts/telegram-set-menu-button.mjs --text "打开应用"
//   BOT_TOKEN=... node scripts/telegram-set-menu-button.mjs --reset
//   PUBLIC_ORIGIN=https://emoemok.top node scripts/telegram-set-menu-button.mjs --dry-run
//
// 参数：
//   --text <文案>   按钮文案（默认「打开应用」；与 --reset 同给时忽略）
//   --origin <url>  应用中心地址来源，缺省读 PUBLIC_ORIGIN 环境变量
//   --reset         恢复 Telegram 默认菜单按钮（展开命令列表），需要 BOT_TOKEN
//   --dry-run       只打印将发送的 payload，不发任何请求（不需要 BOT_TOKEN）
//
// 凭据与来源（没有任何硬编码 token）：
//   * BOT_TOKEN 只从环境变量读（与 Worker 绑定同名，见 src/env.ts；惯例同
//     scripts/set-admin-password.mjs 的 ADMIN_PASSWORD），不读文件、不落盘；
//   * PUBLIC_ORIGIN 与 Worker 的同名绑定语义一致（resolvePublicOrigin 的取值），
//     命令行 --origin 优先于环境变量。
// 重跑时机：菜单按钮 URL 是一次性写入 Telegram 服务端的，换域名/换路径后
// 必须重跑本脚本（见 docs/ops/ops-runbook.md 第 4 节）。

const APP_PATH = "/app";

function parseArgs(argv) {
  const opts = { text: "打开应用", origin: "", reset: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--text" && argv[index + 1]) {
      opts.text = argv[index + 1];
      index += 1;
    } else if (arg === "--origin" && argv[index + 1]) {
      opts.origin = argv[index + 1];
      index += 1;
    } else if (arg === "--reset") {
      opts.reset = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      console.error(`未知参数：${arg}（支持 --text / --origin / --reset / --dry-run）`);
      process.exit(1);
    }
  }
  return opts;
}

/** 与 src/services/public-origin.service.ts 同语义：剥尾斜杠，防 https://host//app。 */
function normalizeOrigin(raw) {
  return raw.trim().replace(/\/+$/, "");
}

function buildPayload(opts) {
  if (opts.reset) {
    return { menu_button: { type: "default" } };
  }
  return {
    menu_button: {
      type: "web_app",
      text: opts.text,
      web_app: { url: `${normalizeOrigin(opts.origin)}${APP_PATH}` },
    },
  };
}

const opts = parseArgs(process.argv.slice(2));

if (!opts.reset) {
  const origin = normalizeOrigin(opts.origin || process.env.PUBLIC_ORIGIN || "");
  if (!origin) {
    console.error("未提供应用中心地址：请设置 PUBLIC_ORIGIN 环境变量（或用 --origin 指定）。");
    process.exit(1);
  }
  if (!origin.startsWith("https://")) {
    // web_app 按钮要求 HTTPS（与代码里 useWebApp 判定同一条约束）。
    console.error(`PUBLIC_ORIGIN 必须是 https:// 开头（web_app 按钮要求），当前是：${origin}`);
    process.exit(1);
  }
  opts.origin = origin;
}

const payload = buildPayload(opts);

if (opts.dryRun) {
  console.log("--dry-run：以下为将发送到 setChatMenuButton 的 payload（未发请求）——");
  console.log(JSON.stringify(payload, null, 2));
  console.log("目标接口：POST https://api.telegram.org/bot$BOT_TOKEN/setChatMenuButton");
  process.exit(0);
}

const botToken = process.env.BOT_TOKEN?.trim();
if (!botToken) {
  console.error("未设置 BOT_TOKEN 环境变量：本脚本只从环境变量读凭据，不从文件读取。");
  console.error(
    "用法示例：BOT_TOKEN=<token> PUBLIC_ORIGIN=https://emoemok.top node scripts/telegram-set-menu-button.mjs",
  );
  process.exit(1);
}

let response;
try {
  response = await fetch("https://api.telegram.org/bot" + botToken + "/setChatMenuButton", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
} catch (error) {
  console.error("请求 Telegram API 失败：", error);
  process.exit(1);
}

const body = (await response.json().catch(() => null)) ?? {};
if (!response.ok || body.ok !== true) {
  // Telegram 会原样返回 description（例如 URL 不在已配置域名里时的 BUTTON_URL_INVALID）。
  console.error(`setChatMenuButton 失败：HTTP ${response.status}`, JSON.stringify(body));
  process.exit(1);
}

console.log(
  opts.reset
    ? "已恢复默认菜单按钮（展开命令列表）。"
    : `菜单按钮已设置为 web_app：${payload.menu_button.text} → ${payload.menu_button.web_app.url}`,
);
