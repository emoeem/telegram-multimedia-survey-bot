export async function createAuditLog(
  db: D1Database,
  input: {
    actorUserId?: number | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (
        actor_user_id, action, entity_type, entity_id,
        before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.actorUserId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      new Date().toISOString(),
    )
    .run();
}
