import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { SurveyApp } from "./SurveyApp";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <SurveyApp />
  </StrictMode>,
);
