import { useState } from "react";
import { CircleHelp, X } from "lucide-react";
import { getScreenHelp } from "./screen-help";

/**
 * 每屏「这是什么」按钮 + 底部弹层（2026-11-18，用户反馈：功能太多看不懂）。
 *
 * 放在 PageHeader 的 actions 里（helpKey 一个 prop 接线）。弹层内容来自
 * screen-help.ts 的注册表：一句话说明 + 新手最常用的动作与入口。
 * 样式沿用 ThemePickerSheet 的底部弹层约定（fixed z-50 / 圆角面板 /
 * card 变量色），不引入新的弹层体系。
 */
export function HelpButton({ helpKey }: { helpKey: string }) {
  const [open, setOpen] = useState(false);
  const help = getScreenHelp(helpKey);
  if (!help) return null;
  return (
    <>
      <button
        type="button"
        className="survey-icon-btn"
        aria-label="这个页面是什么"
        title="这个页面是什么"
        onClick={() => setOpen(true)}
      >
        <CircleHelp className="h-4 w-4" />
      </button>
      {open ? (
        <div className="fixed inset-0 z-50">
          <button aria-label="关闭说明" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-[0_-12px_40px_-16px_rgba(15,23,42,.3)]">
            <div className="flex items-center justify-between">
              <span className="text-[15px] font-semibold text-[var(--survey-heading)]">这个页面是什么</span>
              <button
                type="button"
                className="survey-icon-btn h-8 w-8"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--survey-muted)]">{help.intro}</p>
            <ul className="mt-3 space-y-2">
              {help.entries.map((entry) => (
                <li key={entry.label} className="rounded-xl border border-[var(--survey-card-border)] p-3">
                  <p className="text-[13px] font-semibold text-[var(--survey-heading)]">{entry.label}</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--survey-muted)]">{entry.hint}</p>
                  {entry.href ? (
                    <a
                      href={entry.href}
                      className="mt-1.5 inline-block text-[12px] font-semibold text-[var(--survey-primary)] underline"
                      onClick={() => setOpen(false)}
                    >
                      前往
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
