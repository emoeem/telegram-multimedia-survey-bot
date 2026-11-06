import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  BadgeCheck,
  ClipboardList,
  Coins,
  Contact,
  FileUp,
  LayoutDashboard,
  ListChecks,
  Menu,
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
// 工作区数据源（2026-11-07 T2）：图标轨、tab 条与 Dashboard 功能地图共用
// admin/src/workspaces.ts 的同一份 WORKSPACES——纯数据模块不依赖 lucide-react，
// 图标以字符串键存储，在这里映射成组件；两层的完整说明见该模块头注释。
import { WORKSPACES, tabNumberOf, type WorkspaceIconKey } from "../workspaces";
import { TestBanner } from "./TestBanner";
import { ErrorBoundary } from "./ErrorBoundary";

/** workspaces.ts 的图标键 → lucide 组件。Record 全键覆盖：加新键时这里漏了会直接 tsc 报错。 */
const ICONS: Record<WorkspaceIconKey, LucideIcon> = {
  badgeCheck: BadgeCheck,
  clipboardList: ClipboardList,
  coins: Coins,
  contact: Contact,
  fileUp: FileUp,
  images: Images,
  inbox: Inbox,
  keyRound: KeyRound,
  listChecks: ListChecks,
  package: Package,
  palette: Palette,
  scrollText: ScrollText,
  serverCog: ServerCog,
  settings: Settings,
  sprout: Sprout,
  tags: Tags,
  target: Target,
  trash2: Trash2,
  users: Users,
};

/** 沉浸创作态：整宽渲染，图标轨与子导航都隐藏（顶栏返回按钮负责退出）。 */
const IMMERSIVE_PATH = /\/surveys\/\d+\/(editor|scene\/\d+)$/;

function workspaceIdOf(pathname: string): string | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  for (const workspace of WORKSPACES) {
    if (workspace.tabs.some((item) => isActivePath(item.to, normalized))) return workspace.id;
  }
  // 问卷详情子页（详情/编辑/答卷/统计/版本/场景）归属问卷工作区。
  if (/^\/surveys\/\d+/.test(normalized)) return "surveys";
  return null;
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

  // 角色过滤平移到工作区模型：creator 只见问卷工作区（+总览）；未接入
  // 授权中心的部署隐藏「授权/控制中心」两个 tab。
  const workspaces = useMemo(() => {
    if (isCreator) {
      return WORKSPACES.map((workspace) =>
        workspace.id === "surveys"
          ? { ...workspace, tabs: workspace.tabs.filter((item) => item.to !== "/imports" && item.to !== "/categories") }
          : workspace,
      );
    }
    if (licenseCenter) return WORKSPACES;
    return WORKSPACES.map((workspace) =>
      workspace.id === "system"
        ? { ...workspace, tabs: workspace.tabs.filter((item) => item.to !== "/licenses" && item.to !== "/control") }
        : workspace,
    );
  }, [isCreator, licenseCenter]);

  const activeWorkspaceId = workspaceIdOf(location.pathname);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  // 沉浸创作态：编辑器/场景编辑器整宽渲染，图标轨与子导航都不出现。
  const immersive = IMMERSIVE_PATH.test(location.pathname.replace(/\/+$/, ""));

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
    if (path.startsWith("/task-packs")) return "小游戏管理";
    if (path.startsWith("/media-library")) return "素材库";
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
    <div className={`admin-shell flex min-h-dvh flex-col bg-page${immersive ? " is-immersive" : ""}`}>
      <div className="flex flex-1">
        <aside
          /* 工作区图标轨（2026-10-31）：桌面常驻 56px，只放工作区图标——
           * 点哪个进哪个的「工作区」，子导航出现在主区域顶部。
           * <640px 保持抽屉：抽屉里列工作区（带说明），选完进工作区、
           * 用页面顶部的子导航条切换。 */
          className={`admin-sidebar fixed inset-y-0 left-0 z-30 flex w-56 -translate-x-full flex-col bg-sidebar px-3 py-4 text-slate-300 transition-transform duration-200 sm:sticky sm:top-0 sm:h-dvh sm:translate-x-0 sm:self-start sm:w-14 sm:px-1.5 ${
            drawer ? "translate-x-0" : ""
          }`}
        >
          <div className="admin-brand mb-4 flex items-center justify-center whitespace-nowrap px-1">
            <Link to="/" aria-label="回到总览" title="总览">
              <BrandMark />
            </Link>
          </div>
          <nav
            className="admin-nav flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overscroll-contain py-1"
            aria-label="工作区"
          >
            {workspaces.map((workspace) => {
              const Icon = ICONS[workspace.icon];
              const active = activeWorkspaceId === workspace.id;
              return (
                <Link
                  key={workspace.id}
                  to={workspace.entry}
                  title={`${workspace.order} · ${workspace.label} · ${workspace.hint}`}
                  aria-label={workspace.label}
                  aria-current={active ? "page" : undefined}
                  className={`admin-rail-icon group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors sm:justify-center sm:px-0 ${
                    active
                      ? "bg-[color-mix(in_srgb,var(--color-primary)_15%,transparent)] text-white"
                      : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                  }`}
                >
                  {active ? (
                    <span className="absolute left-0 top-1/2 hidden h-7 w-1 -translate-y-1/2 rounded-r-full bg-[var(--color-primary)] sm:block" />
                  ) : null}
                  <Icon className="h-[19px] w-[19px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate sm:hidden">{workspace.label}</span>
                  <span className="hidden truncate text-[11px] font-normal text-slate-500 sm:hidden sm:block lg:hidden">
                    {workspace.hint}
                  </span>
                </Link>
              );
            })}
          </nav>
          <div className="mt-3 border-t border-white/5 pt-2.5">
            <div className="flex flex-col gap-0.5">
              {isCreator ? null : (
                <a
                  href="/trial"
                  target="_blank"
                  rel="noreferrer"
                  title="挑战任务（新标签打开）"
                  aria-label="挑战任务"
                  className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center sm:px-0"
                >
                  <Target className="h-[18px] w-[18px] shrink-0" />
                  <span className="sm:hidden">挑战任务</span>
                </a>
              )}
              <a
                href="/s"
                target="_blank"
                rel="noreferrer"
                title="问卷列表（新标签打开）"
                aria-label="问卷列表"
                className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center sm:px-0"
              >
                <ClipboardList className="h-[18px] w-[18px] shrink-0" />
                <span className="sm:hidden">问卷列表</span>
              </a>
            </div>
          </div>
          {/* Only the phone drawer needs this: from 640px up the header's
              `.admin-env-pill` already shows the same string. */}
          <div className="mt-3 px-2 text-[11px] text-slate-300 sm:hidden">
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
          {/* 工作区子导航：进入工作区后主区域顶部的横向 tab 条——
              「点问卷这个分类，整个界面就不一样」。总览与沉浸创作态不出现。 */}
          {activeWorkspace && !immersive ? (
            <nav className="admin-workspace-tabs" aria-label={`${activeWorkspace.label}工作区`}>
              {activeWorkspace.tabs.map((item) => {
                const Icon = ICONS[item.icon];
                const active = isActivePath(item.to, location.pathname);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    className={`admin-workspace-tab${active ? " is-active" : ""}`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {/* 稳定编号（取自 workspaces.ts 的 order，角色过滤不漂移）：
                        与 Dashboard 功能地图互相指认，「去 1.4」口头可达。 */}
                    <span className="opacity-60">{tabNumberOf(activeWorkspace, item)}</span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          ) : null}
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
