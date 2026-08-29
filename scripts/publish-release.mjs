#!/usr/bin/env node
/**
 * 把新版本注册到授权中心（客户实例校验版本时会查询这里）。
 * 用法：node scripts/publish-release.mjs [版本号] ["更新说明"]
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOKEN_FILE = path.join(ROOT_DIR, ".license-admin.env");
const DEFAULT_LICENSE_SERVER_URL = "https://telegram-multimedia-survey-bot.pd2335346.workers.dev";

function readEnvValue(contents, key) {
  return contents.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";
}

function normalizeVersion(value) {
  const version = String(value).trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error("版本号格式无效（应为 x.y.z，例如 0.4.0）");
  }
  return version;
}

async function main() {
  let config;
  try {
    config = await fs.readFile(TOKEN_FILE, "utf8");
  } catch {
    throw new Error("尚未初始化授权中心。请先运行 scripts/setup-license-admin.mjs。");
  }
  const adminToken = readEnvValue(config, "LICENSE_ADMIN_TOKEN");
  if (!adminToken) {
    throw new Error("本地授权令牌无效。请重新运行 scripts/setup-license-admin.mjs。");
  }
  const configuredUrl = readEnvValue(config, "LICENSE_SERVER_URL");
  const licenseServerUrl = configuredUrl || DEFAULT_LICENSE_SERVER_URL;

  const args = process.argv.slice(2);
  const version = normalizeVersion(args[0] ?? "");
  const notes = args[1] ?? "";

  const rl = createInterface({ input, output });
  try {
    const notesValue = notes || (await rl.question("更新说明（直接回车跳过）: ")).trim();
    const confirm = (await rl.question(`确认把版本 ${version} 注册到授权中心 ${licenseServerUrl} ？(y/N) `))
      .trim()
      .toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      console.log("已取消。");
      return;
    }

    const response = await fetch(`${licenseServerUrl.replace(/\/+$/, "")}/api/v1/releases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Admin-Token": adminToken,
      },
      body: JSON.stringify({
        version,
        ...(notesValue ? { notes: notesValue } : {}),
        channel: "stable",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) {
      throw new Error(`注册失败（HTTP ${response.status}）：${body?.error ?? JSON.stringify(body)}`);
    }
    console.log(`✅ 版本 ${version} 已注册到授权中心。`);
    if (body.release?.notes) console.log(`   说明：${body.release.notes}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
