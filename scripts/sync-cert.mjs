#!/usr/bin/env node
/**
 * 把仓库根目录的 cert/（认证卡生成器源文件）同步进 admin/public/cert/，
 * 这样 `pnpm build:admin` 会随 Vite 一起拷进 admin/dist，由 Worker 的
 * ASSETS binding 在 /cert 路径下对外提供。
 *
 * 源目录 cert/ 仍是唯一事实来源；本脚本只做单向覆盖拷贝。
 */
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "cert");
const dest = join(root, "admin", "public", "cert");

if (!existsSync(src)) {
  console.error(`[sync-cert] source directory missing: ${src}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
const files = readdirSync(dest);
console.log(`[sync-cert] cert/ -> admin/public/cert/ (${files.join(", ")})`);
