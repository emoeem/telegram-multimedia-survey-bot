#!/usr/bin/env node

import { createHash, createDecipheriv, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";

const PEPPER = process.env.SURVEY_CODE_PEPPER ?? "";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const CONFIG = process.env.WRANGLER_CONFIG ?? "";

if (!PEPPER) {
  throw new Error("必须通过 SURVEY_CODE_PEPPER 提供新的访问密码 pepper。");
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: process.cwd(),
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`wrangler 退出码：${code ?? "unknown"}`));
    });
  });
}

function parseWranglerJson(output) {
  const start = output.lastIndexOf("[");
  const objectStart = output.lastIndexOf("{");
  const jsonStart = start >= 0 && (objectStart < 0 || start < objectStart) ? start : objectStart;
  if (jsonStart < 0) throw new Error("无法解析 wrangler --json 输出。");
  return JSON.parse(output.slice(jsonStart));
}

async function query(sql) {
  const args = ["d1", "execute", "DB", "--remote", "--json", "--command", sql];
  if (CONFIG) args.push("--config", CONFIG);
  return parseWranglerJson(await runWrangler(args));
}

async function execute(sql) {
  const args = ["d1", "execute", "DB", "--remote", "--command", sql, "--yes"];
  if (CONFIG) args.push("--config", CONFIG);
  await runWrangler(args);
}

function extractRows(result) {
  const first = Array.isArray(result) ? result[0] : result;
  return first?.results ?? [];
}

function decryptSurveyAccessCode(encryptedCode, botToken) {
  const [version, ivEncoded, payloadEncoded] = String(encryptedCode ?? "").split(":");
  if (version !== "v1" || !ivEncoded || !payloadEncoded) return null;
  try {
    const iv = Buffer.from(ivEncoded, "base64");
    const payload = Buffer.from(payloadEncoded, "base64");
    const key = createHash("sha256").update(`survey-access-code:v1:${botToken}`).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    const authTag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function legacySha256(code) {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex");
}

function hashV2(code) {
  const normalized = code.trim();
  const salt = randomBytes(16);
  const digest = createHash("sha256")
    .update(salt)
    .update(PEPPER, "utf8")
    .update(normalized, "utf8")
    .digest("hex");
  return `sha256v2:${salt.toString("hex")}$${digest}`;
}

const result = await query(
  "SELECT id, access_code, access_code_encrypted FROM surveys WHERE access_code IS NOT NULL ORDER BY id",
);
const rows = extractRows(result);

let upgraded = 0;
let skippedV2 = 0;
let missingLegacyPlaintext = 0;
let invalidLegacyEncryption = 0;

for (const row of rows) {
  const stored = String(row.access_code ?? "");
  if (!stored) continue;

  if (stored.startsWith("sha256v2:")) {
    skippedV2 += 1;
    continue;
  }

  let plaintext = stored;
  if (stored.startsWith("sha256:")) {
    if (!BOT_TOKEN) {
      missingLegacyPlaintext += 1;
      console.warn(`#${row.id}: sha256 旧哈希没有可用 BOT_TOKEN，无法安全升级。`);
      continue;
    }
    plaintext = decryptSurveyAccessCode(row.access_code_encrypted, BOT_TOKEN);
    if (!plaintext || legacySha256(plaintext) !== stored.slice("sha256:".length)) {
      invalidLegacyEncryption += 1;
      console.warn(`#${row.id}: access_code_encrypted 无法证明对应旧哈希，跳过。`);
      continue;
    }
  }

  const next = hashV2(plaintext);
  await execute(
    `UPDATE surveys SET access_code = ${sqlString(next)}, updated_at = datetime('now') WHERE id = ${Number(row.id)}`,
  );
  upgraded += 1;
  console.log(`[${upgraded}] survey #${row.id} -> sha256v2`);
}

console.log("\n访问密码升级完成：");
console.log(`  已升级：${upgraded}`);
console.log(`  已是 v2：${skippedV2}`);
console.log(`  缺少旧 sha256 明文：${missingLegacyPlaintext}`);
console.log(`  加密副本无效：${invalidLegacyEncryption}`);

if (missingLegacyPlaintext || invalidLegacyEncryption) {
  console.error("存在无法安全自动迁移的旧 sha256 记录；请让对应问卷管理员重新设置访问密码后再执行一次。");
  process.exitCode = 2;
}
