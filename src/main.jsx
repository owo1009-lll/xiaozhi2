import React from "react";
import { createRoot } from "react-dom/client";
import App from "./MainApp.jsx";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // During local prototyping, stale service-worker caches can keep old labels,
    // old score pages, and old issue sessions alive after a rebuild.
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
    if ("caches" in window) {
      window.caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((key) => key.startsWith("ai-erhu") || key.includes("vite")).map((key) => window.caches.delete(key)),
          ),
        )
        .catch(() => {});
    }
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
