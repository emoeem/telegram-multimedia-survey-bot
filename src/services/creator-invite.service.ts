import {
  createCreatorInvite,
  listCreatorInvites,
  redeemCreatorInvite,
  type CreatorInviteRecord,
  type RedeemCreatorInviteResult,
} from "../db/repositories/creator-invite.repository";
import { grantCreatorTrial } from "../db/repositories/creator-trial.repository";

/**
 * 体验创作者邀请码。
 *
 * 管理端生成码 → 对方在机器人里 /invite 兑换 → 授权落到**他自己的 Telegram 身份**
 * 上（creator_trial_grants），所以到期提醒、按人撤销、后台权限判定全都不用改。
 */

/** 去掉 0/O/1/I 这类易混字符，肉眼抄写不出错。 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CREATOR_INVITE_MAX_USES = 50;
export const CREATOR_INVITE_MAX_DAYS = 365;
export const CREATOR_INVITE_MAX_VALIDITY_DAYS = 90;

function randomBlock(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/** 形如 CR-7F3K-9Q2M。 */
export function generateCreatorInviteCode(): string {
  return `CR-${randomBlock(4)}-${randomBlock(4)}`;
}

/** 允许用户带空格、大小写、省略横线地输入。 */
export function normalizeCreatorInviteCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  const match = compact.match(/^CR([A-Z0-9]{8})$/);
  if (!match) return null;
  return `CR-${match[1]!.slice(0, 4)}-${match[1]!.slice(4)}`;
}

export interface IssueCreatorInviteInput {
  days: number;
  maxUses: number;
  expiresInDays: number;
  note: string | null;
  createdBy: number | null;
}

export function validateIssueInput(input: IssueCreatorInviteInput): string | null {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > CREATOR_INVITE_MAX_DAYS) {
    return `体验天数必须是 1-${CREATOR_INVITE_MAX_DAYS} 的整数`;
  }
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > CREATOR_INVITE_MAX_USES) {
    return `可用次数必须是 1-${CREATOR_INVITE_MAX_USES} 的整数`;
  }
  if (
    !Number.isInteger(input.expiresInDays) ||
    input.expiresInDays < 1 ||
    input.expiresInDays > CREATOR_INVITE_MAX_VALIDITY_DAYS
  ) {
    return `有效期必须是 1-${CREATOR_INVITE_MAX_VALIDITY_DAYS} 天`;
  }
  if (input.note !== null && input.note.length > 60) return "备注不能超过 60 个字";
  return null;
}

export async function issueCreatorInvite(db: D1Database, input: IssueCreatorInviteInput): Promise<CreatorInviteRecord> {
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
  // 撞码概率极低（32^8），但主键冲突时重试一次更省心。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateCreatorInviteCode();
    try {
      return await createCreatorInvite(db, {
        code,
        days: input.days,
        maxUses: input.maxUses,
        expiresAt,
        note: input.note,
        createdBy: input.createdBy,
      });
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("邀请码生成失败");
}

export function listCreatorInvitesForAdmin(db: D1Database, limit = 50): Promise<CreatorInviteRecord[]> {
  return listCreatorInvites(db, limit);
}

export type RedeemForUserResult =
  | { ok: true; days: number; expiresAt: string }
  | { ok: false; reason: Extract<RedeemCreatorInviteResult, { ok: false }>["reason"] };

/** 核销 + 发放体验创作者，一次调用完成（bot 只需处理结果文案）。 */
export async function redeemCreatorInviteForUser(
  db: D1Database,
  input: { code: string; userId: number; grantedBy: number | null },
): Promise<RedeemForUserResult> {
  const normalized = normalizeCreatorInviteCode(input.code);
  if (!normalized) return { ok: false, reason: "not_found" };
  const redeemed = await redeemCreatorInvite(db, normalized);
  if (!redeemed.ok) return redeemed;
  const grant = await grantCreatorTrial(db, {
    userId: input.userId,
    grantedBy: input.grantedBy ?? input.userId,
    days: redeemed.days,
  });
  return { ok: true, days: redeemed.days, expiresAt: grant.expiresAt };
}
