import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TrialAdultGateCard } from "./TrialAdultGateCard";
import { ackAdultPackLocally, isAdultPackAckedLocally } from "./trial-adult-ack";
import { lazyPlayView } from "../game-plugins/loader";
import type { GameHostBridge, GamePlayResult } from "../game-plugins/types";
import type { GameRunView } from "../../../src/game-plugin/types";
import { identityHeaders, type AnswerValue } from "./api";
import { resolveTrialPackAdult } from "./trial-api";

/**
 * 插件玩法的宿主（问卷 game 题在答题时的容器）。
 *
 * 三条职责边界：
 *  1. 网络只在宿主：插件只拿到 GameHostBridge，不自己拼 API 路径；
 *  2. 答案只走规范形状：结算时把 runId 写回答卷，服务端再按 runId 重算分数
 *     ——与内置爬塔同一条数据管道；
 *  3. **配置不下发**：任务包 settings 里有正确项（flip-card 的 options[0]），
 *     所以 PlayView 只拿到 `{}`；它需要展示的一切都从服务端算好的
 *     view.payload 里取。这条边界是安全性的核心，改动时别"顺手"把 config 传下去。
 */

export type PluginGameAnswer = Extract<AnswerValue, { kind: "game" }>;

interface RunSummary {
  id: number;
  status: string;
  score: number;
  grade: string | null;
}

interface ActionResult {
  view: GameRunView;
  finished: boolean;
  result: GamePlayResult | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    // trial 路由要身份（Telegram initData / 邮箱会话 / 匿名 key），与
    // trial-api.ts 的 trialRequest 同一待遇——不带头的请求一律 401。
    headers: { "Content-Type": "application/json", ...identityHeaders() },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(typeof payload.message === "string" ? payload.message : "请求失败") as Error & {
      code?: string;
    };
    error.code = typeof payload.code === "string" ? payload.code : undefined;
    throw error;
  }
  return payload as T;
}

export function PluginGamePlay({
  packId,
  pluginId,
  persona = "male",
  mode = "normal",
  value,
  disabled,
  onResult,
}: {
  packId: number;
  pluginId: string;
  persona?: "male" | "female";
  mode?: "normal" | "hell";
  value: AnswerValue | undefined;
  disabled?: boolean;
  onResult: (next: PluginGameAnswer) => void;
}) {
  // 0106：18+ ack 改按包键（键含 pack id，见 trial-adult-ack.ts）。原与
  // TrialScreen 共用全局键 trialAdultAgreement:v1（一次确认解锁所有包），
  // 本轮废除；旧全局键 '1' 只读单向兼容，存量用户零回归。
  const [adultAck, setAdultAck] = useState(() => isAdultPackAckedLocally(packId));
  /**
   * 包级 18+ 标志（修复 3：按 pack.adult 决定是否弹门）。null = 还没查到
   * （/api/trial/packs 在路上或失败）——fail-closed：门先弹着，绝不因查询
   * 失败跳过 18+ 确认；adult=false 的全年龄包绝不弹门。
   */
  const [packAdult, setPackAdult] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<GamePlayResult | null>(() => {
    if (value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === "game") {
      const answer = value as PluginGameAnswer;
      return {
        runId: answer.runId,
        score: answer.score,
        grade: answer.grade ?? null,
        completed: answer.completed,
      };
    }
    return null;
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const runIdRef = useRef<number | null>(null);
  const lastResultRef = useRef<GamePlayResult | null>(null);

  // 换题换包时按新包重估 ack 与包级 adult（/s 侧 question 切换不重挂组件；
  // 修复 3：门按 pack.adult 分支——adult=false 的全年龄包绝不弹门）。
  useEffect(() => {
    setAdultAck(isAdultPackAckedLocally(packId));
    setPackAdult(null);
    let cancelled = false;
    void resolveTrialPackAdult(packId)
      .then((adult) => {
        if (!cancelled) setPackAdult(adult);
      })
      .catch(() => {
        // resolveTrialPackAdult 内部已兜成 null；这里再兜一层保持 fail-closed。
        if (!cancelled) setPackAdult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [packId]);

  // 同一个插件只创建一次懒加载组件（每次 render 新建会反复挂载）。
  const PlayView = useMemo(() => lazyPlayView(pluginId), [pluginId]);

  // 客户端缺实现时提前给出可读的错误，而不是让 Suspense 一直转圈。
  useEffect(() => {
    let cancelled = false;
    import("../game-plugins/loader")
      .then(({ loadClientPlugin }) => loadClientPlugin(pluginId))
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "插件加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const host = useMemo<GameHostBridge>(() => {
    const start = async (): Promise<GameRunView> => {
      // 先探进行中的局：换题/刷新回来时接着玩，而不是报 run_active。
      const active = await fetch("/api/trial/runs/active", { headers: identityHeaders() }).then(
        (response) => response.json() as Promise<{ run: RunSummary | null; view: GameRunView | null }>,
      );
      if (active.run && active.view && active.run.status === "active") {
        runIdRef.current = active.run.id;
        return active.view;
      }
      const created = await postJson<{ run: RunSummary; view: GameRunView }>("/api/trial/runs", {
        packId,
        persona,
        mode,
        startingFloor: 1,
        // 0106 服务端第二道闸（请求参数确认）：adult 包显式携带；能走到
        // 引擎开局说明宿主的包级门已放行（adultAck 状态即本地包级 ack）。
        adultAck,
      });
      runIdRef.current = created.run.id;
      return created.view;
    };

    const act = async (action: unknown): Promise<ActionResult> => {
      const id = runIdRef.current;
      if (id === null) throw new Error("本局尚未开始");
      const response = await postJson<ActionResult>(`/api/trial/runs/${id}/action`, { action });
      lastResultRef.current = response.result;
      return response;
    };

    return {
      adultAck,
      requestAdultAck: () => {
        // 0106 按包确认：只写包级键（键含 pack id），绝不回写全局键。
        ackAdultPackLocally(packId);
        setAdultAck(true);
      },
      start,
      act,
      async commit() {
        const result = lastResultRef.current;
        if (!result) return null;
        const answer: PluginGameAnswer = {
          kind: "game",
          runId: result.runId,
          score: result.score,
          grade: result.grade,
          completed: result.completed,
        };
        setSaved(result);
        onResultRef.current(answer);
        return result;
      },
      async abandon() {
        const id = runIdRef.current;
        if (id === null) return;
        const response = await postJson<ActionResult>(`/api/trial/runs/${id}/action`, {
          action: { kind: "abandon" },
        });
        lastResultRef.current = response.result;
      },
    };
  }, [adultAck, mode, packId, persona]);

  const handleAdultAck = useCallback(() => host.requestAdultAck(), [host]);

  if (loadError) {
    return <p className="mt-4 text-sm text-red-500">{loadError}</p>;
  }
  // 修复 3：adult=false 的全年龄包直接进玩法，不弹 18+ 门；adult=true 或
  // 查询未果（fail-closed）且未 ack 时弹统一确认卡（同一组件同一文案）。
  if (packAdult !== false && !adultAck) {
    return <TrialAdultGateCard packName={null} onConfirm={handleAdultAck} />;
  }

  return (
    <Suspense fallback={<p className="mt-4 text-sm text-[var(--survey-muted)]">正在加载小游戏…</p>}>
      <PlayView
        // 配置不下发：插件要展示的内容都在服务端算好的 view.payload 里。
        config={{}}
        host={host}
        saved={saved}
        {...(disabled === undefined ? {} : { disabled })}
      />
    </Suspense>
  );
}
