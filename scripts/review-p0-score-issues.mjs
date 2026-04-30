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
    runSummary: "",
    screenshotDir: "",
    timeoutMs: 60000,
    titles: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") parsed.baseUrl = argv[++index] || parsed.baseUrl;
    else if (arg === "--run-summary") parsed.runSummary = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--screenshot-dir") parsed.screenshotDir = path.resolve(REPO_ROOT, argv[++index] || "");
    else if (arg === "--timeout-ms") parsed.timeoutMs = Math.max(5000, Number(argv[++index]) || parsed.timeoutMs);
    else if (arg === "--title") parsed.titles.push(argv[++index] || "");
  }
  if (!parsed.runSummary) {
    throw new Error("Pass --run-summary <run-summary.json>.");
  }
  if (!parsed.titles.length) {
    parsed.titles = ["炫动", "古巷深处"];
  }
  return parsed;
}

function readJson(filePath) {
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

function reviewTargetFromRunSummary(args) {
  const report = readJson(args.runSummary);
  const htmlPath = report?.scoreIssueReview?.htmlPath || path.join(path.dirname(args.runSummary), "score-issue-review.html");
  const htmlWebPath = report?.scoreIssueReview?.htmlWebPath || pathToWebPath(htmlPath);
  return {
    reviewUrl: new URL(htmlWebPath, args.baseUrl).toString(),
    screenshotDir: args.screenshotDir || path.join(path.dirname(args.runSummary), "p0-browser-review"),
  };
}

function candidateChromePaths() {
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
}

function findChromePath() {
  const found = candidateChromePaths().find((item) => fs.existsSync(item));
  if (!found) throw new Error("Chrome or Edge executable was not found. Set CHROME_PATH if needed.");
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

function safeName(value) {
  return String(value || "page")
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "page";
}

async function runReview(args) {
  const target = reviewTargetFromRunSummary(args);
  const chromePath = findChromePath();
  const port = 9600 + Math.floor(Math.random() * 300);
  const userDataDir = path.join(os.tmpdir(), `ai-erhu-p0-review-${Date.now()}`);
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

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
    const cards = await evaluate(send, `(() => Array.from(document.querySelectorAll("button[data-session-id]")).map((button, index) => {
      const card = button.closest(".review-card");
      return {
        index,
        sessionId: button.dataset.sessionId || "",
        title: card?.querySelector("h2")?.textContent || "",
      };
    }))()`);
    const selectedCards = cards.filter((card) => args.titles.some((title) => card.title.includes(title)));
    if (selectedCards.length !== args.titles.length) {
      throw new Error(`Expected ${args.titles.length} target cards, found ${selectedCards.length}.`);
    }

    const results = [];
    for (const card of selectedCards) {
      await navigate(send, waitEvent, target.reviewUrl, args.timeoutMs);
      const storageResult = await evaluate(send, `(() => {
        const sessionId = ${JSON.stringify(card.sessionId)};
        const storagePrefix = ${JSON.stringify(ISSUE_SESSION_STORAGE_PREFIX)};
        const sessionsNode = document.getElementById("score-issue-sessions");
        const sessions = sessionsNode ? JSON.parse(sessionsNode.textContent || "{}") : {};
        const payload = sessions[sessionId];
        if (!payload) return { ok: false, reason: "missing-session-payload" };
        const serialized = JSON.stringify(payload);
        for (const storage of [localStorage, sessionStorage]) {
          for (const key of Object.keys(storage)) {
            if (key.startsWith(storagePrefix)) storage.removeItem(key);
          }
        }
        localStorage.setItem(storagePrefix + sessionId, serialized);
        sessionStorage.setItem(storagePrefix + sessionId, serialized);
        return { ok: true };
      })()`);
      if (!storageResult.ok) throw new Error(`Failed to store session ${card.title}: ${storageResult.reason}`);

      const issueUrl = new URL("/", args.baseUrl);
      issueUrl.searchParams.set("mode", "score-issues");
      issueUrl.searchParams.set("issueSession", card.sessionId);
      await navigate(send, waitEvent, issueUrl.toString(), args.timeoutMs);
      const issueCount = await evaluate(send, `document.querySelectorAll(".issue-list-button").length`);
      const pieceResult = {
        title: card.title,
        sessionId: card.sessionId,
        issueCount,
        distinctPages: [],
        issueResults: [],
        screenshots: [],
        failures: [],
      };

      for (let issueIndex = 0; issueIndex < issueCount; issueIndex += 1) {
        const issueResult = await evaluate(send, `(() => new Promise((resolve) => {
          const buttons = Array.from(document.querySelectorAll(".issue-list-button"));
          const button = buttons[${issueIndex}];
          const audio = document.querySelector(".audio-player");
          if (!button || !audio) {
            resolve({ ok: false, reason: "missing-button-or-audio", issueIndex: ${issueIndex} });
            return;
          }
          audio.currentTime = 0;
          button.click();
          setTimeout(() => {
            const active = document.querySelector(".issue-list-button.is-active") || button;
            const activeNumber = (active.querySelector(".issue-number-chip")?.textContent || "").trim();
            const pageMatch = (document.body.innerText || "").match(/第\\s*(\\d+)\\s*页\\s*\\/\\s*(\\d+)/);
            const highlights = Array.from(document.querySelectorAll(".score-note-highlight,.score-measure-highlight")).map((item) => {
              const rect = item.getBoundingClientRect();
              const className = item.className || "";
              const label = (item.textContent || "").trim();
              const topPercent = Number.parseFloat(item.style.top || "NaN");
              return {
                label,
                className,
                leftPercent: Number.parseFloat(item.style.left || "NaN"),
                topPercent,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            });
            const metaTexts = Array.from(document.querySelectorAll(".sidebar-meta")).map((item) => item.textContent || "");
            const hint = metaTexts.find((item) => item.includes("已定位") && item.includes("原音")) || "";
            resolve({
              ok: true,
              issueIndex: ${issueIndex},
              activeNumber,
              activeText: (active.textContent || "").replace(/\\s+/g, " ").trim(),
              pageNumber: pageMatch ? Number(pageMatch[1]) : null,
              pageCount: pageMatch ? Number(pageMatch[2]) : null,
              highlightCount: highlights.length,
              highlightLabels: highlights.map((item) => item.label),
              highlightTopPercents: highlights.map((item) => item.topPercent).filter((value) => Number.isFinite(value)),
              bottomLineHighlightSuspect: highlights.some((item) => Number.isFinite(item.topPercent) && item.topPercent > 55),
              matchingHighlight: highlights.some((item) => item.label === activeNumber),
              playbackHint: hint,
              audioCurrentTime: Number(audio.currentTime) || 0,
              audioJumpedFromStart: (Number(audio.currentTime) || 0) > 0.5,
            });
          }, 850);
        }))()`);
        if (!issueResult.ok) {
          pieceResult.failures.push(`issue-${issueIndex + 1}:${issueResult.reason || "unknown"}`);
        }
        if (!issueResult.matchingHighlight) pieceResult.failures.push(`issue-${issueIndex + 1}:highlight-number-mismatch`);
        if (!issueResult.audioJumpedFromStart) pieceResult.failures.push(`issue-${issueIndex + 1}:audio-did-not-jump`);
        if (issueResult.pageNumber && !pieceResult.distinctPages.includes(issueResult.pageNumber)) {
          pieceResult.distinctPages.push(issueResult.pageNumber);
        }
        const screenshot = await captureScreenshot(
          send,
          target.screenshotDir,
          `${safeName(card.title)}-issue-${String(issueIndex + 1).padStart(2, "0")}.png`,
        );
        pieceResult.screenshots.push(path.relative(REPO_ROOT, screenshot));
        pieceResult.issueResults.push(issueResult);
      }
      pieceResult.distinctPages.sort((left, right) => left - right);
      results.push(pieceResult);
    }
    ws.close();
    return {
      ok: results.every((item) => item.failures.length === 0),
      reviewUrl: target.reviewUrl,
      screenshotDir: path.relative(REPO_ROOT, target.screenshotDir),
      results,
    };
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

runReview(parseArgs())
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
