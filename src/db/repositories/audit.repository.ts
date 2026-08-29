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

export interface AuditLogListItem {
  id: number;
  actorUserId: number | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  after: unknown;
  createdAt: string;
}

export async function listAuditLogs(
  db: D1Database,
  input: { limit: number; offset: number; action?: string; entityType?: string },
): Promise<{ items: AuditLogListItem[]; total: number }> {
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  if (input.action) {
    conditions.push("a.action = ?");
    binds.push(input.action);
  }
  if (input.entityType) {
    conditions.push("a.entity_type = ?");
    binds.push(input.entityType);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows, count] = (await db.batch([
    db
      .prepare(
        `SELECT a.id, a.actor_user_id actorUserId, a.action, a.entity_type entityType,
                a.entity_id entityId, a.after_json afterJson, a.created_at createdAt,
                u.username, u.first_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ${where}
         ORDER BY a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, input.offset),
    db.prepare(`SELECT COUNT(*) count FROM audit_logs a ${where}`).bind(...binds),
  ])) as [
    D1Result<{
      id: number;
      actorUserId: number | null;
      action: string;
      entityType: string;
      entityId: string | null;
      afterJson: string | null;
      createdAt: string;
      username: string | null;
      first_name: string | null;
    }>,
    D1Result<{ count: number }>,
  ];

  const items = (rows.results ?? []).map((row) => {
    let after: unknown = null;
    if (row.afterJson) {
      try {
        after = JSON.parse(row.afterJson) as unknown;
      } catch {
        after = row.afterJson;
      }
    }
    const actorName = row.first_name ? String(row.first_name) : row.username ? `@${row.username}` : null;
    return {
      id: Number(row.id),
      actorUserId: row.actorUserId === null ? null : Number(row.actorUserId),
      actorName,
      action: String(row.action),
      entityType: String(row.entityType),
      entityId: row.entityId === null ? null : String(row.entityId),
      after,
      createdAt: String(row.createdAt),
    };
  });
  return {
    items,
    total: Number((count.results?.[0] as { count?: number } | undefined)?.count ?? 0),
  };
}
