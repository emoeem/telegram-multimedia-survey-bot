#!/usr/bin/env node
/**
 * 免登录投稿数据迁移:submission-bot 的 D1 → 本站 D1。
 *
 * 用法(两步,都在本仓库根目录):
 *   1) 从旧账号导出(会提示登录 fb8f4c 账号;database_id 见 /home/emo/code/bot/wrangler.toml):
 *      cd /home/emo/code/bot && npx wrangler d1 export submission-bot-db \
 *        --remote --output /tmp/submission-bot.sql --skip-confirmation
 *   2) 转换 + 产出导入文件(本地转成本站新表结构):
 *      node scripts/migrate-web-submissions.mjs /tmp/submission-bot.sql > web-submissions-import.sql
 *   3) 导入本站(先跑 migration 0088):
 *      pnpm exec wrangler d1 migrations apply DB --remote
 *      pnpm exec wrangler d1 execute DB --remote --file web-submissions-import.sql
 *
 * 映射规则(与 migration 0088 的注释一致):
 *   submissions(id, status, created_at, published_at)  → web_submissions(同 id 保留)
 *   data.__viewer / __email / __ip / __nickname        → viewer_token / email / ip / nickname 列
 *   data.photos[].fileId                               → 保留原样(legacyFileId 语义:由
 *                                                       SUBMISSION_BOT_LEGACY_TOKEN 只读代取)
 *   web_thread_messages                                → web_submission_threads
 *   discussion_comments(仅网页投稿的)                  → web_submission_comments
 *
 * 只迁移 __source='web' 的投稿(Telegram 向导投稿的历史数据留在旧库;旧 Worker
 * 退役后它们不可再访问,导出文件本身即存档)。
 */
import { readFileSync, writeFileSync } from "node:fs";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) fail("用法: node scripts/migrate-web-submissions.mjs <submission-bot.sql> [输出文件]");
const outputPath = process.argv[3] ?? "web-submissions-import.sql";

let sql;
try {
  sql = readFileSync(inputPath, "utf8");
} catch (error) {
  fail(`读不了 ${inputPath}: ${error.message}`);
}

/**
 * 解析一行 INSERT:返回 { table, row } —— row 是「列名 → 值」映射。
 *
 * 按列名而不是位置取值:wrangler d1 export 的列序是导出器决定的(且不同表
 * 顺序不同、未必含全部建表列),位置假设在真实导出上全部错位。
 */
function parseInsertLine(rawLine) {
  // d1 export 把含换行/回车的字符串包成 replace('X','\n',char(10)) 运行时
  // 表达式。先归一化成普通字符串字面量(字面 \n 还原成真换行),扫描器只认一种形态。
  const line = rawLine.replace(/replace\('((?:[^']|'')*)','(?:\\r|\\n)+',char\((?:10|13)\)\)/g, (_all, inner) => {
    const restored = inner.replaceAll("\\r\\n", "\r\n").replaceAll("\\n", "\n").replaceAll("\\r", "\r");
    return `'${restored.replaceAll("'", "''")}'`;
  });
  // 两种形态都容忍:VALUES( 无空格(d1 export)与 VALUES ( 有空格。
  // 值元组用 [\s\S]:归一化后的字符串字面量里是真换行(跨行),`.` 不匹配换行。
  const match = line.match(/^INSERT INTO "([a-z_]+)" \((.*?)\) VALUES\s?\(([\s\S]*)\);\s*$/);
  if (!match) return null;
  const table = match[1];
  const columns = match[2].split(",").map((name) => name.trim().replaceAll('"', ""));
  const body = match[3];

  const values = [];
  let current = "";
  let inString = false;
  let sawValue = false;
  const pushToken = () => {
    const trimmed = current.trim();
    if (trimmed !== "") {
      // SQLite 导出把 NULL 写成裸 NULL(非字符串);其余非字符串 token 是数字。
      values.push(trimmed === "NULL" ? null : trimmed);
    }
    current = "";
    sawValue = false;
  };
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (char === "'") {
        if (body[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
          values.push(current);
          current = "";
          sawValue = true;
        }
      } else {
        current += char;
      }
    } else if (char === "'") {
      // 引号前的空白属于分隔符,不是任何值的一部分。
      current = "";
      inString = true;
    } else if (char === ",") {
      if (sawValue || current.trim() !== "") pushToken();
      else values.push(null); // 空段(只可能出现在尾逗号)
      sawValue = false;
    } else {
      current += char;
    }
  }
  pushToken();
  const row = {};
  columns.forEach((column, index) => {
    row[column] = values[index] ?? null;
  });
  return { table, row };
}

function sqlString(value) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

function sqlInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? String(parsed) : "NULL";
}

const lines = sql.split("\n");
const submissions = [];
const threads = [];
const comments = [];

for (const line of lines) {
  const parsed = parseInsertLine(line);
  if (!parsed) continue;
  const { table, row } = parsed;

  if (table === "submissions") {
    const dataRaw = row.data ?? "{}";
    let data;
    try {
      data = JSON.parse(dataRaw);
    } catch {
      continue;
    }
    if (data.__source !== "web") continue;
    submissions.push({
      id: Number(row.id),
      data: dataRaw,
      status: row.status ?? "pending",
      contentHash: row.content_hash ?? null,
      flags: row.flags ?? null,
      publishChatId: row.publish_chat_id ?? null,
      publishMessageId: row.publish_message_id ?? null,
      // 导出列集不含 updated_at(表没有该列的旧版本),回落 created_at。
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? row.created_at ?? 0),
      publishedAt: row.published_at ?? null,
      fullName: row.full_name ?? null,
    });
  }
  if (table === "web_thread_messages") {
    threads.push({
      submissionId: Number(row.submission_id),
      direction: row.direction ?? "to_author",
      text: row.text ?? "",
      seen: Number(row.seen_by_author ?? 0),
      createdAt: Number(row.created_at ?? 0),
    });
  }
  if (table === "discussion_comments") {
    comments.push({
      submissionId: Number(row.submission_id),
      chatId: row.chat_id ?? null,
      messageId: row.message_id ?? null,
      authorName: row.author_name ?? null,
      text: row.text ?? null,
      parentAuthor: row.parent_author_name ?? null,
      kind: row.kind ?? "user",
      createdAt: Number(row.created_at ?? 0),
    });
  }
}

const submissionIds = new Set(submissions.map((item) => item.id));
const out = [];

out.push("-- 由 scripts/migrate-web-submissions.mjs 生成;目标库需已跑 migration 0088。");
out.push("-- 幂等:重复执行会因主键冲突失败,这是有意的(防止把新库状态覆盖回旧数据)。");
out.push("-- 注意:D1 execute 不接受 BEGIN/COMMIT,按语句逐条执行(wrangler 单文件本身就是原子提交窗口)。");

for (const item of submissions) {
  let data;
  try {
    data = JSON.parse(item.data);
  } catch {
    data = {};
  }
  const viewer = typeof data.__viewer === "string" ? data.__viewer : null;
  const email = typeof data.__email === "string" ? data.__email : null;
  const ip = typeof data.__ip === "string" ? data.__ip : null;
  // 网页表单昵称优先;老数据只有 full_name('网页访客'或管理员改过的名字)。
  const nickname = (typeof data.__nickname === "string" && data.__nickname) || item.fullName || null;
  // data 里的 __ip / __email 敏感信息保留在 data 中不动:收件箱与管理端已从列里读,
  // 保留原始 JSON 作为迁移保真。__viewer 提升为列后从 data 里去掉,避免两处真相。
  if (data.__viewer !== undefined) delete data.__viewer;
  const columns =
    "INSERT INTO web_submissions (id, viewer_token, email, nickname, ip, template_id, data, status, flags, content_hash, publish_chat_id, publish_message_id, created_at, updated_at, published_at) VALUES (";
  out.push(
    columns +
      [
        item.id,
        sqlString(viewer),
        sqlString(email),
        sqlString(nickname),
        sqlString(ip),
        "'default'",
        sqlString(JSON.stringify(data)),
        sqlString(item.status),
        sqlString(item.flags),
        sqlString(item.contentHash),
        sqlString(item.publishChatId),
        sqlInt(item.publishMessageId),
        sqlInt(item.createdAt),
        sqlInt(item.updatedAt),
        item.publishedAt ? sqlInt(item.publishedAt) : "NULL",
      ].join(", ") +
      ");",
  );
}

let threadCount = 0;
for (const item of threads) {
  if (!submissionIds.has(item.submissionId)) continue;
  out.push(
    `INSERT INTO web_submission_threads (submission_id, direction, text, seen_by_author, created_at) VALUES (` +
      [
        item.submissionId,
        sqlString(item.direction),
        sqlString(item.text),
        item.seen ? 1 : 0,
        sqlInt(item.createdAt),
      ].join(", ") +
      ");",
  );
  threadCount += 1;
}

let commentCount = 0;
for (const item of comments) {
  if (!submissionIds.has(item.submissionId)) continue;
  out.push(
    `INSERT INTO web_submission_comments (submission_id, telegram_chat_id, telegram_message_id, author_name, text, kind, parent_author, created_at) VALUES (` +
      [
        item.submissionId,
        sqlString(item.chatId),
        sqlInt(item.messageId),
        sqlString(item.authorName),
        sqlString(item.text),
        sqlString(item.kind),
        sqlString(item.parentAuthor),
        sqlInt(item.createdAt),
      ].join(", ") +
      ");",
  );
  commentCount += 1;
}

writeFileSync(outputPath, out.join("\n") + "\n");
console.log(`✓ 迁移文件已生成: ${outputPath}`);
console.log(`  投稿 ${submissions.length} 条(仅 __source=web)`);
console.log(`  作者-管理员线程 ${threadCount} 条`);
console.log(`  评论区 ${commentCount} 条`);
console.log(`  Telegram 向导投稿未迁移(留在旧库,导出文件即存档)。`);
console.log(`下一步:`);
console.log(`  pnpm exec wrangler d1 migrations apply DB --remote`);
console.log(`  pnpm exec wrangler d1 execute DB --remote --file ${outputPath}`);
