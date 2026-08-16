#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOKEN_FILE = path.join(ROOT_DIR, ".license-admin.env");
const DEFAULT_LICENSE_SERVER_URL =
  "https://telegram-multimedia-survey-bot.pd2335346.workers.dev";

function readEnvValue(contents, key) {
  return contents.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";
}

function normalizePeriod(value) {
  const period = String(value).trim().toLowerCase();
  if (period === "forever") return period;
  if (/^\d+$/.test(period) && Number(period) >= 1 && Number(period) <= 36_500) {
    return period;
  }
  throw new Error("授权期限只能是 1 到 36500 的天数，或 forever。");
}

async function main() {
  let config;
  try {
    config = await fs.readFile(TOKEN_FILE, "utf8");
  } catch {
    throw new Error("尚未初始化授权中心。请先双击 scripts\\setup-license-admin.cmd。");
  }
  const adminToken = readEnvValue(config, "LICENSE_ADMIN_TOKEN");
  if (!adminToken) {
    throw new Error("本地授权令牌无效。请重新运行 scripts\\setup-license-admin.cmd。");
  }

  const rl = createInterface({ input, output });
  try {
    const customerName = (await rl.question("客户名称: ")).trim();
    if (!customerName) throw new Error("客户名称不能为空。");
    const period = normalizePeriod(
      (await rl.question("授权期限（直接回车为 365，永久输入 forever）: ")).trim() || "365",
    );
    const configuredUrl = readEnvValue(config, "LICENSE_SERVER_URL");
    const licenseServerUrl = (
      await rl.question(`授权中心地址（直接回车使用 ${configuredUrl || DEFAULT_LICENSE_SERVER_URL}）: `)
    ).trim() || configuredUrl || DEFAULT_LICENSE_SERVER_URL;
    if (!/^https:\/\//i.test(licenseServerUrl)) {
      throw new Error("授权中心地址必须以 https:// 开头。");
    }
    const savedConfig = config.match(/^LICENSE_SERVER_URL=/m)
      ? config.replace(/^LICENSE_SERVER_URL=.*$/m, `LICENSE_SERVER_URL=${licenseServerUrl}`)
      : `${config.trimEnd()}\nLICENSE_SERVER_URL=${licenseServerUrl}\n`;
    await fs.writeFile(TOKEN_FILE, savedConfig, { encoding: "utf8", mode: 0o600 });

    const response = await fetch(
      `${licenseServerUrl.replace(/\/+$/, "")}/api/v1/licenses/create`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          customerName,
          period,
          maxActivations: 1,
          notes: "Created by owner issue-license wizard",
        }),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true || typeof body.licenseKey !== "string") {
      throw new Error(`授权创建失败（HTTP ${response.status}）：${JSON.stringify(body)}`);
    }
    console.log(`\n授权已创建\n客户：${customerName}\n授权编号：${body.license?.publicId ?? "未知"}\n\n请只把下面这一行发给部署者：\n${body.licenseKey}\n`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\n发放失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
