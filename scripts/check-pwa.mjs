import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const readText = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const fail = (message) => {
  console.error(`[pwa-check] ${message}`);
  process.exitCode = 1;
};

const indexHtml = readText("index.html");
const manifest = JSON.parse(readText("public/manifest.webmanifest"));
const main = readText("src/main.jsx");
const serviceWorker = readText("public/sw.js");

if (!indexHtml.includes('rel="manifest"') || !indexHtml.includes("/manifest.webmanifest")) {
  fail("index.html must reference /manifest.webmanifest");
}

if (!manifest.name || !manifest.short_name || manifest.display !== "standalone" || manifest.start_url !== "/") {
  fail("manifest must define name, short_name, display=standalone, and start_url=/");
}

if (!Array.isArray(manifest.icons) || manifest.icons.length < 2) {
  fail("manifest must include installable icons");
} else {
  for (const icon of manifest.icons) {
    const iconPath = String(icon.src || "").replace(/^\//, "");
    if (!iconPath || !fs.existsSync(path.join(root, "public", iconPath.replace(/^public[\\/]/, "")))) {
      fail(`manifest icon is missing: ${icon.src}`);
    }
  }
}

if (!main.includes('navigator.serviceWorker.register("/sw.js")')) {
  fail("production app must register /sw.js");
}

if (!main.includes("import.meta.env.DEV") || !main.includes("clear-sw")) {
  fail("app must keep a dev/manual stale-cache cleanup path");
}

for (const prefix of ["/api/", "/data/", "/exports/", "/score/"]) {
  if (!serviceWorker.includes(`"${prefix}"`)) {
    fail(`service worker must avoid caching dynamic path ${prefix}`);
  }
}

if (serviceWorker.includes("registration.unregister()")) {
  fail("production service worker must not unregister itself");
}

if (!serviceWorker.includes("request.mode === \"navigate\"") || !serviceWorker.includes("caches.match(\"/\")")) {
  fail("service worker must provide a navigation fallback for the app shell");
}

if (!process.exitCode) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        manifest: manifest.short_name,
        display: manifest.display,
        icons: manifest.icons.length,
        dynamicCacheBypass: ["/api/", "/data/", "/exports/", "/score/"],
      },
      null,
      2,
    ),
  );
}
