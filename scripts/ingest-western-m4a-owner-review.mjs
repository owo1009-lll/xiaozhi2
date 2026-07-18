import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function ingestM4aOwnerReview({
  repoRoot = process.cwd(),
  source,
  replace = false,
} = {}) {
  const config = JSON.parse(await fs.readFile(
    path.join(repoRoot, "config", "western-m4a-real-photo-acceptance.json"),
    "utf8",
  ));
  const report = JSON.parse(await fs.readFile(
    path.join(repoRoot, config.outputRoot, "report.json"),
    "utf8",
  ));
  const sourcePath = path.resolve(source || path.join(repoRoot, "..", "m4a-owner-measure-review.json"));
  const bytes = await fs.readFile(sourcePath);
  const review = JSON.parse(bytes.toString("utf8"));
  const errors = [];
  if (review.contract !== "western-m4a-owner-measure-review-v1") errors.push("owner-review-contract-mismatch");
  if (review.evidenceDigest !== report.evidenceDigest) errors.push("owner-review-evidence-digest-mismatch");
  if (!String(review.reviewer || "").trim()) errors.push("owner-review-reviewer-missing");
  if (!String(review.reviewedAt || "").trim()) errors.push("owner-review-reviewed-at-missing");
  if (!Array.isArray(review.cases) || review.cases.length === 0) errors.push("owner-review-cases-missing");
  if ((review.cases || []).some((row) => row.allProjectedMeasureBoxesCorrect !== true)) {
    errors.push("owner-review-unconfirmed-case");
  }
  const destination = path.resolve(repoRoot, config.ownerReviewPath);
  let existingHash = "";
  try {
    existingHash = sha256(await fs.readFile(destination));
  } catch {
    existingHash = "";
  }
  const incomingHash = sha256(bytes);
  if (existingHash && existingHash !== incomingHash && !replace) {
    errors.push("different-owner-review-exists");
  }
  if (errors.length === 0) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (existingHash !== incomingHash) await fs.copyFile(sourcePath, destination);
  }
  return {
    contract: "western-m4a-owner-review-intake-v1",
    ready: errors.length === 0,
    blockingReasons: errors,
    source: sourcePath,
    destination: path.relative(repoRoot, destination).replace(/\\/g, "/"),
    sha256: incomingHash,
    status: errors.length ? "rejected" : existingHash === incomingHash ? "already-current" : "ingested",
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const result = await ingestM4aOwnerReview({
    source: argumentValue("--from") || undefined,
    replace: process.argv.includes("--replace"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
