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

// Trust model: the backend must bind 127.0.0.1 in public mode so the ONLY way
// in from the internet is cloudflared, which always stamps `cf-connecting-ip` /
// `cf-ray`. A request without those headers therefore came from this machine
// (the operator's local browser) and is trusted; a request with them came
// through the tunnel and is limited to the allowlist. If the port were bound to
// 0.0.0.0 this assumption would break, so the production launcher sets the bind
// host explicitly and this guard documents the dependency.
function isTunnelRequest(req) {
  return Boolean(safeString(req.get("cf-connecting-ip")).trim() || safeString(req.get("cf-ray")).trim());
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
