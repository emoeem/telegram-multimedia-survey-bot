import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  ClipboardList,
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
  Settings,
  Sprout,
  Users,
} from "lucide-react";
import { fetchEnvironment } from "../api";
import { getTelegramInitData } from "../telegram";
import { TestBanner } from "./TestBanner";

const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, label: "总览" },
  { to: "/surveys", icon: ClipboardList, label: "问卷" },
  { to: "/responses", icon: ListChecks, label: "答卷动态" },
  { to: "/imports", icon: FileUp, label: "导入" },
  { to: "/users", icon: Users, label: "用户" },
  { to: "/reports", icon: Package, label: "报告" },
  { to: "/templates", icon: Palette, label: "模板" },
  { to: "/plaza", icon: Sprout, label: "树洞" },
  { to: "/profile-gallery", icon: Contact, label: "个人画廊" },
  { to: "/task-packs", icon: Target, label: "挑战任务" },
  { to: "/audit", icon: ScrollText, label: "审计" },
  { to: "/licenses", icon: KeyRound, label: "授权" },
  { to: "/settings", icon: Settings, label: "设置" },
];

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

  useEffect(() => {
    fetchEnvironment().then(setEnvironment);
  }, []);

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

  const title = useMemo(() => {
    const path = location.pathname;
    if (/^\/surveys\/\d+\/responses\/\d+$/.test(path)) return "答卷详情";
    if (/^\/surveys\/\d+\/responses$/.test(path)) return "答卷";
    if (/^\/surveys\/\d+\/analytics$/.test(path)) return "统计";
    if (/^\/surveys\/\d+\/editor$/.test(path)) return "问卷编辑器";
    if (/^\/surveys\/\d+/.test(path)) return "问卷详情";
    if (path.startsWith("/surveys")) return "问卷";
    if (path.startsWith("/responses")) return "答卷动态";
    if (path.startsWith("/imports")) return "导入问卷";
    if (path.startsWith("/users")) return "用户目录";
    if (path.startsWith("/reports")) return "报告归档";
    if (path.startsWith("/templates")) return "报告模板";
    if (path.startsWith("/plaza")) return "树洞";
    if (path.startsWith("/profile-gallery")) return "个人画廊";
    if (path.startsWith("/task-packs")) return "挑战任务包";
    if (path.startsWith("/audit")) return "审计日志";
    if (path.startsWith("/licenses")) return "授权管理";
    if (path.startsWith("/login")) return "浏览器登录";
    if (path.startsWith("/settings")) return "系统设置";
    return "总览";
  }, [location.pathname]);

  const showTestBanner = environment === "development" && !getTelegramInitData();
  const browserMode = !getTelegramInitData() && !location.pathname.startsWith("/login");
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
    if (path.startsWith("/profile-gallery") || path.startsWith("/plaza")) {
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
    <div className="flex min-h-dvh flex-col bg-page">
      <TestBanner visible={showTestBanner} />
      {browserMode ? (
        <div className="flex flex-wrap items-center justify-center gap-2 border-b border-[color-mix(in_srgb,var(--color-primary)_20%,var(--surface))] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--surface))] px-4 py-2 text-center text-xs text-[var(--color-primary)]">
          <span>浏览器访问模式：在 Telegram 发送 /admin_login 获取电脑登录链接</span>
          <Link to="/login" className="link">
            去登录
          </Link>
        </div>
      ) : null}
      <div className="flex flex-1">
        <aside
          className={`fixed inset-y-0 left-0 z-30 flex w-64 -translate-x-full flex-col bg-sidebar px-4 py-5 text-slate-300 transition-transform duration-200 sm:static sm:translate-x-0 sm:w-16 sm:px-2 lg:w-64 lg:px-4 ${
            drawer ? "translate-x-0" : ""
          }`}
        >
          <div className="mb-7 flex items-center gap-2.5 whitespace-nowrap px-1.5">
            <BrandMark />
            <span className="text-[15px] font-bold tracking-tight text-white sm:hidden lg:inline">问卷管理后台</span>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5">
            {NAV_ITEMS.map((item) => {
              const active =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.to}
                  to={item.to}
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
          </nav>
          <div className="mt-4 border-t border-white/5 pt-3">
            <p className="mb-2 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:hidden lg:block">
              线上体验
            </p>
            <div className="flex flex-col gap-0.5">
              <a
                href="/plaza"
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center lg:justify-start"
              >
                <Sprout className="h-[18px] w-[18px] shrink-0" />
                <span className="sm:hidden lg:inline">打开树洞</span>
                <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60 sm:hidden lg:inline" />
              </a>
              <a
                href="/trial"
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center lg:justify-start"
              >
                <Target className="h-[18px] w-[18px] shrink-0" />
                <span className="sm:hidden lg:inline">挑战任务</span>
                <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60 sm:hidden lg:inline" />
              </a>
              <a
                href="/s"
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-sidebar-hover hover:text-white sm:justify-center lg:justify-start"
              >
                <ClipboardList className="h-[18px] w-[18px] shrink-0" />
                <span className="sm:hidden lg:inline">问卷列表</span>
                <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-60 sm:hidden lg:inline" />
              </a>
            </div>
          </div>
          <div className="mt-4 px-1.5 text-[11px] text-slate-500 sm:hidden lg:block">
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
        <main className="mx-auto w-full min-w-0 max-w-[1320px] flex-1 p-4 sm:p-8">
          <header className="mb-7 flex items-center gap-3">
            <button aria-label="返回上一页" title="返回上一页" onClick={goBack} className="btn btn-icon">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <button aria-label="打开菜单" className="btn btn-icon sm:hidden" onClick={() => setDrawer(!drawer)}>
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="m-0 text-xl font-bold tracking-tight sm:text-[26px]">{title}</h1>
          </header>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
