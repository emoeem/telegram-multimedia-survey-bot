import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout";

/**
 * Every route is behind a dynamic import so the initial admin bundle only
 * carries the shell plus the screen that is opening. The editor, analytics and
 * task-pack screens pull in the most code (drag-and-drop, charts, previews);
 * loading them on demand keeps first paint fast on a phone in a Telegram
 * WebView.
 */
const DashboardPage = lazy(() => import("./routes/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const SurveysPage = lazy(() => import("./routes/SurveysPage").then((m) => ({ default: m.SurveysPage })));
const SurveyDetailPage = lazy(() => import("./routes/SurveyDetailPage").then((m) => ({ default: m.SurveyDetailPage })));
const EditorPage = lazy(() => import("./routes/EditorPage").then((m) => ({ default: m.EditorPage })));
const ResponsesPage = lazy(() => import("./routes/ResponsesPage").then((m) => ({ default: m.ResponsesPage })));
const ResponseDetailPage = lazy(() =>
  import("./routes/ResponseDetailPage").then((m) => ({ default: m.ResponseDetailPage })),
);
const ResponseActivityPage = lazy(() =>
  import("./routes/ResponseActivityPage").then((m) => ({ default: m.ResponseActivityPage })),
);
const ImportPage = lazy(() => import("./routes/ImportPage").then((m) => ({ default: m.ImportPage })));
const AnalyticsPage = lazy(() => import("./routes/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const UsersPage = lazy(() => import("./routes/UsersPage").then((m) => ({ default: m.UsersPage })));
const VersionsPage = lazy(() => import("./routes/VersionsPage").then((m) => ({ default: m.VersionsPage })));
const ReportsPage = lazy(() => import("./routes/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const TemplatesPage = lazy(() => import("./routes/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
const LoginPage = lazy(() => import("./routes/LoginPage").then((m) => ({ default: m.LoginPage })));
const AuditPage = lazy(() => import("./routes/AuditPage").then((m) => ({ default: m.AuditPage })));
const SettingsPage = lazy(() => import("./routes/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const LicensesPage = lazy(() => import("./routes/LicensesPage").then((m) => ({ default: m.LicensesPage })));
const PlazaPostsPage = lazy(() => import("./routes/PlazaPostsPage").then((m) => ({ default: m.PlazaPostsPage })));
const ProfileGalleryPage = lazy(() =>
  import("./routes/ProfileGalleryPage").then((m) => ({ default: m.ProfileGalleryPage })),
);
const TaskPacksPage = lazy(() => import("./routes/TaskPacksPage").then((m) => ({ default: m.TaskPacksPage })));

/** Skeleton shown while the route chunk downloads. */
function RouteFallback() {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="页面加载中">
      <div className="h-7 w-40 animate-pulse rounded-lg bg-[var(--color-surface-2,rgba(127,127,127,0.12))]" />
      <div className="h-28 animate-pulse rounded-xl bg-[var(--color-surface-2,rgba(127,127,127,0.12))]" />
      <div className="h-28 animate-pulse rounded-xl bg-[var(--color-surface-2,rgba(127,127,127,0.12))]" />
    </div>
  );
}

function lazyElement(node: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

const router = createBrowserRouter(
  [
    // Login is a standalone surface: no admin navigation or page chrome.
    { path: "login", element: lazyElement(<LoginPage />) },
    {
      element: <Layout />,
      children: [
        { index: true, element: lazyElement(<DashboardPage />) },
        { path: "surveys", element: lazyElement(<SurveysPage />) },
        { path: "responses", element: lazyElement(<ResponseActivityPage />) },
        { path: "imports", element: lazyElement(<ImportPage />) },
        { path: "surveys/:id", element: lazyElement(<SurveyDetailPage />) },
        { path: "surveys/:id/editor", element: lazyElement(<EditorPage />) },
        { path: "surveys/:id/responses", element: lazyElement(<ResponsesPage />) },
        { path: "surveys/:id/responses/:responseId", element: lazyElement(<ResponseDetailPage />) },
        { path: "surveys/:id/analytics", element: lazyElement(<AnalyticsPage />) },
        { path: "surveys/:id/versions", element: lazyElement(<VersionsPage />) },
        { path: "reports", element: lazyElement(<ReportsPage />) },
        { path: "templates", element: lazyElement(<TemplatesPage />) },
        { path: "plaza", element: lazyElement(<PlazaPostsPage />) },
        { path: "profile-gallery", element: lazyElement(<ProfileGalleryPage />) },
        { path: "task-packs", element: lazyElement(<TaskPacksPage />) },
        { path: "audit", element: lazyElement(<AuditPage />) },
        { path: "settings", element: lazyElement(<SettingsPage />) },
        { path: "licenses", element: lazyElement(<LicensesPage />) },
        { path: "users", element: lazyElement(<UsersPage />) },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: "/admin" },
);

export function App() {
  return <RouterProvider router={router} />;
}
