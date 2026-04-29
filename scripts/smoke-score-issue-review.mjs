import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    baseUrl: DEFAULT_BASE_URL,
    chromePath: "",
    reviewUrl: "",
    runSummary: "",
    screenshotDir: "",
    noScreenshots: false,
    timeoutMs: 30000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") parsed.baseUrl = argv[++index] || parsed.baseUrl;
    else if (arg === "--chrome") parsed.chromePath = argv[++index] || "";
    else if (arg === "--review-url") parsed.reviewUrl = argv[++index] || "";
    else if (arg === "--run-summary") parsed.runSummary = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--screenshot-dir") parsed.screenshotDir = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--no-screenshots") parsed.noScreenshots = true;
    else if (arg === "--timeout-ms") parsed.timeoutMs = Math.max(5000, Number(argv[++index]) || parsed.timeoutMs);
  }
  return parsed;
}

function readJson(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pathToWebPath(filePath) {
  const dataRoot = path.join(REPO_ROOT, "data");
  const relative = path.relative(dataRoot, filePath);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `/data/${relative.split(path.sep).join("/")}`;
  }
  return "";
}

function findLatestReviewManifest() {
  const corpusRoot = path.join(REPO_ROOT, "data", "real-tests", "corpus-runs");
  if (!fs.existsSync(corpusRoot)) return "";
  return fs.readdirSync(corpusRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(corpusRoot, entry.name, "score-issue-review-manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => {
      const manifest = readJson(manifestPath, {});
      return {
        manifestPath,
        generatedAt: Date.parse(manifest?.generatedAt || "") || fs.statSync(manifestPath).mtimeMs,
        itemCount: Number(manifest?.itemCount || 0),
      };
    })
    .filter((item) => item.itemCount > 0)
    .sort((left, right) => right.generatedAt - left.generatedAt)[0]?.manifestPath || "";
}

function resolveReviewTarget(args) {
  if (args.reviewUrl) {
    return {
      reviewUrl: args.reviewUrl,
      screenshotDir: args.screenshotDir || path.join(REPO_ROOT, "data", "real-tests", "browser-smoke"),
      source: "review-url",
    };
  }

  if (args.runSummary) {
    const report = readJson(args.runSummary, {});
    const htmlWebPath = report?.scoreIssueReview?.htmlWebPath;
    const htmlPath = report?.scoreIssueReview?.htmlPath || path.join(path.dirname(args.runSummary), "score-issue-review.html");
    return {
      reviewUrl: htmlWebPath ? new URL(htmlWebPath, args.baseUrl).toString() : new URL(pathToWebPath(htmlPath), args.baseUrl).toString(),
      screenshotDir: args.screenshotDir || path.dirname(args.runSummary),
      source: path.relative(REPO_ROOT, args.runSummary),
    };
  }

  const manifestPath = findLatestReviewManifest();
  if (!manifestPath) {
    throw new Error("No score issue review manifest with items was found. Run `npm run review:score-issues` or pass --run-summary.");
  }
  const htmlPath = path.join(path.dirname(manifestPath), "score-issue-review.html");
  return {
    reviewUrl: new URL(pathToWebPath(htmlPath), args.baseUrl).toString(),
    screenshotDir: args.screenshotDir || path.dirname(manifestPath),
    source: path.relative(REPO_ROOT, manifestPath),
  };
}

function candidateChromePaths() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.filter(Boolean);
}

function findChromePath(explicitPath = "") {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) return explicitPath;
    throw new Error(`Chrome executable not found: ${explicitPath}`);
  }
  const found = candidateChromePaths().find((item) => fs.existsSync(item));
  if (!found) throw new Error("Chrome or Edge executable was not found. Pass --chrome or set CHROME_PATH.");
  return found;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function waitForChrome(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome DevTools did not become ready.");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  ws.addEventListener("message", (message) => {
    const payload = JSON.parse(message.data);
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(JSON.stringify(payload.error)));
      else resolve(payload.result || {});
      return;
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.method === payload.method) {
        waiters.splice(index, 1);
        waiter.resolve(payload.params || {});
      }
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      const send = (method, params = {}) => new Promise((commandResolve, commandReject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve: commandResolve, reject: commandReject });
        ws.send(JSON.stringify({ id, method, params }));
      });
      const waitEvent = (method, timeoutMs = 15000) => new Promise((eventResolve, eventReject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.resolve === eventResolve);
          if (index >= 0) waiters.splice(index, 1);
          eventReject(new Error(`Timed out waiting for ${method}`));
        }, timeoutMs);
        waiters.push({
          method,
          resolve: (params) => {
            clearTimeout(timer);
            eventResolve(params);
          },
        });
      });
      resolve({ ws, send, waitEvent });
    });
    ws.addEventListener("error", reject);
  });
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function navigate(send, waitEvent, url, timeoutMs) {
  const loadPromise = waitEvent("Page.loadEventFired", timeoutMs).catch(() => null);
  await send("Page.navigate", { url });
  await loadPromise;
  await sleep(1200);
}

async function captureScreenshot(send, screenshotDir, filename) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const filePath = path.join(screenshotDir, filename);
  fs.writeFileSync(filePath, Buffer.from(shot.data, "base64"));
  return filePath;
}

function appBaseUrlFromReviewUrl(reviewUrl, fallbackBaseUrl) {
  try {
    const url = new URL(reviewUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return fallbackBaseUrl;
  }
}

async function runSmoke(args) {
  const target = resolveReviewTarget(args);
  const chromePath = findChromePath(args.chromePath);
  const port = 9300 + Math.floor(Math.random() * 500);
  const userDataDir = path.join(os.tmpdir(), `ai-erhu-score-issue-smoke-${Date.now()}`);
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  const screenshots = [];
  try {
    await waitForChrome(port, args.timeoutMs);
    const browserTarget = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const { ws, send, waitEvent } = await connect(browserTarget.webSocketDebuggerUrl);
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await navigate(send, waitEvent, target.reviewUrl, args.timeoutMs);
    const review = await evaluate(send, `(() => ({
      title: document.title,
      h1: document.querySelector("h1")?.textContent || "",
      cardCount: document.querySelectorAll(".review-card").length,
      buttonCount: document.querySelectorAll("button[data-session-id]").length,
      riskChipCount: document.querySelectorAll(".risk-list span").length,
      hasExpectedText: document.body.innerText.includes("真实曲库问题谱面复核") && document.body.innerText.includes("打开问题谱面"),
    }))()`);
    if (!args.noScreenshots) screenshots.push(await captureScreenshot(send, target.screenshotDir, "score-issue-review-smoke.png"));

    const clickResult = await evaluate(send, `(() => {
      const button = document.querySelector("button[data-session-id]");
      if (!button) return { ok: false, reason: "missing-button" };
      const sessionId = button.dataset.sessionId;
      button.click();
      return {
        ok: true,
        sessionId,
        localStored: Object.keys(localStorage).some((key) => key.includes(sessionId)),
        sessionStored: Object.keys(sessionStorage).some((key) => key.includes(sessionId)),
      };
    })()`);

    const issueUrl = new URL("/", appBaseUrlFromReviewUrl(target.reviewUrl, args.baseUrl));
    issueUrl.searchParams.set("mode", "score-issues");
    issueUrl.searchParams.set("issueSession", clickResult.sessionId || "");
    await navigate(send, waitEvent, issueUrl.toString(), args.timeoutMs);
    const issuePage = await evaluate(send, `(() => ({
      title: document.title,
      url: location.href,
      hasScoreShell: Boolean(document.querySelector(".score-issue-shell")),
      hasAudioPanel: document.body.innerText.includes("原音"),
      hasPieceTitle: Boolean(document.querySelector(".score-issue-title")),
      buttonCount: document.querySelectorAll("button").length,
      textSample: document.body.innerText.slice(0, 500),
    }))()`);
    if (!args.noScreenshots) screenshots.push(await captureScreenshot(send, target.screenshotDir, "score-issue-page-smoke.png"));
    ws.close();

    const failures = [];
    if (!review.hasExpectedText) failures.push("review-page-missing-expected-text");
    if (review.cardCount <= 0) failures.push("review-page-no-cards");
    if (review.buttonCount <= 0) failures.push("review-page-no-open-button");
    if (!clickResult.ok) failures.push(clickResult.reason || "open-button-click-failed");
    if (!clickResult.localStored && !clickResult.sessionStored) failures.push("issue-session-not-stored");
    if (!issuePage.hasScoreShell) failures.push("issue-page-shell-missing");
    if (!issuePage.hasAudioPanel) failures.push("issue-page-audio-panel-missing");
    if (!issuePage.hasPieceTitle) failures.push("issue-page-title-missing");

    return {
      ok: failures.length === 0,
      failures,
      source: target.source,
      reviewUrl: target.reviewUrl,
      review,
      clickResult,
      issuePage,
      screenshots: screenshots.map((item) => path.relative(REPO_ROOT, item)),
    };
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

export async function runScoreIssueReviewSmoke(options = {}) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    chromePath: "",
    reviewUrl: "",
    runSummary: "",
    screenshotDir: "",
    noScreenshots: false,
    timeoutMs: 30000,
    ...options,
  };
  if (args.runSummary) args.runSummary = path.resolve(REPO_ROOT, args.runSummary);
  if (args.screenshotDir) args.screenshotDir = path.resolve(REPO_ROOT, args.screenshotDir);
  return runSmoke(args);
}

async function main() {
  const args = parseArgs();
  const result = await runSmoke(args);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
