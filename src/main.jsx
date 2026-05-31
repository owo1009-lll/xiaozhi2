import React from "react";
import { createRoot } from "react-dom/client";
import App from "./MainApp.jsx";
import "./styles.css";

const clearServiceWorkerState = () => {
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
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const params = new URLSearchParams(window.location.search);
    const shouldClear = import.meta.env.DEV || params.has("clear-sw") || params.get("mode") === "teacher";
    if (shouldClear) {
      clearServiceWorkerState();
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
