import { listCreatorTrialsExpiringBefore } from "../db/repositories/creator-trial.repository";
import { sendMessage } from "../bot/telegram";

export async function sendCreatorTrialExpiryReminders(
  db: D1Database,
  cache: KVNamespace,
  botToken: string,
  adminIds: number[],
): Promise<void> {
  const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const grants = await listCreatorTrialsExpiringBefore(db, deadline);
  for (const grant of grants) {
    const key = `creator-trial-reminder:${grant.id}:${grant.expiresAt.slice(0, 10)}`;
    if (await cache.get(key)) continue;
    const expires = grant.expiresAt.slice(0, 10);
    const userName = grant.user.firstName ?? grant.user.username ?? String(grant.user.telegramUserId);
    try {
      await sendMessage(botToken, grant.user.telegramUserId, `你的体验创作者权限将于 ${expires} 到期。到期后已创建的问卷会保留，但不能再创建、编辑或发布。`);
      for (const adminId of adminIds) {
        await sendMessage(botToken, adminId, `体验创作者即将到期\n用户：${userName}\nTelegram ID：${grant.user.telegramUserId}\n到期：${expires}\n可在 /admin 的“体验创作者”中续期或撤销。`);
      }
      await cache.put(key, "1", { expirationTtl: 14 * 86_400 });
    } catch (error) {
      console.warn("Creator trial reminder failed", grant.userId, error);
    }
  }
}
