import { deleteSurvey, restoreSurvey } from "../db/repositories/survey.repository";
import {
  deleteShowcaseItem,
  deleteShowcasePerson,
  restoreShowcaseItem,
  restoreShowcasePerson,
} from "../db/repositories/showcase.repository";
import { restorePlazaPost } from "../db/repositories/plaza-post.repository";
import { deleteCustomReportTemplate, restoreCustomReportTemplate } from "../db/repositories/report-template.repository";
import { getMediaAssetById } from "../db/repositories/media.repository";
import { KVMediaStore } from "./media/temporary-media-store";

export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const TRASH_LIST_LIMIT = 100;

export type TrashKind = "survey" | "showcase_person" | "showcase_item" | "plaza_post" | "report_template";

export interface TrashItem {
  kind: TrashKind;
  id: string;
  title: string;
  deletedAt: string;
  detail?: string | null;
}

export interface TrashTarget {
  kind: TrashKind;
  id: string;
}

export function trashCutoff(now = Date.now()): string {
  return new Date(now - TRASH_RETENTION_DAYS * DAY_MS).toISOString();
}

export async function listTrash(db: D1Database, now = Date.now(), limit = TRASH_LIST_LIMIT): Promise<TrashItem[]> {
  const cutoff = trashCutoff(now);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const [surveys, people, items, posts, templates] = await db.batch([
    db
      .prepare(
        `SELECT id, title, deleted_at deletedAt FROM surveys
       WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC, id DESC LIMIT ?`,
      )
      .bind(cutoff, safeLimit),
    db
      .prepare(
        `SELECT id, name title, deleted_at deletedAt FROM showcase_persons
       WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC, id DESC LIMIT ?`,
      )
      .bind(cutoff, safeLimit),
    db
      .prepare(
        `SELECT i.id, i.title, i.deleted_at deletedAt
       FROM showcase_items i
       LEFT JOIN showcase_persons p ON p.id = i.person_id
       WHERE i.deleted_at IS NOT NULL AND i.deleted_at >= ? AND (p.id IS NULL OR p.deleted_at IS NULL)
       ORDER BY i.deleted_at DESC, i.id DESC LIMIT ?`,
      )
      .bind(cutoff, safeLimit),
    db
      .prepare(
        `SELECT id, substr(content, 1, 80) title, deleted_at deletedAt
       FROM plaza_posts
       WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC, id DESC LIMIT ?`,
      )
      .bind(cutoff, safeLimit),
    db
      .prepare(
        `SELECT id, name title, deleted_at deletedAt FROM report_templates
       WHERE deleted_at IS NOT NULL AND deleted_at >= ? ORDER BY deleted_at DESC, id DESC LIMIT ?`,
      )
      .bind(cutoff, safeLimit),
  ]);

  const rows = [
    ...((surveys?.results ?? []) as Array<Record<string, unknown>>).map((row) => ({
      kind: "survey" as const,
      id: String(row.id),
      title: String(row.title),
      deletedAt: String(row.deletedAt),
    })),
    ...((people?.results ?? []) as Array<Record<string, unknown>>).map((row) => ({
      kind: "showcase_person" as const,
      id: String(row.id),
      title: String(row.title),
      deletedAt: String(row.deletedAt),
    })),
    ...((items?.results ?? []) as Array<Record<string, unknown>>).map((row) => ({
      kind: "showcase_item" as const,
      id: String(row.id),
      title: String(row.title),
      deletedAt: String(row.deletedAt),
    })),
    ...((posts?.results ?? []) as Array<Record<string, unknown>>).map((row) => ({
      kind: "plaza_post" as const,
      id: String(row.id),
      title: String(row.title),
      deletedAt: String(row.deletedAt),
    })),
    ...((templates?.results ?? []) as Array<Record<string, unknown>>).map((row) => ({
      kind: "report_template" as const,
      id: String(row.id),
      title: String(row.title),
      deletedAt: String(row.deletedAt),
    })),
  ];
  rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || Number(b.id) - Number(a.id));
  return rows.slice(0, safeLimit);
}

export async function restoreTrashItem(db: D1Database, target: TrashTarget): Promise<boolean> {
  switch (target.kind) {
    case "survey":
      return restoreSurvey(db, Number(target.id));
    case "showcase_person":
      return restoreShowcasePerson(db, Number(target.id));
    case "showcase_item":
      return restoreShowcaseItem(db, Number(target.id));
    case "plaza_post":
      return restorePlazaPost(db, Number(target.id));
    case "report_template":
      return restoreCustomReportTemplate(db, target.id);
  }
}

export async function permanentlyDeleteTrashItem(
  db: D1Database,
  target: TrashTarget,
  mediaKv?: KVNamespace,
): Promise<boolean> {
  switch (target.kind) {
    case "survey":
      await deleteSurvey(db, Number(target.id), { force: true });
      return true;
    case "showcase_person":
      return deleteShowcasePerson(db, Number(target.id));
    case "showcase_item":
      return deleteShowcaseItem(db, Number(target.id));
    case "report_template":
      return deleteCustomReportTemplate(db, target.id);
    case "plaza_post": {
      const id = Number(target.id);
      const row = await db
        .prepare("SELECT image_asset_id AS imageAssetId FROM plaza_posts WHERE id = ? LIMIT 1")
        .bind(id)
        .first<{ imageAssetId: number | null }>();
      if (mediaKv && row?.imageAssetId) {
        const asset = await getMediaAssetById(db, row.imageAssetId);
        if (asset?.storageKey) await new KVMediaStore(mediaKv).delete(asset.storageKey).catch(() => undefined);
      }
      const result = await db.prepare("DELETE FROM plaza_posts WHERE id = ? AND deleted_at IS NOT NULL").bind(id).run();
      return Number(result.meta?.changes ?? 0) > 0;
    }
  }
}
