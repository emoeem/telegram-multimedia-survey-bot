import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { fetchEnvironment } from "../api";
import { telegramInitData } from "../telegram";
import { TestBanner } from "./TestBanner";

const NAV_ITEMS = [
  { to: "/", icon: "📊", label: "总览" },
  { to: "/surveys", icon: "📝", label: "问卷" },
];

const COMING_SOON_ITEMS = [
  { icon: "📥", label: "答卷" },
  { icon: "📈", label: "统计" },
  { icon: "🎨", label: "结果模板" },
  { icon: "👥", label: "用户" },
  { icon: "⚙️", label: "设置" },
];

export function Layout() {
  const location = useLocation();
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
    if (/^\/surveys\/\d+\/editor$/.test(path)) return "问卷编辑器";
    if (/^\/surveys\/\d+/.test(path)) return "问卷详情";
    if (path.startsWith("/surveys")) return "问卷";
    return "总览";
  }, [location.pathname]);

  const showTestBanner = environment === "development" && !telegramInitData;
  const isSurveysActive = location.pathname.startsWith("/surveys");

  return (
    <div className="flex min-h-screen flex-col">
      <TestBanner visible={showTestBanner} />
      <div className="flex flex-1">
        <aside
          className={`fixed inset-y-0 left-0 z-30 flex w-60 -translate-x-full flex-col bg-[#111827] px-4 py-6 text-gray-300 transition-transform duration-200 sm:static sm:translate-x-0 sm:px-2 lg:w-60 lg:px-4 ${
            drawer ? "translate-x-0" : ""
          }`}
        >
          <div className="mb-8 whitespace-nowrap text-lg font-bold text-white sm:hidden lg:block">
            问卷管理后台
          </div>
          <div className="mb-8 hidden text-center text-xl sm:block lg:hidden">📋</div>
          <nav className="flex flex-col">
            {NAV_ITEMS.map((item) => {
              const active =
                item.to === "/" ? location.pathname === "/" : isSurveysActive;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`mt-1 flex items-center gap-2.5 rounded-lg px-3 py-3 text-sm sm:justify-center lg:justify-start ${
                    active ? "bg-[#263449] text-white" : "hover:bg-[#263449] hover:text-white"
                  }`}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className="sm:hidden lg:inline">{item.label}</span>
                </Link>
              );
            })}
            {COMING_SOON_ITEMS.map((item) => (
              <button
                key={item.label}
                disabled
                className="mt-1 flex cursor-default items-center gap-2.5 rounded-lg px-3 py-3 text-sm opacity-40 sm:justify-center lg:justify-start"
              >
                <span className="shrink-0">{item.icon}</span>
                <span className="sm:hidden lg:inline">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>
        {drawer ? (
          <button
            aria-label="关闭菜单"
            className="fixed inset-0 z-20 bg-slate-900/45 sm:hidden"
            onClick={() => setDrawer(false)}
          />
        ) : null}
        <main className="mx-auto w-full min-w-0 max-w-[1320px] flex-1 p-4 sm:p-8">
          <header className="mb-7 flex items-center gap-3">
            <button
              aria-label="打开菜单"
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 bg-white text-xl sm:hidden"
              onClick={() => setDrawer(!drawer)}
            >
              ☰
            </button>
            <h1 className="m-0 text-xl font-bold sm:text-[28px]">{title}</h1>
          </header>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
