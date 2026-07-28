import assert from "node:assert/strict";
import express from "express";

import {
  STUDENT_PUBLIC_ALLOWLIST,
  assertSafePublicBindHost,
  createPublicAccessGuard,
  createPublicRateLimiter,
} from "../src/server/publicAccessGuard.js";

const PUBLIC_ORIGIN = "https://stringinstrumentdiagnosis.icu";
const TUNNEL_HEADERS = { "cf-connecting-ip": "203.0.113.7", "cf-ray": "abc123-SJC" };

// Backend fixture: the guard first, then representative sensitive routes plus
// the student allowlist and the /data static leak surface.
function buildApp({ publicMode }) {
  const app = express();
  app.use(createPublicAccessGuard({ publicMode, allowOrigins: PUBLIC_ORIGIN }));
  app.use(createPublicRateLimiter({
    publicMode,
    rules: [{
      method: "POST",
      path: "/api/strings/analyze",
      windowMs: 60_000,
      maxRequests: 2,
      maxConcurrent: 1,
    }],
  }));
  app.use(express.json());
  app.get("/api/health", (req, res) => res.json({ ok: true, route: "health" }));
  app.get("/api/strings/student-gate", (req, res) => res.json({ ok: true, route: "student-gate" }));
  app.get("/api/strings/student-submissions", (req, res) => res.json({ ok: true, route: "student-submissions" }));
  app.get("/api/strings/content-safety-status", (req, res) => res.json({ ok: true, route: "content-safety-status" }));
  app.post("/api/strings/analyze", (req, res) => res.json({ ok: true, route: "analyze" }));
  app.get("/api/wechat/content-safety-callback", (req, res) => res.send("callback-check"));
  app.post("/api/wechat/content-safety-callback", (req, res) => res.send("success"));
  app.get("/api/wechat/content-safety-media/:token", (req, res) => res.json({ ok: true, route: "temporary-media" }));
  app.get("/api/strings/controlled-submissions", (req, res) => res.json({ ok: true, route: "review-queue" }));
  app.post("/api/strings/controlled-submissions/run-batch", (req, res) => res.json({ ok: true, route: "run-batch" }));
  app.get("/api/erhu/research/adjudications", (req, res) => res.json({ ok: true, route: "research" }));
  app.get("/data/private/secret.m4a", (req, res) => res.json({ ok: true, route: "private-data" }));
  app.get(/.*/, (req, res) => res.json({ ok: true, route: "spa-fallback" }));
  return app;
}

async function call(server, { method = "GET", path, headers = {}, body }) {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body,
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  return { status: response.status, body: responseBody, headers: response.headers };
}

async function withServer(app, run) {
  const server = app.listen(0);
  try {
    await run(server);
  } finally {
    server.close();
  }
}

// The allowlist must stay an explicit set of student/content-safety endpoints — a guard against
// someone widening the public surface by editing the list.
assert.deepEqual(
  STUDENT_PUBLIC_ALLOWLIST.map((entry) => `${entry.method} ${entry.path}`).sort(),
  [
    "GET /api/health",
    "GET /api/strings/content-safety-status",
    "GET /api/strings/score-coordinates",
    "GET /api/strings/score-diagnosis",
    "GET /api/strings/score-editions",
    "GET /api/strings/score-render",
    "GET /api/strings/student-gate",
    "GET /api/strings/student-submissions",
    "GET /api/wechat/content-safety-callback",
    "POST /api/strings/analyze",
    "POST /api/wechat/content-safety-callback",
  ],
  "public allowlist drifted",
);
assert.doesNotThrow(() => assertSafePublicBindHost({ publicMode: false, bindHost: "" }));
assert.doesNotThrow(() => assertSafePublicBindHost({ publicMode: true, bindHost: "127.0.0.1" }));
assert.doesNotThrow(() => assertSafePublicBindHost({ publicMode: true, bindHost: "::1" }));
assert.throws(
  () => assertSafePublicBindHost({ publicMode: true, bindHost: "" }),
  /loopback/,
  "public mode must fail closed when ERHU_BIND_HOST is missing",
);
assert.throws(
  () => assertSafePublicBindHost({ publicMode: true, bindHost: "0.0.0.0" }),
  /loopback/,
  "public mode must reject an all-interface bind",
);

// 1. Public mode OFF: every route answers regardless of headers (local dev).
await withServer(buildApp({ publicMode: false }), async (server) => {
  for (const path of ["/api/strings/controlled-submissions", "/data/private/secret.m4a", "/api/erhu/research/adjudications"]) {
    const res = await call(server, { path, headers: TUNNEL_HEADERS });
    assert.equal(res.status, 200, `public mode off must serve ${path}`);
  }
});

// 2. Public mode ON, tunnel traffic: student allowlist passes, everything else 403.
await withServer(buildApp({ publicMode: true }), async (server) => {
  const gate = await call(server, { path: "/api/strings/student-gate", headers: { ...TUNNEL_HEADERS, origin: PUBLIC_ORIGIN } });
  assert.equal(gate.status, 200, "student-gate must pass on the public site");
  assert.equal(gate.body.route, "student-gate");
  assert.equal(gate.headers.get("access-control-allow-origin"), PUBLIC_ORIGIN, "CORS origin must echo the allowed site");

  const analyze = await call(server, { method: "POST", path: "/api/strings/analyze", headers: TUNNEL_HEADERS });
  assert.equal(analyze.status, 200, "analyze must pass on the public site");
  const analyzeSecond = await call(server, {
    method: "POST",
    path: "/api/strings/analyze",
    headers: TUNNEL_HEADERS,
  });
  assert.equal(analyzeSecond.status, 200, "the configured request budget must permit its second request");
  const analyzeRateLimited = await call(server, {
    method: "POST",
    path: "/api/strings/analyze",
    headers: TUNNEL_HEADERS,
  });
  assert.equal(analyzeRateLimited.status, 429, "the public request budget must fail closed before the route runs");
  assert.equal(analyzeRateLimited.headers.get("retry-after"), "60");

  const health = await call(server, { path: "/api/health", headers: TUNNEL_HEADERS });
  assert.equal(health.status, 200, "health must pass on the public site");

  const callback = await call(server, { path: "/api/wechat/content-safety-callback", headers: TUNNEL_HEADERS });
  assert.equal(callback.status, 200, "WeChat callback verification must pass on the public site");

  const temporaryMedia = await call(server, {
    path: "/api/wechat/content-safety-media/abcdefghijklmnopqrstuvwx12345678",
    headers: TUNNEL_HEADERS,
  });
  assert.equal(temporaryMedia.status, 200, "a correctly shaped temporary content-safety URL must reach its handler");

  // Sensitive surfaces must be blocked for tunnel traffic.
  for (const probe of [
    { path: "/api/strings/controlled-submissions" },
    { method: "POST", path: "/api/strings/controlled-submissions/run-batch" },
    { path: "/api/erhu/research/adjudications" },
    { path: "/data/private/secret.m4a" },
    { path: "/api/wechat/content-safety-media/too-short" },
    { path: "/?mode=strings" },
  ]) {
    const res = await call(server, { ...probe, headers: TUNNEL_HEADERS });
    assert.equal(res.status, 403, `tunnel traffic must be blocked from ${probe.path}`);
    assert.equal(res.body?.route, undefined, `blocked route must not execute for ${probe.path}`);
  }

  const malformedJson = await call(server, {
    method: "POST",
    path: "/api/strings/controlled-submissions/run-batch",
    headers: { ...TUNNEL_HEADERS, "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(
    malformedJson.status,
    403,
    "the public guard must reject a private route before parsing its body",
  );

  // Preflight is answered without reaching a route.
  const preflight = await call(server, {
    method: "OPTIONS",
    path: "/api/strings/analyze",
    headers: { ...TUNNEL_HEADERS, origin: PUBLIC_ORIGIN },
  });
  assert.equal(preflight.status, 204, "OPTIONS preflight must be answered 204");
  assert.equal(preflight.headers.get("access-control-allow-origin"), PUBLIC_ORIGIN);

  // A disallowed origin must not receive a permissive CORS header.
  const foreign = await call(server, {
    path: "/api/strings/student-gate",
    headers: { ...TUNNEL_HEADERS, origin: "https://evil.example" },
  });
  assert.equal(foreign.headers.get("access-control-allow-origin"), null, "unlisted origin must not be echoed");
});

// 3. Public mode ON, local traffic (no tunnel headers): full backend stays usable.
await withServer(buildApp({ publicMode: true }), async (server) => {
  for (const probe of [
    { path: "/api/strings/controlled-submissions" },
    { path: "/api/erhu/research/adjudications" },
    { path: "/data/private/secret.m4a" },
    { path: "/?mode=strings" },
  ]) {
    const res = await call(server, probe);
    assert.equal(res.status, 200, `local operator traffic must still reach ${probe.path}`);
  }
});

console.log("western public access guard tests passed");
