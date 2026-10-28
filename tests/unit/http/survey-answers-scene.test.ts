import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";
import type { Env } from "../../../src/index";
import { isWebAnswerPresent, planWebAnswer } from "../../../src/http/survey/answers";

/**
 * scene 题的答案写入闸门（planWebAnswer / isWebAnswerPresent）。
 *
 * answers.ts 的 planWebAnswer 对未知题型一律 400——新增 scene 题型若漏了
 * 分支，参与者会在「下一题」时收到 unsupported_type。这里用全量迁移建出的
 * 真实 schema 走一遍写入，钉住：合法 visited 落库、失效热点 id 被丢弃、
 * 空 visited 清答案、形状错误 400、必答判定与 matrix 同语义。
 */
const MIGRATIONS_DIR = join(process.cwd(), "db/migrations");

function fullSchema(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
    .join("\n");
}

function makeEnv(db: D1Database): Env {
  return { DB: db, ENVIRONMENT: "development" } as unknown as Env;
}

const SCENE_SETTINGS = JSON.stringify({
  scene: {
    version: 1,
    start: "room",
    scenes: {
      room: {
        id: "room",
        title: "房间",
        image: "/api/survey/media/1",
        width: 1600,
        height: 1000,
        hotspots: [
          {
            id: "window",
            x: 0.05,
            y: 0.08,
            w: 0.3,
            h: 0.5,
            label: "窗外",
            action: { kind: "image", src: "/api/survey/media/2", title: "窗外" },
          },
          {
            id: "cat",
            x: 0.37,
            y: 0.76,
            w: 0.18,
            h: 0.22,
            label: "猫",
            action: { kind: "image", src: "/api/survey/media/3", title: "猫" },
          },
        ],
      },
    },
  },
});

const RESPONSE_ID = 701;
const QUESTION_ID = 711;

const sceneQuestion = {
  id: QUESTION_ID,
  type: "scene",
  settingsJson: SCENE_SETTINGS,
  validationJson: null,
  options: [],
} as unknown as Parameters<typeof planWebAnswer>[2];

const emptyQuestion = {
  id: QUESTION_ID + 1,
  type: "scene",
  settingsJson: null,
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
      "INSERT INTO surveys (id, owner_id, title, status, anonymous, allow_multiple_responses, max_responses_per_user, version, created_at, updated_at) VALUES (501, 1, '场景卷', 'published', 0, 0, 1, 1, ?, ?)",
    )
    .bind(now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO survey_questions (id, survey_id, type, title, required, \"order\", created_at, updated_at) VALUES (?, 501, 'scene', '探索', 1, 0, ?, ?)",
    )
    .bind(QUESTION_ID, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO survey_responses (id, survey_id, participant_hash, status, started_at, created_at, updated_at) VALUES (?, 501, 'scene-test-hash', 'in_progress', ?, ?, ?)",
    )
    .bind(RESPONSE_ID, now, now, now)
    .run();
}

type AnswerPlan = Awaited<ReturnType<typeof planWebAnswer>>;

/** 断言成功并取出写入计划；失败时给出状态码便于排障。 */
function expectStatements(plan: AnswerPlan): D1PreparedStatement[] {
  if ("error" in plan) throw new Error(`应成功，却收到 ${plan.error.status}`);
  return plan.statements;
}

/** 断言被拒绝并取出错误响应。 */
async function expectError(plan: AnswerPlan): Promise<Response> {
  if (!("error" in plan)) throw new Error("应被拒绝，却拿到了写入计划");
  return plan.error;
}

describe.skipIf(!sqliteD1Available)("scene 答案写入（planWebAnswer）", () => {
  let db: D1Database;
  let env: Env;
  beforeAll(() => {
    db = createSqliteD1(fullSchema());
    env = makeEnv(db);
    return seed(db);
  });

  async function storedJsonValue(questionId = QUESTION_ID): Promise<string | null> {
    const row = await db
      .prepare("SELECT json_value FROM answers WHERE response_id = ? AND question_id = ?")
      .bind(RESPONSE_ID, questionId)
      .first<{ json_value: string | null }>();
    return row?.json_value ?? null;
  }

  it("合法 visited 写入 kind-tagged JSON，失效热点 id 被丢弃且去重", async () => {
    const plan = await planWebAnswer(env, RESPONSE_ID, sceneQuestion, {
      kind: "scene",
      visited: ["window", "bogus", "cat", "window"],
    });
    for (const statement of expectStatements(plan)) {
      await statement.run();
    }
    expect(JSON.parse((await storedJsonValue()) ?? "{}")).toEqual({
      kind: "scene",
      visited: ["window", "cat"],
    });
  });

  it("再次提交空 visited 清掉答案行", async () => {
    const plan = await planWebAnswer(env, RESPONSE_ID, sceneQuestion, { kind: "scene", visited: [] });
    for (const statement of expectStatements(plan)) {
      await statement.run();
    }
    expect(await storedJsonValue()).toBeNull();
  });

  it("形状错误返回 400：非对象 / visited 非数组 / 项非字符串", async () => {
    for (const bad of [null, "window", 42, { visited: "window" }, { visited: [1, 2] }, { kind: "scene" }]) {
      const error = await expectError(await planWebAnswer(env, RESPONSE_ID, sceneQuestion, bad));
      expect(error.status, `value=${JSON.stringify(bad)} 应为 400`).toBe(400);
    }
  });

  it("配置缺失（settingsJson 为空）时拒绝作答而不是落库", async () => {
    const error = await expectError(
      await planWebAnswer(env, RESPONSE_ID, emptyQuestion, { kind: "scene", visited: ["window"] }),
    );
    expect(error.status).toBe(400);
  });

  it("isWebAnswerPresent：有 visited 算已答、空 visited 算未答（必答判定与 matrix 同语义）", () => {
    const answer = (jsonValue: string | null) =>
      ({
        jsonValue,
        textValue: null,
        numberValue: null,
        booleanValue: null,
        ratingValue: null,
        dateValue: null,
        timeValue: null,
      }) as Parameters<typeof isWebAnswerPresent>[0];

    expect(isWebAnswerPresent(answer(JSON.stringify({ kind: "scene", visited: ["cat"] })))).toBe(true);
    expect(isWebAnswerPresent(answer(JSON.stringify({ kind: "scene", visited: [] })))).toBe(false);
    expect(isWebAnswerPresent(answer(null))).toBe(false);
  });
});
