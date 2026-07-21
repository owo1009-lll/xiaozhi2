import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACK_CONTRACT = "western-round5-review-assist-calibration-pack-v1";
const TARGET_CONTRACT = "western-round5-targeted-diagnosis-intake-v1";
const DEFAULT_PACK = path.join("data", "experiments", "western-strings-round5-review-assist-calibration-pack");
const DEFAULT_OUT = path.join("data", "private", "western-strings-round5-review-assist-calibration-draft");
const LABELS = new Set(["positive", "confusion_negative", "uncertain"]);
const GATES = new Set(["merged_substitution", "missing", "extra", "drag"]);

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function workspacePath(root, value) {
  const text = safeString(value);
  if (!text || path.isAbsolute(text)) return "";
  const resolved = path.resolve(root, text);
  return isInside(root, resolved) ? resolved : "";
}

function relativePath(root, value) {
  return path.relative(root, value).replace(/\\/g, "/");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows, fields) {
  return `${[fields, ...rows.map((row) => fields.map((field) => row[field] ?? ""))]
    .map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

async function copyBoundSource({ root, sourcePath, expectedSha256, targetPath }) {
  const source = workspacePath(root, sourcePath);
  if (!source) throw new Error(`source-path-invalid:${sourcePath}`);
  const bytes = await fs.readFile(source);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error(`source-sha-mismatch:${sourcePath}`);
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(source, targetPath);
}

export async function stageReviewAssistCalibration({
  repoRoot = process.cwd(),
  packDir = DEFAULT_PACK,
  completedPath = path.join(DEFAULT_PACK, "round5-review-assist-calibration.completed.json"),
  outDir = DEFAULT_OUT,
} = {}) {
  const root = path.resolve(repoRoot);
  const pack = path.resolve(root, packDir);
  const completedFile = path.resolve(root, completedPath);
  const output = path.resolve(root, outDir);
  if (!isInside(root, pack) || !isInside(root, completedFile) || !isInside(root, output)) {
    throw new Error("review-assist-calibration-path-outside-workspace");
  }
  const [ledgerBytes, completedBytes] = await Promise.all([
    fs.readFile(path.join(pack, "ledger.json")),
    fs.readFile(completedFile),
  ]);
  const ledgerSha256 = sha256(ledgerBytes);
  const ledger = JSON.parse(ledgerBytes.toString("utf8"));
  const completed = JSON.parse(completedBytes.toString("utf8"));
  const blockers = [];
  if (ledger.contract !== PACK_CONTRACT || completed.contract !== PACK_CONTRACT) blockers.push("review-pack-contract-invalid");
  if (completed.ledgerSha256 !== ledgerSha256) blockers.push("review-pack-ledger-sha-mismatch");
  if (ledger.calibrationOnly !== true || ledger.freshBlindEligible !== false
      || completed.calibrationOnly !== true || completed.freshBlindEligible !== false) {
    blockers.push("review-pack-calibration-boundary-invalid");
  }

  const ledgerByIdentity = new Map((ledger.rows || []).map((row) => [safeString(row.identityKey), row]));
  const seen = new Set();
  const accepted = [];
  const excludedUncertain = [];
  for (const [index, review] of (Array.isArray(completed.reviews) ? completed.reviews : []).entries()) {
    const identityKey = safeString(review.identityKey);
    const row = ledgerByIdentity.get(identityKey);
    if (!row) {
      blockers.push(`review-identity-unknown:${index}`);
      continue;
    }
    if (seen.has(identityKey)) {
      blockers.push(`review-identity-duplicate:${identityKey}`);
      continue;
    }
    seen.add(identityKey);
    const label = safeString(review.label);
    if (!LABELS.has(label)) {
      blockers.push(`review-label-invalid:${identityKey}`);
      continue;
    }
    if (label === "uncertain") {
      excludedUncertain.push(identityKey);
      continue;
    }
    const gate = safeString(review.gate);
    if (!GATES.has(gate)) blockers.push(`review-gate-invalid:${identityKey}`);
    if (!safeString(review.reviewedBy)) blockers.push(`reviewer-missing:${identityKey}`);
    if (!safeString(review.asPerformed)) blockers.push(`as-performed-missing:${identityKey}`);
    if (label === "confusion_negative" && !safeString(review.confusionKind)) {
      blockers.push(`confusion-kind-missing:${identityKey}`);
    }
    accepted.push({ row, review: { ...review, identityKey, label, gate } });
  }
  if (!accepted.length) blockers.push("review-pack-no-usable-labels");

  const metadata = completed.recordingMetadata && typeof completed.recordingMetadata === "object"
    ? completed.recordingMetadata : {};
  const byRecording = new Map();
  for (const acceptedRow of accepted) {
    const recordingId = safeString(acceptedRow.row.recordingId);
    if (!byRecording.has(recordingId)) byRecording.set(recordingId, []);
    byRecording.get(recordingId).push(acceptedRow);
  }
  for (const recordingId of byRecording.keys()) {
    const item = metadata[recordingId] || {};
    for (const field of ["performerId", "deviceId", "roomId"]) {
      if (!safeString(item[field])) blockers.push(`recording-metadata-missing:${recordingId}:${field}`);
    }
    if (safeString(item.consent).toLowerCase() !== "yes") blockers.push(`recording-consent-invalid:${recordingId}`);
    if (safeString(item.licenseStatus) !== "local-only") blockers.push(`recording-license-invalid:${recordingId}`);
  }
  if (blockers.length) {
    return {
      ok: false,
      staged: false,
      calibrationOnly: true,
      freshBlindEligible: false,
      usableLabelCount: accepted.length,
      excludedUncertainCount: excludedUncertain.length,
      blockingReasons: [...new Set(blockers)].sort(),
    };
  }

  const manifestRows = [];
  const truthRecordings = {};
  for (const [recordingId, recordingRows] of byRecording) {
    const first = recordingRows[0].row;
    const item = metadata[recordingId];
    const audioExtension = path.extname(first.audioSourcePath) || ".m4a";
    const scoreExtension = path.extname(first.scoreSourcePath) || ".musicxml";
    const audioTarget = path.join(output, "files", `${recordingId}${audioExtension}`);
    const scoreTarget = path.join(output, "files", `${recordingId}${scoreExtension}`);
    await copyBoundSource({ root, sourcePath: first.audioSourcePath, expectedSha256: first.audioSourceSha256, targetPath: audioTarget });
    await copyBoundSource({ root, sourcePath: first.scoreSourcePath, expectedSha256: first.scoreSourceSha256, targetPath: scoreTarget });
    manifestRows.push({
      recordingId,
      pieceId: first.pieceId,
      performerId: safeString(item.performerId),
      deviceId: safeString(item.deviceId),
      roomId: safeString(item.roomId),
      split: "calibration",
      audioPath: relativePath(root, audioTarget),
      scorePath: relativePath(root, scoreTarget),
      consent: "yes",
      licenseStatus: "local-only",
      source: "teacher-reviewed-policy-c-calibration",
    });
    truthRecordings[recordingId] = {
      completeErrorInventory: false,
      events: recordingRows.map(({ row, review }) => ({
        gate: review.gate,
        label: review.label,
        measure: row.measure,
        beat: row.beat,
        scoreMidi: row.scoreMidi,
        asPerformed: safeString(review.asPerformed),
        ...(review.label === "confusion_negative" ? { confusionKind: safeString(review.confusionKind) } : {}),
        reviewedBy: safeString(review.reviewedBy),
        comments: safeString(review.comments),
        sourceIdentityKey: row.identityKey,
        sourceSemantic: row.sourceSemantic,
      })),
    };
  }
  await fs.mkdir(output, { recursive: true });
  const manifestFields = [
    "recordingId", "pieceId", "performerId", "deviceId", "roomId", "split",
    "audioPath", "scorePath", "consent", "licenseStatus", "source",
  ];
  const manifestBytes = csv(manifestRows, manifestFields);
  const truth = {
    contractVersion: TARGET_CONTRACT,
    scope: "calibration-draft-only",
    calibrationOnly: true,
    freshBlindEligible: false,
    sourceLedgerSha256: ledgerSha256,
    recordings: truthRecordings,
  };
  const truthBytes = `${JSON.stringify(truth, null, 2)}\n`;
  await fs.writeFile(path.join(output, "manifest.csv"), manifestBytes, "utf8");
  await fs.writeFile(path.join(output, "position-truth.json"), truthBytes, "utf8");
  const report = {
    ok: true,
    staged: true,
    contract: "western-round5-review-assist-calibration-draft-v1",
    calibrationOnly: true,
    freshBlindEligible: false,
    ledgerSha256,
    recordingCount: manifestRows.length,
    usableLabelCount: accepted.length,
    excludedUncertainCount: excludedUncertain.length,
    paths: {
      manifest: relativePath(root, path.join(output, "manifest.csv")),
      truth: relativePath(root, path.join(output, "position-truth.json")),
    },
    hashes: { manifestSha256: sha256(manifestBytes), truthSha256: sha256(truthBytes) },
    blockingReasons: [],
  };
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--pack-dir") args.packDir = argv[++index];
    else if (argv[index] === "--completed") args.completedPath = argv[++index];
    else if (argv[index] === "--out-dir") args.outDir = argv[++index];
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  stageReviewAssistCalibration(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
