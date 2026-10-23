import { useCallback, useEffect, useState } from "react";
import { Coins, Gift, Settings2, Sparkles, Target, Wallet } from "lucide-react";
import { api, apiSend } from "../api";
import { ErrorPanel, SkeletonPanel } from "../components/ui";
import { useDialogs } from "../components/Dialogs";

/**
 * 金币经济管理（/coin-economy）：投稿审核、奖池、运营配置、调账与流水查询。
 * 全部操作走 /api/admin/*（仅平台管理员），调账与配置变更都写审计日志。
 */

interface ConfigShape {
  timezoneOffsetMinutes: number;
  checkin: {
    enabled: boolean;
    ladder: Array<{ minStreak: number; amount: number }>;
    backfill: { enabled: boolean; cost: number; maxBackfillDays: number };
  };
  moderation?: { enabled: boolean; endpoint: string; rejectBelow: number; approveAbove: number };
  challenges: { enabled: boolean };
  pricing: { minPrice: number; maxPrice: number; hotWeight: number; qualityFactor: number; refreshSeconds: number };
  submissions: {
    enabled: boolean;
    autoApproveText: boolean;
    baseRewards: Record<string, number>;
    tierMultipliers: [number, number, number];
    dailyRewardCap: number;
    maxPerDay: number;
  };
  gacha: { enabled: boolean; maxMulti: number };
}

interface SubmissionRow {
  id: number;
  participantHash: string;
  type: string;
  title: string;
  description: string | null;
  contentText: string | null;
  mediaAssetId: number | null;
  status: string;
  qualityTier: number | null;
  rewardAmount: number | null;
  createdAt: string;
}

interface PoolRow {
  id: number;
  slug: string;
  name: string;
  status: string;
  costSingle: number;
  costMulti: number | null;
  pityAt: number | null;
  version: number;
  itemCount: number;
}

type Tab = "review" | "pools" | "challenges" | "config" | "adjust";

export function CoinEconomyPage() {
  const [tab, setTab] = useState<Tab>("review");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">金币经济</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          投稿审核、奖池上架、签到/定价/奖励配置与人工调账（全部写审计）。
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="金币管理分区">
        {(
          [
            { key: "review", label: "投稿审核", icon: Sparkles },
            { key: "pools", label: "抽卡奖池", icon: Gift },
            { key: "challenges", label: "挑战定义", icon: Target },
            { key: "config", label: "运营配置", icon: Settings2 },
            { key: "adjust", label: "调账与流水", icon: Wallet },
          ] as const
        ).map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`btn btn-sm ${tab === entry.key ? "btn-accent" : "btn-quiet"}`}
            onClick={() => setTab(entry.key)}
          >
            <entry.icon className="h-4 w-4" />
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "review" ? <ReviewTab /> : null}
      {tab === "pools" ? <PoolsTab /> : null}
      {tab === "challenges" ? <ChallengesTab /> : null}
      {tab === "config" ? <ConfigTab /> : null}
      {tab === "adjust" ? <AdjustTab /> : null}
    </div>
  );
}

function ReviewTab() {
  const [rows, setRows] = useState<SubmissionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<Record<number, number>>({});
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [poolChoice, setPoolChoice] = useState<Record<number, number>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const reload = useCallback(() => {
    setError(null);
    api<{ submissions: SubmissionRow[] }>("/api/admin/submissions")
      .then((data) => setRows(data.submissions))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  useEffect(() => {
    reload();
    api<{ pools: PoolRow[] }>("/api/admin/gacha/pools")
      .then((data) => setPools(data.pools))
      .catch(() => undefined);
  }, [reload]);

  const review = async (id: number, decision: "approved" | "rejected" | "changes_requested") => {
    if (busyId !== null) return;
    setBusyId(id);
    setError(null);
    try {
      await apiSend("POST", `/api/admin/submissions/${id}/review`, { decision, qualityTier: tier[id] ?? 2 });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "审核失败");
    } finally {
      setBusyId(null);
    }
  };

  const addToPool = async (id: number) => {
    if (busyId !== null) return;
    const poolId = poolChoice[id] ?? pools[0]?.id;
    if (!poolId) {
      setError("请先创建奖池");
      return;
    }
    setBusyId(id);
    setError(null);
    try {
      await apiSend("POST", `/api/admin/submissions/${id}/pool`, { poolId, rarity: "R" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入奖池失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      {error ? (
        <div className="alert alert-error flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}
      {rows === null ? (
        <SkeletonPanel lines={6} />
      ) : rows.length === 0 ? (
        <div className="panel p-6 text-center text-sm text-[var(--color-muted)]">没有待审核的投稿</div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="panel space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">
                  #{row.id} {row.title}
                  <span className="ml-2 rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-muted)]">
                    {row.type}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {row.createdAt.slice(0, 16)} · 状态 {row.status}
                  {row.rewardAmount != null ? ` · 已奖励 ${row.rewardAmount}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                  质量档
                  <select
                    className="rounded border border-[var(--color-edge)] bg-[var(--surface)] px-1.5 py-1 text-xs"
                    value={tier[row.id] ?? 2}
                    onChange={(event) => setTier((prev) => ({ ...prev, [row.id]: Number(event.target.value) }))}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyId !== null}
                  onClick={() => void review(row.id, "changes_requested")}
                >
                  需修改
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-hover"
                  disabled={busyId !== null}
                  onClick={() => void review(row.id, "rejected")}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-accent"
                  disabled={busyId !== null}
                  onClick={() => void review(row.id, "approved")}
                >
                  {busyId === row.id && "处理中…"}
                  {busyId !== row.id && (row.rewardAmount == null ? "通过并奖励" : "通过")}
                </button>
                {row.status === "approved" ? (
                  <span className="flex items-center gap-1">
                    <select
                      aria-label="选择奖池"
                      className="rounded border border-[var(--color-edge)] bg-[var(--surface)] px-1.5 py-1 text-xs"
                      value={poolChoice[row.id] ?? ""}
                      onChange={(event) => setPoolChoice((prev) => ({ ...prev, [row.id]: Number(event.target.value) }))}
                    >
                      <option value="">选择奖池…</option>
                      {pools.map((pool) => (
                        <option key={pool.id} value={pool.id}>
                          {pool.name}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-sm" onClick={() => void addToPool(row.id)}>
                      加入奖池
                    </button>
                  </span>
                ) : null}
              </div>
            </div>
            {row.contentText ? (
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--surface-muted)] p-2 text-xs text-[var(--color-muted)]">
                {row.contentText}
              </p>
            ) : null}
            {row.mediaAssetId ? (
              <img
                src={`/api/submissions/media/${row.mediaAssetId}`}
                alt={`投稿 #${row.id} 预览`}
                className="max-h-48 rounded-lg"
                loading="lazy"
              />
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function PoolsTab() {
  const [pools, setPools] = useState<PoolRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ slug: "", name: "", costSingle: 20, costMulti: "", pityAt: "" });

  const reload = useCallback(() => {
    setError(null);
    api<{ pools: PoolRow[] }>("/api/admin/gacha/pools")
      .then((data) => setPools(data.pools))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    setError(null);
    try {
      await apiSend("POST", "/api/admin/gacha/pools", {
        slug: form.slug,
        name: form.name,
        costSingle: Number(form.costSingle),
        costMulti: form.costMulti ? Number(form.costMulti) : null,
        pityAt: form.pityAt ? Number(form.pityAt) : null,
      });
      setForm({ slug: "", name: "", costSingle: 20, costMulti: "", pityAt: "" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  };

  const toggleStatus = async (pool: PoolRow) => {
    setError(null);
    try {
      await apiSend("PUT", `/api/admin/gacha/pools/${pool.id}`, {
        status: pool.status === "active" ? "ended" : "active",
      });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "状态更新失败");
    }
  };

  return (
    <div className="space-y-3">
      {error ? (
        <div className="alert alert-error flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}
      <div className="panel space-y-2 p-4">
        <p className="text-sm font-bold">创建奖池（创建后默认草稿；加入内容生成快照后才能上架）</p>
        <div className="grid gap-2 sm:grid-cols-5">
          <input aria-label="slug" className="input" placeholder="slug（如 spring-2026）" value={form.slug} onChange={(event) => setForm((prev) => ({ ...prev, slug: event.target.value }))} />
          <input aria-label="名称" className="input" placeholder="名称" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
          <input aria-label="单抽价格" className="input" type="number" placeholder="单抽" value={form.costSingle} onChange={(event) => setForm((prev) => ({ ...prev, costSingle: Number(event.target.value) }))} />
          <input aria-label="十连价格" className="input" type="number" placeholder="十连（可选）" value={form.costMulti} onChange={(event) => setForm((prev) => ({ ...prev, costMulti: event.target.value }))} />
          <input aria-label="保底抽数" className="input" type="number" placeholder="保底（可选）" value={form.pityAt} onChange={(event) => setForm((prev) => ({ ...prev, pityAt: event.target.value }))} />
        </div>
        <button type="button" className="btn btn-sm btn-accent" disabled={!form.slug || !form.name} onClick={() => void create()}>
          <Coins className="h-4 w-4" />
          创建
        </button>
      </div>
      {pools === null ? (
        <SkeletonPanel lines={4} />
      ) : (
        pools.map((pool) => (
          <div key={pool.id} className="panel flex flex-wrap items-center justify-between gap-2 p-4">
            <div>
              <p className="text-sm font-bold">
                {pool.name} <span className="ml-1 text-xs font-normal text-[var(--color-muted)]">({pool.slug})</span>
              </p>
              <p className="text-xs text-[var(--color-muted)]">
                状态 {pool.status} · 单抽 {pool.costSingle}
                {pool.costMulti ? ` · 十连 ${pool.costMulti}` : ""}
                {pool.pityAt ? ` · 保底 ${pool.pityAt}` : ""} · {pool.itemCount} 个内容 · 版本 v{pool.version}
              </p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => void toggleStatus(pool)}>
              {pool.status === "active" ? "下架" : "上架"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}


interface ChallengeRow {
  id: number;
  code: string;
  title: string;
  description: string;
  icon: string;
  goalType: string;
  goalTarget: number;
  reward: number;
  period: string;
  startAt: string | null;
  endAt: string | null;
  active: number;
  sort: number;
}

const GOAL_TYPE_LABELS: Record<string, string> = {
  completed_surveys: "完成问卷数",
  checkin_streak: "连续签到天数",
  submissions_approved: "过审投稿数",
  gacha_pulls: "抽卡次数",
  plaza_posts: "树洞发帖数",
};

function ChallengesTab() {
  const [rows, setRows] = useState<ChallengeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: "",
    title: "",
    description: "",
    icon: "🎯",
    goalType: "completed_surveys",
    goalTarget: 1,
    reward: 10,
    period: "once",
  });

  const reload = useCallback(() => {
    setError(null);
    api<{ challenges: ChallengeRow[] }>("/api/admin/coins/challenges")
      .then((data) => setRows(data.challenges))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = async () => {
    setError(null);
    try {
      await apiSend("POST", "/api/admin/coins/challenges", { ...form });
      setForm({ ...form, code: "", title: "", description: "" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  };

  const toggle = async (row: ChallengeRow) => {
    setError(null);
    try {
      await apiSend("PUT", `/api/admin/coins/challenges/${row.id}`, { active: row.active !== 1 });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    }
  };

  return (
    <div className="space-y-3">
      {error ? (
        <div className="alert alert-error flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}
      <div className="panel space-y-2 p-4">
        <p className="text-sm font-bold">新建挑战（进度全部由服务端按真实记录计算）</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <input aria-label="code" className="input" placeholder="code（如 first_survey）" value={form.code} onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))} />
          <input aria-label="标题" className="input" placeholder="标题" value={form.title} onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} />
          <input aria-label="图标" className="input" placeholder="图标 emoji" value={form.icon} onChange={(event) => setForm((prev) => ({ ...prev, icon: event.target.value }))} />
          <select aria-label="目标类型" className="input" value={form.goalType} onChange={(event) => setForm((prev) => ({ ...prev, goalType: event.target.value }))}>
            {Object.entries(GOAL_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input aria-label="目标数" className="input" type="number" placeholder="目标数" value={form.goalTarget} onChange={(event) => setForm((prev) => ({ ...prev, goalTarget: Number(event.target.value) }))} />
          <input aria-label="奖励金币" className="input" type="number" placeholder="奖励金币" value={form.reward} onChange={(event) => setForm((prev) => ({ ...prev, reward: Number(event.target.value) }))} />
          <select aria-label="周期" className="input" value={form.period} onChange={(event) => setForm((prev) => ({ ...prev, period: event.target.value }))}>
            <option value="once">一次性</option>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
          </select>
          <input aria-label="说明" className="input" placeholder="说明（可选）" value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} />
        </div>
        <button type="button" className="btn btn-sm btn-accent" disabled={!form.code || !form.title} onClick={() => void create()}>
          <Target className="h-4 w-4" />
          创建挑战
        </button>
        <p className="text-xs text-[var(--color-muted)]">
          挑战应奖励真实参与（完成问卷、连续签到、过审投稿），避免奖励单纯的操作次数。
        </p>
      </div>
      {rows === null ? (
        <SkeletonPanel lines={4} />
      ) : rows.length === 0 ? (
        <div className="panel p-6 text-center text-sm text-[var(--color-muted)]">还没有挑战定义</div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="panel flex flex-wrap items-center justify-between gap-2 p-4">
            <div>
              <p className="text-sm font-bold">
                {row.icon} {row.title}
                <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">({row.code})</span>
                {row.active !== 1 ? <span className="ml-2 rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px]">已停用</span> : null}
              </p>
              <p className="text-xs text-[var(--color-muted)]">
                {GOAL_TYPE_LABELS[row.goalType] ?? row.goalType} ≥ {row.goalTarget} · 奖励 {row.reward} ·{" "}
                {row.period === "once" ? "一次性" : row.period === "daily" ? "每日" : "每周"}
                {row.startAt ? ` · ${row.startAt.slice(0, 10)} 起` : ""}
                {row.endAt ? ` · ${row.endAt.slice(0, 10)} 止` : ""}
              </p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => void toggle(row)}>
              {row.active === 1 ? "停用" : "启用"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function ConfigTab() {
  const [config, setConfig] = useState<ConfigShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    api<ConfigShape>("/api/admin/coins/config")
      .then(setConfig)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async (section: string, value: unknown) => {
    setError(null);
    setSaved(false);
    try {
      const next = await apiSend<ConfigShape>("PUT", "/api/admin/coins/config", { section, value });
      setConfig(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  };

  if (error) {
    return (
      <div className="alert alert-error flex items-center justify-between gap-3">
        <span>{error}</span>
        <button type="button" className="btn btn-sm" onClick={reload}>
          重试
        </button>
      </div>
    );
  }
  if (!config) return <SkeletonPanel lines={6} />;

  return (
    <div className="space-y-3">
      {saved ? <div className="alert alert-success">已保存（写入审计）</div> : null}
      <div className="panel space-y-3 p-4">
        <p className="text-sm font-bold">问卷解锁定价</p>
        <div className="grid gap-2 sm:grid-cols-5">
          {(
            [
              ["minPrice", "最低价"],
              ["maxPrice", "最高价"],
              ["hotWeight", "热度权重"],
              ["qualityFactor", "内容系数"],
              ["refreshSeconds", "刷新间隔(秒)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-xs text-[var(--color-muted)]">
              {label}
              <input
                aria-label={label}
                className="input mt-1"
                type="number"
                step="any"
                value={config.pricing[key]}
                onChange={(event) =>
                  setConfig({ ...config, pricing: { ...config.pricing, [key]: Number(event.target.value) } })
                }
              />
            </label>
          ))}
        </div>
        <button type="button" className="btn btn-sm btn-accent" onClick={() => void save("pricing", config.pricing)}>
          保存定价
        </button>
      </div>
      <div className="panel space-y-3 p-4">
        <p className="text-sm font-bold">投稿奖励（基础奖励 × 质量档乘数，受每日上限约束）</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="text-xs text-[var(--color-muted)]">
            每日奖励上限
            <input
              aria-label="每日奖励上限"
              className="input mt-1"
              type="number"
              value={config.submissions.dailyRewardCap}
              onChange={(event) =>
                setConfig({ ...config, submissions: { ...config.submissions, dailyRewardCap: Number(event.target.value) } })
              }
            />
          </label>
          <label className="text-xs text-[var(--color-muted)]">
            每日投稿上限
            <input
              aria-label="每日投稿上限"
              className="input mt-1"
              type="number"
              value={config.submissions.maxPerDay}
              onChange={(event) =>
                setConfig({ ...config, submissions: { ...config.submissions, maxPerDay: Number(event.target.value) } })
              }
            />
          </label>
          {(["text", "image", "survey_report"] as const).map((type) => (
            <label key={type} className="text-xs text-[var(--color-muted)]">
              {type} 基础奖励
              <input
                aria-label={`${type} 基础奖励`}
                className="input mt-1"
                type="number"
                value={config.submissions.baseRewards[type] ?? 0}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    submissions: {
                      ...config.submissions,
                      baseRewards: { ...config.submissions.baseRewards, [type]: Number(event.target.value) },
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <button type="button" className="btn btn-sm btn-accent" onClick={() => void save("submissions", config.submissions)}>
          保存投稿奖励
        </button>
      </div>
      <div className="panel space-y-3 p-4">
        <p className="text-sm font-bold">签到阶梯</p>
        {config.checkin.ladder.map((step, index) => (
          <div key={index} className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
            连续 ≥
            <input
              aria-label={`第 ${index + 1} 档连续天数`}
              className="input w-20"
              type="number"
              value={step.minStreak}
              onChange={(event) => {
                const ladder = [...config.checkin.ladder];
                ladder[index] = { ...step, minStreak: Number(event.target.value) };
                setConfig({ ...config, checkin: { ...config.checkin, ladder } });
              }}
            />
            天 →
            <input
              aria-label={`第 ${index + 1} 档奖励`}
              className="input w-20"
              type="number"
              value={step.amount}
              onChange={(event) => {
                const ladder = [...config.checkin.ladder];
                ladder[index] = { ...step, amount: Number(event.target.value) };
                setConfig({ ...config, checkin: { ...config.checkin, ladder } });
              }}
            />
            金币
          </div>
        ))}
        <div className="mt-3 border-t border-[var(--color-edge)] pt-3">
          <p className="text-xs font-bold text-[var(--color-ink)]">补签（默认关闭）</p>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={config.checkin.backfill.enabled}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    checkin: { ...config.checkin, backfill: { ...config.checkin.backfill, enabled: event.target.checked } },
                  })
                }
              />
              开放补签
            </label>
            <label className="flex items-center gap-1.5">
              每次费用
              <input
                aria-label="补签费用"
                className="input w-24"
                type="number"
                value={config.checkin.backfill.cost}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    checkin: { ...config.checkin, backfill: { ...config.checkin.backfill, cost: Number(event.target.value) } },
                  })
                }
              />
              金币
            </label>
            <label className="flex items-center gap-1.5">
              可补最近
              <input
                aria-label="补签窗口天数"
                className="input w-20"
                type="number"
                value={config.checkin.backfill.maxBackfillDays}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    checkin: { ...config.checkin, backfill: { ...config.checkin.backfill, maxBackfillDays: Number(event.target.value) } },
                  })
                }
              />
              天
            </label>
          </div>
        </div>
        <button type="button" className="btn btn-sm btn-accent" onClick={() => void save("checkin", config.checkin)}>
          保存签到配置
        </button>
      </div>
      <ModerationSection />
    </div>
  );
}


/** 外部内容安全审核服务配置。默认关闭 —— 关闭时投稿走人工审核。 */
function ModerationSection() {
  const [state, setState] = useState<{ enabled: boolean; endpoint: string; rejectBelow: number; approveAbove: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<{ moderation?: typeof state }>("/api/admin/coins/config")
      .then((config) =>
        setState(
          config.moderation ?? { enabled: false, endpoint: "", rejectBelow: 0.85, approveAbove: 0.2 },
        ),
      )
      .catch(() => setState({ enabled: false, endpoint: "", rejectBelow: 0.85, approveAbove: 0.2 }));
  }, []);

  if (!state) return null;

  const save = async () => {
    setError(null);
    try {
      await apiSend("PUT", "/api/admin/coins/config", { section: "moderation", value: state });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  };

  return (
    <div className="panel space-y-3 p-4">
      <p className="text-sm font-bold">外部内容安全审核（可选）</p>
      <p className="text-xs text-[var(--color-muted)]">
        默认关闭：关闭或未配置密钥时，所有投稿都进入人工审核队列；服务不可达/超时也一律转人工，绝不放行。
        启用需同时配置 <code>MODERATION_API_KEY</code> 环境密钥（wrangler secret）。
      </p>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {saved ? <div className="alert alert-success">已保存</div> : null}
      <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <input type="checkbox" checked={state.enabled} onChange={(event) => setState({ ...state, enabled: event.target.checked })} />
        启用外部审核服务
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs text-[var(--color-muted)] sm:col-span-3">
          服务地址（https，POST JSON）
          <input
            aria-label="审核服务地址"
            className="input mt-1"
            placeholder="https://moderation.example.com/check"
            value={state.endpoint}
            onChange={(event) => setState({ ...state, endpoint: event.target.value })}
          />
        </label>
        <label className="text-xs text-[var(--color-muted)]">
          拒绝阈值（≥ 判拒绝）
          <input
            aria-label="拒绝阈值"
            className="input mt-1"
            type="number"
            step="0.05"
            value={state.rejectBelow}
            onChange={(event) => setState({ ...state, rejectBelow: Number(event.target.value) })}
          />
        </label>
        <label className="text-xs text-[var(--color-muted)]">
          通过阈值（≤ 判通过）
          <input
            aria-label="通过阈值"
            className="input mt-1"
            type="number"
            step="0.05"
            value={state.approveAbove}
            onChange={(event) => setState({ ...state, approveAbove: Number(event.target.value) })}
          />
        </label>
      </div>
      <button type="button" className="btn btn-sm btn-accent" onClick={() => void save()}>
        保存审核配置
      </button>
    </div>
  );
}

function AdjustTab() {
  const { confirm } = useDialogs();
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [adjustPending, setAdjustPending] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Array<Record<string, unknown>> | null>(null);

  const resolve = async () => {
    setError(null);
    try {
      const data = await api<{ participantHash: string; account: { balance: number } | null }>(
        `/api/admin/coins/account?${target.includes("@") || /^\d+$/.test(target) ? `userId=${encodeURIComponent(target)}` : `participantHash=${encodeURIComponent(target)}`}`,
      );
      setHash(data.participantHash);
      setResult(`余额：${data.account?.balance ?? 0}`);
      const txns = await api<{ transactions: Array<Record<string, unknown>> }>(
        `/api/admin/coins/transactions?participantHash=${encodeURIComponent(data.participantHash)}`,
      );
      setTransactions(txns.transactions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败");
    }
  };

  const adjustBusy = adjustPending !== "";
  const adjust = async () => {
    if (adjustBusy) return;
    const ok = await confirm({
      title: "确认人工调账？",
      message: `将把用户 ${target} 的金币余额直接变更 ${Number(amount) > 0 ? "+" : ""}${amount}。此操作写入审计日志。`,
      confirmLabel: "确认调账",
      variant: Number(amount) < 0 ? "danger" : "default",
    });
    if (!ok) return;
    setAdjustPending("调账中…");
    setError(null);
    setResult(null);
    try {
      const data = await apiSend<{ balance: number }>("POST", "/api/admin/coins/adjust", {
        participantHash: hash,
        amount: Number(amount),
        reason,
      });
      setResult(`调账成功，余额 ${data.balance}`);
      setReason("");
      setAmount("");
      void resolve();
    } catch (err) {
      setError(err instanceof Error ? err.message : "调账失败");
    } finally {
      setAdjustPending("");
    }
  };

  return (
    <div className="space-y-3">
      {error ? <div className="alert alert-error">{error}</div> : null}
      {result ? <div className="alert alert-success">{result}</div> : null}
      <div className="panel space-y-2 p-4">
        <p className="text-sm font-bold">查询用户金币（按用户 ID 或 participantHash）</p>
        <div className="flex gap-2">
          <input aria-label="用户标识" className="input" value={target} onChange={(event) => setTarget(event.target.value)} />
          <button type="button" className="btn btn-sm" onClick={() => void resolve()}>
            查询
          </button>
        </div>
        {hash ? (
          <>
            <p className="text-xs text-[var(--color-muted)]">participantHash：{hash}</p>
            <div className="flex flex-wrap gap-2">
              <input
                aria-label="调账金额"
                className="input w-32"
                type="number"
                placeholder="金额（±）"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <input
                aria-label="调账原因"
                className="input flex-1"
                placeholder="原因（必填，写入审计）"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm btn-accent"
                disabled={!amount || reason.trim().length < 3}
                onClick={() => void adjust()}
              >
                调账
              </button>
            </div>
            {transactions ? (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {transactions.map((txn) => (
                  <div key={String(txn.id)} className="flex items-center justify-between rounded bg-[var(--surface-muted)] px-2 py-1 text-xs">
                    <span>
                      {String(txn.kind)} · {String(txn.note ?? "")}
                    </span>
                    <span className={Number(txn.amount) > 0 ? "font-bold text-[var(--app-success)]" : "font-bold text-[var(--app-danger)]"}>
                      {Number(txn.amount) > 0 ? "+" : ""}
                      {String(txn.amount)}（余 {String(txn.balanceAfter)}）
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
