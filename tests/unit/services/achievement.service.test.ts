import { describe, expect, it } from "vitest";

import {
  ACHIEVEMENTS,
  evaluateAchievements,
  evaluateTimeOfDayAchievements,
  loadAchievementOverview,
  markAchievementsSeen,
  participantHour,
  timeOfDayAchievementCodes,
} from "../../../src/services/achievement.service";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

const SCHEMA = `
CREATE TABLE survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  gallery_published INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE plaza_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published'
);
CREATE TABLE plaza_post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published'
);
CREATE TABLE participant_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  UNIQUE (participant_hash, code)
);
`;

async function seed(db: D1Database) {
  await db.batch([
    db.prepare("INSERT INTO survey_responses (participant_hash, status, gallery_published) VALUES ('web_a', 'completed', 1)"),
    db.prepare("INSERT INTO survey_responses (participant_hash, status, gallery_published) VALUES ('web_a', 'in_progress', 0)"),
    db.prepare("INSERT INTO task_runs (participant_hash, status, score) VALUES ('web_a', 'completed', 620)"),
    db.prepare("INSERT INTO plaza_posts (user_id, status) VALUES (7, 'published')"),
    db.prepare("INSERT INTO plaza_post_comments (user_id, status) VALUES (7, 'published')"),
  ]);
}

describe.skipIf(!sqliteD1Available)("achievement evaluation (real SQLite)", () => {
  it("computes metrics from the real tables and only reports the first unlock", async () => {
    const db = createSqliteD1(SCHEMA);
    await seed(db);

    const firstRun = await evaluateAchievements(db, { participantHash: "web_a", userId: 7 });
    const codes = firstRun.map((item) => item.code);
    expect(codes).toContain("first_survey");
    expect(codes).toContain("profile_published");
    expect(codes).toContain("trial_first_clear");
    expect(codes).toContain("trial_high_score");
    expect(codes).toContain("plaza_first_post");
    expect(codes).toContain("plaza_comment");
    expect(codes).toContain("all_rounder");
    // 未达标的徽章不能提前发放。
    expect(codes).not.toContain("survey_five");
    expect(codes).not.toContain("trial_clear_ten");
    expect(codes).not.toContain("trial_veteran");

    // 第二轮：成绩没变化，就不该再报告「刚刚解锁」。
    expect(await evaluateAchievements(db, { participantHash: "web_a", userId: 7 })).toEqual([]);
  });

  it("keeps every participant's badges separate", async () => {
    const db = createSqliteD1(SCHEMA);
    await db.batch([
      db.prepare("INSERT INTO survey_responses (participant_hash, status, gallery_published) VALUES ('web_a', 'completed', 0)"),
      db.prepare("INSERT INTO survey_responses (participant_hash, status, gallery_published) VALUES ('tg_700', 'completed', 0)"),
    ]);
    const unlocked = await evaluateAchievements(db, { participantHash: "tg_700", userId: 700 });
    expect(unlocked.map((item) => item.code)).toEqual(["first_survey"]);
    expect((await loadAchievementOverview(db, "web_a")).unlocked).toBe(0);
  });

  it("reports catalog progress and clears the unseen dot", async () => {
    const db = createSqliteD1(SCHEMA);
    await seed(db);
    await evaluateAchievements(db, { participantHash: "web_a", userId: 7 });

    const overview = await loadAchievementOverview(db, "web_a");
    expect(overview.total).toBe(ACHIEVEMENTS.length);
    expect(overview.unlocked).toBeGreaterThan(0);
    expect(overview.unseen).toBe(overview.unlocked);
    const nightOwl = overview.items.find((item) => item.code === "night_owl");
    expect(nightOwl).toMatchObject({ unlocked: false, secret: true });

    expect(await markAchievementsSeen(db, "web_a")).toBe(overview.unlocked);
    expect((await loadAchievementOverview(db, "web_a")).unseen).toBe(0);
  });

  it("derives the time-of-day easter eggs from the participant's local hour", async () => {
    // 固定用 UTC 瞬时值断言，这样在 UTC 的 CI 上也是同一结论：
    // 16:30Z = 次日 00:30（北京）/ 22:15Z = 06:15（北京）/ 04:00Z = 12:00（北京）。
    expect(timeOfDayAchievementCodes(new Date("2026-10-02T16:30:00Z"))).toEqual(["night_owl"]);
    expect(timeOfDayAchievementCodes(new Date("2026-10-02T22:15:00Z"))).toEqual(["early_bird"]);
    expect(timeOfDayAchievementCodes(new Date("2026-10-03T04:00:00Z"))).toEqual([]);
    expect(participantHour(new Date("2026-10-02T16:30:00Z"))).toBe(0);

    const db = createSqliteD1(SCHEMA);
    const unlocked = await evaluateTimeOfDayAchievements(db, {
      participantHash: "web_a",
      now: new Date("2026-10-02T16:30:00Z"),
    });
    expect(unlocked.map((item) => item.code)).toEqual(["night_owl"]);
  });
});
