/**
 * 后台任务中心（ControlCenterPage「后台任务」卡片组）的聚合查询。
 *
 * 只读、零迁移：报告投递（0027）、图片生成（0014）、结果渲染（0013）与导出
 * （0005）四张任务表都是既有表，这里只做 SELECT——失败/积压计数 + 最近失败
 * 明细。写路径一律不进本文件：人工重试只能复用既有端点（报告投递
 * `POST /api/admin/report-deliveries/:id/retry`），其余任务类型当前没有重试
 * 端点，前端入口置灰，绝不在观测层旁边造第二条与队列消费者不一致的状态机。
 */

export interface JobStatusCount {
  status: string;
  count: number;
}

export type JobKind = "delivery" | "image_generator" | "render" | "export";

export interface JobFailureRow {
  kind: JobKind;
  id: number;
  status: string;
  /** export_jobs 没有 attempts 列，恒为 0。 */
  attempts: number;
  error: string | null;
  createdAt: string;
  /** 最近一次状态变化时间：投递=updated_at，其余=completed_at（兜底 created_at）。 */
  happenedAt: string;
  // 按 kind 各取所需，一次查齐避免前端按类型二次请求。
  responseId: number | null;
  surveyId: number | null;
  surveyTitle: string | null;
  generatorId: number | null;
  resultProfileId: number | null;
  chatId: number | null;
  format: string | null;
}

export interface JobOverview {
  counts: {
    deliveries: JobStatusCount[];
    imageGeneratorJobs: JobStatusCount[];
    renderJobs: JobStatusCount[];
    exportJobs: JobStatusCount[];
  };
  /** 积压 = 已入队但还没到终态的行数（投递含 delivering，导出含 sending）。 */
  backlog: {
    deliveries: number;
    imageGeneratorJobs: number;
    renderJobs: number;
    exportJobs: number;
  };
  recentFailures: JobFailureRow[];
}

interface CountRow {
  status: string;
  count: number | null;
}

interface DeliveryFailureRow {
  id: number;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  happenedAt: string;
  responseId: number | null;
  surveyId: number | null;
  surveyTitle: string | null;
}

interface GeneratorFailureRow {
  id: number;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  happenedAt: string;
  generatorId: number;
  chatId: number;
}

interface RenderFailureRow {
  id: number;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  happenedAt: string;
  resultProfileId: number;
  chatId: number | null;
}

interface ExportFailureRow {
  id: number;
  status: string;
  error: string | null;
  createdAt: string;
  happenedAt: string;
  surveyId: number;
  format: string;
}

/**
 * 投递的「失败/重试中」口径：`failed` 是终态；`pending` 且 `next_retry_at`
 * 非空是 failReportDelivery 写入的可重试错误（指数退避中），对管理员同样是
 * 「这条报告没送出去」的信号，所以和 failed 一起进失败明细。
 */
const deliveryFailureWhere = `
WHERE rd.status = 'failed'
   OR (rd.status = 'pending' AND rd.next_retry_at IS NOT NULL)`;

export async function getJobOverview(db: D1Database, limit: number): Promise<JobOverview> {
  // 8 条语句一次 batch（D1 单往返）；每张表各自按 id DESC 取 limit 条失败，
  // 合并后再按 happenedAt 排序截断——四张表的 id 互不相干，全局排序只能靠时间。
  const [
    deliveryCounts,
    generatorCounts,
    renderCounts,
    exportCounts,
    deliveryRows,
    generatorRows,
    renderRows,
    exportRows,
  ] = (await db.batch([
    db.prepare("SELECT status, COUNT(*) AS count FROM report_deliveries GROUP BY status"),
    db.prepare("SELECT status, COUNT(*) AS count FROM image_generator_jobs GROUP BY status"),
    db.prepare("SELECT status, COUNT(*) AS count FROM render_jobs GROUP BY status"),
    db.prepare("SELECT status, COUNT(*) AS count FROM export_jobs GROUP BY status"),
    db
      .prepare(
        `SELECT rd.id, rd.status, rd.attempts, rd.last_error AS error,
                  rd.created_at AS createdAt,
                  COALESCE(rd.updated_at, rd.created_at) AS happenedAt,
                  rd.response_id AS responseId,
                  r.survey_id AS surveyId,
                  s.title AS surveyTitle
           FROM report_deliveries rd
           LEFT JOIN survey_responses r ON r.id = rd.response_id
           LEFT JOIN surveys s ON s.id = r.survey_id
           ${deliveryFailureWhere}
           ORDER BY rd.id DESC
           LIMIT ?`,
      )
      .bind(limit),
    db
      .prepare(
        `SELECT id, status, attempts, error_message AS error,
                  created_at AS createdAt,
                  COALESCE(completed_at, created_at) AS happenedAt,
                  generator_id AS generatorId,
                  chat_id AS chatId
           FROM image_generator_jobs
           WHERE status = 'failed'
           ORDER BY id DESC
           LIMIT ?`,
      )
      .bind(limit),
    db
      .prepare(
        `SELECT id, status, attempts, error_message AS error,
                  created_at AS createdAt,
                  COALESCE(completed_at, started_at, created_at) AS happenedAt,
                  result_profile_id AS resultProfileId,
                  chat_id AS chatId
           FROM render_jobs
           WHERE status = 'failed'
           ORDER BY id DESC
           LIMIT ?`,
      )
      .bind(limit),
    db
      .prepare(
        `SELECT id, status, error_message AS error,
                  created_at AS createdAt,
                  COALESCE(completed_at, created_at) AS happenedAt,
                  survey_id AS surveyId,
                  format
           FROM export_jobs
           WHERE status = 'failed'
           ORDER BY id DESC
           LIMIT ?`,
      )
      .bind(limit),
  ])) as [
    D1Result<CountRow>,
    D1Result<CountRow>,
    D1Result<CountRow>,
    D1Result<CountRow>,
    D1Result<DeliveryFailureRow>,
    D1Result<GeneratorFailureRow>,
    D1Result<RenderFailureRow>,
    D1Result<ExportFailureRow>,
  ];

  const toCounts = (result: D1Result<CountRow>): JobStatusCount[] =>
    (result.results ?? []).map((row) => ({ status: row.status, count: Number(row.count ?? 0) }));

  const sum = (rows: JobStatusCount[], statuses: string[]) =>
    rows.filter((row) => statuses.includes(row.status)).reduce((acc, row) => acc + row.count, 0);

  const deliveries = toCounts(deliveryCounts);
  const imageGeneratorJobs = toCounts(generatorCounts);
  const renderJobs = toCounts(renderCounts);
  const exportJobs = toCounts(exportCounts);

  const failures: JobFailureRow[] = [
    ...(deliveryRows.results ?? []).map((row): JobFailureRow => ({
      kind: "delivery",
      id: row.id,
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      error: row.error,
      createdAt: row.createdAt,
      happenedAt: row.happenedAt,
      responseId: row.responseId,
      surveyId: row.surveyId,
      surveyTitle: row.surveyTitle,
      generatorId: null,
      resultProfileId: null,
      chatId: null,
      format: null,
    })),
    ...(generatorRows.results ?? []).map((row): JobFailureRow => ({
      kind: "image_generator",
      id: row.id,
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      error: row.error,
      createdAt: row.createdAt,
      happenedAt: row.happenedAt,
      responseId: null,
      surveyId: null,
      surveyTitle: null,
      generatorId: row.generatorId,
      resultProfileId: null,
      chatId: row.chatId,
      format: null,
    })),
    ...(renderRows.results ?? []).map((row): JobFailureRow => ({
      kind: "render",
      id: row.id,
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      error: row.error,
      createdAt: row.createdAt,
      happenedAt: row.happenedAt,
      responseId: null,
      surveyId: null,
      surveyTitle: null,
      generatorId: null,
      resultProfileId: row.resultProfileId,
      chatId: row.chatId,
      format: null,
    })),
    ...(exportRows.results ?? []).map((row): JobFailureRow => ({
      kind: "export",
      id: row.id,
      status: row.status,
      attempts: 0,
      error: row.error,
      createdAt: row.createdAt,
      happenedAt: row.happenedAt,
      responseId: null,
      surveyId: row.surveyId,
      surveyTitle: null,
      generatorId: null,
      resultProfileId: null,
      chatId: null,
      format: row.format,
    })),
  ]
    // ISO 时间字符串字典序 = 时间序；同毫秒再按 id 兜底，保证顺序稳定。
    .sort((a, b) => (a.happenedAt === b.happenedAt ? b.id - a.id : b.happenedAt.localeCompare(a.happenedAt)))
    .slice(0, limit);

  return {
    counts: { deliveries, imageGeneratorJobs, renderJobs, exportJobs },
    backlog: {
      deliveries: sum(deliveries, ["pending", "delivering"]),
      imageGeneratorJobs: sum(imageGeneratorJobs, ["queued", "processing"]),
      renderJobs: sum(renderJobs, ["queued", "processing"]),
      exportJobs: sum(exportJobs, ["pending", "running", "sending"]),
    },
    recentFailures: failures,
  };
}
