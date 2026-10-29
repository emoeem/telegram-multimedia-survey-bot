import { useEffect, useState } from "react";
import { BookOpenCheck, Lock } from "lucide-react";
import { questManifest, questProps } from "../../../../../src/game-plugin/plugins/quest/manifest";
import { defineGamePlugin } from "../../define";
import type { GameEditViewProps, GamePlayViewProps } from "../../types";

/**
 * quest 剧情扩展包 · 客户端半身。
 *
 * 编辑态：内容是导入器生成的 JSON，不做结构编辑器（改包请重新导入），
 * 只展示统计与提示。答题态：galgame 式底部对话框 + 选项 + 道具栏，
 * 全部渲染引擎算好的 payload——本地不做任何判分。
 */

interface QuestViewChoice {
  text: string;
  locked: boolean;
  lockHint: string | null;
}

interface QuestPayload {
  node: { id: string; chapter: string | null; speaker: string | null; text: string; image: string | null } | null;
  choices: QuestViewChoice[];
  inventory: Array<{ id: string; name: string; icon: string; kind: string; desc: string }>;
  totalItems: number;
  finished: boolean;
  endingTitle: string | null;
  endingNote: string | null;
  cluesFound: number;
  collectiblesFound: number;
  cover: number | null;
}

function payloadOf(view: unknown): QuestPayload {
  const payload = (view as { payload?: unknown })?.payload;
  return (payload ?? {}) as QuestPayload;
}

function EditView({ config }: GameEditViewProps<Record<string, unknown>>) {
  let stats = "还没有内容（请通过「导入扩展包」生成）。";
  try {
    const parsed = JSON.parse(String(config.content ?? "{}")) as {
      nodes?: unknown[];
      items?: unknown[];
      title?: string;
    };
    if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
      stats = `《${parsed.title ?? "未命名"}》 · ${parsed.nodes.length} 个节点 · ${(parsed.items ?? []).length} 个道具`;
    }
  } catch {
    stats = "content 不是合法 JSON（请重新导入扩展包）。";
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-3 text-xs text-[var(--color-muted-soft)]">
        <p className="flex items-center gap-1.5 font-semibold text-[var(--color-ink)]">
          <BookOpenCheck className="h-4 w-4" aria-hidden="true" />
          剧情扩展包
        </p>
        <p className="mt-1">{stats}</p>
        <p className="mt-1">修改内容请重新上传扩展包（管理端「任务包 → 导入扩展包」），不要手改 JSON。</p>
      </div>
      {config.adult ? (
        <p className="rounded-lg bg-[var(--app-warning)]/10 px-3 py-2 text-[11px] text-[var(--app-warning)]">
          已标记 18+：答题端会先弹年龄确认。
        </p>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  clue: "线索",
  collectible: "收集",
  key: "钥匙",
};

function PlayView({ host, saved, disabled }: GamePlayViewProps<Record<string, unknown>>) {
  const [view, setView] = useState<Awaited<ReturnType<typeof host.start>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInventory, setShowInventory] = useState(false);

  useEffect(() => {
    if (!host.adultAck) return;
    let cancelled = false;
    void host
      .start()
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "开局失败");
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!host.adultAck) return null; // 门禁由宿主渲染

  if (error) {
    return (
      <div className="rounded-xl border border-[var(--app-danger)]/40 bg-[var(--app-danger)]/10 px-4 py-3 text-sm text-[var(--app-danger)]">
        {error}
      </div>
    );
  }
  if (saved && !view) {
    return (
      <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-4 text-sm">
        <p className="font-semibold text-[var(--color-ink)]">已完成 · 评级 {saved.grade ?? "—"}</p>
        <p className="mt-1 text-xs text-[var(--color-muted-soft)]">得分 {saved.score}。重答会开启新的一局。</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-4 text-sm text-[var(--color-muted-soft)]">
        正在打开剧情…
      </div>
    );
  }

  const payload = payloadOf(view);
  const choose = async (index: number) => {
    if (busy || disabled) return;
    const choice = payload.choices[index];
    if (!choice || choice.locked) return;
    setBusy(true);
    try {
      // step 与 flip-card 同款约定：view.step 是 1 基展示值，服务端按 0 基比对。
      const next = await host.act({ kind: "choose", choiceIndex: index, step: view.step - 1 });
      setView(next.view);
      if (next.finished) await host.commit();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "网络异常，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="vn-dialog quest-dialog relative mx-auto w-full max-w-[720px]">
        {payload.node?.chapter ? <span className="vn-dialog-chapter">{payload.node.chapter}</span> : null}
        {payload.node?.speaker ? <span className="vn-dialog-speaker">{payload.node.speaker}</span> : null}
        {payload.node?.image ? (
          <img
            src={payload.node.image}
            alt=""
            className="mb-3 max-h-[36dvh] w-full rounded-xl object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <div className="vn-dialog-text max-h-none">
          <p className="whitespace-pre-wrap">{payload.node?.text ?? "…"}</p>
          {payload.finished ? (
            <div className="mt-3 rounded-xl border border-[#fcd34d55] bg-[#f59e0b]/10 p-3">
              <p className="text-sm font-bold text-[#f59e0b]">结局 · {payload.endingTitle ?? "完"}</p>
              {payload.endingNote ? <p className="mt-1 text-xs leading-5 opacity-80">{payload.endingNote}</p> : null}
              <p className="mt-2 text-xs opacity-80">
                {typeof view.score === "number" ? `得分 ${view.score} · ` : ""}线索 {payload.cluesFound} · 收集{" "}
                {payload.collectiblesFound}/{payload.totalItems}
              </p>
            </div>
          ) : null}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {payload.choices.map((choice, index) => (
            <button
              key={index}
              type="button"
              disabled={busy || disabled || choice.locked}
              onClick={() => void choose(index)}
              className={`flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition ${
                choice.locked
                  ? "cursor-not-allowed border-[var(--color-edge)] bg-transparent text-[var(--color-muted)]"
                  : "border-[var(--survey-primary)]/45 bg-[var(--survey-primary)]/10 text-[var(--survey-heading)] hover:bg-[var(--survey-primary)]/20 active:scale-[0.99]"
              }`}
            >
              {choice.locked ? <Lock className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
              <span className="min-w-0 flex-1">{choice.text}</span>
              {choice.locked && choice.lockHint ? (
                <span className="shrink-0 text-[11px] text-[var(--color-muted)]">需要「{choice.lockHint}」</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setShowInventory((current) => !current)}
          className="min-h-9 rounded-full border border-[var(--color-edge)] px-3 text-xs font-semibold text-[var(--color-muted-soft)] hover:text-[var(--color-ink)]"
          aria-expanded={showInventory}
        >
          🎒 道具（{payload.inventory.length}/{payload.totalItems}）
        </button>
        <p className="text-xs tabular-nums text-[var(--color-muted)]">
          进度 {view.step}/{view.total}
        </p>
      </div>
      {showInventory ? (
        <ul className="mx-auto grid w-full max-w-[720px] grid-cols-1 gap-2 sm:grid-cols-2">
          {payload.inventory.length === 0 ? (
            <li className="col-span-full rounded-xl border border-dashed border-[var(--color-edge)] p-3 text-center text-xs text-[var(--color-muted)]">
              还没有获得道具。探索选项试试。
            </li>
          ) : null}
          {payload.inventory.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-xl border border-[var(--color-edge)] bg-[var(--surface)] p-3 text-xs"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                {item.icon}
              </span>
              <span className="min-w-0">
                <b className="text-[var(--color-ink)]">{item.name}</b>
                <span className="ml-1.5 rounded-full bg-[var(--survey-primary)]/15 px-1.5 py-0.5 text-[10px] text-[var(--survey-primary)]">
                  {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                {item.desc ? <span className="mt-0.5 block text-[var(--color-muted-soft)]">{item.desc}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const questClientPlugin = defineGamePlugin({
  manifest: questManifest,
  props: questProps,
  EditView,
  PlayView,
  summary: (config) => {
    try {
      const parsed = JSON.parse(String(config.content ?? "{}")) as { title?: string };
      return parsed.title ? `剧情：${parsed.title}` : "剧情扩展包";
    } catch {
      return "剧情扩展包（内容无效）";
    }
  },
});

export default questClientPlugin;
