/**
 * 主机器人命令注册表（唯一事实源）。
 *
 * 背景：历史上命令散落在 survey-handler / admin-handler / builder-handler /
 * publish-target 四处，最多时 35 条，但 Telegram 菜单只登记 4 条——其余用户
 * 根本发现不了，其中还包括 3 条只回「请改用别的命令」的死命令。这份表把
 * 命令收敛成三层（公共 / 管理员 / 厂商），并按场景（私聊 / 群）决定菜单项，
 * 与 Telegram 的 BotCommandScope 一一对应。
 *
 * 设计约束：
 *   * Telegram 命令只允许小写拉丁字母、数字、下划线，长度 ≤ 32；
 *   * 菜单按 scope 注册（default / all_group_chats / 逐个管理员 chat），
 *     所以「管理员命令普通用户看不到」是靠 scope 实现，而不是靠隐藏；
 *   * 群里能用的命令必须对群里任何人安全：/surveys 只渲染 URL 按钮（不发
 *     回调、不翻页，避免刷群），/publish_here 未授权时静默。
 */

export type CommandAudience = "public" | "admin" | "vendor";
export type CommandScope = "private" | "group";

export interface CommandSpec {
  /** 命令名，不含斜杠。 */
  name: string;
  /** Telegram 菜单里显示的说明（≤ 256 字符）。 */
  description: string;
  audience: CommandAudience;
  /** 允许在哪些场景使用/展示；私聊命令不进群菜单，反之亦然。 */
  scopes: readonly CommandScope[];
}

/**
 * 命令全集。顺序即菜单展示顺序。
 *
 * 只保留 13 条：编辑器（建卷/改题/导入/保存）已收拢到网页后台，快速动作
 * （发布/关闭/导出/预览/复制）走「我的问卷」详情按钮，不再单独占命令。
 */
export const COMMANDS: readonly CommandSpec[] = [
  // ---- 公共：私聊菜单 ----
  { name: "start", description: "主菜单", audience: "public", scopes: ["private"] },
  { name: "surveys", description: "浏览并填写问卷", audience: "public", scopes: ["private", "group"] },
  { name: "me", description: "我的：问卷 / 投稿 / 个人中心", audience: "public", scopes: ["private"] },
  { name: "codes", description: "问卷访问密码", audience: "public", scopes: ["private"] },
  { name: "redeem", description: "兑换邀请码（/redeem 邀请码）", audience: "public", scopes: ["private"] },
  { name: "help", description: "命令与使用说明", audience: "public", scopes: ["private", "group"] },

  // ---- 群组：把本群设为公开发布目标（普通成员静默） ----
  { name: "publish_here", description: "把本群设为公开发布目标", audience: "public", scopes: ["group"] },

  // ---- 管理员：只在管理员私聊菜单出现 ----
  { name: "admin", description: "管理员中心", audience: "admin", scopes: ["private"] },
  { name: "review", description: "网页投稿审核", audience: "admin", scopes: ["private"] },
  { name: "users", description: "Bot 用户目录", audience: "admin", scopes: ["private"] },

  // ---- 厂商：仅授权中心部署（DEPLOYMENT_ROLE=vendor） ----
  { name: "license", description: "软件授权管理", audience: "vendor", scopes: ["private"] },
  { name: "release", description: "版本发布记录", audience: "vendor", scopes: ["private"] },
  { name: "trial", description: "体验创作者管理", audience: "vendor", scopes: ["private"] },
] as const;

/** 命令名 → 规格。 */
export const COMMAND_BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.map((command) => [command.name, command]),
);

/**
 * 旧命令 → 新命令的指引。
 *
 * 用户选择了「彻底重命名」：旧命令不再保留原行为，但也不静默无视——回一行
 * 「命令已更新」比毫无反应好排查。value 为 null 表示该功能已迁到网页后台，
 * 提示文案另给。
 *
 * 例外：`/license_create` 一类的**高级授权子命令**保留原名可用——它们需要
 * 参数（天数/设备数/客户名），做成按钮流要额外维护一套问答状态机，而使用者
 * 只有厂商管理员。它们不进菜单、不进本表，在 `/license` 的帮助文本里列出。
 */
export const RENAMED_COMMANDS: ReadonlyMap<string, string | null> = new Map<string, string | null>([
  ["my_surveys", "me"],
  ["mypolls", "me"],
  ["passwords", "codes"],
  ["set_survey_code", "codes"],
  ["get_survey_code", "codes"],
  ["invite", "redeem"],
  ["set_publish_target", "publish_here"],
  ["surveys_admin", "admin"],
  ["admin_login", "admin"],
  ["trials", "trial"],
  ["licenses", "license"],
  ["releases", "release"],
  // 编辑器与快速动作：迁到网页后台 / 「我的问卷」详情按钮。
  ["create", null],
  ["continue", null],
  ["import", null],
  ["save", null],
  ["discard", null],
  ["back", null],
  ["done", null],
  ["clear", null],
  ["question_media", null],
  ["option_media", null],
  ["edit_question_title", null],
  ["duplicate", null],
  ["export", null],
  ["export_json", null],
  ["preview", null],
]);

/** 迁移到网页后台的命令：给用户的说明。 */
export const MOVED_TO_WEB_MESSAGE =
  "这个命令已经收进网页后台了：打开「🌐 网页管理后台」→ 问卷编辑器即可（我的问卷里也有入口）。";

/** `/cmd@botname args` 的解析结果。 */
export interface ParsedCommand {
  name: string;
  args: string;
  /** 原文（已剥离 @botname 后缀），便于需要完整参数的旧路径复用。 */
  text: string;
}

/**
 * 解析一条消息是否为命令，并统一剥离 `@机器人名` 后缀。
 *
 * Telegram 在群里会把命令写成 `/cmd@bot_username`；此前只有 /start、/invite、
 * /set_publish_target 各自处理后缀，其余命令在群里一律失配。统一在这里剥掉，
 * 下游只认裸命令名。
 */
export function parseCommand(raw: string | undefined): ParsedCommand | null {
  if (!raw) return null;
  const match = /^\/([A-Za-z0-9_]{1,64})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  if (!name) return null;
  const args = (match[3] ?? "").trim();
  return { name, args, text: args ? `/${name} ${args}` : `/${name}` };
}

/**
 * 按场景与角色生成 Telegram 菜单。
 *
 * @param scope  private = 私聊菜单；group = 群菜单
 * @param role   调用者身份；管理员菜单额外含 admin 命令，厂商部署再含 vendor 命令
 */
export function menuFor(
  scope: CommandScope,
  role: CommandAudience = "public",
): Array<{ command: string; description: string }> {
  return COMMANDS.filter((command) => {
    if (!command.scopes.includes(scope)) return false;
    if (command.audience === "public") return true;
    if (command.audience === "admin") return role === "admin" || role === "vendor";
    return role === "vendor";
  }).map((command) => ({ command: command.name, description: command.description }));
}

/** `/help` 的正文：按角色列出真正可用的命令。 */
export function helpText(role: CommandAudience, scope: CommandScope = "private"): string {
  const lines = menuFor(scope, role).map((command) => `/${command.command} — ${command.description}`);
  const header =
    scope === "group"
      ? "🤖 本群可用命令"
      : role === "public"
        ? "🤖 可用命令"
        : role === "admin"
          ? "🤖 命令（含管理员）"
          : "🤖 命令（含管理员与授权中心）";
  const footer =
    scope === "group"
      ? ["", "填卷、看结果、管理问卷请私聊机器人。"]
      : ["", "建卷、改题、统计与导出在网页后台完成：发送 /start 打开主菜单。"];
  return [header, "", ...lines, ...footer].join("\n");
}

/** 旧命令的指引文案；非旧命令返回 null。 */
export function renameHint(name: string): string | null {
  if (!RENAMED_COMMANDS.has(name)) return null;
  const target = RENAMED_COMMANDS.get(name);
  return target ? `命令已更新：请用 /${target}` : MOVED_TO_WEB_MESSAGE;
}
