#!/usr/bin/env node
// 初始化 / 修改管理后台密码。
//
// 用法：
//   node scripts/set-admin-password.mjs                 # 交互式输入
//   ADMIN_PASSWORD=... node scripts/set-admin-password.mjs
//   node scripts/set-admin-password.mjs --password ... [--apply] [--config <wrangler.toml>]
//
// 默认只打印 PBKDF2 哈希与对应的 SQL；加 `--apply` 会直接通过
// `wrangler d1 execute DB --remote` 写入生产库的 system_settings。

import { adminPasswordHashSql, hashAdminPassword } from "./lib/admin-password.mjs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const opts = { password: process.env.ADMIN_PASSWORD ?? "", apply: false, config: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--password" && argv[i + 1]) {
      opts.password = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--config" && argv[i + 1]) {
      // Target one specific deployment (e.g. a customer instance under
      // customer-deployments/). Without it wrangler reads ./wrangler.toml, i.e.
      // the authorization center, so setting a customer's password would
      // silently overwrite the vendor's own login instead.
      opts.config = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--apply") {
      opts.apply = true;
    }
  }
  return opts;
}

async function promptPassword() {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("请输入新的管理员密码（8-256 字符，不会回显）: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

function runWrangler(hash, config = "") {
  const sql = adminPasswordHashSql(hash);
  return new Promise((resolve, reject) => {
    const args = ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--command", sql];
    if (config) args.push("--config", config);
    console.log(
      `> pnpm exec wrangler d1 execute DB --remote${config ? ` --config ${config}` : ""} --command "<upsert admin_password_hash>"`,
    );
    const child = spawn("pnpm", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler 退出码：${code ?? "unknown"}`));
    });
  });
}

const opts = parseArgs(process.argv.slice(2));
let password = opts.password;
if (!password) password = await promptPassword();
if (!password) {
  console.error("未提供密码。");
  process.exit(1);
}
if (password.length < 8 || password.length > 256) {
  console.error("密码长度必须为 8-256 个字符。");
  process.exit(1);
}

const hash = await hashAdminPassword(password);
console.log(`\n哈希：${hash}\n`);

if (opts.apply) {
  try {
    await runWrangler(hash, opts.config);
    console.log("已写入生产库。");
  } catch (error) {
    console.error("写入失败：", error);
    process.exit(1);
  }
} else {
  console.log('未加 --apply，仅打印。加上 --apply 会写入生产库。');
}
