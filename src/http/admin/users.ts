import { getUserById } from "../../db/repositories/user.repository";
import { WriteContext, writeAudit } from "./helpers";
import { Env } from "../../index";
import {
  addUserTag,
  cancelActiveResponsesForUser,
  removeUserTag,
  setUserBan,
} from "../../db/repositories/user.repository";

export async function handleAdminUsersWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const { user, isAdmin, fail, json } = ctx;
  const db = env.DB;

  const userTagRoute = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/tags(?:\/([^/]+))?$/);
  if (userTagRoute) {
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可管理用户标签");
    const userId = Number(userTagRoute[1]);
    const target = await getUserById(db, userId);
    if (!target) return fail(404, "not_found", "用户不存在");
    const tagValue = userTagRoute[2];
    if (request.method === "POST" && tagValue === undefined) {
      const tag = typeof body.tag === "string" ? body.tag.trim() : "";
      if (!tag || tag.length > 30) {
        return fail(400, "validation_failed", "标签必须是 1-30 字符的非空字符串");
      }
      await addUserTag(db, { userId, tag, createdBy: user.id });
      return json({ ok: true });
    }
    if (request.method === "DELETE" && tagValue !== undefined) {
      await removeUserTag(db, userId, decodeURIComponent(tagValue));
      return json({ ok: true });
    }
    return fail(405, "method_not_allowed", "仅支持 POST / DELETE");
  }

  const userBanRoute = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/ban$/);
  if (userBanRoute) {
    if (request.method !== "POST") return fail(405, "method_not_allowed", "仅支持 POST");
    if (!isAdmin) return fail(403, "forbidden", "仅管理员可封禁用户");
    const userId = Number(userBanRoute[1]);
    const target = await getUserById(db, userId);
    if (!target) return fail(404, "not_found", "用户不存在");
    if (target.systemRole === "admin") return fail(400, "cannot_ban_admin", "不能封禁管理员");
    const banned = body.banned === true;
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 240) : "";
    await setUserBan(db, userId, {
      banned,
      bannedBy: user.id,
      reason: banned ? reason || "管理员操作" : null,
    });
    if (banned) await cancelActiveResponsesForUser(db, userId);
    await writeAudit(db, {
      actorUserId: user.id,
      action: banned ? "user.ban" : "user.unban",
      entityType: "user",
      entityId: String(userId),
      before: { banned: target.bannedAt !== null },
      after: { banned, reason: reason || null },
    });
    return json({ ok: true, banned });
  }

  // POST /api/admin/imports/from-url — public Microsoft/Zoho Forms URL → survey JSON
  // (PDF / Office documents must be imported through the local Python CLI importer).

  return null;
}
