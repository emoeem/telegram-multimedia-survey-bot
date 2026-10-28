import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { safeGet, safeSet } from "./storage";
import { TRIAL_AGREEMENT_KEY } from "./GamePlayer";
import { lazyPlayView } from "../game-plugins/loader";
import type { GameHostBridge, GamePlayResult } from "../game-plugins/types";
import type { GameRunView } from "../../../src/game-plugin/types";
import type { AnswerValue } from "./api";

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
    headers: { "Content-Type": "application/json" },
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
  const [adultAck, setAdultAck] = useState(() => safeGet(TRIAL_AGREEMENT_KEY) === "1");
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
      const active = await fetch("/api/trial/runs/active").then(
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
        safeSet(TRIAL_AGREEMENT_KEY, "1");
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
  if (!adultAck) {
    return (
      <div className="mt-4 rounded-xl border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
        <p className="flex items-start gap-1.5 text-[13px] leading-6 text-[var(--survey-body)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
          <span>该小游戏为虚构互动内容，请确认你已年满 18 周岁后开始。</span>
        </p>
        <button
          type="button"
          className="mt-3 w-full rounded-[var(--survey-button-radius)] bg-[var(--survey-primary)] py-2.5 text-sm font-bold text-[var(--survey-primary-content)]"
          onClick={handleAdultAck}
        >
          我已年满 18 周岁，同意进入
        </button>
      </div>
    );
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
