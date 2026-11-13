// `sending` 是发送阶段（文件已渲染完、即将/正在 sendDocument），不入 0005 的
// 建表约束（该列无 CHECK），仅为幂等记账引入的显式阶段。
export type ExportJobStatus = "pending" | "running" | "sending" | "completed" | "failed";

export interface ExportJob {
  id: number;
  surveyId: number;
  requestedBy: number | null;
  format: "csv" | "zip";
  status: ExportJobStatus;
  r2Key: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface ExportJobRow {
  id: number;
  survey_id: number;
  requested_by: number | null;
  format: string;
  status: string;
  r2_key: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

function mapExportJob(row: ExportJobRow): ExportJob {
  return {
    id: row.id,
    surveyId: row.survey_id,
    requestedBy: row.requested_by,
    format: row.format as ExportJob["format"],
    status: row.status as ExportJobStatus,
    r2Key: row.r2_key,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function createExportJob(
  db: D1Database,
  input: {
    surveyId: number;
    requestedBy: number | null;
    format: ExportJob["format"];
  },
): Promise<ExportJob> {
  const timestamp = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO export_jobs (
        survey_id, requested_by, format, status, created_at
      ) VALUES (?, ?, ?, 'pending', ?)`,
    )
    .bind(input.surveyId, input.requestedBy, input.format, timestamp)
    .run();

  const id = result.meta?.last_row_id;
  if (typeof id !== "number") {
    throw new Error("Failed to create export job");
  }

  const row = await db.prepare("SELECT * FROM export_jobs WHERE id = ? LIMIT 1").bind(id).first<ExportJobRow>();

  if (!row) {
    throw new Error("Failed to load export job");
  }

  return mapExportJob(row);
}

export async function getExportJobById(db: D1Database, id: number): Promise<ExportJob | null> {
  const row = await db.prepare("SELECT * FROM export_jobs WHERE id = ? LIMIT 1").bind(id).first<ExportJobRow>();

  return row ? mapExportJob(row) : null;
}

export async function updateExportJob(
  db: D1Database,
  id: number,
  input: {
    status: ExportJobStatus;
    r2Key?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `UPDATE export_jobs SET
        status = ?,
        r2_key = ?,
        error_message = ?,
        completed_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.status,
      input.r2Key ?? null,
      input.errorMessage ?? null,
      input.status === "completed" || input.status === "failed" ? timestamp : null,
      id,
    )
    .run();
}

/**
 * 原子认领导出任务：条件 UPDATE 抢占，`changes === 1` 才算拿到。两个消费者
 * 同时处理同一条任务时，只有一个能把行推到 `running`，另一个必须跳过。
 *
 * `redelivered`（队列重投，即 message.attempts > 0）额外放行 `running`/`sending`：
 * 队列只在前一次投递失败或消费者死亡后才重投，那时的 `running`/`sending` 是
 * 死消费者的遗留，不放行这些任务会永久卡死（export_jobs 没有恢复扫描）。
 * 重投恰好撞上仍在工作的上一个消费者时，双方后面的 markExportJobSending
 * 条件更新保证只有一方真正发送。
 */
export async function claimExportJob(db: D1Database, id: number, redelivered: boolean): Promise<boolean> {
  const statuses = redelivered ? "('pending', 'running', 'sending', 'failed')" : "('pending', 'failed')";
  const result = await db
    .prepare(`UPDATE export_jobs SET status = 'running' WHERE id = ? AND status IN ${statuses}`)
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * 发送前的最后一步占位：`running` → `sending`。此刻另一个消费者再来标记会
 * 拿到 0 并放弃发送——把「两边都渲染完、都发文件」压成只有先标记的一方发送。
 *
 * 同时写入 sending_at（0097）：维护扫描靠它判定「进入 sending 多久」，没有
 * 这一列，卡死的 sending 行（消费者死亡且重投丢失）既不会被回收也不会被
 * retention 清理——表结构里没有其他状态变迁时间列可复用（created_at 是任务
 * 创建时间，导出可能在 pending/running 上合法停留远超发送窗口，拿它近似会
 * 误判刚进 sending 的健康行）。
 */
export async function markExportJobSending(db: D1Database, id: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE export_jobs SET status = 'sending', sending_at = ? WHERE id = ? AND status = 'running'`)
    .bind(new Date().toISOString(), id)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * 发送成功后的记账：同一个 `db.batch()`（D1 单事务，语句顺序执行、要么全落
 * 要么全不落）里先持久化 message_id、再置 `completed`。export_jobs 没有
 * message_id 列，复用 `r2_key` 存 `tg:<chatId>:<messageId>`——仓库内没有任何
 * 写路径给导出任务填 r2_key，该列实际空闲。
 *
 * 注意：Telegram 没有幂等键，这不是绝对 exactly-once——「请求已送达但响应
 * 丢失/进程在发送后、batch 前死亡」的窗口无法消除，本记账只是把重复窗口压
 * 到最小：之后的重复投递看到 completed（或 sending 且已记账）就直接跳过发送。
 */
export async function completeExportJobDelivery(db: D1Database, id: number, deliveryRef: string | null): Promise<void> {
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (deliveryRef !== null) {
    statements.push(
      db.prepare(`UPDATE export_jobs SET r2_key = ? WHERE id = ? AND status = 'sending'`).bind(deliveryRef, id),
    );
  }
  statements.push(
    db
      .prepare(`UPDATE export_jobs SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'sending'`)
      .bind(timestamp, id),
  );
  await db.batch(statements);
}

/**
 * 防御性收尾：行停在 `sending` 且 r2_key 已记账（上一任发送成功后没来得及走
 * 完收尾——正常情况下记账与置终态在同一个 batch 里，到不了这里；这是给旧
 * 数据或未来把 batch 拆开改的回归留的护栏）。只补终态，绝不重复发送。
 */
export async function completeRecordedExportJob(db: D1Database, id: number): Promise<void> {
  const timestamp = new Date().toISOString();
  await db
    .prepare(
      `UPDATE export_jobs SET status = 'completed', completed_at = ?
       WHERE id = ? AND status = 'sending' AND r2_key IS NOT NULL`,
    )
    .bind(timestamp, id)
    .run();
}
