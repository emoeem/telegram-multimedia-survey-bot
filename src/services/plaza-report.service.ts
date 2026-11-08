/**
 * 广场（树洞）举报 · 服务层（0096）。
 *
 * 与纸条举报（note-chat.service.ts 的 reportNote / reportMessage）同构，
 * 两处刻意不同：
 *  1) 去重键是 users.id（reporter_user_id），不是 participant_hash——广场
 *     全部写路径要求 dbUserId（无登录用户一律 401 identity_required），而
 *     同一登录用户经 TG initData / 邮箱会话 / 匿名 key 解析出的 hash 各不
 *     相同，按 hash 去重可被同人多身份绕过，report_count 虚高误触发隐藏
 *     （0096 迁移头注释有完整推理）。
 *  2) 阈值隐藏 = status 置 'removed'：广场没有独立的 hidden 态（0037 的
 *     status 只有 published | removed），管理端用既有 status 接口复核恢复。
 *
 * 阈值是常量而不是可配置设置：纸条的 REPORT_HIDE_THRESHOLD 同样是
 * note-chat.service.ts 的硬编码常量（管理端只透传展示），仓库没有举报阈值
 * 这类 system_settings 键，plaza 侧保持同一模式，零迁移结论不变。
 */

/** 举报达到该数自动下架（与纸条 REPORT_HIDE_THRESHOLD = 3 同口径）。 */
export const PLAZA_REPORT_HIDE_THRESHOLD = 3;

/** 举报理由与服务端同口径截断（0089 note_reports 先例）。 */
export const PLAZA_REPORT_REASON_MAX = 200;

export interface PlazaReportOutcome {
  /** 本次举报（或此前的举报）是否已把内容推到阈值下架。 */
  hidden: boolean;
  /** 去重后的累计举报数（同人同对象只计一次）。 */
  reportCount: number;
}

interface ReportTargetRow {
  reportCount: number;
}

/**
 * 举报树洞帖子。目标不存在 / 已下架 / 已删除时返回 null（HTTP 层转 404），
 * 与 plaza-api 现行「读一行判存在」的口径一致；DB 错误原样抛出。
 */
export async function reportPlazaPost(
  db: D1Database,
  postId: number,
  reporterUserId: number,
  reason: string,
): Promise<PlazaReportOutcome | null> {
  return insertReport(
    db,
    "plaza_post_reports",
    "post_id",
    "plaza_posts",
    postId,
    reporterUserId,
    reason,
    `SELECT id, report_count AS reportCount FROM plaza_posts WHERE id = ? AND status = 'published' AND deleted_at IS NULL LIMIT 1`,
  );
}

/** 举报树洞评论。口径同 {@link reportPlazaPost}（评论无 deleted_at，只看 status）。 */
export async function reportPlazaComment(
  db: D1Database,
  commentId: number,
  reporterUserId: number,
  reason: string,
): Promise<PlazaReportOutcome | null> {
  return insertReport(
    db,
    "plaza_comment_reports",
    "comment_id",
    "plaza_post_comments",
    commentId,
    reporterUserId,
    reason,
    `SELECT id, report_count AS reportCount FROM plaza_post_comments WHERE id = ? AND status = 'published' LIMIT 1`,
  );
}

/** 两张举报表共用的插入 + 计数 + 阈值下架；差异只在表名/列名/存在性谓词。 */
async function insertReport(
  db: D1Database,
  reportsTable: string,
  targetColumn: string,
  contentTable: string,
  targetId: number,
  reporterUserId: number,
  reason: string,
  existsSql: string,
): Promise<PlazaReportOutcome | null> {
  const target = await db.prepare(existsSql).bind(targetId).first<ReportTargetRow>();
  if (!target) return null;
  try {
    await db
      .prepare(
        `INSERT INTO ${reportsTable} (${targetColumn}, reporter_user_id, reason, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(targetId, reporterUserId, String(reason ?? "").slice(0, PLAZA_REPORT_REASON_MAX), new Date().toISOString())
      .run();
  } catch (error) {
    // UNIQUE(目标, reporter_user_id) 兜底：同人重复举报幂等返回当前计数
    // （reportNote 同款分支）。
    if (/UNIQUE constraint failed/i.test(String((error as Error)?.message ?? ""))) {
      return { hidden: false, reportCount: Number(target.reportCount ?? 0) };
    }
    throw error;
  }
  const count = Number(target.reportCount ?? 0) + 1;
  const hidden = count >= PLAZA_REPORT_HIDE_THRESHOLD;
  await db
    .prepare(
      `UPDATE ${contentTable} SET report_count = ?, status = CASE WHEN ? THEN 'removed' ELSE status END WHERE id = ?`,
    )
    .bind(count, hidden ? 1 : 0, targetId)
    .run();
  return { hidden, reportCount: count };
}
