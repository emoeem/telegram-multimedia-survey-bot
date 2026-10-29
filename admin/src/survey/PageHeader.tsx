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
  topNav = true,
  wide = true,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
  backHref?: string;
  backLabel?: string;
  /**
   * 桌面端是否给主导航（BottomNav 在 ≥lg 是 fixed top-0 高 56px）让位。
   * 广场/展示区/纸条这些带主导航的页面用默认 true；**投稿中心这类不渲染
   * BottomNav 的页面必须传 false**——否则顶栏悬在 56px 之下，上面露出一条
   * 没有任何遮挡的缝，表单内容从缝里穿过（线上反馈的「顶栏悬浮、中间缺
   * 一块」就是它）。
   */
  topNav?: boolean;
  /** 内容列宽：wide = 站点级 1200px 居中列；false = 与 max-w-3xl 的表单列对齐。 */
  wide?: boolean;
}) {
  return (
    <header
      className={`sticky top-0 z-30 border-b border-[var(--survey-card-border)] bg-[var(--survey-header-bg)] backdrop-blur-md ${
        topNav ? "lg:top-14" : "lg:top-0"
      }`}
    >
      {/* 容器：移动 max-w-xl（拇指热区），桌面默认与 foxsir 同款 1200px 居中列。 */}
      <div
        className={`mx-auto max-w-xl px-4 pb-2.5 pt-[calc(env(safe-area-inset-top,0px)+10px)] ${
          wide ? "lg:max-w-[1200px]" : "lg:max-w-3xl"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <a href={backHref} className="survey-home-link" aria-label={`返回${backLabel}`} title={`返回${backLabel}`}>
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={2.5} />
            <span>{backLabel}</span>
          </a>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold text-[var(--survey-heading)] lg:font-[family-name:var(--fx-font-serif)] lg:text-[17px] lg:tracking-[0.04em]">
              {title}
            </p>
            {subtitle ? <p className="mt-0.5 truncate text-[11px] text-[var(--survey-muted)]">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </div>
        {tabs ? <div className="mt-2.5 flex gap-1.5 pb-0.5">{tabs}</div> : null}
      </div>
    </header>
  );
}
