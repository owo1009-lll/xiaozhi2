import { safeString } from "./baseUtils.js";

// The student site (Vercel) and the analysis backend (this machine, reached
// through a Cloudflare tunnel) share one Express port. Everything on that port
// — ops, research, teacher, score import, the western review console, the
// `/data` static mount that exposes private recordings, and the SPA fallback —
// must stay off the public internet. Only the handful of student endpoints may
// answer tunnel traffic; the operator keeps using the full backend locally.
export const STUDENT_PUBLIC_ALLOWLIST = Object.freeze([
  { method: "GET", path: "/api/health" },
  { method: "GET", path: "/api/strings/student-gate" },
  { method: "GET", path: "/api/strings/student-submissions" },
  // The Mini Program polls this status-only endpoint after WeChat's asynchronous
  // image safety callback. It never returns user media or moderation details.
  { method: "GET", path: "/api/strings/content-safety-status" },
  { method: "POST", path: "/api/strings/analyze" },
  { method: "POST", path: "/api/strings/training-consent" },
  // WeChat verifies this URL and posts `mediaCheckAsync` results here.
  { method: "GET", path: "/api/wechat/content-safety-callback" },
  { method: "POST", path: "/api/wechat/content-safety-callback" },
  // Reference score images + coordinate sidecars for the student score view
  // (built-in supported editions only; reference material, not student data).
  { method: "GET", path: "/api/strings/score-editions" },
  { method: "GET", path: "/api/strings/score-render" },
  { method: "GET", path: "/api/strings/score-coordinates" },
  { method: "GET", path: "/api/strings/score-diagnosis" },
]);

export const DEFAULT_PUBLIC_RATE_LIMITS = Object.freeze([
  Object.freeze({
    method: "POST",
    path: "/api/strings/analyze",
    windowMs: 10 * 60 * 1000,
    maxRequests: 8,
    maxConcurrent: 2,
  }),
  Object.freeze({
    method: "POST",
    path: "/api/strings/training-consent",
    windowMs: 10 * 60 * 1000,
    maxRequests: 8,
    maxConcurrent: 2,
  }),
  Object.freeze({
    method: "GET",
    path: "/api/strings/student-submissions",
    windowMs: 10 * 60 * 1000,
    maxRequests: 30,
    maxConcurrent: 4,
  }),
]);

// Trust model: the backend must bind 127.0.0.1 in public mode so the ONLY way
// in from the internet is cloudflared, which always stamps `cf-connecting-ip` /
// `cf-ray`. A request without those headers therefore came from this machine
// (the operator's local browser) and is trusted; a request with them came
// through the tunnel and is limited to the allowlist. If the port were bound to
// 0.0.0.0 this assumption would break, so the production launcher sets the bind
// host explicitly and this guard documents the dependency.
export function isTunnelRequest(req) {
  return Boolean(safeString(req.get("cf-connecting-ip")).trim() || safeString(req.get("cf-ray")).trim());
}

export function assertSafePublicBindHost({ publicMode = false, bindHost = "" } = {}) {
  if (!publicMode) return;
  const normalized = safeString(bindHost).trim().toLowerCase();
  if (!["127.0.0.1", "::1", "localhost"].includes(normalized)) {
    throw new Error("WESTERN_PUBLIC_MODE requires ERHU_BIND_HOST to be a loopback address.");
  }
}

export function createPublicRateLimiter({
  publicMode = false,
  rules = DEFAULT_PUBLIC_RATE_LIMITS,
  now = () => Date.now(),
} = {}) {
  const ruleByRoute = new Map(rules.map((rule) => [`${rule.method} ${rule.path}`, rule]));
  const clients = new Map();
  let lastSweepAt = 0;

  function sweepExpired(currentTime) {
    if (currentTime - lastSweepAt < 60_000) return;
    lastSweepAt = currentTime;
    for (const [key, entry] of clients.entries()) {
      const rule = ruleByRoute.get(entry.route);
      const cutoff = currentTime - Number(rule?.windowMs || 0);
      entry.requests = entry.requests.filter((timestamp) => timestamp > cutoff);
      if (!entry.requests.length && entry.active === 0) clients.delete(key);
    }
  }

  return function publicRateLimiter(req, res, next) {
    if (!publicMode || !isTunnelRequest(req)) return next();
    const route = `${req.method} ${req.path}`;
    const rule = ruleByRoute.get(route);
    if (!rule) return next();

    const currentTime = now();
    sweepExpired(currentTime);
    const clientIp = safeString(req.get("cf-connecting-ip")).trim() || "tunnel-unknown";
    const key = `${route}\0${clientIp}`;
    const entry = clients.get(key) || { route, requests: [], active: 0 };
    const cutoff = currentTime - Number(rule.windowMs);
    entry.requests = entry.requests.filter((timestamp) => timestamp > cutoff);
    clients.set(key, entry);

    if (entry.requests.length >= Number(rule.maxRequests)) {
      const retryAt = entry.requests[0] + Number(rule.windowMs);
      res.set("Retry-After", String(Math.max(1, Math.ceil((retryAt - currentTime) / 1000))));
      return res.status(429).json({ ok: false, error: "Too many public requests. Please try again later." });
    }
    if (entry.active >= Number(rule.maxConcurrent)) {
      res.set("Retry-After", "1");
      return res.status(429).json({ ok: false, error: "Too many public requests are already running." });
    }

    entry.requests.push(currentTime);
    entry.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    return next();
  };
}

export function createPublicAccessGuard({
  publicMode = false,
  allowOrigins = "",
  allowlist = STUDENT_PUBLIC_ALLOWLIST,
} = {}) {
  const allowed = new Set(allowlist.map((entry) => `${entry.method} ${entry.path}`));
  const origins = safeString(allowOrigins)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  function isTemporaryContentSafetyMediaRequest(req) {
    return req.method === "GET" && /^\/api\/wechat\/content-safety-media\/[A-Za-z0-9_-]{24,160}$/.test(req.path);
  }

  return function publicAccessGuard(req, res, next) {
    if (!publicMode) return next();
    if (!isTunnelRequest(req)) return next();

    const requestOrigin = safeString(req.get("origin")).trim();
    if (requestOrigin && origins.includes(requestOrigin)) {
      res.set("Access-Control-Allow-Origin", requestOrigin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    if (allowed.has(`${req.method} ${req.path}`) || isTemporaryContentSafetyMediaRequest(req)) {
      return next();
    }

    return res.status(403).json({
      ok: false,
      error: "This endpoint is not available on the public site.",
    });
  };
}
