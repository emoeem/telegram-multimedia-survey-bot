#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOKEN_FILE = path.join(ROOT_DIR, ".license-admin.env");
const WRANGLER = process.platform === "win32" ? "npx.cmd" : "npx";

function parseToken(contents) {
  return contents.match(/^LICENSE_ADMIN_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
}

async function loadOrCreateToken(rotate) {
  if (!rotate) {
    try {
      const existing = parseToken(await fs.readFile(TOKEN_FILE, "utf8"));
      if (existing) return existing;
    } catch {
      // Create the file below.
    }
  }

  const token = randomBytes(32).toString("base64url");
  await fs.writeFile(TOKEN_FILE, `LICENSE_ADMIN_TOKEN=${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return token;
}

function putSecret(token) {
  return new Promise((resolve, reject) => {
    console.log(
      "> npx wrangler secret put LICENSE_ADMIN_TOKEN --config wrangler.toml",
    );
    const child = spawn(
      WRANGLER,
      [
        "wrangler",
        "secret",
        "put",
        "LICENSE_ADMIN_TOKEN",
        "--config",
        path.join(ROOT_DIR, "wrangler.toml"),
      ],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    child.stdin.end(`${token}\n`);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Wrangler 退出码：${code ?? "unknown"}`));
    });
  });
}

const rotate = process.argv.includes("--rotate");
const dryRun = process.argv.includes("--dry-run");

try {
  const token = await loadOrCreateToken(rotate);
  if (!dryRun) await putSecret(token);
  console.log(
    dryRun
      ? `预演完成，本地令牌文件：${TOKEN_FILE}`
      : `授权中心管理令牌已写入 Cloudflare Secret。\n本地令牌文件：${TOKEN_FILE}`,
  );
} catch (error) {
  console.error(
    `初始化失败：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
