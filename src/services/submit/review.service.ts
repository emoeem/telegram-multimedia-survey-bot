import { WebSubmitStore } from "./store";
import { composeWebSubmissionText, type WebSubmitFormConfig } from "./form-config";
import { sendMessage } from "../../bot/telegram";

/**
 * 免登录投稿的审核动作（HTTP 管理端与 TG bot 管理共用）。
 *
 * 通过 = CAS 状态翻转到 published（防并发双击/两处同时通过）→ 可选频道摘要
 * 推送（运营在 web_submit_form 配置 publishChannelId 时）→ 给作者线程留言。
 * 发送失败不回滚状态；驳回同理，理由进作者线程。
 */

export type ReviewFailureCode = "not_found" | "already_published" | "already_rejected" | "in_flight";

export type ReviewOutcome = { ok: true; link: string | null } | { ok: false; code: ReviewFailureCode };

export interface ReviewEnv {
  BOT_TOKEN: string;
}

export async function approveWebSubmission(
  env: ReviewEnv,
  db: D1Database,
  config: WebSubmitFormConfig,
  id: number,
): Promise<ReviewOutcome> {
  const store = new WebSubmitStore(db);
  const row = await store.getSubmission(id);
  if (!row) return { ok: false, code: "not_found" };
  if (row.status === "published") return { ok: false, code: "already_published" };
  const won = await store.setStatus(id, "published", ["pending", "failed", "publishing"]);
  if (!won) {
    const fresh = await store.getSubmission(id);
    return { ok: false, code: fresh?.status === "published" ? "already_published" : "in_flight" };
  }
  const channelId = Number(config.publishChannelId);
  let link: string | null = null;
  if (Number.isInteger(channelId) && channelId !== 0) {
    try {
      const text = composeWebSubmissionText(config, row.data, id);
      const sent = await sendMessage(env.BOT_TOKEN, channelId, text.slice(0, 4000), undefined, undefined, "HTML");
      const payload = (await sent.json()) as { result?: { message_id?: number } };
      const messageId = payload?.result?.message_id;
      if (messageId) link = `https://t.me/c/${String(channelId).slice(4)}/${messageId}`;
    } catch (error) {
      console.warn("web submission channel push failed", { id, error: String(error) });
    }
  }
  await store.addThreadMessage(id, "to_author", "你的投稿已通过审核 ✅");
  return { ok: true, link };
}

export async function rejectWebSubmission(
  db: D1Database,
  id: number,
  reason: string,
): Promise<ReviewOutcome> {
  const store = new WebSubmitStore(db);
  const row = await store.getSubmission(id);
  if (!row) return { ok: false, code: "not_found" };
  if (row.status === "published") return { ok: false, code: "already_published" };
  const won = await store.setStatus(id, "rejected", ["pending", "failed"]);
  if (!won) {
    const fresh = await store.getSubmission(id);
    return { ok: false, code: fresh?.status === "rejected" ? "already_rejected" : "in_flight" };
  }
  if (reason) await store.addThreadMessage(id, "to_author", `你的投稿未通过审核：${reason}`);
  return { ok: true, link: null };
}
