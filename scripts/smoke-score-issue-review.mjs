import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ISSUE_SESSION_STORAGE_PREFIX } from "../src/analysisLabels.js";

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
    allCards: false,
    maxCards: 0,
    viewportWidth: 1440,
    viewportHeight: 1100,
    mobile: false,
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
    else if (arg === "--all-cards") parsed.allCards = true;
    else if (arg === "--max-cards") parsed.maxCards = Math.max(1, Number(argv[++index]) || 0);
    else if (arg === "--viewport") {
      const [width, height] = String(argv[++index] || "").split(/[xX]/).map((item) => Math.round(Number(item)));
      if (Number.isFinite(width) && width >= 320) parsed.viewportWidth = width;
      if (Number.isFinite(height) && height >= 480) parsed.viewportHeight = height;
    } else if (arg === "--mobile") {
      parsed.mobile = true;
      if (parsed.viewportWidth === 1440) parsed.viewportWidth = 390;
      if (parsed.viewportHeight === 1100) parsed.viewportHeight = 844;
    }
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

function safeScreenshotName(value) {
  return String(value || "page")
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "page";
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
      width: args.viewportWidth,
      height: args.viewportHeight,
      deviceScaleFactor: 1,
      mobile: Boolean(args.mobile),
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

    const reviewCards = await evaluate(send, `(() => Array.from(document.querySelectorAll("button[data-session-id]")).map((button, index) => {
      const card = button.closest(".review-card");
      return {
        index,
        sessionId: button.dataset.sessionId || "",
        title: card?.querySelector("h2")?.textContent || "",
        riskChipCount: card?.querySelectorAll(".risk-list span").length || 0,
      };
    }))()`);
    const cardLimit = args.allCards ? Math.max(1, args.maxCards || reviewCards.length) : Math.max(1, args.maxCards || 1);
    const cardsToCheck = reviewCards.slice(0, args.allCards ? Math.min(cardLimit, reviewCards.length) : Math.min(cardLimit, 1));

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

    const storageResults = [];
    const checkedPages = [];
    for (const card of cardsToCheck) {
      await navigate(send, waitEvent, target.reviewUrl, args.timeoutMs);
      const storageResult = await evaluate(send, `(() => {
        const sessionId = ${JSON.stringify(card.sessionId)};
        const storagePrefix = ${JSON.stringify(ISSUE_SESSION_STORAGE_PREFIX)};
        const sessionsNode = document.getElementById("score-issue-sessions");
        const sessions = sessionsNode ? JSON.parse(sessionsNode.textContent || "{}") : {};
        const payload = sessions[sessionId];
        if (!payload) return { sessionId, ok: false, reason: "missing-session-payload" };
        const serialized = JSON.stringify(payload);
        try {
          for (const storage of [localStorage, sessionStorage]) {
            for (const key of Object.keys(storage)) {
              if (key.startsWith(storagePrefix)) storage.removeItem(key);
            }
          }
          localStorage.setItem(storagePrefix + sessionId, serialized);
          sessionStorage.setItem(storagePrefix + sessionId, serialized);
          return {
            sessionId,
            ok: true,
            localStored: Boolean(localStorage.getItem(storagePrefix + sessionId)),
            sessionStored: Boolean(sessionStorage.getItem(storagePrefix + sessionId)),
          };
        } catch (error) {
          return { sessionId, ok: false, reason: error.message || String(error) };
        }
      })()`);
      storageResults.push(storageResult);

      const issueUrl = new URL("/", appBaseUrlFromReviewUrl(target.reviewUrl, args.baseUrl));
      issueUrl.searchParams.set("mode", "score-issues");
      issueUrl.searchParams.set("issueSession", card.sessionId || "");
      await navigate(send, waitEvent, issueUrl.toString(), args.timeoutMs);
      const issuePage = await evaluate(send, `(() => {
        const image = document.querySelector(".score-page-image");
        const canvas = document.querySelector(".pdf-preview-canvas");
        return {
          title: document.title,
          url: location.href,
          hasScoreShell: Boolean(document.querySelector(".score-issue-shell")),
          hasAudioPanel: Boolean(document.querySelector(".audio-player")) || document.body.innerText.includes("原音"),
          hasPieceTitle: Boolean(document.querySelector(".score-issue-title")),
          hasIssueList: document.querySelectorAll(".issue-list-button").length > 0,
          issueListCount: document.querySelectorAll(".issue-list-button").length,
          issueNumberChipCount: document.querySelectorAll(".issue-list-button .issue-number-chip").length,
          hasScorePanel: Boolean(document.querySelector(".score-page-panel")),
          hasRenderedScore: Boolean((image && image.complete && image.naturalWidth > 0) || (canvas && canvas.width > 0 && canvas.height > 0)),
          highlightCount: document.querySelectorAll(".score-note-highlight,.score-measure-highlight").length,
          highlightNumberCount: Array.from(document.querySelectorAll(".score-note-highlight .score-note-index,.score-measure-highlight span"))
            .filter((item) => (item.textContent || "").trim()).length,
          highlightToneClassCount: Array.from(document.querySelectorAll(".score-note-highlight,.score-measure-highlight"))
            .filter((item) => Array.from(item.classList).some((className) => className.startsWith("issue-tone-"))).length,
          hasIssueColorLegend: Boolean(document.querySelector(".issue-color-legend")),
          colorLegendDotCount: document.querySelectorAll(".issue-color-legend .legend-dot").length,
          hasMelodyLineMode: Boolean(document.querySelector(".issue-line-mode")),
          listToneClassCount: Array.from(document.querySelectorAll(".issue-list-button"))
            .filter((item) => Array.from(item.classList).some((className) => className.startsWith("issue-tone-"))).length,
          buttonCount: document.querySelectorAll("button").length,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          hasHorizontalBodyOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 8,
          textSample: document.body.innerText.slice(0, 500),
        };
      })()`);
      const playbackCheck = await evaluate(send, `(() => new Promise((resolve) => {
        const audio = document.querySelector(".audio-player");
        const button = document.querySelector(".issue-list-button");
        if (!audio) {
          resolve({ ok: false, reason: "missing-audio-player" });
          return;
        }
        if (!button) {
          resolve({ ok: false, reason: "missing-issue-button" });
          return;
        }
        const beforeTime = Number(audio.currentTime) || 0;
        try {
          button.click();
        } catch (error) {
          resolve({ ok: false, reason: error.message || String(error) });
          return;
        }
        setTimeout(() => {
          const metaTexts = Array.from(document.querySelectorAll(".sidebar-meta"))
            .map((item) => item.textContent || "");
          const hint = metaTexts.find((item) => item.includes("已定位") && item.includes("原音")) || "";
          resolve({
            ok: Boolean(hint),
            reason: hint ? "" : "missing-playback-hint",
            hint,
            beforeTime,
            currentTime: Number(audio.currentTime) || 0,
            paused: Boolean(audio.paused),
            activeIssueCount: document.querySelectorAll(".issue-list-button.is-active").length,
          });
        }, 800);
      }))()`);
      const pageFailures = [];
      if (!issuePage.hasScoreShell) pageFailures.push("issue-page-shell-missing");
      if (!issuePage.hasAudioPanel) pageFailures.push("issue-page-audio-panel-missing");
      if (!issuePage.hasPieceTitle) pageFailures.push("issue-page-title-missing");
      if (!issuePage.hasIssueList) pageFailures.push("issue-page-list-missing");
      if (issuePage.issueNumberChipCount < issuePage.issueListCount) pageFailures.push("issue-page-issue-numbering-incomplete");
      if (!issuePage.hasScorePanel) pageFailures.push("issue-page-score-panel-missing");
      if (!issuePage.hasRenderedScore) pageFailures.push("issue-page-score-render-missing");
      if (issuePage.highlightCount > 0 && issuePage.highlightNumberCount <= 0) pageFailures.push("issue-page-highlight-numbering-missing");
      if (issuePage.highlightToneClassCount < issuePage.highlightCount) pageFailures.push("issue-page-highlight-tone-class-missing");
      if (!issuePage.hasIssueColorLegend || issuePage.colorLegendDotCount < 3) pageFailures.push("issue-page-color-legend-missing");
      if (issuePage.listToneClassCount < issuePage.issueListCount) pageFailures.push("issue-page-list-tone-class-missing");
      if (!issuePage.hasMelodyLineMode) pageFailures.push("issue-page-melody-line-mode-missing");
      if (issuePage.hasHorizontalBodyOverflow) pageFailures.push("issue-page-horizontal-overflow");
      if (!playbackCheck.ok) pageFailures.push(`issue-page-playback-link-missing:${playbackCheck.reason || "unknown"}`);
      checkedPages.push({
        ...issuePage,
        cardIndex: card.index,
        cardTitle: card.title,
        sessionId: card.sessionId,
        riskChipCount: card.riskChipCount,
        storageOk: Boolean(storageResult?.ok),
        playbackCheck,
        ok: pageFailures.length === 0,
        failures: pageFailures,
      });
      if (!args.noScreenshots) {
        const filename = args.allCards
          ? `score-issue-page-smoke-${String(card.index + 1).padStart(2, "0")}-${safeScreenshotName(card.title)}.png`
          : "score-issue-page-smoke.png";
        screenshots.push(await captureScreenshot(send, target.screenshotDir, filename));
      }
    }
    ws.close();

    const failures = [];
    if (!review.hasExpectedText) failures.push("review-page-missing-expected-text");
    if (review.cardCount <= 0) failures.push("review-page-no-cards");
    if (review.buttonCount <= 0) failures.push("review-page-no-open-button");
    if (cardsToCheck.length <= 0) failures.push("review-page-no-checkable-cards");
    if (!clickResult.ok) failures.push(clickResult.reason || "open-button-click-failed");
    if (!clickResult.localStored && !clickResult.sessionStored) failures.push("issue-session-not-stored");
    for (const storageResult of storageResults) {
      if (!storageResult.ok || (!storageResult.localStored && !storageResult.sessionStored)) {
        failures.push(`issue-session-storage-failed:${storageResult.sessionId}:${storageResult.reason || "not-stored"}`);
      }
    }
    for (const page of checkedPages) {
      for (const failure of page.failures || []) {
        failures.push(`${failure}:${page.cardTitle || page.sessionId}`);
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      source: target.source,
      reviewUrl: target.reviewUrl,
      viewport: {
        width: args.viewportWidth,
        height: args.viewportHeight,
        mobile: Boolean(args.mobile),
      },
      review,
      checkedCardCount: checkedPages.length,
      clickResult,
      storageResults,
      issuePage: checkedPages[0] || null,
      checkedPages,
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
    allCards: false,
    maxCards: 0,
    viewportWidth: 1440,
    viewportHeight: 1100,
    mobile: false,
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
