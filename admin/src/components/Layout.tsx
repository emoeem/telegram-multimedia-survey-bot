import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  ClipboardList,
  Coins,
  Contact,
  FileDown,
  FileUp,
  LayoutDashboard,
  ListChecks,
  Menu,
  MoreHorizontal,
  Package,
  Palette,
  Target,
  KeyRound,
  ScrollText,
  Trash2,
  Settings,
  ServerCog,
  Sprout,
  Images,
  Inbox,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";
import { fetchAdminSession, fetchDeploymentInfo, fetchEnvironment } from "../api";
import { getTelegramInitData } from "../telegram";
import { TestBanner } from "./TestBanner";
import { ErrorBoundary } from "./ErrorBoundary";

type NavItem = { to: string; icon: LucideIcon; label: string };
type NavGroup = {
  label: string;
  items: NavItem[];
  /** Renders a disclosure button instead of a static label (lg and up only). */
  collapsible?: boolean;
  /** Starts folded. Only used when `collapsible` is set. */
  defaultCollapsed?: boolean;
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "工作台",
    items: [
      { to: "/", icon: LayoutDashboard, label: "总览" },
      { to: "/surveys", icon: ClipboardList, label: "问卷" },
      { to: "/categories", icon: Tags, label: "分类" },
      { to: "/responses", icon: ListChecks, label: "答卷动态" },
      { to: "/imports", icon: FileUp, label: "导入" },
      { to: "/exports", icon: FileDown, label: "导出" },
    ],
  },
  {
    label: "内容",
    // Collapsible but expanded by default: this is the daily working set.
    // On a short screen (1280x800) folding it is the escape hatch that brings
    // the sidebar back under the fold — see COLLAPSE_STORAGE_KEY below.
    collapsible: true,
    items: [
      { to: "/coin-economy", icon: Coins, label: "金币经济" },
      { to: "/web-submissions", icon: Inbox, label: "网页投稿" },
      { to: "/users", icon: Users, label: "用户" },
      { to: "/reports", icon: Package, label: "报告" },
      { to: "/templates", icon: Palette, label: "模板" },
      { to: "/cert-content", icon: BadgeCheck, label: "认证卡内容" },
    ],
  },
  {
    label: "社区",
    items: [
      { to: "/plaza", icon: Sprout, label: "树洞" },
      { to: "/profile-gallery", icon: Contact, label: "个人画廊" },
      { to: "/showcase", icon: Images, label: "展示区" },
      // Renamed from 挑战任务: the footer's /trial link carries the same label,
      // and the two point at different pages (this one is the 任务包 admin, the
      // footer one is the public 挑战 page). The page title here is 挑战任务包.
      { to: "/task-packs", icon: Target, label: "任务包" },
    ],
  },
  {
    label: "系统",
    // Folded by default: it is the least-used group and it is exactly the one
    // that got pushed below the fold on a 900px-tall window.
    collapsible: true,
    defaultCollapsed: true,
    items: [
      { to: "/audit", icon: ScrollText, label: "审计" },
      { to: "/trash", icon: Trash2, label: "回收站" },
      { to: "/licenses", icon: KeyRound, label: "授权" },
      { to: "/control", icon: ServerCog, label: "控制中心" },
      { to: "/settings", icon: Settings, label: "设置" },
    ],
  },
];

const COLLAPSE_STORAGE_KEY = "admin:nav-collapsed";

function readCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const collapsed: Record<string, boolean> = {};
    for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") collapsed[label] = value;
    }
    return collapsed;
  } catch {
    // Corrupt JSON or storage disabled: fall back to the per-group defaults.
    return {};
  }
}

function writeCollapsedGroups(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota exceeded or private mode: folding still works for this session.
    return;
  }
}

// `sm`/`lg` are Tailwind's 640px/1000px boundaries; the icon rail lives between
// them. Read the same numbers here so the disclosure button is only rendered
// where its label is actually visible.
const RAIL_QUERY = "(min-width: 640px) and (max-width: 999px)";

/**
 * 「矮窗口」：nav 装不下时，把后两组收进「更多」面板。
 *
 * 不是按宽度定的——iPad 横屏是 1024 宽，早就进了 lg（带文字的完整侧栏），
 * 照样装不下：实测内容 777px、可视 570px，溢出 207px。所以判据是高度，
 * 两档阈值都是量出来的。条目数随角色与部署变化（完整管理端 19 项、未接入
 * 授权中心 17 项、创作者 3 项），下面是 17 项时的实测值——更多的项只会更早触发：
 *
 *  - 精细指针（鼠标，每行 40px）：内容 669px，900px 高可用 702px（余 33）、
 *    800px 高只剩 574px（溢出 95）—— 阈值取 860。
 *  - 粗指针（触屏，每行 44px）：内容 777px，加非 nav 部分约 198px 共 975px
 *    —— 阈值取 1000。
 *
 * 逗号分隔即「或」：两种条件任一成立就启用紧凑模式。
 */
const COMPACT_NAV_QUERY =
  "(min-width: 640px) and (max-height: 860px), (min-width: 640px) and (pointer: coarse) and (max-height: 1000px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function isActivePath(itemPath: string, pathname: string): boolean {
  return itemPath === "/" ? pathname === "/" : pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}

/**
 * A creator trial only ever authors its own surveys, so the shell shows it just
 * the survey workspace (editor and response pages live under /surveys). Every
 * other page is admin-only and the API refuses it anyway.
 */
const CREATOR_NAV_TARGETS = new Set(["/", "/surveys", "/responses"]);

/** Survey-detail routes live under these prefixes, so they stay reachable. */
function isCreatorAllowedPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === "/" || normalized.startsWith("/surveys") || normalized.startsWith("/responses");
}

function BrandMark() {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-950/40">
      <ListChecks className="h-5 w-5" />
    </span>
  );
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [environment, setEnvironment] = useState<string | null>(null);
  // Starts hidden: a customer instance must never briefly advertise a console it
  // cannot use. The vendor's link appears as soon as the role is confirmed.
  const [licenseCenter, setLicenseCenter] = useState(false);
  // Defaults to the full admin navigation: if the session probe fails we must
  // never lock a real admin out of pages only they can use.
  const [isCreator, setIsCreator] = useState(false);

  useEffect(() => {
    fetchEnvironment().then(setEnvironment);
    fetchDeploymentInfo().then((info) => {
      if (info) setLicenseCenter(info.licenseCenter);
    });
    fetchAdminSession().then((info) => {
      if (info?.role === "creator") setIsCreator(true);
    });
  }, []);

  const navGroups = useMemo(() => {
    if (isCreator) {
      return NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => CREATOR_NAV_TARGETS.has(item.to)),
      })).filter((group) => group.items.length > 0);
    }
    if (licenseCenter) return NAV_GROUPS;
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.to !== "/licenses" && item.to !== "/control"),
    })).filter((group) => group.items.length > 0);
  }, [isCreator, licenseCenter]);

  const railMode = useMediaQuery(RAIL_QUERY);
  const compactNav = useMediaQuery(COMPACT_NAV_QUERY);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(readCollapsedGroups);
  const [railMenuOpen, setRailMenuOpen] = useState(false);
  const railMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const railMenuRef = useRef<HTMLDivElement | null>(null);
  // 紧凑轨把「其余组 + 两个外部入口」收进一个面板。面板条目统一成同一形状，
  // 因为组内条目是路由（react-router Link），而两个快捷入口是开新标签的原生
  // <a>——混在一起渲染会让「问卷列表」丢掉 target=_blank。
  const railGroups = useMemo(() => {
    if (!compactNav) return { primary: navGroups, secondary: [] as NavGroup[] };
    return { primary: navGroups.slice(0, 2), secondary: navGroups.slice(2) };
  }, [navGroups, compactNav]);
  const railMenuGroups = useMemo(() => {
    const groups = railGroups.secondary.map((group) => ({
      label: group.label,
      items: group.items.map((item) => ({
        key: item.to,
        label: item.label,
        icon: item.icon,
        to: item.to,
        external: false,
      })),
    }));
    groups.push({
      label: "快捷入口",
      items: [
        ...(isCreator ? [] : [{ key: "/trial", label: "挑战任务", icon: Target, to: "/trial", external: true }]),
        { key: "/s", label: "问卷列表", icon: ClipboardList, to: "/s", external: true },
      ],
    });
    return groups;
  }, [isCreator, railGroups]);
  const railMenuActive = railMenuGroups.some((group) =>
    group.items.some((item) => !item.external && isActivePath(item.to, location.pathname)),
  );

  const setGroupCollapsed = (label: string, collapsed: boolean) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [label]: collapsed };
      writeCollapsedGroups(next);
      return next;
    });
  };

  // Navigating into a folded group opens it, so a deep link (or the "设置"
  // button in the header) never lands on a page whose own nav entry is hidden.
  // The stored value is updated too: the user asked for it to be reachable.
  const activeGroupLabels = useMemo(
    () =>
      navGroups
        .filter((group) => group.items.some((item) => isActivePath(item.to, location.pathname)))
        .map((group) => group.label),
    [navGroups, location.pathname],
  );

  useEffect(() => {
    setCollapsedGroups((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const label of activeGroupLabels) {
        if (next[label] !== false) {
          next[label] = false;
          changed = true;
        }
      }
      if (!changed) return prev;
      writeCollapsedGroups(next);
      return next;
    });
  }, [activeGroupLabels]);

  useEffect(() => {
    if (!drawer) return undefined;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawer]);

  useEffect(() => {
    setDrawer(false);
  }, [location.pathname]);

  // 「更多」面板：Esc 关闭并把焦点还给触发器，点面板外关闭（面板是 absolute，
  // 靠 document 级 pointerdown 判断，不铺遮罩——遮罩会盖住正在看的页面）。
  useEffect(() => {
    if (!railMenuOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRailMenuOpen(false);
      railMenuButtonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (railMenuRef.current?.contains(target) || railMenuButtonRef.current?.contains(target)) return;
      setRailMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [railMenuOpen]);

  useEffect(() => {
    setRailMenuOpen(false);
  }, [location.pathname, compactNav]);

  // A creator trial that reaches an admin-only URL (bookmark, typed address) is
  // sent back to the survey workspace; the API refuses those pages anyway.
  useEffect(() => {
    if (isCreator && !isCreatorAllowedPath(location.pathname)) navigate("/");
  }, [isCreator, location.pathname, navigate]);

  const title = useMemo(() => {
    const path = location.pathname;
    if (/^\/surveys\/\d+\/responses\/\d+$/.test(path)) return "答卷详情";
    if (/^\/surveys\/\d+\/responses$/.test(path)) return "答卷";
    if (/^\/surveys\/\d+\/analytics$/.test(path)) return "统计";
    if (/^\/surveys\/\d+\/scene\/\d+$/.test(path)) return "场景编辑器";
    if (/^\/surveys\/\d+\/editor$/.test(path)) return "问卷编辑器";
    if (/^\/surveys\/\d+/.test(path)) return "问卷详情";
    if (path.startsWith("/surveys")) return "问卷";
    if (path.startsWith("/responses")) return "答卷动态";
    if (path.startsWith("/imports")) return "导入问卷";
    if (path.startsWith("/users")) return "用户目录";
    if (path.startsWith("/reports")) return "报告归档";
    if (path.startsWith("/templates")) return "报告模板";
    if (path.startsWith("/web-submissions")) return "网页投稿审核";
    if (path.startsWith("/plaza")) return "树洞";
    if (path.startsWith("/profile-gallery")) return "个人画廊";
    if (path.startsWith("/showcase")) return "展示区";
    if (path.startsWith("/task-packs")) return "挑战任务包";
    if (path.startsWith("/audit")) return "审计日志";
    if (path.startsWith("/trash")) return "回收站";
    if (path.startsWith("/licenses")) return "授权管理";
    if (path.startsWith("/control")) return "控制中心";
    if (path.startsWith("/login")) return "浏览器登录";
    if (path.startsWith("/settings")) return "系统设置";
    return "总览";
  }, [location.pathname]);

  const showTestBanner = environment === "development" && !getTelegramInitData();
  // The admin app is mounted under /admin, so the login route is
  // "/admin/login" — checking "/login" showed this banner on the login page
  // itself, telling people to go where they already were.
  const browserMode = !getTelegramInitData() && !location.pathname.endsWith("/login");
  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  const isNestedSurveyPage = /^\/surveys\/\d+/.test(normalizedPath);
  const goBack = () => {
    const path = location.pathname;
    if (/^\/surveys\/\d+\/responses\/\d+$/.test(path)) {
      navigate(path.replace(/\/responses\/\d+$/, "/responses"));
      return;
    }
    if (/^\/surveys\/\d+\/(editor|analytics|responses)$/.test(path)) {
      navigate(path.replace(/\/(editor|analytics|responses)$/, ""));
      return;
    }
    if (/^\/surveys\/\d+\//.test(path)) {
      navigate("/surveys");
      return;
    }
    if (path.startsWith("/profile-gallery") || path.startsWith("/plaza") || path.startsWith("/showcase")) {
      navigate("/");
      return;
    }
    if (path.startsWith("/task-packs")) {
      navigate("/");
      return;
    }
    if (path !== "/") navigate("/");
  };

  return (
    <div className="admin-shell flex min-h-dvh flex-col bg-page">
      <div className="flex flex-1">
        <aside
          // `sm:static` let the sidebar stretch with the page: on the dashboard
          // the flex row grew to 1118px inside a 900px window, so the footer's
          // shortcuts and the environment line sat below the fold and no amount
          // of nav sizing could bring them back. Sticky + viewport height makes
          // the sidebar a fixed frame whose nav is the only scrolling part.
          className={`admin-sidebar fixed inset-y-0 left-0 z-30 flex w-64 -translate-x-full flex-col bg-sidebar px-4 py-5 text-slate-300 transition-transform duration-200 sm:sticky sm:top-0 sm:h-dvh sm:translate-x-0 sm:self-start sm:w-16 sm:px-2 lg:w-64 lg:px-4 ${
            drawer ? "translate-x-0" : ""
          }`}
        >
          <div className="admin-brand mb-4 flex items-center gap-2.5 whitespace-nowrap px-1.5">
            <BrandMark />
            <span className="text-[15px] font-bold tracking-tight text-white sm:hidden lg:inline">问卷管理后台</span>
          </div>
          <nav className="admin-nav flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain pr-1">
            {railGroups.primary.map((group) => {
              // The icon rail hides every label, so a disclosure button there
              // would be a nameless chevron: rail mode always shows the items.
              const foldable = Boolean(group.collapsible) && !railMode;
              const collapsed = foldable ? (collapsedGroups[group.label] ?? Boolean(group.defaultCollapsed)) : false;
              const itemsId = `nav-group-${group.label}`;
              return (
                <div key={group.label} className={`admin-nav-group${collapsed ? " is-collapsed" : ""}`}>
                  {foldable ? (
                    <button
                      type="button"
                      className="admin-nav-toggle"
                      aria-expanded={!collapsed}
                      aria-controls={itemsId}
                      title={`${collapsed ? "展开" : "收起"}${group.label}`}
                      onClick={() => setGroupCollapsed(group.label, !collapsed)}
                    >
                      <span>{group.label}</span>
                      <ChevronDown className="admin-nav-caret" aria-hidden="true" />
                    </button>
                  ) : (
                    <p className="admin-nav-label">{group.label}</p>
                  )}
                  {/* `display:none` rather than the `hidden` attribute: a Tailwind
                    `flex` class on the same element outranks the UA `[hidden]`
                    rule. display:none also drops the links from the tab order. */}
                  <div
                    id={itemsId}
                    className="flex flex-col gap-px"
                    style={collapsed ? { display: "none" } : undefined}
                  >
                    {group.items.map((item) => {
                      const active = isActivePath(item.to, location.pathname);
                      const Icon = item.icon;
                      return (
                        <Link
                          key={item.to}
                          to={item.to}
                          // The icon rail (640–999px) hides `.admin-nav-label`
                          // and every item's text, and these links carried no
                          // accessible name at all — on an iPad in portrait the
                          // sidebar was 19 anonymous icons for both sighted and
                          // screen-reader users. `title` gives the mouse a
                          // tooltip, `aria-label` gives assistive tech the name.
                          title={item.label}
                          aria-label={item.label}
                          aria-current={active ? "page" : undefined}
                          className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors sm:justify-center lg:justify-start ${
                            active
                              ? "bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] text-white"
                              : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                          }`}
                        >
                          {active ? (
                            <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-[var(--color-primary)]" />
                          ) : null}
                          <Icon className="h-[18px] w-[18px] shrink-0" />
                          <span className="sm:hidden lg:inline">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>
          {compactNav ? (
            <button
              ref={railMenuButtonRef}
              type="button"
              aria-expanded={railMenuOpen}
              aria-controls="admin-rail-more"
              aria-label="更多"
              title="更多"
              onClick={() => setRailMenuOpen((open) => !open)}
              className={`admin-rail-more mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors sm:justify-center lg:justify-start ${
                railMenuOpen || railMenuActive
                  ? "bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] text-white"
                  : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
              }`}
            >
              <MoreHorizontal className="h-[18px] w-[18px] shrink-0" />
            </button>
          ) : null}
          {compactNav && railMenuOpen ? (
            <div
              id="admin-rail-more"
              ref={railMenuRef}
              className="absolute left-full top-0 z-40 flex h-full w-60 flex-col gap-3 overflow-y-auto overscroll-contain bg-sidebar px-3 py-5 shadow-2xl ring-1 ring-white/10"
            >
              {railMenuGroups.map((group) => (
                <div key={group.label}>
                  <p className="admin-nav-label">{group.label}</p>
                  <div className="mt-0.5 flex flex-col gap-px">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const active = !item.external && isActivePath(item.to, location.pathname);
                      const className = `admin-rail-more-item flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] text-white"
                          : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                      }`;
                      if (item.external) {
                        return (
                          <a
                            key={item.key}
                            href={item.to}
                            target="_blank"
                            rel="noreferrer"
                            className={className}
                            onClick={() => setRailMenuOpen(false)}
                          >
                            <Icon className="h-[18px] w-[18px] shrink-0" />
                            <span>{item.label}</span>
                            <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60" />
                          </a>
                        );
                      }
                      return (
                        <Link
                          key={item.key}
                          to={item.to}
                          className={className}
                          aria-current={active ? "page" : undefined}
                          onClick={() => setRailMenuOpen(false)}
                        >
                          <Icon className="h-[18px] w-[18px] shrink-0" />
                          <span>{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {compactNav ? null : (
            <div className="mt-3 border-t border-white/5 pt-2.5">
              {/* No 线上体验 caption: the divider above already separates these
                two shortcuts, and the caption cost 28px of a 900px window. */}
              <div className="flex flex-col gap-0.5">
                {/* 打开树洞 / 打开展示区 used to live here pointing at /plaza and
                  /showcase — the exact URLs the 社区 group already links to, so
                  the footer only offered a second way to the same two pages.
                  The community group is the single entry point now. */}
                {isCreator ? null : (
                  <a
                    href="/trial"
                    target="_blank"
                    rel="noreferrer"
                    title="挑战任务"
                    aria-label="挑战任务"
                    className="group flex items-center gap-3 rounded-xl px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center lg:justify-start"
                  >
                    <Target className="h-[18px] w-[18px] shrink-0" />
                    <span className="sm:hidden lg:inline">挑战任务</span>
                    <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60 sm:hidden lg:inline" />
                  </a>
                )}
                <a
                  href="/s"
                  target="_blank"
                  rel="noreferrer"
                  title="问卷列表"
                  aria-label="问卷列表"
                  className="group flex items-center gap-3 rounded-xl px-3 py-1.5 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center lg:justify-start"
                >
                  <ClipboardList className="h-[18px] w-[18px] shrink-0" />
                  <span className="sm:hidden lg:inline">问卷列表</span>
                  <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60 sm:hidden lg:inline" />
                </a>
              </div>
            </div>
          )}
          {/* Only the phone drawer needs this: from 640px up the header's
              `.admin-env-pill` already shows the same string, and at 1000px+
              the duplicate cost 29px of a 900px window. */}
          <div className="mt-3 px-1.5 text-[11px] text-slate-300 sm:hidden">
            {environment === "production" ? "生产环境" : environment ? "开发 / 预发布环境" : "…"}
          </div>
        </aside>
        {drawer ? (
          <button
            aria-label="关闭菜单"
            className="fixed inset-0 z-20 bg-slate-900/50 backdrop-blur-[2px] sm:hidden"
            onClick={() => setDrawer(false)}
          />
        ) : null}
        <main className="admin-main mx-auto w-full min-w-0 flex-1 p-4 sm:p-8">
          {/* The notices sit inside the content column, not above the flex row.
              Above the row they pushed the sidebar 33px down, so a
              `sticky top-0 h-dvh` sidebar hung 33px past the bottom of the
              window — the environment line was clipped and no nav sizing could
              fix it. `.admin-notices` re-breaks them out of <main>'s padding;
              that padding is 14px !important below 720px, so a Tailwind
              `-mx-4` (16px) overflowed a 390px screen by 2px. */}
          {/* Rendered only when a notice exists: an empty wrapper still applies
              its -32px top margin, which shifted the header up inside Telegram
              where neither banner is shown. */}
          {showTestBanner || browserMode ? (
            <div className="admin-notices">
              <TestBanner visible={showTestBanner} />
              {browserMode ? (
                <div className="browser-mode-banner flex flex-wrap items-center justify-center gap-2 border-b border-[color-mix(in_srgb,var(--color-primary)_20%,var(--surface))] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] px-4 py-2 text-center text-xs text-[var(--color-primary)]">
                  <span>浏览器访问模式：使用管理员密码登录</span>
                  <Link to="/login" className="link">
                    去登录
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
          <header className="admin-content-header">
            <div className="admin-content-header-inner">
              <button
                aria-label="打开菜单"
                className="btn btn-icon sm:hidden shrink-0"
                onClick={() => setDrawer(!drawer)}
              >
                <Menu className="h-5 w-5" />
              </button>
              <button
                aria-label="返回上一页"
                title="返回上一页"
                onClick={goBack}
                className="btn btn-icon shrink-0"
                style={{ display: isNestedSurveyPage ? undefined : "none" }}
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="admin-breadcrumb">
                  <span className="hidden sm:inline">管理后台</span>
                  <span className="hidden sm:inline">/</span>
                  <strong className="truncate">{title}</strong>
                </div>
              </div>
              {environment ? (
                <span className="admin-env-pill hidden sm:inline-flex">
                  {environment === "production" ? "生产环境" : environment}
                </span>
              ) : null}
              {isCreator ? null : (
                <button
                  className="btn btn-sm hidden sm:inline-flex"
                  onClick={() => navigate("/settings")}
                  title="系统设置"
                >
                  <Settings className="h-4 w-4" />
                  设置
                </button>
              )}
            </div>
          </header>
          {/* Scoped to the route: a render error on one page used to replace
              the whole shell (sidebar, navigation and an editor's unsaved
              state included). Re-keyed by path so navigating away resets it. */}
          <ErrorBoundary key={location.pathname} scope="route">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
