import { Trophy } from "lucide-react";
import type { AchievementItem, AchievementOverview } from "./api";

const GROUP_ORDER: AchievementItem["group"][] = ["问卷", "挑战", "广场", "彩蛋"];

function Badge({ item }: { item: AchievementItem }) {
  const hidden = !item.unlocked && item.secret;
  const label = hidden ? "???" : item.title;
  return (
    <div
      title={hidden ? "隐藏成就，达成后揭晓" : item.description}
      className={`flex min-w-0 flex-col items-center gap-1 rounded-[var(--survey-radius)] border px-1.5 py-2.5 text-center ${
        item.unlocked
          ? "border-[var(--survey-card-border)] bg-[var(--survey-primary-soft)]"
          : "border-dashed border-[var(--survey-card-border)] bg-[var(--survey-bg)] opacity-70"
      }`}
    >
      <span className={`text-xl leading-none ${item.unlocked ? "" : "grayscale"}`} aria-hidden>
        {item.unlocked ? item.icon : "🔒"}
      </span>
      <span
        className={`w-full truncate text-[10px] font-semibold ${
          item.unlocked ? "text-[var(--survey-heading)]" : "text-[var(--survey-muted)]"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * 「我的」页的徽章墙：只渲染服务端下发的目录与解锁状态。
 * 未解锁的非隐藏徽章显示名称 + 锁，隐藏徽章在解锁前显示 ???。
 */
export function AchievementWall({ overview }: { overview: AchievementOverview }) {
  const percent = overview.total > 0 ? Math.round((overview.unlocked / overview.total) * 100) : 0;
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: overview.items.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0);

  return (
    <section className="rounded-[var(--survey-radius)] border border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--survey-muted)]">
          <Trophy className="h-3.5 w-3.5" />
          我的成就
          {overview.unseen > 0 ? (
            <span className="ml-0.5 rounded-full bg-[var(--survey-primary)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--survey-primary-content)]">
              +{overview.unseen}
            </span>
          ) : null}
        </p>
        <span className="text-[11px] font-semibold text-[var(--survey-muted)]">
          {overview.unlocked} / {overview.total}
        </span>
      </div>

      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--survey-bg)]">
        <div className="h-full rounded-full bg-[var(--survey-primary)]" style={{ width: `${percent}%` }} />
      </div>

      <div className="mt-3.5 space-y-3">
        {groups.map(({ group, items }) => (
          <div key={group}>
            <p className="text-[10px] font-semibold tracking-wide text-[var(--survey-muted)]">{group}</p>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {items.map((item) => (
                <Badge key={item.code} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {overview.unlocked === 0 ? (
        <p className="mt-3 text-[11px] leading-4 text-[var(--survey-muted)]">
          完成问卷、通关挑战或在广场发言，都会点亮新的徽章。
        </p>
      ) : null}
    </section>
  );
}
