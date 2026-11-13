/**
 * env.ADMIN_IDS（逗号分隔）的统一解析。原为 src/index.ts 的私有助手；拆分后
 * guard / bot/bootstrap / cron / http/router 四处共用，独立成文件避免互相
 * 回引 index 造成循环 import。
 */
export function parseAdminIds(value: string): number[] {
  return value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
}
