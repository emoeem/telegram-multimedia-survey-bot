import type { Env } from "../index";
import { fail, json, resolveParticipant } from "./survey-api";
import { checkRateLimit } from "../services/rate-limit.service";
import { resolveSubmissionBotUrl } from "../services/contact-links.service";
import { listTaskPacks } from "../db/repositories/task-pack.repository";
import {
  createTaskRun,
  getActiveTaskRunByParticipant,
  getTaskRunById,
  listTaskRunLeaderboard,
  listTaskRunsByParticipant,
  mergeTaskRun,
  saveTaskRun,
  toTrialRun,
  type TaskRunRecord,
} from "../db/repositories/task-run.repository";
import { evaluateAchievements, serializeUnlockedAchievements } from "../services/achievement.service";
import type { TrialAction, TrialInventory, TrialRun, TrialTaskItem } from "../trial/engine";
import {
  applyTrialAction,
  createShopState,
  itemCap,
  itemPrice,
  normalizeTrialMode,
  normalizeTrialPersona,
  pickNextTask,
  rollStartCoins,
  shopCost,
  trialGrade,
  TRIAL_GRADE_COPY,
  TRIAL_SHOP,
  validateShopSelection,
} from "../trial/engine";

/**
 * Public trial API for the web task system (/trial): pack discovery, the
 * run loop (shop → complete/skip/boost/abandon → settlement), leaderboard and
 * personal history. Identity follows the survey participant model
 * (Telegram initData / participant token / anonymous key).
 */
export async function handleTrialApiRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/trial/")) return null;

  if (request.method === "GET" && url.pathname === "/api/trial/packs") {
    const packs = await listTaskPacks(env.DB, { enabledOnly: true });
    return json({
      submissionBotUrl: resolveSubmissionBotUrl(env),
      // The shop economy is authoritative server-side: the client renders it
      // but never owns the numbers, so the two can't drift.
      shop: {
        normalCoins: TRIAL_SHOP.normalCoins,
        hellCoins: TRIAL_SHOP.hellCoins,
        rerollCap: TRIAL_SHOP.rerollCap,
        prices: { skipTicket: itemPrice("skipTicket"), booster: itemPrice("booster"), shield: itemPrice("shield") },
        caps: { skipTicket: itemCap("skipTicket"), booster: itemCap("booster"), shield: itemCap("shield") },
      },
      packs: packs.map((pack) => ({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        normalFloors: pack.normalFloors,
        hellFloors: pack.hellFloors,
        prepItems: pack.prepItems,
        prepText: pack.prepText,
      })),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/trial/me") {
    const participant = await resolveParticipant(request, env).catch(() => null);
    const telegram = participant !== null && !(participant instanceof Response) && participant.kind === "telegram";
    const telegramUserId =
      telegram && participant && !(participant instanceof Response) ? participant.telegramUserId : null;
    const adminIds = env.ADMIN_IDS.split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    return json({ telegram, isAdmin: telegramUserId !== null && adminIds.includes(telegramUserId) });
  }

  if (request.method === "GET" && url.pathname === "/api/trial/leaderboard") {
    const packId = Number(url.searchParams.get("packId"));
    const mode = normalizeTrialMode(url.searchParams.get("mode")) ?? "normal";
    if (!Number.isInteger(packId) || packId <= 0) return fail(400, "validation_failed", "无效的任务包");
    const participant = await resolveParticipant(request, env).catch(() => null);
    const participantHash = participant && !(participant instanceof Response) ? participant.participantHash : null;
    const entries = await listTaskRunLeaderboard(env.DB, {
      packId,
      mode,
      ...(participantHash ? { participantHash } : {}),
    });
    return json({ entries });
  }

  if (request.method === "GET" && url.pathname === "/api/trial/runs/active") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const run = await getActiveTaskRunByParticipant(env.DB, participant.participantHash);
    if (!run) return json({ run: null });
    // A disabled pack must not hide an active run: the participant would be
    // locked out by run_active on /runs while having no way to even abandon.
    const packs = await listTaskPacks(env.DB, { withItems: true });
    const pack = packs.find((item) => item.id === run.packId);
    if (!pack) {
      // Pack deleted outright: the run can never continue — settle it so the
      // participant regains the ability to start a new one.
      const settled = applyTrialAction([], toTrialRun(run), "abandon").run;
      await saveTaskRun(env.DB, mergeTaskRun(run, settled));
      return json({ run: serializeRun(settled, `#${run.packId}`), task: null, packMissing: true });
    }
    const items = pack.items ?? [];
    const current = items.find((item) => item.id === run.state.currentTaskId) ?? null;
    return json({
      run: serializeRun(run, pack.name),
      task: current ? serializeTask(current) : null,
      packEnabled: pack.enabled,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/trial/history") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const runs = await listTaskRunsByParticipant(env.DB, participant.participantHash, 10);
    const packs = await listTaskPacks(env.DB, {});
    const packNames = new Map(packs.map((pack) => [pack.id, pack.name]));
    return json({
      runs: runs.map((run) => ({
        ...serializeRun(run, packNames.get(run.packId) ?? `#${run.packId}`),
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        grade: run.status === "completed" ? trialGrade(toTrialRun(run)) : null,
      })),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/trial/runs") {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    if (!env.CACHE) return fail(503, "unavailable", "当前部署未启用挑战功能");
    const limit = await checkRateLimit(env.CACHE, "trial-start", participant.participantHash, 10, 3600);
    if (!limit.allowed) {
      return Response.json(
        { code: "rate_limited", message: `开局太频繁啦，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再来` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }
    const body = (await request.json().catch(() => null)) as {
      packId?: unknown;
      persona?: unknown;
      mode?: unknown;
      startingFloor?: unknown;
    } | null;
    const packId = Number(body?.packId);
    if (!Number.isInteger(packId) || packId <= 0) return fail(400, "validation_failed", "无效的任务包");
    const persona = normalizeTrialPersona(body?.persona);
    if (!persona) return fail(400, "validation_failed", "请选择身份");
    const mode = normalizeTrialMode(body?.mode) ?? "normal";
    const startingFloorRaw = Number(body?.startingFloor ?? 1);
    const startingFloor = Number.isInteger(startingFloorRaw) && startingFloorRaw >= 1 ? startingFloorRaw : 1;

    const existing = await getActiveTaskRunByParticipant(env.DB, participant.participantHash);
    if (existing) return fail(409, "run_active", "你已有一局进行中的挑战，请先完成或放弃");

    const packs = await listTaskPacks(env.DB, { enabledOnly: true, withItems: true });
    const pack = packs.find((item) => item.id === packId);
    if (!pack) return fail(404, "not_found", "任务包不存在或已停用");
    const items = pack.items ?? [];
    if (items.length === 0) return fail(409, "empty_pack", "该任务包还没有可用任务，请联系管理员");
    // The run's floor window must stay inside the content actually reachable by
    // this persona/mode — otherwise the player climbs into floors with no tasks
    // and the run dead-ends halfway.
    const matched = items.filter(
      (item) =>
        (item.persona === "any" || item.persona === persona) &&
        (item.mode === "any" || item.mode === mode),
    );
    if (matched.length === 0) {
      return fail(409, "empty_pack", "该任务包在你的身份/模式下没有可用任务，请换个设置或联系管理员");
    }
    const coverageTop = matched.reduce((top, item) => Math.max(top, item.maxFloor), 0);
    if (startingFloor > coverageTop) {
      return fail(400, "validation_failed", `该任务包的内容只覆盖到第 ${coverageTop} 层，请选择更低的起始层`);
    }
    const floorCount = mode === "hell" ? pack.hellFloors : pack.normalFloors;
    const maxFloor = Math.min(startingFloor + floorCount - 1, coverageTop);

    const state = createShopState(items, persona, mode, startingFloor, maxFloor, rollStartCoins(mode));
    const record = await createTaskRun(env.DB, {
      packId,
      userId: participant.dbUserId ?? null,
      participantHash: participant.participantHash,
      persona,
      mode,
      startingFloor,
      maxFloor,
      state,
    });
    const run = toTrialRun(record);
    return json({ run: serializeRun(run, pack.name), task: null }, 201);
  }

  const shopMatch = url.pathname.match(/^\/api\/trial\/runs\/(\d+)\/shop$/);
  if (request.method === "POST" && shopMatch) {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const runId = Number(shopMatch[1]);
    const record = await getTaskRunById(env.DB, runId);
    if (!record || record.participantHash !== participant.participantHash) {
      return fail(404, "not_found", "挑战局不存在");
    }
    const run = toTrialRun(record);
    if (run.state.phase !== "shop") return fail(409, "not_in_shop", "当前不在商店阶段");
    const body = (await request.json().catch(() => null)) as {
      reroll?: unknown;
      skipTickets?: unknown;
      boosters?: unknown;
      shields?: unknown;
    } | null;

    if (body?.reroll === true) {
      if ((run.state.coinRerolls ?? 0) >= TRIAL_SHOP.rerollCap) {
        return fail(409, "reroll_exhausted", `本局重摇次数已用完（最多 ${TRIAL_SHOP.rerollCap} 次）`);
      }
      run.state.coins = rollStartCoins(run.mode);
      run.state.coinRerolls = (run.state.coinRerolls ?? 0) + 1;
      await saveTaskRun(env.DB, mergeTaskRun(record, run));
      const packs = await listTaskPacks(env.DB, { withItems: true });
      const pack = packs.find((item) => item.id === run.packId);
      return json({ run: serializeRun(run, pack?.name ?? `#${run.packId}`), task: null, coins: run.state.coins });
    }

    const rawSkipTickets = body?.skipTickets === undefined ? 0 : parseQuantity(body.skipTickets);
    const rawBoosters = body?.boosters === undefined ? 0 : parseQuantity(body.boosters);
    const rawShields = body?.shields === undefined ? 0 : parseQuantity(body.shields);
    if (rawSkipTickets === null || rawBoosters === null || rawShields === null) {
      return fail(400, "validation_failed", "道具数量必须是整数");
    }
    const selection: TrialInventory = {
      skipTickets: rawSkipTickets,
      boosters: rawBoosters,
      shields: rawShields,
    };
    const validated = validateShopSelection(selection);
    if (!validated.ok) return fail(400, "validation_failed", "道具数量超出单局上限");
    const cost = shopCost(selection);
    if (cost > run.state.coins) return fail(400, "insufficient_coins", "金币不够，先重摇或减少购买");

    run.state.inventory = selection;
    run.state.phase = "playing";
    const packs = await listTaskPacks(env.DB, { withItems: true });
    const pack = packs.find((item) => item.id === run.packId);
    if (!pack) return fail(404, "not_found", "任务包不存在");
    const items = pack.items ?? [];
    const firstTask = pickNextTask(items, run);
    if (!firstTask) return fail(409, "empty_pack", "该任务包在你的设置下没有可用任务");
    run.state.currentTaskId = firstTask.id;
    run.state.usedTaskIds = [firstTask.id];
    await saveTaskRun(env.DB, mergeTaskRun(record, run));
    return json({
      run: serializeRun(run, pack.name),
      task: serializeTask(firstTask),
      spent: cost,
    });
  }

  const actionMatch = url.pathname.match(/^\/api\/trial\/runs\/(\d+)\/action$/);
  if (request.method === "POST" && actionMatch) {
    const participant = await resolveParticipant(request, env);
    if (participant instanceof Response) return participant;
    const runId = Number(actionMatch[1]);
    const record = await getTaskRunById(env.DB, runId);
    if (!record || record.participantHash !== participant.participantHash) {
      return fail(404, "not_found", "挑战局不存在");
    }
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const rawAction = body?.action;
    if (
      rawAction !== "complete" &&
      rawAction !== "skip" &&
      rawAction !== "abandon" &&
      rawAction !== "boost" &&
      rawAction !== "shield_exit"
    ) {
      return fail(400, "validation_failed", "无效的操作");
    }
    const run = toTrialRun(record);
    // Abandon is always available — including from the shop phase and when the
    // pack has since been deleted — otherwise a stuck run locks the participant
    // out of ever starting a new one.
    if (rawAction === "abandon") {
      if (run.status !== "active") return fail(409, "run_not_active", "本局已经结束了");
      const settled = applyTrialAction([], run, "abandon").run;
      await saveTaskRun(env.DB, mergeTaskRun(record, settled));
      const packNames = await listTaskPacks(env.DB, { withItems: true });
      const packName = packNames.find((item) => item.id === record.packId)?.name ?? `#${record.packId}`;
      return json({
        run: serializeRun(settled, packName),
        task: null,
        earned: 0,
        grade: null,
        gradeCopy: null,
      });
    }
    if (run.state.phase !== "playing") return fail(409, "not_playing", "本局还在商店阶段，先确认出发");
    const packs = await listTaskPacks(env.DB, { withItems: true });
    const pack = packs.find((item) => item.id === record.packId);
    if (!pack) return fail(404, "not_found", "任务包不存在");
    const items = pack.items ?? [];
    const action = rawAction as TrialAction;
    const { run: nextRun, nextTask, earned } = applyTrialAction(items, run, action);
    await saveTaskRun(env.DB, mergeTaskRun(record, nextRun));
    const task =
      nextTask ??
      (nextRun.status === "active" && nextRun.state.currentTaskId !== null
        ? (items.find((item) => item.id === nextRun.state.currentTaskId) ?? null)
        : null);
    // 收官那一击可能解锁挑战类成就；结算已经落库，徽章失败不影响返回。
    let newAchievements: ReturnType<typeof serializeUnlockedAchievements> = [];
    if (nextRun.status === "completed") {
      newAchievements = serializeUnlockedAchievements(
        await evaluateAchievements(env.DB, {
          participantHash: participant.participantHash,
          userId: participant.dbUserId ?? null,
        }),
      );
    }
    return json({
      run: serializeRun(nextRun, pack.name),
      task: task ? serializeTask(task) : null,
      earned,
      grade: nextRun.status === "completed" ? trialGrade(nextRun) : null,
      gradeCopy: nextRun.status === "completed" ? TRIAL_GRADE_COPY[trialGrade(nextRun)] : null,
      newAchievements,
    });
  }

  return fail(404, "not_found", "接口不存在");
}

function parseQuantity(value: unknown): number | null {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : null;
}

export const TRIAL_SHOP_PUBLIC = {
  prices: { skipTicket: itemPrice("skipTicket"), booster: itemPrice("booster"), shield: itemPrice("shield") },
  caps: { skipTicket: itemCap("skipTicket"), booster: itemCap("booster"), shield: itemCap("shield") },
};

interface SerializedRun {
  id: number;
  packId: number;
  packName: string;
  persona: string;
  mode: string;
  startingFloor: number;
  currentFloor: number;
  maxFloor: number;
  score: number;
  completedTasks: number;
  skippedTasks: number;
  status: string;
  phase: string;
  coins: number;
  inventory: TrialInventory;
  boosted: boolean;
  coinRerolls: number;
}

function serializeRun(run: TrialRun | (TaskRunRecord & TrialRun), packName: string): SerializedRun {
  return {
    id: run.id,
    packId: run.packId,
    packName,
    persona: run.persona,
    mode: run.mode,
    startingFloor: run.startingFloor,
    currentFloor: run.currentFloor,
    maxFloor: run.maxFloor,
    score: run.score,
    completedTasks: run.completedTasks,
    skippedTasks: run.skippedTasks,
    status: run.status,
    phase: run.state?.phase ?? "shop",
    coins: run.state?.coins ?? 0,
    inventory: run.state?.inventory ?? { skipTickets: 0, boosters: 0, shields: 0 },
    boosted: run.state?.boosted === true,
    coinRerolls: run.state?.coinRerolls ?? 0,
  };
}

function serializeTask(item: Pick<TrialTaskItem, "id" | "title" | "description" | "warning" | "score">) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    warning: item.warning ?? "",
    score: item.score,
  };
}
