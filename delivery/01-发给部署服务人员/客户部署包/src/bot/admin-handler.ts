import {
  deleteSurvey,
  getSurveyById,
  listAllSurveys,
  updateSurveyStatus,
} from "../db/repositories/survey.repository";
import { getUserByTelegramId, upsertUser } from "../db/repositories/user.repository";
import {
  grantCreatorTrial,
  listActiveCreatorTrials,
  revokeCreatorTrial,
} from "../db/repositories/creator-trial.repository";
import {
  isAdmin,
  assertCanManageSurvey,
} from "../services/permission.service";
import { answerCallbackQuery, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import {
  getSurveyPortfolioStatistics,
  getSurveyStatistics,
  listSurveyPerformance,
} from "../services/statistics.service";
import type { BotContext, TelegramCallbackQuery, TelegramMessage } from "./types";
import {
  createLicense,
  deactivateLicenseInstallation,
  extendLicenseUpdates,
  extendTimedLicense,
  getSoftwareLicenseByPublicId,
  listLicenseActivations,
  listSoftwareLicenses,
  listSoftwareReleases,
  registerSoftwareRelease,
  setLicenseStatus,
} from "../services/license.service";
import type {
  SoftwareLicense,
  SoftwareLicenseActivation,
  SoftwareLicenseType,
} from "../db/schema";
import { sendLongMessage } from "./telegram";

const surveyStatusLabels = {
  draft: "草稿",
  published: "已发布",
  closed: "已关闭",
  archived: "已归档",
} as const;

const licenseStatusLabels = {
  active: "有效",
  suspended: "已暂停",
  revoked: "已吊销",
} as const;

interface LicenseIssueState {
  licenseType: SoftwareLicenseType;
  days: number | null;
  maxActivations?: number;
}

interface CreatorTrialIssueState {
  kind: "creator_trial";
  days: number;
}

function licenseIssueStateKey(userId: number): string {
  return `license-issue:${userId}`;
}

function creatorTrialIssueStateKey(userId: number): string {
  return `creator-trial-issue:${userId}`;
}

function adminSurveySearchKey(userId: number): string {
  return `admin-survey-search:${userId}`;
}

function adminSurveySearchInputKey(userId: number): string {
  return `admin-survey-search-input:${userId}`;
}

async function getCreatorTrialIssueState(
  ctx: BotContext,
  userId: number,
): Promise<CreatorTrialIssueState | null> {
  if (!ctx.cache) return null;
  const value = await ctx.cache.get(creatorTrialIssueStateKey(userId));
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CreatorTrialIssueState>;
    return parsed.kind === "creator_trial" && Number.isInteger(parsed.days) && (parsed.days as number) > 0
      ? { kind: "creator_trial", days: parsed.days as number }
      : null;
  } catch {
    return null;
  }
}

async function getLicenseIssueState(
  ctx: BotContext,
  userId: number,
): Promise<LicenseIssueState | null> {
  if (!ctx.cache) return null;
  const value = await ctx.cache.get(licenseIssueStateKey(userId));
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LicenseIssueState>;
    if (
      (parsed.licenseType !== "timed" && parsed.licenseType !== "perpetual") ||
      (parsed.days !== null && parsed.days !== undefined && !Number.isInteger(parsed.days))
    ) {
      return null;
    }
    return { licenseType: parsed.licenseType, days: parsed.days ?? null };
  } catch {
    return null;
  }
}

async function showAdminHome(ctx: BotContext, chatId: number): Promise<void> {
  const licenseAdminEnabled = ctx.licenseAdminEnabled !== false;
  await sendMessage(
    ctx.botToken,
    chatId,
    licenseAdminEnabled
      ? "管理员中心\n\n在这里管理问卷、查看答卷、导出数据、软件授权和体验创作者。"
      : "管理员中心\n\n在这里管理问卷、查看答卷和导出数据。",
    {
      inline_keyboard: [
        [
          { text: "📋 全部问卷", callback_data: "admin:surveys" },
        ],
        [
          { text: "📊 问卷统计总览", callback_data: "admin:overview" },
        ],
        ...(licenseAdminEnabled
          ? [
              [{ text: "🔑 授权与部署", callback_data: "admin:licenses" }],
              [{ text: "👤 体验创作者", callback_data: "admin:trials" }],
            ]
          : []),
      ],
    },
  );
}

async function showLicenseMenu(ctx: BotContext, chatId: number): Promise<void> {
  await sendMessage(
    ctx.botToken,
    chatId,
    "🔑 授权与部署\n\n查看已发放的软件授权，或选择期限后输入客户名称发放新授权。",
    {
      inline_keyboard: [
        [{ text: "查看已发放授权", callback_data: "license:list" }],
        [
          { text: "发放 30 天", callback_data: "license:create:timed:30" },
          { text: "发放 365 天", callback_data: "license:create:timed:365" },
        ],
        [{ text: "发放永久授权", callback_data: "license:create:perpetual:forever" }],
        [{ text: "⬅️ 返回管理员中心", callback_data: "admin:home" }],
      ],
    },
  );
}

async function showCreatorTrialMenu(ctx: BotContext, chatId: number): Promise<void> {
  await sendMessage(
    ctx.botToken,
    chatId,
    "👤 体验创作者\n\n体验用户只能创建、发布和管理自己的问卷，不具备管理员和软件授权权限。",
    {
      inline_keyboard: [
        [{ text: "查看体验用户", callback_data: "trial:list" }],
        [
          { text: "体验 7 天", callback_data: "trial:create:7" },
          { text: "体验 30 天", callback_data: "trial:create:30" },
          { text: "体验 90 天", callback_data: "trial:create:90" },
        ],
        [{ text: "⬅️ 返回管理员中心", callback_data: "admin:home" }],
      ],
    },
  );
}

function formatDate(value: string | null): string {
  if (!value) return "永久";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function formatLicenseSummary(
  license: SoftwareLicense,
  activeActivations?: number,
): string {
  const usage =
    license.licenseType === "timed"
      ? `使用至 ${formatDate(license.expiresAt)}`
      : "永久使用";
  const activationText =
    activeActivations === undefined
      ? ""
      : `，激活 ${activeActivations}/${license.maxActivations}`;
  return `${license.publicId} | ${licenseStatusLabels[license.status]} | ${usage}${activationText}\n客户：${license.customerName ?? "未填写"}`;
}

function formatActivationList(
  activations: SoftwareLicenseActivation[],
): string {
  if (activations.length === 0) return "激活设备：无";
  return [
    "激活设备：",
    ...activations.map((activation, index) => {
      const status = activation.deactivatedAt ? "已停用" : "使用中";
      return `${index + 1}. ${activation.installationName ?? activation.installationId}\n   ID: ${activation.installationId}\n   版本: ${activation.appVersion ?? "未知"} | ${status} | 最后校验: ${formatDate(activation.lastSeenAt)}`;
    }),
  ].join("\n");
}

async function sendLicenseDetails(
  ctx: BotContext,
  chatId: number,
  publicId: string,
): Promise<boolean> {
  const license = await getSoftwareLicenseByPublicId(ctx.db, publicId);
  if (!license) {
    await sendMessage(ctx.botToken, chatId, "授权不存在。");
    return false;
  }
  const activations = await listLicenseActivations(ctx.db, license.id);
  const activeCount = activations.filter(
    (activation) => !activation.deactivatedAt,
  ).length;
  const usage =
    license.licenseType === "timed"
      ? `限时，使用至 ${formatDate(license.expiresAt)}`
      : "永久使用";
  const text = [
    `授权编号：${license.publicId}`,
    `客户：${license.customerName ?? "未填写"}`,
    `状态：${licenseStatusLabels[license.status]}`,
    `类型：${usage}`,
    `升级权益：${formatDate(license.updatesUntil)}`,
    `激活数量：${activeCount}/${license.maxActivations}`,
    "",
    formatActivationList(activations),
  ].join("\n");
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (license.status === "active") {
    rows.push([
      {
        text: "暂停授权",
        callback_data: `license:suspend:${license.publicId}`,
      },
    ]);
  } else if (license.status === "suspended") {
    rows.push([
      {
        text: "恢复授权",
        callback_data: `license:resume:${license.publicId}`,
      },
    ]);
  }
  if (license.status !== "revoked") {
    rows.push([
      {
        text: "吊销授权",
        callback_data: `license:revoke_ask:${license.publicId}`,
      },
    ]);
  }
  await sendLongMessage(
    ctx.botToken,
    chatId,
    text,
    rows.length > 0 ? { inline_keyboard: rows } : undefined,
  );
  return true;
}

async function sendLicenseList(
  ctx: BotContext,
  chatId: number,
): Promise<void> {
  const licenses = await listSoftwareLicenses(ctx.db, 12);
  if (licenses.length === 0) {
    await sendMessage(
      ctx.botToken,
      chatId,
      "暂无已发放的授权。请选择授权期限后输入客户名称即可发放。",
      {
        inline_keyboard: [
          [
            { text: "发放 365 天", callback_data: "license:create:timed:365" },
            { text: "发放永久", callback_data: "license:create:perpetual:forever" },
          ],
          [{ text: "返回管理员中心", callback_data: "admin:home" }],
        ],
      },
    );
    return;
  }
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const [index, license] of licenses.entries()) {
    rows.push([
      {
        text: `${index + 1}. ${license.customerName ?? "未命名客户"} · ${licenseStatusLabels[license.status]} · ${license.licenseType === "timed" ? formatDate(license.expiresAt) : "永久"}`,
        callback_data: `license:view:${license.publicId}`,
      },
    ]);
  }
  rows.push([
    { text: "发放新授权", callback_data: "license:create:timed:365" },
    { text: "返回管理员中心", callback_data: "admin:home" },
  ]);
  await sendMessage(ctx.botToken, chatId, "软件授权\n\n选择一条授权可查看状态、设备和停用操作。", {
    inline_keyboard: rows,
  });
}

async function sendCreatedLicense(
  ctx: BotContext,
  chatId: number,
  actorUserId: number,
  input: LicenseIssueState & { customerName: string },
): Promise<void> {
  const created = await createLicense(ctx.db, {
    licenseType: input.licenseType,
    ...(input.licenseType === "timed"
      ? { usageDays: input.days as number }
      : { updateDays: input.days }),
    maxActivations: input.maxActivations ?? 1,
    customerName: input.customerName,
    actorUserId,
  });
  await sendLongMessage(
    ctx.botToken,
    chatId,
    [
      "授权已发放",
      "",
      `客户：${input.customerName}`,
      `授权编号：${created.license.publicId}`,
      `类型：${created.license.licenseType === "timed" ? `限时至 ${formatDate(created.license.expiresAt)}` : "永久使用"}`,
      `可激活：${created.license.maxActivations} 台部署`,
      "",
      "授权密钥：",
      created.licenseKey,
      "",
      "请立即保存密钥，并只将这一段密钥发给部署人员。部署人员运行交付包时粘贴即可。密钥之后无法再次查看。",
    ].join("\n"),
    {
      inline_keyboard: [
        [
          { text: "查看全部授权", callback_data: "license:list" },
          { text: "继续发放", callback_data: "license:create:timed:365" },
        ],
      ],
    },
  );
}

async function sendCreatorTrialList(
  ctx: BotContext,
  chatId: number,
): Promise<void> {
  const grants = await listActiveCreatorTrials(ctx.db, 30);
  if (grants.length === 0) {
    await sendMessage(ctx.botToken, chatId, "当前没有体验创作者。选择体验天数后，输入对方的 Telegram 数字 ID 即可发放。", {
      inline_keyboard: [
        [{ text: "体验 30 天", callback_data: "trial:create:30" }],
        [{ text: "返回管理员中心", callback_data: "admin:home" }],
      ],
    });
    return;
  }

  const rows: InlineKeyboardMarkup["inline_keyboard"] = grants.map((grant) => {
    const name = grant.user.firstName ?? grant.user.username ?? "未命名用户";
    return [{
      text: `${name} · ${grant.user.telegramUserId} · 至 ${formatDate(grant.expiresAt)}`,
      callback_data: `trial:view:${grant.userId}`,
    }];
  });
  rows.push([{ text: "新增体验创作者", callback_data: "trial:create:30" }]);
  rows.push([{ text: "返回管理员中心", callback_data: "admin:home" }]);
  await sendMessage(ctx.botToken, chatId, "体验创作者\n\n他们只能创建和管理自己的问卷，不具备管理员或软件授权权限。", { inline_keyboard: rows });
}

async function sendCreatorTrialDetails(
  ctx: BotContext,
  chatId: number,
  internalUserId: number,
): Promise<void> {
  const grant = (await listActiveCreatorTrials(ctx.db, 100)).find(
    (item) => item.userId === internalUserId,
  );
  if (!grant) {
    await sendMessage(ctx.botToken, chatId, "该体验授权已失效或不存在。");
    return;
  }
  const usage = await ctx.db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN s.status = 'published' THEN 1 ELSE 0 END) AS published,
            (SELECT COUNT(*) FROM survey_responses r JOIN surveys rs ON rs.id = r.survey_id WHERE rs.owner_id = ?) AS responses
     FROM surveys s WHERE s.owner_id = ?`,
  ).bind(grant.userId, grant.userId).first<{ total: number; published: number | null; responses: number }>();
  await sendMessage(ctx.botToken, chatId, [
    "体验创作者",
    `用户：${grant.user.firstName ?? grant.user.username ?? "未命名用户"}`,
    `Telegram ID：${grant.user.telegramUserId}`,
    `有效至：${formatDate(grant.expiresAt)}`,
    `问卷：${usage?.total ?? 0} 份，已发布 ${usage?.published ?? 0} 份，收到答卷 ${usage?.responses ?? 0} 份`,
    "权限：创建、发布和管理自己的问卷。",
  ].join("\n"), {
    inline_keyboard: [
      [{ text: "撤销体验权限", callback_data: `trial:revoke:${grant.userId}` }],
      [{ text: "返回体验列表", callback_data: "trial:list" }],
    ],
  });
}

function compactAdminSurveyTitle(title: string, maxLength = 28): string {
  const compact = title.replace(/\s+/g, " ").trim();
  return Array.from(compact).length <= maxLength
    ? compact
    : `${Array.from(compact).slice(0, maxLength - 1).join("")}…`;
}

function surveyStatusIcon(status: keyof typeof surveyStatusLabels): string {
  return {
    draft: "📝",
    published: "🟢",
    closed: "⏹",
    archived: "📦",
  }[status];
}

async function getAdminSurveySearch(
  ctx: BotContext,
  userId: number,
): Promise<string> {
  return (await ctx.cache?.get(adminSurveySearchKey(userId)))?.trim() ?? "";
}

async function showAdminSurveyDirectory(
  ctx: BotContext,
  chatId: number,
  userId: number,
  page = 0,
  overview = false,
): Promise<void> {
  const pageSize = 8;
  const search = await getAdminSurveySearch(ctx, userId);
  const result = await listSurveyPerformance(
    ctx.db,
    pageSize,
    Math.max(0, page) * pageSize,
    search,
  );
  const lastPage = Math.max(0, Math.ceil(result.total / pageSize) - 1);
  const safePage = Math.min(Math.max(0, page), lastPage);
  const items = safePage === page
    ? result.items
    : (await listSurveyPerformance(ctx.db, pageSize, safePage * pageSize, search)).items;
  const portfolio = overview
    ? await getSurveyPortfolioStatistics(ctx.db)
    : null;
  const completionRate = portfolio && portfolio.totalStarted > 0
    ? (portfolio.totalCompleted / portfolio.totalStarted) * 100
    : 0;
  const attention = overview && typeof ctx.db.prepare === "function"
    ? await ctx.db.prepare(
      `SELECT
         SUM(CASE WHEN s.status = 'published' AND COALESCE(r.total_completed, 0) = 0 THEN 1 ELSE 0 END) AS zero_completed,
         COALESCE(SUM(r.in_progress), 0) AS in_progress
       FROM surveys s
       LEFT JOIN (
         SELECT survey_id,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS total_completed,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress
         FROM survey_responses
         GROUP BY survey_id
       ) r ON r.survey_id = s.id`,
    ).first<{ zero_completed: number | null; in_progress: number | null }>()
    : null;
  const heading = overview ? "📊 问卷统计总览" : "📋 全部问卷";
  const lines = [
    heading,
    "",
    ...(portfolio
      ? [
          `🗂 ${portfolio.totalSurveys} 份问卷  ·  🟢 ${portfolio.publishedSurveys} 份发布中`,
          `✅ ${portfolio.totalCompleted} 份已完成 / ${portfolio.totalStarted} 次开始  ·  ${completionRate.toFixed(1)}% 完成率`,
          "",
          "⚠️ 需要关注",
          `• ${attention?.zero_completed ?? 0} 份已发布问卷尚无完成答卷`,
          `• ${attention?.in_progress ?? 0} 份答卷正在填写`,
        ]
      : [`🗂 共 ${result.total} 份问卷`]),
    "",
    `🔎 ${search ? `搜索：${search}` : "全部问卷"}  ·  第 ${safePage + 1}/${lastPage + 1} 页（共 ${result.total} 份）`,
  ];
  if (items.length === 0) {
    lines.push("", search ? "没有匹配的问卷。可清除搜索后重试。" : "当前还没有问卷。");
  } else {
    lines.push(
      "",
      ...items.map((survey, index) => [
        `${safePage * pageSize + index + 1}. ${surveyStatusIcon(survey.status)} ${compactAdminSurveyTitle(survey.title, 42)}`,
        `   ${surveyStatusLabels[survey.status]} · 创建者 ${survey.ownerName} · #${survey.id}`,
      ].join("\n")),
    );
  }

  const rows: InlineKeyboardMarkup["inline_keyboard"] = items.map((survey) => [
    {
      text: `${surveyStatusIcon(survey.status)} ${compactAdminSurveyTitle(survey.title)}`,
      callback_data: `admin:survey:${survey.id}`,
    },
  ]);
  const navigation: InlineKeyboardMarkup["inline_keyboard"][number] = [];
  if (safePage > 0) {
    navigation.push({
      text: "⬅️ 上一页",
      callback_data: `admin:survey_list:${safePage - 1}:${overview ? 1 : 0}`,
    });
  }
  if (safePage < lastPage) {
    navigation.push({
      text: "下一页 ➡️",
      callback_data: `admin:survey_list:${safePage + 1}:${overview ? 1 : 0}`,
    });
  }
  if (navigation.length > 0) rows.push(navigation);
  rows.push([{ text: "🔎 搜索问卷", callback_data: `admin:survey_search:${overview ? 1 : 0}` }]);
  if (search) {
    rows.push([{ text: "✖️ 清除搜索", callback_data: `admin:survey_search_clear:${overview ? 1 : 0}` }]);
  }
  rows.push([{ text: "⬅️ 返回管理员中心", callback_data: "admin:home" }]);
  await sendLongMessage(ctx.botToken, chatId, lines.join("\n"), {
    inline_keyboard: rows,
  });
}

async function handleLicenseAdminCommand(
  ctx: BotContext,
  message: TelegramMessage,
  text: string,
  actorUserId: number,
): Promise<boolean> {
  if (text === "/license_help") {
    await sendLongMessage(
      ctx.botToken,
      message.chat.id,
      [
        "给客户授权，只需要三步：",
        "",
        "1. 创建授权",
        "/license_create 30 客户名",
        "/license_create 365 客户名",
        "/license_create forever 客户名",
        "",
        "2. 机器人会返回一段授权密钥，把密钥和软件交给客户。",
        "",
        "3. 在客户部署的软件中填入这段密钥，机器人会自动激活。",
        "",
        "常用管理：",
        "/licenses 查看授权",
        "/license_revoke <授权编号>",
        "",
        "30 和 365 表示可使用天数，forever 表示永久使用和永久升级。",
        "以上简化授权默认只允许 1 个客户部署。",
        "发送 /license_help_advanced 查看设备数、延期和升级期限等高级命令。",
      ].join("\n"),
    );
    return true;
  }

  if (text === "/license_help_advanced") {
    await sendLongMessage(
      ctx.botToken,
      message.chat.id,
      [
        "软件授权高级命令：",
        "/license_create timed <使用天数> <设备数> <客户名>",
        "/license_create perpetual <升级天数|forever> <设备数> <客户名>",
        "/license_extend <授权编号> <天数>",
        "/license_updates <授权编号> <天数|forever>",
        "/license_deactivate <授权编号> <设备ID>",
        "/license_suspend <授权编号>",
        "/license_resume <授权编号>",
        "/license_revoke <授权编号>",
        "/release_add <版本号> [YYYY-MM-DD]",
        "/releases 查看已登记版本",
        "",
        "永久授权的使用权不会到期；升级期限只决定它能运行哪些发布日期的版本。",
      ].join("\n"),
    );
    return true;
  }

  if (text === "/licenses") {
    await sendLicenseList(ctx, message.chat.id);
    return true;
  }

  if (text.startsWith("/license_create ")) {
    const parts = text.split(/\s+/);
    const advanced = parts[1] === "timed" || parts[1] === "perpetual";
    const type: SoftwareLicenseType = advanced
      ? (parts[1] as SoftwareLicenseType)
      : parts[1]?.toLowerCase() === "forever"
        ? "perpetual"
        : "timed";
    const period = advanced ? parts[2] : parts[1];
    const maxActivations = advanced ? Number(parts[3]) : 1;
    const customerName = parts.slice(advanced ? 4 : 2).join(" ").trim();
    if (!period || !Number.isInteger(maxActivations) || !customerName) {
      throw new Error("参数错误，请发送 /license_help 查看简单格式");
    }
    const forever = period.toLowerCase() === "forever";
    if (type === "timed" && forever) {
      throw new Error("限时授权必须填写使用天数");
    }
    const days = forever ? null : Number(period);
    if (days !== null && !Number.isInteger(days)) {
      throw new Error("天数必须是整数或 forever");
    }
    await sendCreatedLicense(ctx, message.chat.id, actorUserId, {
      licenseType: type,
      days,
      maxActivations,
      customerName,
    });
    return true;
  }

  if (text.startsWith("/license_extend ")) {
    const [, publicId, daysText] = text.split(/\s+/);
    const days = Number(daysText);
    if (!publicId || !Number.isInteger(days)) {
      throw new Error("格式：/license_extend <授权编号> <天数>");
    }
    const license = await extendTimedLicense(
      ctx.db,
      publicId,
      days,
      actorUserId,
    );
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `${license.publicId} 已延期至 ${formatDate(license.expiresAt)}。`,
    );
    return true;
  }

  if (text.startsWith("/license_updates ")) {
    const [, publicId, period] = text.split(/\s+/);
    if (!publicId || !period) {
      throw new Error(
        "格式：/license_updates <授权编号> <天数|forever>",
      );
    }
    const days = period.toLowerCase() === "forever" ? null : Number(period);
    if (days !== null && !Number.isInteger(days)) {
      throw new Error("升级天数必须是整数或 forever");
    }
    const license = await extendLicenseUpdates(
      ctx.db,
      publicId,
      days,
      actorUserId,
    );
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `${license.publicId} 的升级权益已更新为 ${formatDate(license.updatesUntil)}。`,
    );
    return true;
  }

  if (text.startsWith("/license_deactivate ")) {
    const [, publicId, installationId] = text.split(/\s+/);
    if (!publicId || !installationId) {
      throw new Error(
        "格式：/license_deactivate <授权编号> <设备ID>",
      );
    }
    await deactivateLicenseInstallation(
      ctx.db,
      publicId,
      installationId,
      actorUserId,
    );
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `${publicId} 的设备 ${installationId} 已停用，激活名额已释放。`,
    );
    return true;
  }

  if (
    text.startsWith("/license_suspend ") ||
    text.startsWith("/license_resume ")
  ) {
    const [command, publicId] = text.split(/\s+/);
    if (!publicId) {
      throw new Error(`${command} 后需要授权编号`);
    }
    const status = command === "/license_suspend" ? "suspended" : "active";
    const license = await setLicenseStatus(
      ctx.db,
      publicId,
      status,
      actorUserId,
    );
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `${license.publicId} 状态已更新为${licenseStatusLabels[license.status]}。`,
    );
    return true;
  }

  if (text.startsWith("/license_revoke ")) {
    const publicId = text.split(/\s+/)[1];
    if (!publicId) {
      throw new Error("格式：/license_revoke <授权编号>");
    }
    const license = await getSoftwareLicenseByPublicId(ctx.db, publicId);
    if (!license) throw new Error("授权不存在");
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `确认永久吊销 ${license.publicId}？吊销后不能恢复。`,
      {
        inline_keyboard: [
          [
            {
              text: "确认吊销",
              callback_data: `license:revoke_confirm:${license.publicId}`,
            },
            {
              text: "取消",
              callback_data: `license:view:${license.publicId}`,
            },
          ],
        ],
      },
    );
    return true;
  }

  if (text.startsWith("/release_add ")) {
    const [, version, dateText] = text.split(/\s+/);
    if (!version) {
      throw new Error("格式：/release_add <版本号> [YYYY-MM-DD]");
    }
    const releasedAt = dateText
      ? `${dateText}T00:00:00.000Z`
      : new Date().toISOString();
    const release = await registerSoftwareRelease(ctx.db, {
      version,
      releasedAt,
      actorUserId,
    });
    await sendMessage(
      ctx.botToken,
      message.chat.id,
      `版本 ${release.version} 已登记，发布日期 ${formatDate(release.releasedAt)}。`,
    );
    return true;
  }

  if (text === "/releases") {
    const releases = await listSoftwareReleases(ctx.db, 50);
    const body =
      releases.length === 0
        ? "当前没有已登记版本。"
        : releases
            .map(
              (release, index) =>
                `${index + 1}. ${release.version} | ${release.channel} | ${formatDate(release.releasedAt)}`,
            )
            .join("\n");
    await sendLongMessage(ctx.botToken, message.chat.id, body);
    return true;
  }

  return false;
}

function isAdminCommand(text: string): boolean {
  return [
    "/admin",
    "/surveys_admin",
    "/licenses",
    "/license_help",
    "/license_help_advanced",
    "/license_create",
    "/license_extend",
    "/license_updates",
    "/license_deactivate",
    "/license_suspend",
    "/license_resume",
    "/license_revoke",
    "/release_add",
    "/releases",
    "/trials",
  ].some((command) => text === command || text.startsWith(`${command} `));
}

export async function handleAdminMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<boolean> {
  const text = message.text?.trim();
  const userId = message.from?.id;

  if (text && userId && ctx.cache) {
    const searchMode = await ctx.cache.get(adminSurveySearchInputKey(userId));
    if (searchMode === "overview" || searchMode === "manage") {
      const user = await getUserByTelegramId(ctx.db, userId);
      if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) return false;
      if (text === "/cancel") {
        await ctx.cache.delete(adminSurveySearchInputKey(userId));
        await sendMessage(ctx.botToken, message.chat.id, "已取消搜索。");
        return true;
      }
      if (!text.startsWith("/")) {
        const search = text.slice(0, 80);
        await ctx.cache.put(adminSurveySearchKey(userId), search, {
          expirationTtl: 24 * 60 * 60,
        });
        await ctx.cache.delete(adminSurveySearchInputKey(userId));
        await showAdminSurveyDirectory(
          ctx,
          message.chat.id,
          userId,
          0,
          searchMode === "overview",
        );
        return true;
      }
    }
  }

  if (!text || !isAdminCommand(text) || !userId) {
    if (!text || !userId) return false;
    const trialState = await getCreatorTrialIssueState(ctx, userId);
    const issueState = await getLicenseIssueState(ctx, userId);
    if (!issueState && !trialState) return false;
    const user = await getUserByTelegramId(ctx.db, userId);
    if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
      return false;
    }
    if (ctx.licenseAdminEnabled === false) {
      await ctx.cache?.delete(licenseIssueStateKey(userId));
      await ctx.cache?.delete(creatorTrialIssueStateKey(userId));
      await sendMessage(ctx.botToken, message.chat.id, "此部署不是授权中心，无法发放软件授权或体验权限。");
      return true;
    }
    if (text === "/cancel") {
      await ctx.cache?.delete(licenseIssueStateKey(userId));
      await ctx.cache?.delete(creatorTrialIssueStateKey(userId));
      await sendMessage(ctx.botToken, message.chat.id, "已取消当前操作。");
      return true;
    }
    if (text.startsWith("/")) return false;
    if (trialState) {
      const targetTelegramId = Number(text);
      if (!Number.isSafeInteger(targetTelegramId) || targetTelegramId <= 0) {
        await sendMessage(ctx.botToken, message.chat.id, "请输入有效的 Telegram 数字 ID，或发送 /cancel 取消。");
        return true;
      }
      if (isAdmin(targetTelegramId, ctx.adminIds)) {
        await ctx.cache?.delete(creatorTrialIssueStateKey(userId));
        await sendMessage(ctx.botToken, message.chat.id, "该用户已是系统管理员，不需要体验创作者授权。");
        return true;
      }
      let target = await getUserByTelegramId(ctx.db, targetTelegramId);
      if (!target) {
        target = await upsertUser(ctx.db, { telegramUserId: targetTelegramId });
      }
      if (target.systemRole === "admin") {
        await ctx.cache?.delete(creatorTrialIssueStateKey(userId));
        await sendMessage(ctx.botToken, message.chat.id, "该用户已是系统管理员，不需要体验创作者授权。");
        return true;
      }
      const grant = await grantCreatorTrial(ctx.db, {
        userId: target.id,
        grantedBy: user.id,
        days: trialState.days,
      });
      await ctx.cache?.delete(creatorTrialIssueStateKey(userId));
      await sendMessage(ctx.botToken, message.chat.id, [
        "体验创作者已开通",
        `Telegram ID：${target.telegramUserId}`,
        `有效至：${formatDate(grant.expiresAt)}`,
        "对方可创建、发布和管理自己的问卷，不具备管理员或软件授权权限。",
      ].join("\n"), {
        inline_keyboard: [[{ text: "查看体验用户", callback_data: "trial:list" }]],
      });
      return true;
    }
    if (!issueState) return false;
    await ctx.cache?.delete(licenseIssueStateKey(userId));
    await sendCreatedLicense(ctx, message.chat.id, user.id, {
      ...issueState,
      customerName: text.slice(0, 120),
    });
    return true;
  }

  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
    await sendMessage(ctx.botToken, message.chat.id, "你没有管理员权限。");
    return true;
  }

  if (
    ctx.licenseAdminEnabled === false &&
    (
      text.startsWith("/license_") ||
      text === "/licenses" ||
      text === "/releases" ||
      text.startsWith("/release_add")
    )
  ) {
    await sendMessage(ctx.botToken, message.chat.id, "此部署不是授权中心，无法发放或管理软件授权。");
    return true;
  }

  if (text === "/trials") {
    if (ctx.licenseAdminEnabled === false) {
      await sendMessage(ctx.botToken, message.chat.id, "此部署不是授权中心，无法管理体验创作者。");
    } else {
      await sendCreatorTrialList(ctx, message.chat.id);
    }
    return true;
  }

  if (await handleLicenseAdminCommand(ctx, message, text, user.id)) {
    return true;
  }

  if (text === "/admin") {
    await showAdminHome(ctx, message.chat.id);
    return true;
  }

  await showAdminSurveyDirectory(ctx, message.chat.id, userId);
  return true;
}

export async function handleAdminCallback(
  ctx: BotContext,
  callback: TelegramCallbackQuery,
): Promise<boolean> {
  const data = callback.data;
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;

  if (!data || !chatId) {
    return false;
  }

  if (!data.startsWith("admin:") && !data.startsWith("license:") && !data.startsWith("trial:")) {
    return false;
  }

  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
    await answerCallbackQuery(ctx.botToken, callback.id, "没有管理员权限");
    return true;
  }

  if (ctx.licenseAdminEnabled === false && (data.startsWith("license:") || data.startsWith("trial:"))) {
    await answerCallbackQuery(ctx.botToken, callback.id, "此部署不是授权中心");
    return true;
  }

  if (data === "admin:home") {
    await showAdminHome(ctx, chatId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "admin:surveys") {
    await showAdminSurveyDirectory(ctx, chatId, userId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "admin:overview") {
    await showAdminSurveyDirectory(ctx, chatId, userId, 0, true);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:survey_list:")) {
    const [, , , pageRaw, overviewRaw] = data.split(":");
    const page = Number(pageRaw);
    if (!Number.isInteger(page) || page < 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "页码无效");
      return true;
    }
    await showAdminSurveyDirectory(ctx, chatId, userId, page, overviewRaw === "1");
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:survey_search_clear:")) {
    const overview = data.endsWith(":1");
    await ctx.cache?.delete(adminSurveySearchKey(userId));
    await showAdminSurveyDirectory(ctx, chatId, userId, 0, overview);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:survey_search:")) {
    const overview = data.endsWith(":1");
    if (!ctx.cache) {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前部署未启用搜索功能");
      return true;
    }
    await ctx.cache.put(
      adminSurveySearchInputKey(userId),
      overview ? "overview" : "manage",
      { expirationTtl: 10 * 60 },
    );
    await sendMessage(
      ctx.botToken,
      chatId,
      "请发送问卷标题关键词或内部编号；发送 /cancel 取消搜索。",
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "admin:licenses") {
    await showLicenseMenu(ctx, chatId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "admin:trials") {
    await showCreatorTrialMenu(ctx, chatId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "license:list") {
    await sendLicenseList(ctx, chatId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data === "trial:list") {
    await sendCreatorTrialList(ctx, chatId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("trial:create:")) {
    const days = Number(data.slice("trial:create:".length));
    if (!Number.isInteger(days) || days <= 0 || days > 3650) {
      await answerCallbackQuery(ctx.botToken, callback.id, "体验天数无效");
      return true;
    }
    if (!ctx.cache) {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前部署未启用授权工作台");
      return true;
    }
    await ctx.cache.put(
      creatorTrialIssueStateKey(userId),
      JSON.stringify({ kind: "creator_trial", days }),
      { expirationTtl: 15 * 60 },
    );
    await sendMessage(ctx.botToken, chatId, `开通 ${days} 天体验创作者。\n\n请发送对方的 Telegram 数字 ID；发送 /cancel 取消。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("trial:view:")) {
    const internalUserId = Number(data.slice("trial:view:".length));
    if (!Number.isInteger(internalUserId) || internalUserId <= 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return true;
    }
    await sendCreatorTrialDetails(ctx, chatId, internalUserId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("trial:revoke:")) {
    const internalUserId = Number(data.slice("trial:revoke:".length));
    if (!Number.isInteger(internalUserId) || internalUserId <= 0) {
      await answerCallbackQuery(ctx.botToken, callback.id, "用户不存在");
      return true;
    }
    await revokeCreatorTrial(ctx.db, internalUserId);
    await sendMessage(ctx.botToken, chatId, "已撤销该用户的体验创作者权限。", {
      inline_keyboard: [[{ text: "返回体验列表", callback_data: "trial:list" }]],
    });
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("license:create:")) {
    const [, , type, period] = data.split(":");
    const licenseType = type === "timed" || type === "perpetual" ? type : null;
    const days = period === "forever" ? null : Number(period);
    if (
      !licenseType ||
      (licenseType === "timed" && days === null) ||
      (days !== null && (!Number.isInteger(days) || days <= 0))
    ) {
      await answerCallbackQuery(ctx.botToken, callback.id, "授权期限无效");
      return true;
    }
    if (!ctx.cache) {
      await answerCallbackQuery(ctx.botToken, callback.id, "当前部署未启用授权工作台");
      return true;
    }
    await ctx.cache.put(
      licenseIssueStateKey(userId),
      JSON.stringify({ licenseType, days }),
      { expirationTtl: 15 * 60 },
    );
    await sendMessage(
      ctx.botToken,
      chatId,
      `正在发放${licenseType === "timed" ? `${days} 天` : "永久"}授权。\n\n请直接发送客户名称；发送 /cancel 取消。`,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("license:view:")) {
    const publicId = data.slice("license:view:".length);
    await sendLicenseDetails(ctx, chatId, publicId);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (
    data.startsWith("license:suspend:") ||
    data.startsWith("license:resume:")
  ) {
    const suspend = data.startsWith("license:suspend:");
    const publicId = data.slice(
      suspend ? "license:suspend:".length : "license:resume:".length,
    );
    const license = await setLicenseStatus(
      ctx.db,
      publicId,
      suspend ? "suspended" : "active",
      user.id,
    );
    await sendMessage(
      ctx.botToken,
      chatId,
      `${license.publicId} 状态已更新为${licenseStatusLabels[license.status]}。`,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("license:revoke_ask:")) {
    const publicId = data.slice("license:revoke_ask:".length);
    const license = await getSoftwareLicenseByPublicId(ctx.db, publicId);
    if (!license) {
      await answerCallbackQuery(ctx.botToken, callback.id, "授权不存在");
      return true;
    }
    await sendMessage(
      ctx.botToken,
      chatId,
      `确认永久吊销 ${license.publicId}？吊销后不能恢复。`,
      {
        inline_keyboard: [
          [
            {
              text: "确认吊销",
              callback_data: `license:revoke_confirm:${license.publicId}`,
            },
            {
              text: "取消",
              callback_data: `license:view:${license.publicId}`,
            },
          ],
        ],
      },
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("license:revoke_confirm:")) {
    const publicId = data.slice("license:revoke_confirm:".length);
    const license = await setLicenseStatus(
      ctx.db,
      publicId,
      "revoked",
      user.id,
    );
    await sendMessage(
      ctx.botToken,
      chatId,
      `${license.publicId} 已永久吊销。`,
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:survey:")) {
    const surveyId = Number(data.slice("admin:survey:".length));
    const survey = await getSurveyById(ctx.db, surveyId);
    if (!survey) {
      await answerCallbackQuery(ctx.botToken, callback.id, "问卷不存在");
      return true;
    }
    const stats = await getSurveyStatistics(ctx.db, surveyId);
    const surveys = await listAllSurveys(ctx.db);
    const surveyIndex = surveys.findIndex((item) => item.id === survey.id);
    const listPosition =
      surveyIndex >= 0 ? `当前序号：${surveyIndex + 1}\n` : "";
    await sendMessage(
      ctx.botToken,
      chatId,
      `📋 ${survey.title}\n${listPosition}内部编号：${survey.id}\n状态：${surveyStatusLabels[survey.status]}\n开始：${stats.totalStarted}\n完成：${stats.totalCompleted}\n完成率：${stats.completionRate.toFixed(1)}%`,
      {
        inline_keyboard: [
          [
            {
              text: "详细统计",
              callback_data: `owner:survey:${survey.id}`,
            },
            {
              text: "完成名单与答卷",
              callback_data: `owner:responses:${survey.id}:0`,
            },
          ],
          [
            {
              text: "CSV",
              callback_data: `owner:export:csv:${survey.id}`,
            },
            {
              text: "Excel",
              callback_data: `owner:export:xlsx:${survey.id}`,
            },
            {
              text: "ZIP",
              callback_data: `owner:export:zip:${survey.id}`,
            },
          ],
          [
            {
              text: "关闭",
              callback_data: `admin:close:${survey.id}`,
            },
            {
              text: "删除",
              callback_data: `admin:delete_ask:${survey.id}`,
            },
          ],
          [
            {
              text: "⬅️ 返回全部问卷",
              callback_data: "admin:surveys",
            },
          ],
        ],
      },
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:close:")) {
    const surveyId = Number(data.slice("admin:close:".length));
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    const survey = await getSurveyById(ctx.db, surveyId);
    if (!survey) {
      await answerCallbackQuery(ctx.botToken, callback.id, "问卷不存在");
      return true;
    }
    await updateSurveyStatus(ctx.db, surveyId, "closed");
    await sendMessage(ctx.botToken, chatId, `问卷“${survey.title}”已关闭。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:delete_ask:")) {
    const surveyId = Number(data.slice("admin:delete_ask:".length));
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    const survey = await getSurveyById(ctx.db, surveyId);
    if (!survey) {
      await answerCallbackQuery(ctx.botToken, callback.id, "问卷不存在");
      return true;
    }
    await sendMessage(
      ctx.botToken,
      chatId,
      `确认永久删除问卷“${survey.title}”？问卷、题目和所有答卷都会被删除。`,
      {
        inline_keyboard: [
          [
            {
              text: "确认删除",
              callback_data: `admin:delete_confirm:${survey.id}`,
            },
            {
              text: "取消",
              callback_data: `admin:survey:${survey.id}`,
            },
          ],
        ],
      },
    );
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  if (data.startsWith("admin:delete_confirm:")) {
    const surveyId = Number(data.slice("admin:delete_confirm:".length));
    await assertCanManageSurvey(ctx.db, user, surveyId, ctx.adminIds);
    const survey = await getSurveyById(ctx.db, surveyId);
    if (!survey) {
      await answerCallbackQuery(ctx.botToken, callback.id, "问卷不存在");
      return true;
    }
    await deleteSurvey(ctx.db, surveyId);
    await sendMessage(ctx.botToken, chatId, `问卷“${survey.title}”已删除。`);
    await answerCallbackQuery(ctx.botToken, callback.id);
    return true;
  }

  return false;
}
