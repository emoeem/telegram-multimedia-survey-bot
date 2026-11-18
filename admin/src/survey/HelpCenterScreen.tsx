import {
  BadgeCheck,
  BookOpen,
  Coins,
  FileText,
  FileUp,
  IdCard,
  Images,
  MailCheck,
  MessagesSquare,
  Send,
  Sparkles,
  Target,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { groupScreenHelp } from "./help-center";
import { PageHeader } from "./PageHeader";
import { SectionHeader } from "./PublicPrimitives";
import { ScreenShell, ThemeAction, usePublicTheme } from "./ScreenShell";

/** 分组图标：与各屏入口在「我的」等处用的 lucide 图标同源。 */
const HELP_SCREEN_ICONS: Record<string, LucideIcon> = {
  survey: FileText,
  plaza: MessagesSquare,
  showcase: Images,
  trial: Target,
  coins: Coins,
  gacha: Sparkles,
  submissions: Send,
  notes: MailCheck,
  series: BookOpen,
  me: UserRound,
  submit: FileUp,
  cert: BadgeCheck,
  // 兜底图标：注册表加了新键而这里没配图标时，别让渲染直接炸。
  fallback: IdCard,
};

/**
 * 帮助中心（/help，2026-11-19 通宵批次 B3）。
 *
 * 每屏 ？ 弹层（help-button.tsx）的整页版：按 SCREEN_HELP 注册表逐屏分组
 * 渲染「这是什么 + 新手最常用的动作」，含未接线 ? 按钮的键（cert 等）。
 * 入口：「我的」页的帮助中心入口 + 任意屏 ？ 弹层底部的「更多帮助」。
 * 壳沿用 ScreenShell（主题 + 底部六 tab 导航），不动 BottomNav 布局。
 */
export function HelpCenterScreen() {
  const themeState = usePublicTheme();
  const groups = groupScreenHelp();
  return (
    <ScreenShell themeState={themeState}>
      <PageHeader
        title="帮助中心"
        subtitle="每一屏是什么、新手第一步点哪里"
        backHref={null}
        wide={false}
        actions={<ThemeAction themeState={themeState} />}
      />
      <main className="mx-auto w-full max-w-3xl px-4 pb-10">
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--survey-muted)]">
          各页面右上角的 ？ 按钮弹出的就是这里的说明；全部说明放在一页，方便一次看完。
        </p>
        {groups.map((group) => {
          const Icon = HELP_SCREEN_ICONS[group.key] ?? HELP_SCREEN_ICONS.fallback;
          return (
            <section key={group.key} className="survey-card mt-3 p-4">
              <SectionHeader icon={Icon} title={group.title} />
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--survey-muted)]">{group.help.intro}</p>
              <ul className="mt-2 space-y-2">
                {group.help.entries.map((entry) => (
                  <li key={entry.label} className="rounded-xl border border-[var(--survey-card-border)] p-3">
                    <p className="text-[13px] font-semibold text-[var(--survey-heading)]">{entry.label}</p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--survey-muted)]">{entry.hint}</p>
                    {entry.href ? (
                      <a
                        href={entry.href}
                        className="mt-1.5 inline-block text-[12px] font-semibold text-[var(--survey-primary)] underline"
                      >
                        前往
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </main>
    </ScreenShell>
  );
}
