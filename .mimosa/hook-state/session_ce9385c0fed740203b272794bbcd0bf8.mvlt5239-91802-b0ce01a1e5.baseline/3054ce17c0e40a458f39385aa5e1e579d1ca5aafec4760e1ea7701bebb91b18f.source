import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 全部 migration 拼成的完整 schema：给真实 SQLite 的集成测试用。
 *
 * 比手写建表更忠实——列名、索引、约束都和生产一致，能抓到"驼峰 fixture
 * 掩盖了某个列"这类问题（report delivery 的 telegram_user_id 就这么露过馅）。
 */
export function fullMigrationSchema(): string {
  const dir = join(process.cwd(), "db", "migrations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}
