// 管理后台密码哈希：`pbkdf2$<iterations>$<salt>$<hash>`（base64url）。
//
// 运行时校验在 src/services/admin-password.service.ts。抽成共享模块是为了让
// 初始化脚本（set-admin-password.mjs）和客户部署脚本（deploy-customer.mjs）
// 使用同一份实现——两份实现一旦漂移，就会出现"脚本写进去的哈希登录不了"。
import { webcrypto as crypto } from "node:crypto";

export const ADMIN_PASSWORD_ITERATIONS = 100_000;

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export async function hashAdminPassword(password, iterations = ADMIN_PASSWORD_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  const hash = new Uint8Array(bits);
  return `pbkdf2$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

/** SQL that sets (or rotates) the admin password hash in `system_settings`. */
export function adminPasswordHashSql(hash, updatedAt = new Date().toISOString()) {
  return (
    `INSERT INTO system_settings (key, value, updated_by, updated_at) ` +
    `VALUES ('admin_password_hash', '${hash}', NULL, '${updatedAt}') ` +
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`
  );
}
