import type { Env } from "../index";
import { fail, json } from "./survey-api";
import { listTaskPacks, type TaskPackRecord } from "../db/repositories/task-pack.repository";
import {
  createTaskRun,
  saveTaskRun,
  type PluginRunEnvelope,
  type TaskRunRecord,
} from "../db/repositories/task-run.repository";
import { evaluateAchievements, serializeUnlockedAchievements } from "../services/achievement.service";
import { gamePluginRegistry } from "../game-plugin/registry";
import type { GameRunView } from "../game-plugin/types";
import { isPluginGameType } from "../trial/engine-registry";
import type { TrialMode, TrialPersona } from "../trial/engine";
import type { Participant } from "./survey-api";

/**
 * 插件玩法局的运行循环（开局 / 动作 / 断线恢复）。
 *
 * 与爬塔分开成模块，是因为两者的状态模型不同：爬塔是固定机制 + 内容表，
 * 插件是"状态整份存 state_json + 引擎纯函数推进"。共享的部分只有：参与者
 * 身份、一局未完成限制、限流、任务包启停校验、成就结算。
 */

export interface PluginRunApi {
  start(input: {
    pack: TaskPackRecord;
    participant: Participant;
    persona: TrialPersona;
    mode: TrialMode;
  }): Promise<Response>;
  action(input: {
    record: TaskRunRecord;
    pack: TaskPackRecord | null;
    participantHash: string;
    action: unknown;
  }): Promise<Response>;
  serialize(record: TaskRunRecord, pack: TaskPackRecord | null): { run: unknown; view: GameRunView | null };
}

/** 插件局的配置来自 task_packs.settings_json（写入时已按 Schema 归一化）。 */
function packConfig(pack: TaskPackRecord): Record<string, unknown> {
  return pack.settings ?? {};
}

function gradeOf(envelope: PluginRunEnvelope | null): string | null {
  return typeof envelope?.grade === "string" ? envelope.grade : null;
}

export function pluginRunSummary(record: TaskRunRecord, packName: string) {
  const envelope = record.plugin;
  const plugin = envelope?.plugin ?? "";
  const manifest = gamePluginRegistry.get(plugin)?.manifest;
  return {
    id: record.id,
    packId: record.packId,
    packName,
    plugin,
    pluginTitle: manifest?.title ?? plugin,
    persona: record.persona,
    mode: record.mode,
    status: record.status,
    score: record.score,
    step: record.currentFloor,
    total: record.maxFloor,
    grade: gradeOf(envelope),
  };
}

export function serializePluginRun(
  record: TaskRunRecord,
  pack: TaskPackRecord | null,
): { run: ReturnType<typeof pluginRunSummary>; view: GameRunView | null } {
  const run = pluginRunSummary(record, pack?.name ?? `#${record.packId}`);
  const envelope = record.plugin;
  if (!envelope) return { run, view: null };
  try {
    const plugin = gamePluginRegistry.require(envelope.plugin);
    const config = pack ? packConfig(pack) : {};
    return { run, view: plugin.engine.view({ state: envelope.state, config }) };
  } catch {
    // 插件下线或 state 损坏：视图给 null，前端提示「本局无法继续」。
    return { run, view: null };
  }
}

export async function startPluginRun(env: Env, input: Parameters<PluginRunApi["start"]>[0]): Promise<Response> {
  const { pack, participant, persona, mode } = input;
  // 限流与"一局未完成"由调用方（trial-api 的开局路由）统一处理，避免两处各扣一次。
  const pluginId = String(pack.gameType ?? "");
  if (!isPluginGameType(pluginId)) {
    return fail(400, "unsupported_game", "该玩法暂未开放");
  }

  // 配置合法性：写入口已经拦过，这里再兜一次（历史数据可能早于校验）。
  const { config, issues } = gamePluginRegistry.validateConfig(pluginId, packConfig(pack));
  if (issues.some((issue) => issue.severity === "error")) {
    return fail(409, "empty_pack", "该小游戏还没有配好内容，请联系管理员");
  }

  const plugin = gamePluginRegistry.require(pluginId);
  let created: { state: unknown; view: GameRunView };
  try {
    created = plugin.engine.createRun({ config, persona, mode, random: Math.random });
  } catch {
    return fail(409, "empty_pack", "该小游戏配置有误，请联系管理员");
  }

  const envelope: PluginRunEnvelope = { kind: "plugin", plugin: pluginId, state: created.state };
  const record = await createTaskRun(env.DB, {
    packId: pack.id,
    userId: participant.dbUserId ?? null,
    participantHash: participant.participantHash,
    persona,
    mode,
    startingFloor: 1,
    maxFloor: Math.max(1, created.view.total),
    state: {
      phase: "playing",
      coins: 0,
      inventory: { skipTickets: 0, boosters: 0, shields: 0 },
      boosted: false,
      usedTaskIds: [],
      maxScore: 1,
      currentTaskId: null,
      coinRerolls: 0,
    },
    plugin: envelope,
  });
  return json({ run: pluginRunSummary(record, pack.name), view: created.view }, 201);
}

export async function applyPluginAction(env: Env, input: Parameters<PluginRunApi["action"]>[0]): Promise<Response> {
  const { record, pack, participantHash, action } = input;
  if (record.participantHash !== participantHash) return fail(404, "not_found", "挑战局不存在");
  const envelope = record.plugin;
  if (!envelope) return fail(409, "unsupported_game", "本局不是插件玩法");

  const plugin = gamePluginRegistry.get(envelope.plugin);
  if (!plugin) return fail(409, "unsupported_game", "该玩法已下线，请放弃本局");

  // 放弃对任何玩法都可用：卡在"进行中"会让参与者再也开不了新局。
  if (action && typeof action === "object" && (action as { kind?: unknown }).kind === "abandon") {
    if (record.status !== "active") return fail(409, "run_not_active", "本局已经结束了");
    const settled: TaskRunRecord = { ...record, status: "abandoned", plugin: envelope };
    await saveTaskRun(env.DB, settled);
    const packName = pack?.name ?? `#${record.packId}`;
    return json({
      run: pluginRunSummary(settled, packName),
      view: safeView(plugin.engine, envelope, pack),
      finished: true,
      result: { runId: settled.id, score: settled.score, grade: null, completed: false },
    });
  }

  if (record.status !== "active") return fail(409, "run_not_active", "本局已经结束了");
  if (!plugin.engine.isAction(action)) return fail(400, "validation_failed", "无效的操作");
  if (!pack) {
    // 包被删了：这一局永远无法继续，结算为放弃（与爬塔同一兜底）。
    const settled: TaskRunRecord = { ...record, status: "abandoned", plugin: envelope };
    await saveTaskRun(env.DB, settled);
    return json({
      run: pluginRunSummary(settled, `#${record.packId}`),
      view: null,
      finished: true,
      result: { runId: settled.id, score: settled.score, grade: null, completed: false },
    });
  }

  const config = packConfig(pack);
  let applied;
  try {
    applied = plugin.engine.apply({ state: envelope.state, config, action, random: Math.random });
  } catch {
    // 状态损坏（例如插件升级后 schema 变了）：按放弃结算，不让参与者卡死。
    const settled: TaskRunRecord = { ...record, status: "abandoned", plugin: envelope };
    await saveTaskRun(env.DB, settled);
    return json({
      run: pluginRunSummary(settled, pack.name),
      view: null,
      finished: true,
      result: { runId: settled.id, score: settled.score, grade: null, completed: false },
    });
  }

  const finished = applied.finished;
  const grade = finished ? plugin.engine.grade({ state: applied.state, config }).grade : null;
  const nextEnvelope: PluginRunEnvelope = {
    kind: "plugin",
    plugin: envelope.plugin,
    state: applied.state,
    ...(grade ? { grade } : {}),
  };
  const next: TaskRunRecord = {
    ...record,
    score: applied.view.score,
    currentFloor: applied.view.step,
    maxFloor: Math.max(1, applied.view.total),
    completedTasks: applied.view.step,
    status: finished ? "completed" : "active",
    plugin: nextEnvelope,
    finishedAt: finished ? new Date().toISOString() : null,
  };
  await saveTaskRun(env.DB, next);

  let newAchievements: ReturnType<typeof serializeUnlockedAchievements> = [];
  if (finished) {
    newAchievements = serializeUnlockedAchievements(
      await evaluateAchievements(env.DB, {
        participantHash,
        userId: record.userId,
      }),
    );
  }
  return json({
    run: pluginRunSummary(next, pack.name),
    view: applied.view,
    finished,
    result: {
      runId: next.id,
      score: next.score,
      grade,
      completed: finished && applied.view.status === "won",
    },
    newAchievements,
  });
}

function safeView(
  engine: { view(input: { state: unknown; config: Record<string, unknown> }): GameRunView },
  envelope: PluginRunEnvelope,
  pack: TaskPackRecord | null,
): GameRunView | null {
  try {
    return engine.view({ state: envelope.state, config: pack ? packConfig(pack) : {} });
  } catch {
    return null;
  }
}

/** 供 /runs/active 使用：插件局恢复视图（包可能已被停用但依然可读）。 */
export async function loadActivePluginRun(env: Env, run: TaskRunRecord): Promise<Response> {
  const packs = await listTaskPacks(env.DB, { withItems: false });
  const pack = packs.find((item) => item.id === run.packId) ?? null;
  const { run: summary, view } = serializePluginRun(run, pack);
  return json({ run: summary, view, packMissing: pack === null, packEnabled: pack?.enabled ?? false });
}

/** 供历史列表使用：插件局的名字/评级。 */
export function pluginHistoryFields(record: TaskRunRecord) {
  return {
    plugin: record.plugin?.plugin ?? null,
    grade: gradeOf(record.plugin),
  };
}
