import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const app = read("app.js");
const api = read("utils/api.js");
const upload = read("pages/upload/upload.js");
const records = read("pages/records/records.js");
const feedback = read("pages/feedback/feedback.js");
const feedbackView = read("pages/feedback/feedback.wxml");
const reviewScore = read("pages/review-score/review-score.js");
const library = read("pages/library/library.js");
const score = read("pages/score/score.js");
const profile = read("pages/profile/profile.js");
const project = JSON.parse(read("project.config.json"));
const javascript = [app, api, upload, records, feedback, reviewScore, library, score, profile].join("\n");

assert.match(app, /apiBase:\s*"https:\/\/api\.stringinstrumentdiagnosis\.icu"/);
assert.equal(project.setting.urlCheck, true, "committed project config must enforce legal domains");

assert.match(api, /url:\s*base\(\)\s*\+\s*"\/api\/strings\/analyze"/);
assert.match(api, /name:\s*"audio"/);
assert.match(api, /payload\.clientPlatform\s*=\s*"wechat-mini-program"/);
assert.match(api, /payload\.wechatLoginCode\s*=\s*loginCode/);

for (const field of ["studentRef", "piece", "pieceId", "scoreId", "instrument", "audioSubmission"]) {
  assert.match(upload, new RegExp(`\\b${field}\\s*:`), `analyze payload must include ${field}`);
}

assert.match(records, /"\/api\/strings\/student-submissions"/);
assert.match(feedbackView, /\bteacherFeedback\b/);
assert.match(feedback, /\bpieceId\b/);
assert.match(feedback, /\bsubmissionId\b/);
assert.match(reviewScore, /"\/api\/strings\/score-editions"/);
assert.match(reviewScore, /"\/api\/strings\/score-diagnosis"/);
assert.match(reviewScore, /\bmeasureIssues\b/);
assert.match(reviewScore, /\bnoteIssues\b/);
assert.match(library, /edition\.scoreId/, "library must hide editions without an analyzable store score");
assert.match(score, /setStorageSync\("selectedScoreId"/, "score selection must preserve the real store scoreId");
assert.match(upload, /scoreId:\s*this\.data\.selectedScoreId/, "analyze payload must use the real store scoreId");

const allowedPublicPaths = new Set([
  "/api/strings/analyze",
  "/api/strings/student-submissions",
  "/api/strings/content-safety-status",
  "/api/strings/score-editions",
  "/api/strings/score-render",
  "/api/strings/score-coordinates",
  "/api/strings/score-diagnosis",
]);
for (const match of javascript.matchAll(/["'](\/api\/[^"'?]+)/g)) {
  assert.equal(allowedPublicPaths.has(match[1]), true, `unexpected Mini Program API path: ${match[1]}`);
}

for (const forbidden of [
  "/api/strings/controlled-submissions",
  "/api/strings/controlled-submissions/run-batch",
  "/api/strings/review",
  "/api/ops",
  "/data/",
]) {
  assert.equal(javascript.includes(forbidden), false, `Mini Program must not call ${forbidden}`);
}

console.log("Mini Program student contract audit passed");
