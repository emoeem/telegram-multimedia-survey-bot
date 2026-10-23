import { describe, expect, it } from "vitest";

import { serveSurveyMedia } from "../../../src/http/survey/media";
import type { Env } from "../../../src/index";
import { createSqliteD1, sqliteD1Available } from "../../helpers/sqlite-d1";

/**
 * 素材公开可见性的**真实 SQL** 语义(公开端点 /api/survey/media/:id)。
 *
 * 这层曾经整个失效:挂载校验的守卫条件写成了 `storageKind !==
 * "temporary"`,而所有素材的 storageKind 恒为 temporary,于是草稿卷、
 * 已下架卷的题图/BGM 都能按自增 id 枚举读取。修复后的语义是:
 *
 *   挂在 status ∈ {published, closed, archived} 且未软删除的问卷上 → 公开
 *   (closed/archived 仍开放:历史答卷者的报告页还引用这些题图,而且问卷
 *   运行期间素材本来就公开过)
 *
 *   draft 挂载 / 软删除问卷 / 完全未挂载 → 拒绝(匿名)
 *
 * mock 型测试(survey-api.test.ts)只能钉「linked 布尔如何驱动行为」,
 * status 过滤本身在 SQL 里,得用真库钉。
 */
const SCHEMA = `
CREATE TABLE surveys (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',
  deleted_at TEXT,
  cover_media_id INTEGER,
  settings_json TEXT
);
CREATE TABLE survey_questions (
  id INTEGER PRIMARY KEY,
  survey_id INTEGER NOT NULL
);
CREATE TABLE question_media (
  question_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL
);
CREATE TABLE question_options (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL
);
CREATE TABLE option_media (
  question_option_id INTEGER NOT NULL,
  media_asset_id INTEGER NOT NULL
);
CREATE TABLE media_assets (
  id INTEGER PRIMARY KEY,
  asset_scope TEXT NOT NULL,
  media_type TEXT NOT NULL,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  url TEXT,
  storage_kind TEXT,
  storage_key TEXT,
  expires_at TEXT,
  mime_type TEXT,
  file_name TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration INTEGER,
  r2_key TEXT,
  created_at TEXT,
  updated_at TEXT
);
`;

function buildEnv() {
  const db = createSqliteD1(SCHEMA);
  for (let id = 1; id <= 10; id += 1) {
    void db
      .prepare(
        "INSERT INTO media_assets (id, asset_scope, media_type, storage_kind, storage_key, mime_type, file_name, file_size) VALUES (?, 'survey', 'audio', 'temporary', ?, 'audio/mpeg', 'bgm.mp3', 3)",
      )
      .bind(id, `media:survey:bgm-${id}`)
      .run();
  }
  const env = {
    DB: db,
    WEBHOOK_SECRET: "webhook-secret",
    MEDIA_KV: {
      put: async () => {},
      get: async () => new ArrayBuffer(3),
    } as unknown as KVNamespace,
  } as unknown as Env;
  return {
    env,
    insert: {
      survey: (
        id: number,
        status: string,
        deletedAt: string | null = null,
        coverMediaId: number | null = null,
        settingsJson: string | null = null,
      ) =>
        void db
          .prepare("INSERT INTO surveys (id, status, deleted_at, cover_media_id, settings_json) VALUES (?, ?, ?, ?, ?)")
          .bind(id, status, deletedAt, coverMediaId, settingsJson)
          .run(),
      question: (id: number, surveyId: number) =>
        void db.prepare("INSERT INTO survey_questions (id, survey_id) VALUES (?, ?)").bind(id, surveyId).run(),
      questionMedia: (questionId: number, mediaAssetId: number) =>
        void db
          .prepare("INSERT INTO question_media (question_id, media_asset_id) VALUES (?, ?)")
          .bind(questionId, mediaAssetId)
          .run(),
    },
  };
}

const describeIf = sqliteD1Available ? describe : describe.skip;

describeIf("survey media visibility (real SQL)", () => {
  it("linked to a published survey → public", async () => {
    const { env, insert } = buildEnv();
    insert.survey(1, "published");
    insert.question(10, 1);
    insert.questionMedia(10, 1);
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/1"), env, 1);
    expect(response.status).toBe(200);
  });

  it("linked to a closed or archived survey → still public (historical reports reference these assets)", async () => {
    const { env, insert } = buildEnv();
    insert.survey(2, "closed");
    insert.question(11, 2);
    insert.questionMedia(11, 2);
    insert.survey(3, "archived");
    insert.question(12, 3);
    insert.questionMedia(12, 3);
    expect((await serveSurveyMedia(new Request("https://worker.test/api/survey/media/2"), env, 2)).status).toBe(200);
    expect((await serveSurveyMedia(new Request("https://worker.test/api/survey/media/3"), env, 3)).status).toBe(200);
  });

  it("linked only to a draft survey → refused (drafts are not enumerable)", async () => {
    const { env, insert } = buildEnv();
    insert.survey(4, "draft");
    insert.question(13, 4);
    insert.questionMedia(13, 4);
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/4"), env, 4);
    expect(response.status).toBe(404);
  });

  it("linked to a soft-deleted survey → refused", async () => {
    const { env, insert } = buildEnv();
    insert.survey(5, "published", "2026-01-01T00:00:00Z");
    insert.question(14, 5);
    insert.questionMedia(14, 5);
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/5"), env, 5);
    expect(response.status).toBe(404);
  });

  it("unlinked asset → refused", async () => {
    const { env } = buildEnv();
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/6"), env, 6);
    expect(response.status).toBe(404);
  });

  it("galgame-style settings_json URL references keep their assets public", async () => {
    const { env, insert } = buildEnv();
    /* 立绘/BGM 不走媒体表,以 URL 字符串嵌在 settings_json(galgame 卷的全部素材)。 */
    insert.survey(7, "published", null, null, JSON.stringify({ background: { image: "/api/survey/media/8" } }));
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/8"), env, 8);
    expect(response.status).toBe(200);
  });

  it("settings_json reference in a DRAFT survey does not make the asset public", async () => {
    const { env, insert } = buildEnv();
    insert.survey(8, "draft", null, null, JSON.stringify({ audio: { url: "/api/survey/media/9" } }));
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/9"), env, 9);
    expect(response.status).toBe(404);
  });

  it("substring ids do not false-match the settings_json reference (767 vs 1767)", async () => {
    const { env, insert } = buildEnv();
    /* 引用的是 1767,素材 767 不能因此变公开。 */
    insert.survey(9, "published", null, null, JSON.stringify({ image: "/api/survey/media/1767" }));
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/10"), env, 10);
    expect(response.status).toBe(404);
  });

  it("cover media of a once-published survey → public", async () => {
    const { env, insert } = buildEnv();
    insert.survey(6, "closed", null, 7);
    const response = await serveSurveyMedia(new Request("https://worker.test/api/survey/media/7"), env, 7);
    expect(response.status).toBe(200);
  });
});
