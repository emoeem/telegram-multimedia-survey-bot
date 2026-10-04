import { describe, expect, it } from "vitest";

import {
  insertParticipantAchievement,
  listParticipantAchievements,
  markParticipantAchievementsSeen,
} from "../../../src/db/repositories/achievement.repository";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

const SCHEMA = `
CREATE TABLE participant_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  UNIQUE (participant_hash, code)
);
CREATE INDEX idx_participant_achievements_hash
  ON participant_achievements(participant_hash, unlocked_at DESC);
`;

describe.skipIf(!sqliteD1Available)("achievement repository (real SQLite)", () => {
  it("only reports the first unlock as new and scopes rows per participant", async () => {
    const db = createSqliteD1(SCHEMA);
    expect(
      await insertParticipantAchievement(db, { participantHash: "web_a", code: "first_survey", meta: { surveys: 1 } }),
    ).toBe(true);
    // 同一枚徽章重复评估：UNIQUE 约束让它变成 no-op，不产生第二条记录。
    expect(await insertParticipantAchievement(db, { participantHash: "web_a", code: "first_survey" })).toBe(false);
    expect(await insertParticipantAchievement(db, { participantHash: "web_b", code: "first_survey" })).toBe(true);

    const rows = await listParticipantAchievements(db, "web_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "first_survey", seen: false, meta: { surveys: 1 } });
  });

  it("marks unseen badges as seen once", async () => {
    const db = createSqliteD1(SCHEMA);
    await insertParticipantAchievement(db, { participantHash: "web_a", code: "first_survey" });
    await insertParticipantAchievement(db, { participantHash: "web_a", code: "night_owl" });
    await insertParticipantAchievement(db, { participantHash: "web_b", code: "first_survey" });

    expect(await markParticipantAchievementsSeen(db, "web_a")).toBe(2);
    expect(await markParticipantAchievementsSeen(db, "web_a")).toBe(0);
    expect((await listParticipantAchievements(db, "web_a")).every((row) => row.seen)).toBe(true);
    expect((await listParticipantAchievements(db, "web_b"))[0]?.seen).toBe(false);
  });
});
