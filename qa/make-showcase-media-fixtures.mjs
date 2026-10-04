/**
 * 生成展示区媒体回归用的三份小样本（图片 / 音频 / 视频），并把它们写成一条可
 * 直接喂给本地 D1 的 seed：媒体以 data: URL 存进 media_assets.url，读取路径和
 * 线上一致（buildMediaResponse 先认 asset.url 的 data: 分支）。
 *
 *   node qa/make-showcase-media-fixtures.mjs
 *   npx wrangler d1 execute DB --local --file=qa/showcase-media-seed.sql
 *
 * 注意：wrangler d1 execute --file 不是原子的（和 migrations apply 不同），所以
 * seed 自己先按固定 id 清一遍，重复执行也安全。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
mkdirSync(fixtures, { recursive: true });

// 本地库里可能已经有 900+ 的展示区素材，QA 样本另取一段 id，避免主键冲突。
const MEDIA_ID_BASE = 950;
const PERSON_ID = 990;

const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const targets = [
  {
    file: "showcase-sample.png",
    mime: "image/png",
    mediaType: "photo",
    kind: "image",
    title: "海报：长夜将明",
    args: ["-f", "lavfi", "-i", "color=c=#3b5bdb:s=320x200", "-frames:v", "1"],
  },
  {
    file: "showcase-sample.wav",
    mime: "audio/wav",
    mediaType: "audio",
    kind: "audio",
    title: "朗读：长夜将明（试听片段）",
    args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "8000"],
  },
  {
    file: "showcase-sample.mp4",
    mime: "video/mp4",
    mediaType: "video",
    kind: "video",
    title: "幕后：写长夜的那一周",
    args: [
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x200:rate=10",
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-movflags", "+faststart",
    ],
  },
];

for (const target of targets) {
  const out = join(fixtures, target.file);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", ...target.args, out]);
  console.log("generated", target.file, readFileSync(out).byteLength, "bytes");
}

const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const articleBody = "夜".repeat(320);

const lines = [
  "-- 由 qa/make-showcase-media-fixtures.mjs 生成：图片/音频/视频各一份 + 一篇长文。",
  "-- 不要手改；要换样本先改生成脚本再重跑。",
  `DELETE FROM media_assets WHERE id >= ${MEDIA_ID_BASE} AND id < ${MEDIA_ID_BASE + 10};`,
  `DELETE FROM showcase_items WHERE person_id = ${PERSON_ID};`,
  `DELETE FROM showcase_persons WHERE id = ${PERSON_ID};`,
  // 早先几轮 QA 留下的同名人物一并清掉，回归脚本里「第一张立绘」才是这份样本。
  `DELETE FROM showcase_items WHERE person_id IN (SELECT id FROM showcase_persons WHERE name = '测试作者' AND id <> ${PERSON_ID});`,
  `DELETE FROM showcase_persons WHERE name = '测试作者' AND id <> ${PERSON_ID};`,
];

targets.forEach((target, index) => {
  const bytes = readFileSync(join(fixtures, target.file));
  const dataUrl = `data:${target.mime};base64,${bytes.toString("base64")}`;
  lines.push(
    `INSERT INTO media_assets (id, asset_scope, media_type, mime_type, file_name, file_size, url, storage_kind, created_at, updated_at)
VALUES (${MEDIA_ID_BASE + index}, 'survey', '${target.mediaType}', '${target.mime}', ${quote(target.file)}, ${bytes.byteLength}, ${quote(dataUrl)}, 'url', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z');`,
  );
});

lines.push(`INSERT INTO showcase_persons (id, name, subtitle, description, accent_color, background_from, background_to, tags_json, links_json, published, sort_order, created_at, updated_at)
VALUES (${PERSON_ID}, '测试作者', '写小说的人', '一位写作者，顺带做朗读和短片。', '#7c8cff', '#182042', '#05070d', '["小说","朗读"]', '[]', 1, 0, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z');`);

targets.forEach((target, index) => {
  lines.push(
    `INSERT INTO showcase_items (person_id, title, description, kind, cover_media_id, cover_url, media_asset_id, url, featured, sort_order, created_at)
VALUES (${PERSON_ID}, ${quote(target.title)}, NULL, '${target.kind}', NULL, NULL, ${MEDIA_ID_BASE + index}, NULL, ${index === 0 ? 1 : 0}, ${index}, '2026-10-03T00:00:00.000Z');`,
  );
});

lines.push(`INSERT INTO showcase_items (person_id, title, description, kind, cover_media_id, cover_url, media_asset_id, url, featured, sort_order, created_at)
VALUES (${PERSON_ID}, '长夜将明', ${quote(articleBody)}, 'article', NULL, NULL, NULL, NULL, 0, 9, '2026-10-03T00:00:00.000Z');`);
lines.push("");

writeFileSync(join(here, "showcase-media-seed.sql"), lines.join("\n"), "utf8");
console.log("wrote qa/showcase-media-seed.sql");
