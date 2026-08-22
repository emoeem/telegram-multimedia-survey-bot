import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./routes/DashboardPage";
import { SurveysPage } from "./routes/SurveysPage";
import { SurveyDetailPage } from "./routes/SurveyDetailPage";
import { EditorPage } from "./routes/EditorPage";

export function App() {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="surveys" element={<SurveysPage />} />
          <Route path="surveys/:id" element={<SurveyDetailPage />} />
          <Route path="surveys/:id/editor" element={<EditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
