import { Navigate, RouterProvider, createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./routes/DashboardPage";
import { SurveysPage } from "./routes/SurveysPage";
import { SurveyDetailPage } from "./routes/SurveyDetailPage";
import { EditorPage } from "./routes/EditorPage";
import { ResponsesPage } from "./routes/ResponsesPage";
import { ResponseDetailPage } from "./routes/ResponseDetailPage";
import { AnalyticsPage } from "./routes/AnalyticsPage";
import { UsersPage } from "./routes/UsersPage";
import { VersionsPage } from "./routes/VersionsPage";
import { ReportsPage } from "./routes/ReportsPage";
import { SettingsPage } from "./routes/SettingsPage";

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <DashboardPage /> },
        { path: "surveys", element: <SurveysPage /> },
        { path: "surveys/:id", element: <SurveyDetailPage /> },
        { path: "surveys/:id/editor", element: <EditorPage /> },
        { path: "surveys/:id/responses", element: <ResponsesPage /> },
        { path: "surveys/:id/responses/:responseId", element: <ResponseDetailPage /> },
        { path: "surveys/:id/analytics", element: <AnalyticsPage /> },
        { path: "surveys/:id/versions", element: <VersionsPage /> },
        { path: "reports", element: <ReportsPage /> },
        { path: "settings", element: <SettingsPage /> },
        { path: "users", element: <UsersPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: "/admin" },
);

export function App() {
  return <RouterProvider router={router} />;
}
