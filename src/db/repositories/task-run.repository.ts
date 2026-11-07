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
  /** 爬塔局的状态（插件局这里是空占位，真实状态在 plugin.state）。 */
  state: TrialRunState;
  /** 插件局信封；爬塔局为 null。 */
  plugin: PluginRunEnvelope | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

/**
 * 插件局在 task_runs.state_json 里的信封。
 *
 * 复用既有列：step/total 映射到 current_floor/max_floor，score 直接写 score
 * ——这样排行榜、历史列表、进度条都不必知道"这局是什么玩法"。
 * grade 在结算时写入，答卷写入路径据此取评级（爬塔局的评级是实时算的）。
 */
export interface PluginRunEnvelope {
  kind: "plugin";
  plugin: string;
  state: unknown;
  grade?: string;
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
  /** 插件局必须带信封；带了你就不需要 state。 */
  plugin?: PluginRunEnvelope;
}

export function isPluginEnvelope(value: unknown): value is PluginRunEnvelope {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === "plugin" && typeof raw.plugin === "string" && raw.plugin.length > 0;
}

function mapRow(row: Record<string, unknown>): TaskRunRecord {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(String(row.state_json ?? "{}"));
  } catch {
    parsed = {};
  }
  const plugin = isPluginEnvelope(parsed) ? parsed : null;
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
    // 插件局不做爬塔归一化（normalizeState 会把插件状态整个丢掉）。
    state: plugin ? normalizeState({}) : normalizeState(parsed),
    plugin,
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
      JSON.stringify(input.plugin ?? input.state),
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
      // 插件局按信封整份写回（含引擎状态与结算评级），爬塔局写回状态机。
      JSON.stringify(record.plugin ?? record.state),
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

/**
 * 排行榜的原始行：与查看者无关，可以整体进 KV 戳式缓存。
 *
 * userId / participant_hash 仅用于服务端 mine 判定（见
 * {@link isMineLeaderboardEntry}），出参前由 {@link toPublicLeaderboardEntry}
 * 剥离——这两个标识符不离开服务端。
 */
export interface LeaderboardRawEntry {
  runId: number;
  packId: number;
  userId: number | null;
  participantHash: string;
  displayName: string;
  score: number;
  floors: number;
  completedTasks: number;
  finishedAt: string;
}

/** 聚合榜（玩法总榜）的出参：在单包榜出参上多带 packId，前端据此映射包名。 */
export interface GameTypeLeaderboardEntry extends LeaderboardEntry {
  packId: number;
}

/** mine 判定（0082）：绑定用户按 user_id；绑定前的旧 hash 行也属于同一个人。 */
export function isMineLeaderboardEntry(
  entry: Pick<LeaderboardRawEntry, "userId" | "participantHash">,
  identity: { participantHash?: string | null; participantDbUserId?: number | null },
): boolean {
  return identity.participantDbUserId != null
    ? entry.userId === identity.participantDbUserId
    : Boolean(identity.participantHash && entry.participantHash === identity.participantHash);
}

/** 出参投影：剥掉 userId / participant_hash，避免内部标识符进响应体。 */
export function toPublicLeaderboardEntry(entry: LeaderboardRawEntry, mine: boolean): LeaderboardEntry {
  return {
    runId: entry.runId,
    displayName: entry.displayName,
    score: entry.score,
    floors: entry.floors,
    completedTasks: entry.completedTasks,
    finishedAt: entry.finishedAt,
    mine,
  };
}

function mapLeaderboardRow(row: Record<string, unknown>): LeaderboardRawEntry {
  const username = typeof row.username === "string" && row.username ? row.username : null;
  const firstName = typeof row.first_name === "string" && row.first_name ? row.first_name : null;
  return {
    runId: Number(row.id),
    packId: Number(row.pack_id),
    userId: typeof row.user_id === "number" ? row.user_id : null,
    participantHash: String(row.participant_hash ?? ""),
    // Prefer the @handle; fall back to the real first name, then a neutral
    // label — never a fake @ prefix on a first name.
    displayName: username ? `@${username}` : (firstName ?? "玩家"),
    score: Number(row.score ?? 0),
    floors: Number(row.max_floor ?? 0) - Number(row.starting_floor ?? 0),
    completedTasks: Number(row.completed_tasks ?? 0),
    finishedAt: String(row.finished_at ?? ""),
  };
}

/** Public leaderboard: completed runs ranked by score (desc) then time (asc).
 *  Anti-abuse: only Telegram-identified runs (user_id set) are ranked, and
 *  each player contributes only their single best run. Anonymous runs stay
 *  visible in personal history but never on the public board. */
export async function listTaskRunLeaderboard(
  db: D1Database,
  options: {
    packId: number;
    mode: TrialMode;
    limit?: number;
    participantHash?: string | null;
    participantDbUserId?: number | null;
  },
): Promise<LeaderboardEntry[]> {
  const raw = await listTaskRunLeaderboardRaw(db, options);
  return raw.map((entry) => toPublicLeaderboardEntry(entry, isMineLeaderboardEntry(entry, options)));
}

/** 单包榜的原始投影（{@link listTaskRunLeaderboard} 的可缓存形态，不带 mine）。 */
export async function listTaskRunLeaderboardRaw(
  db: D1Database,
  options: { packId: number; mode: TrialMode; limit?: number },
): Promise<LeaderboardRawEntry[]> {
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  const { results } = await db
    .prepare(
      `SELECT r.id, r.pack_id, r.score, r.completed_tasks, r.finished_at, r.participant_hash,
              r.max_floor, r.starting_floor, r.user_id,
              u.username, u.first_name
       FROM task_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.pack_id = ? AND r.mode = ? AND r.status = 'completed' AND r.user_id IS NOT NULL
         AND r.id = (
           SELECT r2.id FROM task_runs r2
           WHERE r2.user_id = r.user_id AND r2.pack_id = r.pack_id AND r2.mode = r.mode
             AND r2.status = 'completed'
           ORDER BY r2.score DESC, r2.finished_at ASC LIMIT 1
         )
       ORDER BY r.score DESC, r.finished_at ASC
       LIMIT ?`,
    )
    .bind(options.packId, options.mode, limit)
    .all();
  return ((results ?? []) as Record<string, unknown>[]).map(mapLeaderboardRow);
}

/**
 * 玩法总榜（聚合视角）：该玩法**全部任务包**（含已停用的——成绩已经发生，
 * 不因包下架消失）在同一 mode 下的合并分榜。
 *
 * Anti-abuse 与单包榜一致：只统计 Telegram 实名局（user_id NOT NULL），每人
 * 只取单局最优 MAX(score)。刻意**不**复制单包榜的相关子查询——pack_id 过滤
 * 下没有 user_id 前导索引可借（idx_task_runs_leaderboard 前导是 pack_id，
 * 0045），子查询会把行读放大数倍；这里走 GROUP BY 单趟聚合。
 *
 * 明细列（completed_tasks/floors/finished_at/pack_id）依赖 SQLite 的文档化
 * 行为：聚合查询里唯一一个 max() 的裸列取自取得最大值的那一行
 * （sqlite.org/lang_select.html#bareagg），因此展示的是「最好的那一局」的
 * 明细；同分并列时取哪一行由 SQLite 决定（分数相同，明细差异无感知）。
 */
export async function listGameTypeLeaderboard(
  db: D1Database,
  options: { gameType: string; mode: TrialMode; limit?: number },
): Promise<LeaderboardRawEntry[]> {
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  const { results } = await db
    .prepare(
      `SELECT r.id, r.pack_id, r.score, r.completed_tasks, r.finished_at, r.participant_hash,
              r.max_floor, r.starting_floor, r.user_id,
              u.username, u.first_name,
              MAX(r.score) AS best_score
       FROM task_runs r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.pack_id IN (SELECT id FROM task_packs WHERE game_type = ?)
         AND r.mode = ? AND r.status = 'completed' AND r.user_id IS NOT NULL
       GROUP BY r.user_id
       ORDER BY best_score DESC, r.finished_at ASC
       LIMIT ?`,
    )
    .bind(options.gameType, options.mode, limit)
    .all();
  return ((results ?? []) as Record<string, unknown>[]).map(mapLeaderboardRow);
}

/**
 * 榜单戳：`count:maxUpdatedAt`，与 survey 公开目录的戳同构
 * （src/http/survey/catalog.ts:200-209）。
 *
 * 新鲜度机制依赖 task_runs 的写入面：全 src 只有 task-run.repository.ts:122
 * 的 INSERT（开局，status='active'，不进本谓词）与 :167 的 UPDATE
 * （saveTaskRun 每次保存都盖 updated_at）——所以「先开局后完成」必然翻戳，
 * COUNT 则兜住「一批旧局被删除/集合缩减」的情形。探针是
 * idx_task_runs_leaderboard 上的索引范围扫描（pack_id/mode/status 前导），
 * 比榜单查询便宜但**不是零**：戳式缓存省的是榜单 payload 读，不是探针。
 */
export async function loadTaskRunLeaderboardStamp(
  db: D1Database,
  options: { packId: number; mode: TrialMode },
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS stampUpdatedAt
       FROM task_runs
       WHERE pack_id = ? AND mode = ? AND status = 'completed'`,
    )
    .bind(options.packId, options.mode)
    .first<{ n: number; stampUpdatedAt: string }>();
  return `${Number(row?.n ?? 0)}:${row?.stampUpdatedAt ?? ""}`;
}

/** 玩法总榜的戳探针：谓词与 {@link listGameTypeLeaderboard} 一致
 *  （gameType→pack 集合, mode, status='completed'）。 */
export async function loadGameTypeLeaderboardStamp(
  db: D1Database,
  options: { gameType: string; mode: TrialMode },
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS stampUpdatedAt
       FROM task_runs
       WHERE pack_id IN (SELECT id FROM task_packs WHERE game_type = ?)
         AND mode = ? AND status = 'completed'`,
    )
    .bind(options.gameType, options.mode)
    .first<{ n: number; stampUpdatedAt: string }>();
  return `${Number(row?.n ?? 0)}:${row?.stampUpdatedAt ?? ""}`;
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
