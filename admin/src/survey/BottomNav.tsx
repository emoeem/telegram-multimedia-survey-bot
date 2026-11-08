import { useEffect, useState } from "react";
import { BadgeCheck, ClipboardList, Images, Sparkles, Sprout, UserRound } from "lucide-react";
import { fetchUnreadCount, NOTIFICATIONS_SEEN_EVENT } from "./api";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Sprout;
  pathStartsWith: string[];
  /** 未读角标（T2 · G4）：目前只有「我的」入口挂站内通知未读数。 */
  badge?: "notifications";
};

const ITEMS: NavItem[] = [
  { href: "/s", label: "问卷", icon: ClipboardList, pathStartsWith: ["/s"] },
  { href: "/trial", label: "小游戏", icon: Sparkles, pathStartsWith: ["/trial"] },
  { href: "/plaza", label: "广场", icon: Sprout, pathStartsWith: ["/plaza"] },
  { href: "/showcase", label: "展示", icon: Images, pathStartsWith: ["/showcase"] },
  /* 认证卡生成器（/cert）：它一直是能用的独立页，却没有出现在任何导航里 ——
   * 用户只能靠记住 URL 才进得去，观感上就是「没并进来」。放进全局导航后，
   * 它和问卷、挑战、广场、展示、我的一样是一等入口。 */
  { href: "/cert/", label: "认证卡", icon: BadgeCheck, pathStartsWith: ["/cert"] },
  { href: "/me", label: "我的", icon: UserRound, pathStartsWith: ["/me"], badge: "notifications" },
];

function isActive(item: NavItem, path: string): boolean {
  return item.pathStartsWith.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * 全局主导航。
 *
 * 移动端（<lg）：底部固定玻璃栏，图标在上文字在下，44px 触达。
 * 桌面（≥lg）：foxsir 式顶部固定栏，图标与文字同行；高度钉死 56px
 * （lg:h-14），PageHeader 的 lg:top-14 和 index.css 给 body 加的透明
 * border-top 都依赖这个确定值。active 态只动颜色和底色，不动布局。
 */
export function BottomNav() {
  const path = window.location.pathname;
  // 移动端滚动方向感知隐匿：向下滚收起、向上滚或近底部浮出；桌面顶栏不受影响。
  // 隐匿与 inert 都必须按视口门控（lg=62.5rem 与 Tailwind 断点一致），否则
  // 桌面上滚动会把可见的顶栏一起禁用。
  const [mobile, setMobile] = useState(
    () => typeof window === "undefined" || !window.matchMedia("(min-width: 1000px)").matches,
  );
  const [scrolledAway, setScrolledAway] = useState(false);
  // 未读角标（T2 · G4）：站内通知未读数常驻「我的」入口。成本红线——严禁
  // 定时轮询（本文件不出现任何定时器调用），只在四个离散事件上拉取：
  // ① 挂载（应用按 pathname 整页路由、导航即整页重载，重挂载天然覆盖 pathname
  //    导航变化）；
  // ② popstate 且 pathname 变化（回退/前进等同文档历史导航）；
  // ③ visibilitychange 回前台（离开期间可能积了新通知）；
  // ④ POST /api/me/notifications/seen 成功后 api.ts 派发的
  //    me:notifications-seen 事件（打开通知页清零后角标立即跟随）。
  // 请求频控由服务端 60s KV 边缘缓存兜底（GET /api/me/notifications/unread-count）。
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let lastPath = window.location.pathname;
    const refresh = () => {
      // 瞬时失败保留旧值（不清零误报「没有未读」），下一次离散事件再校正。
      fetchUnreadCount()
        .then((data) => setUnread(data.unread))
        .catch(() => undefined);
    };
    refresh();
    const onPop = () => {
      if (window.location.pathname === lastPath) return;
      lastPath = window.location.pathname;
      refresh();
    };
    const onVisibility = () => {
      if (document.hidden) return;
      lastPath = window.location.pathname;
      refresh();
    };
    window.addEventListener("popstate", onPop);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(NOTIFICATIONS_SEEN_EVENT, refresh);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(NOTIFICATIONS_SEEN_EVENT, refresh);
    };
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1000px)");
    const sync = () => setMobile(!mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const doc = document.scrollingElement;
      if (!doc) return;
      const y = window.scrollY;
      const delta = y - lastY;
      lastY = y;
      const nearBottom = doc.scrollHeight - y - window.innerHeight < 120;
      if (nearBottom) {
        setScrolledAway(false);
        return;
      }
      if (delta > 4 && y > 80) setScrolledAway(true);
      else if (delta < -4) setScrolledAway(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const hidden = scrolledAway && mobile;
  return (
    <nav
      data-hidden={hidden || undefined}
      inert={hidden || undefined}
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-[var(--survey-card-border)] bg-[color-mix(in_srgb,var(--survey-card-bg)_85%,transparent)] px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 backdrop-blur-xl transition-transform duration-200 ease-[var(--fx-ease)] lg:inset-x-auto lg:bottom-auto lg:top-0 lg:h-14 lg:w-full lg:border-b lg:border-t-0 lg:py-0 ${hidden ? "translate-y-full" : ""}`}
      style={{ WebkitBackdropFilter: "blur(12px)" }}
      aria-label="主导航"
    >
      <div className="mx-auto flex max-w-md items-center justify-around lg:h-14 lg:max-w-5xl lg:justify-center lg:gap-2">
        {ITEMS.map((item) => {
          const active = isActive(item, path);
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              className={`group flex min-w-0 flex-1 flex-col items-center gap-0.5 min-h-11 rounded-xl px-2 py-1.5 text-xs font-semibold transition-[color,background-color] duration-[var(--fx-dur-fast)] ease-[var(--fx-ease)] lg:min-h-0 lg:min-w-20 lg:flex-none lg:flex-row lg:gap-2 lg:px-4 lg:py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--survey-primary)] ${
                active
                  ? "text-[var(--survey-primary)]"
                  : "text-[var(--survey-muted)] hover:text-[var(--survey-heading)]"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <span
                className={`relative grid h-9 w-9 place-items-center rounded-xl transition-[background-color,transform] duration-[var(--fx-dur-fast)] ease-[var(--fx-ease)] lg:h-7 lg:w-7 ${
                  active ? "bg-[var(--survey-primary-soft)] scale-110 lg:scale-100" : ""
                }`}
              >
                <Icon className="h-5 w-5 lg:h-4 lg:w-4" strokeWidth={active ? 2.5 : 2} />
                {/* 未读角标：>99 收敛为 99+，避免撑破 44px 触达框。 */}
                {item.badge === "notifications" && unread > 0 ? (
                  <span
                    className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--app-danger)] px-1 text-[9px] font-bold leading-none text-white"
                    aria-label={`${unread} 条未读通知`}
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                ) : null}
              </span>
              <span className="transition-[transform] duration-[var(--fx-dur-fast)] ease-[var(--fx-ease)]">
                {item.label}
              </span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
