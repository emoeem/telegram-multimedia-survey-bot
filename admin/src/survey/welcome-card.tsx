import { useState } from "react";
import { ArrowRight, ClipboardList, Images, Mail, Sparkles, X } from "lucide-react";
import { WELCOME_SEEN_KEY, shouldShowWelcome } from "./welcome-guide";
import { safeGet, safeSet } from "./storage";

/**
 * 首访欢迎卡（2026-11-18，用户反馈：功能太多看不懂）。
 *
 * 首次进入社区/个人类页面时弹一次：这个站是什么 → 除了答题还能玩什么 →
 * 社区怎么用。看过就记住（localStorage），永不重复打扰。
 *
 * 打扰纪律（welcome-guide.ts 的纯逻辑守门）：
 *  - 问卷填写中（/s/{id}）永不弹——Telegram 链接进来的新用户第一屏必须是问卷本身；
 *  - 自动化环境（Playwright）不弹，截图基线不受影响。
 */
export function WelcomeGuide() {
  const visible = shouldShowWelcome({
    pathname: window.location.pathname,
    seen: safeGet(WELCOME_SEEN_KEY) !== null,
    isAutomation: navigator.webdriver === true,
  });
  const [dismissed, setDismissed] = useState(false);
  if (!visible || dismissed) return null;
  const dismiss = () => {
    safeSet(WELCOME_SEEN_KEY, "1");
    setDismissed(true);
  };
  return (
    <div className="fixed inset-0 z-50">
      <button aria-label="关闭欢迎卡" className="absolute inset-0 bg-black/40" onClick={dismiss} />
      <div className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-[var(--survey-card-border)] bg-[var(--survey-card-bg)] p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-[0_-12px_40px_-16px_rgba(15,23,42,.3)]">
        <div className="flex items-center justify-between">
          <span className="text-[16px] font-semibold text-[var(--survey-heading)]">第一次来？30 秒看完</span>
          <button type="button" className="survey-icon-btn h-8 w-8" aria-label="关闭" onClick={dismiss}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="mt-4 space-y-3">
          <li className="flex items-start gap-3">
            <span className="survey-icon-btn h-9 w-9 shrink-0" aria-hidden="true">
              <ClipboardList className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-[var(--survey-heading)]">答题就出报告</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--survey-muted)]">
                挑一份问卷直接填，不用注册，答完生成一份为你写的解读报告。
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="survey-icon-btn h-9 w-9 shrink-0" aria-hidden="true">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-[var(--survey-heading)]">还能玩和攒奖励</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--survey-muted)]">
                小游戏挑战、每日签到攒金币、抽随机报告，都在底部导航里。
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="survey-icon-btn h-9 w-9 shrink-0" aria-hidden="true">
              <Images className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-[var(--survey-heading)]">有社区，也可以安静看</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--survey-muted)]">
                广场是匿名树洞，纸条能抽到同路人聊天；只想看就不用发言。每页右上角的 ？ 都有说明。
              </p>
            </div>
          </li>
        </ul>
        <div className="mt-4 flex items-center gap-2.5">
          <a href="/s" className="btn btn-primary h-11 flex-1" onClick={dismiss}>
            <span className="inline-flex items-center gap-1.5">
              <ClipboardList className="h-4 w-4" aria-hidden="true" />
              去填一份问卷
            </span>
          </a>
          <button type="button" className="btn btn-ghost h-11 shrink-0" onClick={dismiss} aria-label="知道了，稍后再看">
            <span className="inline-flex items-center gap-1 text-[13px]">
              知道了
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </button>
        </div>
        <p className="mt-2 flex items-center gap-1 text-[11px] text-[var(--survey-muted)]" aria-hidden="true">
          <Mail className="h-3 w-3" />
          有疑问随时点每页右上角的 ？ 图标
        </p>
      </div>
    </div>
  );
}
