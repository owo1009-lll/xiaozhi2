import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ingestM4aOwnerReview } from "./ingest-western-m4a-owner-review.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "western-m4a-owner-review-"));
try {
  const repo = path.join(temporary, "repo");
  await fs.mkdir(path.join(repo, "config"), { recursive: true });
  await fs.mkdir(path.join(repo, "out"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "config", "western-m4a-real-photo-acceptance.json"),
    JSON.stringify({ outputRoot: "out", ownerReviewPath: "private/review.json" }),
  );
  await fs.writeFile(path.join(repo, "out", "report.json"), JSON.stringify({ evidenceDigest: "abc123" }));
  const source = path.join(temporary, "review.json");
  const review = {
    contract: "western-m4a-owner-measure-review-v1",
    evidenceDigest: "abc123",
    reviewer: "owner",
    reviewedAt: "2026-07-19T00:00:00Z",
    cases: [{ caseId: "case-1", allProjectedMeasureBoxesCorrect: true, confirmedMeasureCount: 1 }],
  };
  await fs.writeFile(source, JSON.stringify(review));
  const accepted = await ingestM4aOwnerReview({ repoRoot: repo, source });
  assert.equal(accepted.ready, true);
  const replay = await ingestM4aOwnerReview({ repoRoot: repo, source });
  assert.equal(replay.status, "already-current");
  review.evidenceDigest = "stale";
  await fs.writeFile(source, JSON.stringify(review));
  const stale = await ingestM4aOwnerReview({ repoRoot: repo, source, replace: true });
  assert.equal(stale.ready, false);
  assert(stale.blockingReasons.includes("owner-review-evidence-digest-mismatch"));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "owner-review-evidence-digest-bound",
    "owner-identity-and-all-case-confirmation-required",
    "idempotent-review-intake",
    "stale-review-rejected",
  ],
}, null, 2));
