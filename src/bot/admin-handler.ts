import {
  deleteSurvey,
  getSurveyById,
  listAllSurveys,
  updateSurveyStatus,
} from "../db/repositories/survey.repository";
import { getUserByTelegramId } from "../db/repositories/user.repository";
import {
  isAdmin,
  assertCanManageSurvey,
} from "../services/permission.service";
import { answerCallbackQuery, sendMessage, type InlineKeyboardMarkup } from "./telegram";
import { getSurveyStatistics } from "../services/statistics.service";
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
  const licenses = await listSoftwareLicenses(ctx.db, 30);
  if (licenses.length === 0) {
    await sendMessage(
      ctx.botToken,
      chatId,
      "当前没有软件授权。发送 /license_help 查看创建方法。",
    );
    return;
  }
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  const summaries: string[] = [];
  for (const [index, license] of licenses.entries()) {
    const activations = await listLicenseActivations(ctx.db, license.id);
    const activeCount = activations.filter(
      (activation) => !activation.deactivatedAt,
    ).length;
    summaries.push(
      `${index + 1}. ${formatLicenseSummary(license, activeCount)}`,
    );
    rows.push([
      {
        text: `${index + 1}. 查看 ${license.publicId}`,
        callback_data: `license:view:${license.publicId}`,
      },
    ]);
  }
  await sendLongMessage(ctx.botToken, chatId, summaries.join("\n\n"), {
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
    const created = await createLicense(ctx.db, {
      licenseType: type,
      ...(type === "timed"
        ? { usageDays: days as number }
        : { updateDays: days }),
      maxActivations,
      customerName,
      actorUserId,
    });
    await sendLongMessage(
      ctx.botToken,
      message.chat.id,
      [
        "授权已创建。",
        `授权编号：${created.license.publicId}`,
        `客户：${customerName}`,
        `类型：${created.license.licenseType === "timed" ? `限时至 ${formatDate(created.license.expiresAt)}` : "永久使用"}`,
        `升级权益：${formatDate(created.license.updatesUntil)}`,
        `最大激活数：${created.license.maxActivations}`,
        "",
        `授权密钥：${created.licenseKey}`,
        "",
        "请立即安全保存密钥。授权中心只保存哈希，之后无法找回明文。",
        "",
        "怎么授权给客户：",
        "1. 把上面的授权密钥发给客户。",
        "2. 客户部署时设置：",
        'LICENSE_ENFORCEMENT = "required"',
        `LICENSE_SERVER_URL = "${ctx.licenseServerUrl ?? "https://telegram-multimedia-survey-bot.pd2335346.workers.dev"}"`,
        `INSTALLATION_ID = "${created.license.publicId}-01"`,
        "3. 在客户项目中执行 npx wrangler secret put LICENSE_KEY，然后粘贴授权密钥。",
      ].join("\n"),
    );
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
  ].some((command) => text === command || text.startsWith(`${command} `));
}

export async function handleAdminMessage(
  ctx: BotContext,
  message: TelegramMessage,
): Promise<boolean> {
  const text = message.text?.trim();
  const userId = message.from?.id;

  if (!text || !isAdminCommand(text) || !userId) {
    return false;
  }

  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
    await sendMessage(ctx.botToken, message.chat.id, "你没有管理员权限。");
    return true;
  }

  if (await handleLicenseAdminCommand(ctx, message, text, user.id)) {
    return true;
  }

  const surveys = await listAllSurveys(ctx.db);
  if (surveys.length === 0) {
    await sendMessage(ctx.botToken, message.chat.id, "当前没有问卷。");
    return true;
  }

  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: surveys.flatMap((survey, index) => [
      [
        {
          text: `${index + 1}. ${survey.title}（${surveyStatusLabels[survey.status]}）`,
          callback_data: `admin:survey:${survey.id}`,
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
    ]),
  };

  await sendMessage(ctx.botToken, message.chat.id, "全部问卷：", keyboard);
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

  if (!data.startsWith("admin:") && !data.startsWith("license:")) {
    return false;
  }

  const user = await getUserByTelegramId(ctx.db, userId);
  if (!user || !isAdmin(user.telegramUserId, ctx.adminIds)) {
    await answerCallbackQuery(ctx.botToken, callback.id, "没有管理员权限");
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
              text: "查看答卷",
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
