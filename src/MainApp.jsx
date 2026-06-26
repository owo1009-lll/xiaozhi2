import { Suspense, lazy, useEffect, useState } from "react";

const ResearchApp = lazy(() => import("./ResearchApp.jsx"));
const ScoreIssuePage = lazy(() => import("./ScoreIssuePage.jsx"));
const StudentApp = lazy(() => import("./StudentApp.jsx"));
const HealthPage = lazy(() => import("./HealthPage.jsx"));
const TeacherValidationApp = lazy(() => import("./TeacherValidationApp.jsx"));
const WesternStringsApp = lazy(() => import("./WesternStringsApp.jsx"));

function getModeFromLocation() {
  if (typeof window === "undefined") return "student";
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "score-issues") return "score-issues";
  if (params.get("mode") === "health") return "health";
  if (params.get("mode") === "teacher") return "teacher";
  if (params.get("mode") === "strings") return "strings";
  return params.get("mode") === "research" ? "research" : "student";
}

export default function MainApp() {
  const [mode, setMode] = useState(getModeFromLocation);

  useEffect(() => {
    const handlePopState = () => setMode(getModeFromLocation());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function switchMode(nextMode) {
    const url = new URL(window.location.href);
    if (nextMode === "research" || nextMode === "health" || nextMode === "teacher" || nextMode === "strings") {
      url.searchParams.set("mode", nextMode);
    } else {
      url.searchParams.delete("mode");
    }
    window.history.pushState({}, "", url);
    setMode(nextMode);
  }

  const fallback = (
    <div className="app-shell" aria-live="polite">
      <div className="status-banner">Loading module...</div>
    </div>
  );

  return (
    <Suspense fallback={fallback}>
      {mode === "research" ? (
        <ResearchApp onBackToStudent={() => switchMode("student")} />
      ) : mode === "health" ? (
        <HealthPage />
      ) : mode === "teacher" ? (
        <TeacherValidationApp />
      ) : mode === "strings" ? (
        <WesternStringsApp onBackToStudent={() => switchMode("student")} />
      ) : mode === "score-issues" ? (
        <ScoreIssuePage />
      ) : (
        <StudentApp
          onOpenResearch={() => switchMode("research")}
          onOpenTeacherValidation={() => switchMode("teacher")}
        />
      )}
    </Suspense>
  );
}
