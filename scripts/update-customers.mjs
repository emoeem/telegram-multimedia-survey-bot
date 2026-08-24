#!/usr/bin/env node
/**
 * 批量升级所有已部署的客户实例：复用各实例的资源、密钥和授权，
 * 仅重新构建并部署最新代码（含数据库迁移）。
 *
 * 用法：
 *   CLOUDFLARE_ACCOUNT_ID=xxxx CLOUDFLARE_API_TOKEN=xxxx node scripts/update-customers.mjs
 *   node scripts/update-customers.mjs --dry-run
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEPLOYMENTS_ROOT = path.join(ROOT_DIR, "customer-deployments");
const WRANGLER = process.platform === "win32" ? "npx.cmd" : "node";

async function findManifests() {
  let entries;
  try {
    entries = await fs.readdir(DEPLOYMENTS_ROOT, { withFileTypes: true });
  } catch {
    throw new Error(
      `未找到 ${DEPLOYMENTS_ROOT}，请先用 scripts/deploy-customer.mjs 部署客户。`,
    );
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(DEPLOYMENTS_ROOT, entry.name, "deployment-manifest.json");
    try {
      await fs.access(manifestPath);
      manifests.push({ dir: path.join(DEPLOYMENTS_ROOT, entry.name), manifestPath });
    } catch {
      // 目录里没有部署清单则跳过。
    }
  }
  return manifests;
}

function runUpdate(deploymentDir, dryRun) {
  return new Promise((resolve) => {
    const args = [path.join(ROOT_DIR, "scripts/deploy-customer.mjs"), "--update-existing", deploymentDir];
    if (dryRun) args.push("--dry-run");
    const child = spawn(WRANGLER, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["inherit", "inherit", "inherit"],
    });
    child.on("error", (error) => resolve({ ok: false, error: String(error) }));
    child.on("close", (code) => resolve({ ok: code === 0, error: code === 0 ? null : `退出码 ${code}` }));
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!process.env.CLOUDFLARE_API_TOKEN && !dryRun) {
    console.warn("提示：未设置 CLOUDFLARE_API_TOKEN，部署可能失败。");
  }
  const manifests = await findManifests();
  if (manifests.length === 0) {
    console.log("没有找到任何客户部署。");
    return;
  }
  console.log(`共 ${manifests.length} 个客户实例${dryRun ? "（预演）" : ""}：`);
  const failed = [];
  for (const item of manifests) {
    const name = path.basename(item.dir);
    console.log(`\n========== ${name} ==========`);
    const result = await runUpdate(item.dir, dryRun);
    if (!result.ok) {
      failed.push(`${name}: ${result.error}`);
    }
  }
  if (failed.length) {
    console.error(`\n失败 ${failed.length}/${manifests.length}：`);
    for (const line of failed) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`\n✅ 全部 ${manifests.length} 个客户实例${dryRun ? "（预演）" : ""}处理完成。`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
