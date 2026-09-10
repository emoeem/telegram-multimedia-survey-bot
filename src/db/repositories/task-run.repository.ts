import {
  normalizeState,
  type TrialMode,
  type TrialPersona,
  type TrialRun,
  type TrialRunState,
} from "../../trial/engine";

export interface TaskRunRecord {
  id: number;
  packId: number;
  userId: number | null;
  participantHash: string;
  persona: TrialPersona;
  mode: TrialMode;
  startingFloor: number;
  currentFloor: number;
  maxFloor: number;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  status: "active" | "completed" | "abandoned";
  state: TrialRunState;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export interface TaskRunInput {
  packId: number;
  userId: number | null;
  participantHash: string;
  persona: TrialPersona;
  mode: TrialMode;
  startingFloor: number;
  maxFloor: number;
  state: TrialRunState;
}

function mapRow(row: Record<string, unknown>): TaskRunRecord {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(String(row.state_json ?? "{}"));
  } catch {
    parsed = {};
  }
  return {
    id: Number(row.id),
    packId: Number(row.pack_id),
    userId: typeof row.user_id === "number" ? row.user_id : null,
    participantHash: String(row.participant_hash ?? ""),
    persona: row.persona === "female" ? "female" : "male",
    mode: row.mode === "hell" ? "hell" : "normal",
    startingFloor: Number(row.starting_floor ?? 1),
    currentFloor: Number(row.current_floor ?? 1),
    maxFloor: Number(row.max_floor ?? 10),
    score: Number(row.score ?? 0),
    completedTasks: Number(row.completed_tasks ?? 0),
    skippedTasks: Number(row.skipped_tasks ?? 0),
    status: row.status === "completed" ? "completed" : row.status === "abandoned" ? "abandoned" : "active",
    state: normalizeState(parsed),
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
    updatedAt: String(row.updated_at),
  };
}

export function toTrialRun(record: TaskRunRecord): TrialRun {
  return {
    id: record.id,
    packId: record.packId,
    persona: record.persona,
    mode: record.mode,
    startingFloor: record.startingFloor,
    currentFloor: record.currentFloor,
    maxFloor: record.maxFloor,
    score: record.score,
    completedTasks: record.completedTasks,
    skippedTasks: record.skippedTasks,
    status: record.status,
    state: record.state,
  };
}

/** Applies engine output back onto the stored record, keeping identity columns. */
export function mergeTaskRun(record: TaskRunRecord, run: TrialRun): TaskRunRecord {
  return { ...record, ...run, state: run.state };
}

export async function createTaskRun(db: D1Database, input: TaskRunInput): Promise<TaskRunRecord> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO task_runs
        (pack_id, user_id, participant_hash, persona, mode, starting_floor, current_floor, max_floor,
         score, completed_tasks, skipped_tasks, status, state_json, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'active', ?, ?, NULL, ?)`,
    )
    .bind(
      input.packId,
      input.userId,
      input.participantHash,
      input.persona,
      input.mode,
      input.startingFloor,
      input.startingFloor,
      input.maxFloor,
      JSON.stringify(input.state),
      now,
      now,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("无法创建挑战局");
  const created = await getTaskRunById(db, id);
  if (!created) throw new Error("无法创建挑战局");
  return created;
}

export async function getTaskRunById(db: D1Database, id: number): Promise<TaskRunRecord | null> {
  const row = await db.prepare("SELECT * FROM task_runs WHERE id = ? LIMIT 1").bind(id).first();
  return row ? mapRow(row as Record<string, unknown>) : null;
}

export async function getActiveTaskRunByParticipant(
  db: D1Database,
  participantHash: string,
): Promise<TaskRunRecord | null> {
  const row = await db
    .prepare("SELECT * FROM task_runs WHERE participant_hash = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
    .bind(participantHash)
    .first();
  return row ? mapRow(row as Record<string, unknown>) : null;
}

export async function saveTaskRun(db: D1Database, record: TaskRunRecord): Promise<void> {
  await db
    .prepare(
      `UPDATE task_runs
       SET current_floor = ?, score = ?, completed_tasks = ?, skipped_tasks = ?, status = ?, state_json = ?,
           finished_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      record.currentFloor,
      record.score,
      record.completedTasks,
      record.skippedTasks,
      record.status,
      JSON.stringify(record.state),
      record.status === "active" ? null : (record.finishedAt ?? new Date().toISOString()),
      new Date().toISOString(),
      record.id,
    )
    .run();
}

export interface LeaderboardEntry {
  runId: number;
  displayName: string;
  score: number;
  floors: number;
  completedTasks: number;
  finishedAt: string;
  /** True when the row belongs to the requesting participant. */
  mine: boolean;
}

/** Public leaderboard: completed runs ranked by score (desc) then time (asc). */
export async function listTaskRunLeaderboard(
  db: D1Database,
  options: { packId: number; mode: TrialMode; limit?: number; participantHash?: string },
): Promise<LeaderboardEntry[]> {
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  const { results } = await db
    .prepare(
      `SELECT r.id, r.score, r.completed_tasks, r.finished_at, r.participant_hash,
              r.max_floor, r.starting_floor,
              u.username, u.first_name
       FROM task_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.pack_id = ? AND r.mode = ? AND r.status = 'completed'
       ORDER BY r.score DESC, r.finished_at ASC
       LIMIT ?`,
    )
    .bind(options.packId, options.mode, limit)
    .all();
  return ((results ?? []) as Record<string, unknown>[]).map((row) => {
    const username = typeof row.username === "string" && row.username ? row.username : null;
    const firstName = typeof row.first_name === "string" && row.first_name ? row.first_name : null;
    const hash = String(row.participant_hash ?? "");
    return {
      runId: Number(row.id),
      displayName: firstName ? `@${username ?? firstName}` : `玩家 ${hash.slice(-4).toUpperCase()}`,
      score: Number(row.score ?? 0),
      floors: Number(row.max_floor ?? 0) - Number(row.starting_floor ?? 0),
      completedTasks: Number(row.completed_tasks ?? 0),
      finishedAt: String(row.finished_at ?? ""),
      mine: options.participantHash ? hash === options.participantHash : false,
    };
  });
}

export async function listTaskRunsByParticipant(
  db: D1Database,
  participantHash: string,
  limit = 10,
): Promise<TaskRunRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM task_runs WHERE participant_hash = ? ORDER BY id DESC LIMIT ?")
    .bind(participantHash, limit)
    .all();
  return (results ?? []).map((row) => mapRow(row as Record<string, unknown>));
}
