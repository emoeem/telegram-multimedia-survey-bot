import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import type { Env } from "../../../src/index";
import { isWebAnswerPresent, planWebAnswer } from "../../../src/http/survey/answers";
import { listAnswersByResponseId } from "../../../src/db/repositories/response.repository";

/**
 * 小游戏题（game）的答案写入闸门。
 *
 * 答案不是客户端上报的分数，而是一条 task_runs 引用——服务端按 runId 重算
 * 分数/评级。这里钉住四件事：合法 runId 落库并带服务端分数、别人的局被拒、
 * 还在进行中的局被拒、伪造 score 被忽略（以库里记录为准）。
 */
const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

function fullSchema(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
    .join("\n");
}

const PACK_ID = 41;
const RESPONSE_ID = 801;
const QUESTION_ID = 811;
const PARTICIPANT = "game-test-hash";

const gameQuestion = {
  id: QUESTION_ID,
  type: "game",
  settingsJson: JSON.stringify({ game: { packId: PACK_ID } }),
  validationJson: null,
  options: [],
} as unknown as Parameters<typeof planWebAnswer>[2];

async function seed(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO users (id, telegram_user_id, created_at, updated_at) VALUES (1, 900001, ?, ?)")
    .bind(now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user, version, created_at, updated_at) VALUES (501, 1, '小游戏卷', 'published', 0, 0, 1, 1, ?, ?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      `INSERT INTO survey_questions (id, survey_id, type, title, required, "order", settings_json, created_at, updated_at)
       VALUES (?, 501, 'game', '挑战一下', 1, 0, ?, ?, ?)`,
    )
    .bind(QUESTION_ID, JSON.stringify({ game: { packId: PACK_ID } }), now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, created_at, updated_at) VALUES (?, 501, ?, 'in_progress', ?, ?, ?)",
    )
    .bind(RESPONSE_ID, PARTICIPANT, now, now, now)
    .run();
  // task_runs.pack_id 有外键：先建被引用的任务包（game 题 settings 里也指向它）。
  // 999 是「另一个包」，用于验证跨包引用被拒。
  for (const packId of [PACK_ID, 999]) {
    await db
      .prepare(
        `INSERT INTO task_packs (id, name, description, game_type, settings_json, normal_floors, hell_floors, prep_items, prep_text, enabled, sort_order, created_at, updated_at)
         VALUES (?, ?, NULL, 'tower', '{}', 10, 12, '[]', NULL, 1, 0, ?, ?)`,
      )
      .bind(packId, `小游戏包 ${packId}`, now, now)
      .run();
  }
}

interface RunSeed {
  id: number;
  status: "active" | "completed" | "abandoned";
  score: number;
  participantHash: string;
  packId?: number;
}

async function seedRun(db: D1Database, run: RunSeed): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO task_runs (
         id, pack_id, participant_hash, persona, mode, starting_floor, current_floor, max_floor,
         score, completed_tasks, skipped_tasks, status, state_json, started_at, updated_at
       ) VALUES (?, ?, ?, 'male', 'normal', 1, 3, 10, ?, 2, 0, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      run.packId ?? PACK_ID,
      run.participantHash,
      run.score,
      run.status,
      JSON.stringify({ maxScore: 20 }),
      now,
      now,
    )
    .run();
}

type AnswerPlan = Awaited<ReturnType<typeof planWebAnswer>>;

describe.skipIf(!sqliteD1Available)("game 答案写入（planWebAnswer）", () => {
  let db: D1Database;
  let env: Env;
  beforeAll(async () => {
    db = createSqliteD1(fullSchema());
    env = { DB: db, ENVIRONMENT: "development" } as unknown as Env;
    await seed(db);
  });

  it("合法 runId 落库，分数/评级以库内记录为准（伪造 score 被丢弃）", async () => {
    await seedRun(db, { id: 1001, status: "completed", score: 14, participantHash: PARTICIPANT });
    const plan = await planWebAnswer(
      env,
      RESPONSE_ID,
      gameQuestion,
      // 客户端夹带 score: 999 —— 必须被忽略。
      { kind: "game", runId: 1001, score: 999, grade: "S", completed: true },
      PARTICIPANT,
    );
    if ("error" in plan) throw new Error(`应成功，却收到 ${plan.error.status}`);
    await db.batch(plan.statements);

    const answers = await listAnswersByResponseId(db, RESPONSE_ID);
    const stored = answers.find((answer) => answer.questionId === QUESTION_ID);
    expect(stored?.jsonValue).toBeTruthy();
    const parsed = JSON.parse(stored!.jsonValue!) as {
      kind: string;
      runId: number;
      score: number;
      grade: string | null;
      completed: boolean;
    };
    expect(parsed.kind).toBe("game");
    expect(parsed.runId).toBe(1001);
    expect(parsed.score).toBe(14);
    expect(parsed.completed).toBe(true);
    expect(parsed.grade).toEqual(expect.any(String));
    expect(isWebAnswerPresent(stored)).toBe(true);
  });

  it("别人的局被拒（403）", async () => {
    await seedRun(db, { id: 1002, status: "completed", score: 5, participantHash: "someone-else" });
    const plan = await planWebAnswer(env, RESPONSE_ID, gameQuestion, { runId: 1002 }, PARTICIPANT);
    if (!("error" in plan)) throw new Error("应被拒绝");
    expect(plan.error.status).toBe(403);
  });

  it("包的局不属于该题配置的包 → 400", async () => {
    await seedRun(db, { id: 1003, status: "completed", score: 5, participantHash: PARTICIPANT, packId: 999 });
    const plan = await planWebAnswer(env, RESPONSE_ID, gameQuestion, { runId: 1003 }, PARTICIPANT);
    if (!("error" in plan)) throw new Error("应被拒绝");
    expect(plan.error.status).toBe(400);
  });

  it("进行中的局 → 409（先完成或放弃）", async () => {
    await seedRun(db, { id: 1004, status: "active", score: 0, participantHash: PARTICIPANT });
    const plan = await planWebAnswer(env, RESPONSE_ID, gameQuestion, { runId: 1004 }, PARTICIPANT);
    if (!("error" in plan)) throw new Error("应被拒绝");
    expect(plan.error.status).toBe(409);
  });

  it("未通关（放弃）的局可以保存，但不算已作答", async () => {
    await seedRun(db, { id: 1005, status: "abandoned", score: 3, participantHash: PARTICIPANT });
    const plan = await planWebAnswer(env, RESPONSE_ID, gameQuestion, { runId: 1005 }, PARTICIPANT);
    if ("error" in plan) throw new Error(`应成功，却收到 ${plan.error.status}`);
    await db.batch(plan.statements);
    const answers = await listAnswersByResponseId(db, RESPONSE_ID);
    const stored = answers.find((answer) => answer.questionId === QUESTION_ID);
    const parsed = JSON.parse(stored!.jsonValue!) as { completed: boolean; grade: string | null };
    expect(parsed.completed).toBe(false);
    expect(parsed.grade).toBeNull();
    expect(isWebAnswerPresent(stored)).toBe(false);
  });

  it("配置缺失（没有 packId）→ 400", async () => {
    const broken = { ...gameQuestion, settingsJson: "{}" } as unknown as Parameters<typeof planWebAnswer>[2];
    const plan = await planWebAnswer(env, RESPONSE_ID, broken, { runId: 1001 }, PARTICIPANT);
    if (!("error" in plan)) throw new Error("应被拒绝");
    expect(plan.error.status).toBe(400);
  });
});
