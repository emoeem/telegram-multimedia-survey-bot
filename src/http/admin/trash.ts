import type { Env } from "../../index";
import {
  listTrash,
  permanentlyDeleteTrashItem,
  restoreTrashItem,
  trashCutoff,
  type TrashTarget,
} from "../../services/trash.service";
import { WriteContext, ReadContext, writeAudit } from "./helpers";

function parseTargets(value: unknown): TrashTarget[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "items" in value
      ? (value as { items?: unknown }).items
      : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const kind = (item as { kind?: unknown }).kind;
      const id = (item as { id?: unknown }).id;
      if (!["survey", "showcase_person", "showcase_item", "plaza_post", "report_template"].includes(String(kind)))
        return null;
      if (typeof id !== "string" && typeof id !== "number") return null;
      const idValue = String(id).trim();
      if (!idValue || idValue.length > 64) return null;
      return { kind: kind as TrashTarget["kind"], id: idValue };
    })
    .filter((item): item is TrashTarget => item !== null)
    .slice(0, 100);
}

async function withinRetention(db: D1Database, target: TrashTarget, now = Date.now()): Promise<boolean> {
  const cutoff = trashCutoff(now);
  const table =
    target.kind === "survey"
      ? "surveys"
      : target.kind === "showcase_person"
        ? "showcase_persons"
        : target.kind === "showcase_item"
          ? "showcase_items"
          : target.kind === "plaza_post"
            ? "plaza_posts"
            : "report_templates";
  const row = await db
    .prepare(`SELECT deleted_at FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(target.id)
    .first<{ deleted_at: string | null }>();
  return Boolean(row?.deleted_at && row.deleted_at >= cutoff && row.deleted_at <= new Date(now).toISOString());
}

export async function handleAdminTrashRead(url: URL, env: Env, ctx: ReadContext): Promise<Response | null> {
  if (url.pathname !== "/api/admin/trash") return null;
  if (!ctx.isAdmin) return ctx.fail(403, "forbidden", "仅管理员可使用回收站");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  return ctx.json({ items: await listTrash(env.DB, Date.now(), limit), retentionDays: 30 });
}

export async function handleAdminTrashWrite(
  request: Request,
  url: URL,
  env: Env,
  ctx: WriteContext,
  body: Record<string, unknown>,
): Promise<Response | null> {
  if (url.pathname !== "/api/admin/trash") return null;
  if (!ctx.isAdmin) return ctx.fail(403, "forbidden", "仅管理员可使用回收站");
  const targets = parseTargets(body);
  if (targets.length === 0) return ctx.fail(400, "validation_failed", "请选择至少一项回收站内容");

  const action = request.method === "POST" ? "restore" : request.method === "DELETE" ? "purge" : null;
  if (!action) return ctx.fail(405, "method_not_allowed", "回收站仅支持恢复或彻底删除");

  const results: Array<{ kind: TrashTarget["kind"]; id: string; ok: boolean }> = [];
  for (const target of targets) {
    if (!(await withinRetention(env.DB, target))) {
      results.push({ ...target, ok: false });
      continue;
    }
    const ok =
      action === "restore"
        ? await restoreTrashItem(env.DB, target)
        : await permanentlyDeleteTrashItem(env.DB, target, env.MEDIA_KV);
    results.push({ ...target, ok });
    if (ok) {
      await writeAudit(env.DB, {
        actorUserId: ctx.user.id,
        action: action === "restore" ? "trash.restore" : "trash.purge",
        entityType: target.kind,
        entityId: target.id,
      });
    }
  }
  const failed = results.filter((item) => !item.ok);
  return ctx.json({
    ok: failed.length === 0,
    results,
    ...(failed.length ? { code: "trash_item_expired", message: "部分内容已超过 30 天保留期或已被处理" } : {}),
  });
}
