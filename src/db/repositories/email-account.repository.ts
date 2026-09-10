export interface EmailAccountRecord {
  id: number;
  email: string;
  passwordHash: string;
  userId: number | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: Record<string, unknown>): EmailAccountRecord {
  return {
    id: Number(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    userId: typeof row.user_id === "number" ? row.user_id : null,
    verifiedAt: typeof row.verified_at === "string" ? row.verified_at : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getEmailAccountByEmail(db: D1Database, email: string): Promise<EmailAccountRecord | null> {
  const row = await db
    .prepare("SELECT * FROM email_accounts WHERE email = ? LIMIT 1")
    .bind(email.toLowerCase())
    .first();
  return row ? mapRow(row as Record<string, unknown>) : null;
}

export async function getEmailAccountById(db: D1Database, id: number): Promise<EmailAccountRecord | null> {
  const row = await db.prepare("SELECT * FROM email_accounts WHERE id = ? LIMIT 1").bind(id).first();
  return row ? mapRow(row as Record<string, unknown>) : null;
}

export async function createEmailAccount(
  db: D1Database,
  input: { email: string; passwordHash: string; verified: boolean },
): Promise<EmailAccountRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO email_accounts (email, password_hash, user_id, verified_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    )
    .bind(input.email.toLowerCase(), input.passwordHash, input.verified ? now : null, now, now)
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法创建邮箱账户");
  const created = await getEmailAccountById(db, id);
  if (!created) throw new Error("无法创建邮箱账户");
  return created;
}

export async function markEmailAccountVerified(db: D1Database, id: number): Promise<void> {
  await db
    .prepare("UPDATE email_accounts SET verified_at = ?, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), new Date().toISOString(), id)
    .run();
}

export async function updateEmailAccountPassword(db: D1Database, id: number, passwordHash: string): Promise<void> {
  await db
    .prepare(
      "UPDATE email_accounts SET password_hash = ?, verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE id = ?",
    )
    .bind(passwordHash, new Date().toISOString(), new Date().toISOString(), id)
    .run();
}

export async function bindEmailAccountUser(db: D1Database, id: number, userId: number): Promise<void> {
  await db
    .prepare("UPDATE email_accounts SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS NULL")
    .bind(userId, new Date().toISOString(), id)
    .run();
}
