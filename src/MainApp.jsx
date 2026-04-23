import { useEffect, useState } from "react";
import ResearchApp from "./ResearchApp.jsx";
import ScoreIssuePage from "./ScoreIssuePage.jsx";
import StudentApp from "./StudentApp.jsx";

function getModeFromLocation() {
  if (typeof window === "undefined") return "student";
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "score-issues") return "score-issues";
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
    if (nextMode === "research") {
      url.searchParams.set("mode", "research");
    } else {
      url.searchParams.delete("mode");
    }
    window.history.pushState({}, "", url);
    setMode(nextMode);
  }

  if (mode === "research") {
    return <ResearchApp onBackToStudent={() => switchMode("student")} />;
  }

  if (mode === "score-issues") {
    return <ScoreIssuePage />;
  }

  return <StudentApp onOpenResearch={() => switchMode("research")} />;
}
