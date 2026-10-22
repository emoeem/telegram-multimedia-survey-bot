import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

/**
 * 公开页统一顶栏。
 *
 * 为什么要有它：/plaza 和 /submit 原来是各自手写的 header，前者只有标题和两个
 * 圆形图标按钮，后者干脆连 header 都没有（只有一个 h1），两个页面都**没有任何
 * 回主页的入口** —— 进去之后只能靠浏览器后退。这里把「← 首页 + 标题 + 副标题 +
 * 右侧操作 + 可选分段页签」做成一个共用组件，两页引同一份，视觉天然同体系。
 *
 * 触摸目标：`.survey-home-link` 在 index.css 里固定 44px 高，与既有的
 * `.survey-icon-btn` 同一套规则，满足移动端 44×44 的最小点击区。
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  tabs,
  backHref = "/",
  backLabel = "首页",
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md">
      <div className="mx-auto max-w-xl px-4 pb-2.5 pt-[calc(env(safe-area-inset-top,0px)+10px)] lg:max-w-3xl">
        <div className="flex items-center gap-2.5">
          <a
            href={backHref}
            className="survey-home-link"
            aria-label={`返回${backLabel}`}
            title={`返回${backLabel}`}
          >
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={2.5} />
            <span>{backLabel}</span>
          </a>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold text-[var(--survey-heading)]">{title}</p>
            {subtitle ? (
              <p className="mt-0.5 truncate text-[11px] text-[var(--survey-muted)]">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </div>
        {tabs ? <div className="mt-2.5 flex gap-1.5 pb-0.5">{tabs}</div> : null}
      </div>
    </header>
  );
}
