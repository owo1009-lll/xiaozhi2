import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const outputRoot = path.join(repoRoot, "data", "real-tests", "separation-quality");

function parseArgs(argv) {
  const result = {
    all: false,
    roots: [],
    limit: 20,
    lowConfidenceThreshold: 0.4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      result.all = true;
    } else if (arg === "--root") {
      result.roots.push(argv[++index]);
    } else if (arg === "--limit") {
      result.limit = Number(argv[++index]) || result.limit;
    } else if (arg === "--low-confidence") {
      result.lowConfidenceThreshold = Number(argv[++index]) || result.lowConfidenceThreshold;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    }
  }
  return result;
}

function usage() {
  return [
    "Usage: node scripts/audit-separation-quality.mjs [--all] [--root <file-or-dir>] [--limit <n>] [--low-confidence <ratio>]",
    "",
    "Default: scan the latest real-corpus run-summary.json.",
    "--all: scan real-corpus run summaries, piece-pass JSON, and section-analysis-cache JSON.",
  ].join("\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 4) {
  const numeric = numberOrNull(value);
  if (numeric === null) return null;
  return Number(numeric.toFixed(digits));
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function latestRealCorpusSummary() {
  const corpusRoot = path.join(repoRoot, "data", "real-tests", "corpus-runs");
  if (!fs.existsSync(corpusRoot)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(corpusRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(corpusRoot, entry.name, "run-summary.json");
    if (fs.existsSync(summaryPath)) {
      candidates.push({ summaryPath, name: entry.name });
    }
  }
  candidates.sort((left, right) => right.name.localeCompare(left.name));
  for (const candidate of candidates) {
    const text = fs.readFileSync(candidate.summaryPath, "utf8");
    if (text.includes("separationConfidence")) return candidate.summaryPath;
  }
  return candidates[0]?.summaryPath || null;
}

function collectRunSummaries(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(rootDir, entry.name, "run-summary.json");
    if (fs.existsSync(summaryPath)) files.push(summaryPath);
  }
  return files;
}

function collectJsonFiles(targetPath) {
  const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(repoRoot, targetPath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return absolutePath.endsWith(".json") ? [absolutePath] : [];
  const files = [];
  const stack = [absolutePath];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        if (entry.name === "score-issue-review-sessions.json") continue;
        files.push(next);
      }
    }
  }
  return files;
}

function defaultScanFiles(args) {
  if (args.roots.length) {
    return args.roots.flatMap((root) => collectJsonFiles(root));
  }
  if (!args.all) {
    const latest = latestRealCorpusSummary();
    return latest ? [latest] : [];
  }
  return [
    ...collectRunSummaries(path.join(repoRoot, "data", "real-tests", "corpus-runs")),
    ...collectJsonFiles(path.join(repoRoot, "data", "piece-pass")),
    ...collectJsonFiles(path.join(repoRoot, "data", "section-analysis-cache")),
  ];
}

function sourceKind(filePath) {
  const relative = relativePath(filePath);
  if (relative.startsWith("data/real-tests/corpus-runs/")) return "real-corpus";
  if (relative.startsWith("data/section-analysis-cache/")) return "section-analysis-cache";
  if (relative.startsWith("data/piece-pass/")) return "piece-pass";
  return "json";
}

function contextFromObject(object, parentContext) {
  const context = { ...parentContext };
  for (const key of ["analysisId", "scoreId", "pieceId", "sectionId", "sectionTitle", "audioHash"]) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== "") {
      context[key] = String(object[key]);
    }
  }
  if (object?.pieceTitle) {
    context.pieceTitle = String(object.pieceTitle);
  } else if (!context.pieceTitle && object?.title && typeof object.title === "string") {
    context.pieceTitle = object.title;
  }
  if (object?.piecePassJob?.pieceTitle) context.pieceTitle = String(object.piecePassJob.pieceTitle);
  return context;
}

function extractRecord(object, context, filePath, pointer) {
  const diagnostics = object?.diagnostics && typeof object.diagnostics === "object" ? object.diagnostics : {};
  const pick = (key) => (object?.[key] !== undefined ? object[key] : diagnostics[key]);
  const confidence = numberOrNull(pick("separationConfidence"));
  if (confidence === null) return null;
  return {
    sourceKind: sourceKind(filePath),
    sourcePath: relativePath(filePath),
    jsonPath: pointer,
    analysisId: object?.analysisId || context.analysisId || "",
    scoreId: object?.scoreId || context.scoreId || "",
    pieceId: object?.pieceId || context.pieceId || "",
    pieceTitle: object?.pieceTitle || context.pieceTitle || "",
    sectionId: object?.sectionId || context.sectionId || "",
    sectionTitle: object?.sectionTitle || context.sectionTitle || "",
    audioHash: object?.audioHash || context.audioHash || "",
    separationApplied: Boolean(pick("separationApplied")),
    separationMode: String(pick("separationMode") || ""),
    separationConfidence: round(confidence),
    separationEnergyRatio: round(pick("separationEnergyRatio")),
    separationScoreBandRatio: round(pick("separationScoreBandRatio")),
    separationConfidentPitchCount: numberOrNull(pick("separationConfidentPitchCount")),
    separationScoreBandHitCount: numberOrNull(pick("separationScoreBandHitCount")),
    durationSeconds: round(pick("durationSeconds"), 3),
    scoreNoteCount: numberOrNull(pick("scoreNoteCount")),
    pitchTrackCount: numberOrNull(pick("pitchTrackCount")),
    rawAudioPath: String(pick("rawAudioPath") || ""),
    erhuEnhancedAudioPath: String(pick("erhuEnhancedAudioPath") || ""),
    accompanimentResidualPath: String(pick("accompanimentResidualPath") || ""),
  };
}

function scanValue(value, context, filePath, pointer, records) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, context, filePath, `${pointer}/${index}`, records));
    return;
  }
  const nextContext = contextFromObject(value, context);
  const record = extractRecord(value, nextContext, filePath, pointer);
  if (record) {
    records.push(record);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    scanValue(child, nextContext, filePath, `${pointer}/${key}`, records);
  }
}

function summarize(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0 };
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    p10: round(pick(0.1)),
    p25: round(pick(0.25)),
    p50: round(pick(0.5)),
    p75: round(pick(0.75)),
    p90: round(pick(0.9)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
  };
}

function hasQualityBreakdown(record) {
  return record.separationEnergyRatio !== null || record.separationScoreBandRatio !== null;
}

function hasInconsistentQualityBreakdown(record) {
  if (!hasQualityBreakdown(record)) return false;
  const energyRatio = record.separationEnergyRatio ?? 0;
  const scoreBandRatio = record.separationScoreBandRatio ?? 0;
  const confidentPitchCount = record.separationConfidentPitchCount ?? 0;
  const scoreBandHitCount = record.separationScoreBandHitCount ?? 0;
  return (
    record.separationConfidence > 0.13
    && energyRatio === 0
    && scoreBandRatio === 0
    && confidentPitchCount === 0
    && scoreBandHitCount === 0
  );
}

function groupByPiece(records, lowConfidenceThreshold) {
  const groups = new Map();
  for (const record of records) {
    const key = record.pieceTitle || record.scoreId || record.pieceId || "(unknown)";
    if (!groups.has(key)) {
      groups.set(key, {
        pieceTitle: key,
        count: 0,
        separationAppliedCount: 0,
        lowConfidenceCount: 0,
        confidenceValues: [],
        energyRatioValues: [],
        scoreBandRatioValues: [],
        minConfidence: null,
        worstSourcePath: "",
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if (record.separationApplied) group.separationAppliedCount += 1;
    if (record.separationConfidence < lowConfidenceThreshold) group.lowConfidenceCount += 1;
    group.confidenceValues.push(record.separationConfidence);
    if (record.separationEnergyRatio !== null) group.energyRatioValues.push(record.separationEnergyRatio);
    if (record.separationScoreBandRatio !== null) group.scoreBandRatioValues.push(record.separationScoreBandRatio);
    if (group.minConfidence === null || record.separationConfidence < group.minConfidence) {
      group.minConfidence = record.separationConfidence;
      group.worstSourcePath = record.sourcePath;
    }
  }
  return [...groups.values()]
    .map((group) => ({
      pieceTitle: group.pieceTitle,
      count: group.count,
      separationAppliedCount: group.separationAppliedCount,
      lowConfidenceCount: group.lowConfidenceCount,
      minConfidence: round(group.minConfidence),
      meanConfidence: summarize(group.confidenceValues).mean,
      meanEnergyRatio: summarize(group.energyRatioValues).mean,
      meanScoreBandRatio: summarize(group.scoreBandRatioValues).mean,
      worstSourcePath: group.worstSourcePath,
    }))
    .sort((left, right) => (
      right.lowConfidenceCount - left.lowConfidenceCount
      || left.minConfidence - right.minConfidence
      || String(left.pieceTitle).localeCompare(String(right.pieceTitle), "zh-Hans-CN")
    ));
}

function writeMarkdown(report, filePath) {
  const lines = [
    "# Separation Quality Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Scanned files: ${report.scannedFileCount}`,
    `- Separation records: ${report.recordCount}`,
    `- Records with energy/score-band metrics: ${report.recordsWithQualityBreakdown}`,
    `- Usable records with energy/score-band metrics: ${report.recordsWithUsableQualityBreakdown}`,
    `- Applied records with usable metrics: ${report.recordsWithAppliedQualityBreakdown}`,
    `- Auto-rejected records with usable metrics: ${report.recordsWithRejectedQualityBreakdown}`,
    `- Records missing energy/score-band metrics: ${report.recordsMissingQualityBreakdown}`,
    `- Inconsistent stale metric records: ${report.inconsistentQualityBreakdownCount}`,
    `- Separation applied records: ${report.separationAppliedCount}`,
    `- Low confidence threshold: ${report.lowConfidenceThreshold}`,
    `- Low confidence records: ${report.lowConfidenceCount}`,
    "",
    "## Confidence",
    "",
    `- min/p10/p50/p90/max: ${report.confidence.min ?? ""}/${report.confidence.p10 ?? ""}/${report.confidence.p50 ?? ""}/${report.confidence.p90 ?? ""}/${report.confidence.max ?? ""}`,
    `- mean: ${report.confidence.mean ?? ""}`,
    "",
    "## Energy Ratio",
    "",
    `- count: ${report.energyRatio.count || 0}`,
    `- min/p50/max: ${report.energyRatio.min ?? ""}/${report.energyRatio.p50 ?? ""}/${report.energyRatio.max ?? ""}`,
    "",
    "## Score-Band Ratio",
    "",
    `- count: ${report.scoreBandRatio.count || 0}`,
    `- min/p50/max: ${report.scoreBandRatio.min ?? ""}/${report.scoreBandRatio.p50 ?? ""}/${report.scoreBandRatio.max ?? ""}`,
    "",
    "## Applied Separation Metrics",
    "",
    `- confidence count/min/p50/max: ${report.appliedConfidence.count || 0}/${report.appliedConfidence.min ?? ""}/${report.appliedConfidence.p50 ?? ""}/${report.appliedConfidence.max ?? ""}`,
    `- energy count/min/p50/max: ${report.appliedEnergyRatio.count || 0}/${report.appliedEnergyRatio.min ?? ""}/${report.appliedEnergyRatio.p50 ?? ""}/${report.appliedEnergyRatio.max ?? ""}`,
    `- score-band count/min/p50/max: ${report.appliedScoreBandRatio.count || 0}/${report.appliedScoreBandRatio.min ?? ""}/${report.appliedScoreBandRatio.p50 ?? ""}/${report.appliedScoreBandRatio.max ?? ""}`,
    "",
    "## Auto-Rejected Separation Metrics",
    "",
    `- confidence count/min/p50/max: ${report.rejectedConfidence.count || 0}/${report.rejectedConfidence.min ?? ""}/${report.rejectedConfidence.p50 ?? ""}/${report.rejectedConfidence.max ?? ""}`,
    `- energy count/min/p50/max: ${report.rejectedEnergyRatio.count || 0}/${report.rejectedEnergyRatio.min ?? ""}/${report.rejectedEnergyRatio.p50 ?? ""}/${report.rejectedEnergyRatio.max ?? ""}`,
    `- score-band count/min/p50/max: ${report.rejectedScoreBandRatio.count || 0}/${report.rejectedScoreBandRatio.min ?? ""}/${report.rejectedScoreBandRatio.p50 ?? ""}/${report.rejectedScoreBandRatio.max ?? ""}`,
    "",
    "## Worst Applied Records",
    "",
    "| Piece | Section | Confidence | Energy | Score band | Applied | Source |",
    "| --- | --- | ---: | ---: | ---: | --- | --- |",
    ...(report.worstRecords.length
      ? report.worstRecords.map((record) => `| ${record.pieceTitle || record.scoreId || ""} | ${record.sectionTitle || record.sectionId || ""} | ${record.separationConfidence} | ${record.separationEnergyRatio ?? ""} | ${record.separationScoreBandRatio ?? ""} | ${record.separationApplied ? "yes" : "no"} | ${record.sourcePath} |`)
      : ["| None |  |  |  |  |  |  |"]),
    "",
    "## Auto-Rejected Records",
    "",
    "| Piece | Section | Confidence | Energy | Score band | Applied | Source |",
    "| --- | --- | ---: | ---: | ---: | --- | --- |",
    ...(report.rejectedRecords.length
      ? report.rejectedRecords.map((record) => `| ${record.pieceTitle || record.scoreId || ""} | ${record.sectionTitle || record.sectionId || ""} | ${record.separationConfidence} | ${record.separationEnergyRatio ?? ""} | ${record.separationScoreBandRatio ?? ""} | ${record.separationApplied ? "yes" : "no"} | ${record.sourcePath} |`)
      : ["| None |  |  |  |  |  |  |"]),
    "",
    "## By Piece",
    "",
    "| Piece | Records | Low confidence | Min confidence | Mean confidence | Applied | Worst source |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...(report.byPiece.length
      ? report.byPiece.map((item) => `| ${item.pieceTitle} | ${item.count} | ${item.lowConfidenceCount} | ${item.minConfidence ?? ""} | ${item.meanConfidence ?? ""} | ${item.separationAppliedCount} | ${item.worstSourcePath} |`)
      : ["| None | 0 | 0 |  |  | 0 |  |"]),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ["- None"]),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const files = [...new Set(defaultScanFiles(args))].sort();
const records = [];
const warnings = [];
for (const filePath of files) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    scanValue(parsed, {}, filePath, "", records);
  } catch (error) {
    warnings.push(`Skipped ${relativePath(filePath)}: ${error.message}`);
  }
}

const qualityBreakdownRecords = records.filter(hasQualityBreakdown);
const inconsistentQualityBreakdownRecords = qualityBreakdownRecords.filter(hasInconsistentQualityBreakdown);
const usableQualityBreakdownRecords = qualityBreakdownRecords.filter((record) => !hasInconsistentQualityBreakdown(record));
const usableAppliedRecords = usableQualityBreakdownRecords.filter((record) => record.separationApplied);
const usableRejectedRecords = usableQualityBreakdownRecords.filter((record) => !record.separationApplied);
const recordsWithQualityBreakdown = qualityBreakdownRecords.length;
const worstRecordCandidates = usableAppliedRecords.length
  ? usableAppliedRecords
  : usableQualityBreakdownRecords.length
    ? usableQualityBreakdownRecords
    : qualityBreakdownRecords.length
      ? qualityBreakdownRecords
      : records;
const rejectedRecordCandidates = usableRejectedRecords.length
  ? usableRejectedRecords
  : qualityBreakdownRecords.length
    ? qualityBreakdownRecords
    : records;
if (records.length && recordsWithQualityBreakdown === 0) {
  warnings.push("No records include separationEnergyRatio or separationScoreBandRatio yet; refresh analyses after the quality-metric change to populate them.");
}
if (inconsistentQualityBreakdownRecords.length) {
  warnings.push(`${inconsistentQualityBreakdownRecords.length} records have inconsistent separation quality metrics and were excluded from quality distributions; refresh those analyses to replace stale zeroed metrics.`);
}

const worstRecords = [...worstRecordCandidates]
  .sort((left, right) => (
    left.separationConfidence - right.separationConfidence
    || (left.separationEnergyRatio ?? 1) - (right.separationEnergyRatio ?? 1)
    || (left.separationScoreBandRatio ?? 1) - (right.separationScoreBandRatio ?? 1)
    || String(left.pieceTitle || left.sourcePath).localeCompare(String(right.pieceTitle || right.sourcePath), "zh-Hans-CN")
  ))
  .slice(0, Math.max(1, args.limit));
const rejectedRecords = [...rejectedRecordCandidates]
  .sort((left, right) => (
    left.separationConfidence - right.separationConfidence
    || (left.separationScoreBandRatio ?? 1) - (right.separationScoreBandRatio ?? 1)
    || String(left.pieceTitle || left.sourcePath).localeCompare(String(right.pieceTitle || right.sourcePath), "zh-Hans-CN")
  ))
  .slice(0, Math.max(1, args.limit));

const report = {
  generatedAt: new Date().toISOString(),
  scanMode: args.all ? "all" : "real-corpus",
  roots: args.roots.length ? args.roots : (args.all ? ["data/real-tests/corpus-runs", "data/piece-pass", "data/section-analysis-cache"] : [relativePath(files[0] || "")]),
  scannedFileCount: files.length,
  recordCount: records.length,
  recordsWithQualityBreakdown,
  recordsWithUsableQualityBreakdown: usableQualityBreakdownRecords.length,
  recordsWithAppliedQualityBreakdown: usableAppliedRecords.length,
  recordsWithRejectedQualityBreakdown: usableRejectedRecords.length,
  recordsMissingQualityBreakdown: Math.max(0, records.length - recordsWithQualityBreakdown),
  inconsistentQualityBreakdownCount: inconsistentQualityBreakdownRecords.length,
  worstRecordScope: usableAppliedRecords.length ? "applied-quality-breakdown" : (usableQualityBreakdownRecords.length ? "usable-quality-breakdown" : (qualityBreakdownRecords.length ? "quality-breakdown" : "all-records")),
  separationAppliedCount: records.filter((record) => record.separationApplied).length,
  lowConfidenceThreshold: args.lowConfidenceThreshold,
  lowConfidenceCount: records.filter((record) => record.separationConfidence < args.lowConfidenceThreshold).length,
  confidence: summarize(records.map((record) => record.separationConfidence)),
  energyRatio: summarize(usableQualityBreakdownRecords.map((record) => record.separationEnergyRatio).filter((value) => value !== null)),
  scoreBandRatio: summarize(usableQualityBreakdownRecords.map((record) => record.separationScoreBandRatio).filter((value) => value !== null)),
  appliedConfidence: summarize(usableAppliedRecords.map((record) => record.separationConfidence)),
  appliedEnergyRatio: summarize(usableAppliedRecords.map((record) => record.separationEnergyRatio).filter((value) => value !== null)),
  appliedScoreBandRatio: summarize(usableAppliedRecords.map((record) => record.separationScoreBandRatio).filter((value) => value !== null)),
  rejectedConfidence: summarize(usableRejectedRecords.map((record) => record.separationConfidence)),
  rejectedEnergyRatio: summarize(usableRejectedRecords.map((record) => record.separationEnergyRatio).filter((value) => value !== null)),
  rejectedScoreBandRatio: summarize(usableRejectedRecords.map((record) => record.separationScoreBandRatio).filter((value) => value !== null)),
  byPiece: groupByPiece(records, args.lowConfidenceThreshold),
  worstRecords,
  rejectedRecords,
  warnings,
};

ensureDir(outputRoot);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = path.join(outputRoot, `${stamp}-separation-quality.json`);
const latestJsonPath = path.join(outputRoot, "latest-separation-quality.json");
const latestMdPath = path.join(outputRoot, "latest-separation-quality.md");
const latestModeJsonPath = path.join(outputRoot, `latest-${report.scanMode}-separation-quality.json`);
const latestModeMdPath = path.join(outputRoot, `latest-${report.scanMode}-separation-quality.md`);
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
fs.writeFileSync(latestModeJsonPath, JSON.stringify(report, null, 2), "utf8");
writeMarkdown(report, latestMdPath);
writeMarkdown(report, latestModeMdPath);

console.log(JSON.stringify({
  scanMode: report.scanMode,
  scannedFileCount: report.scannedFileCount,
  recordCount: report.recordCount,
  recordsWithQualityBreakdown: report.recordsWithQualityBreakdown,
  recordsWithUsableQualityBreakdown: report.recordsWithUsableQualityBreakdown,
  recordsWithAppliedQualityBreakdown: report.recordsWithAppliedQualityBreakdown,
  recordsWithRejectedQualityBreakdown: report.recordsWithRejectedQualityBreakdown,
  recordsMissingQualityBreakdown: report.recordsMissingQualityBreakdown,
  inconsistentQualityBreakdownCount: report.inconsistentQualityBreakdownCount,
  worstRecordScope: report.worstRecordScope,
  separationAppliedCount: report.separationAppliedCount,
  lowConfidenceCount: report.lowConfidenceCount,
  confidence: report.confidence,
  energyRatio: report.energyRatio,
  scoreBandRatio: report.scoreBandRatio,
  appliedConfidence: report.appliedConfidence,
  appliedEnergyRatio: report.appliedEnergyRatio,
  appliedScoreBandRatio: report.appliedScoreBandRatio,
  rejectedConfidence: report.rejectedConfidence,
  rejectedEnergyRatio: report.rejectedEnergyRatio,
  rejectedScoreBandRatio: report.rejectedScoreBandRatio,
  worstRecords: report.worstRecords.slice(0, 10).map((record) => ({
    pieceTitle: record.pieceTitle,
    sectionTitle: record.sectionTitle,
    separationApplied: record.separationApplied,
    separationConfidence: record.separationConfidence,
    separationEnergyRatio: record.separationEnergyRatio,
    separationScoreBandRatio: record.separationScoreBandRatio,
    sourcePath: record.sourcePath,
  })),
  rejectedRecords: report.rejectedRecords.slice(0, 10).map((record) => ({
    pieceTitle: record.pieceTitle,
    sectionTitle: record.sectionTitle,
    separationApplied: record.separationApplied,
    separationConfidence: record.separationConfidence,
    separationEnergyRatio: record.separationEnergyRatio,
    separationScoreBandRatio: record.separationScoreBandRatio,
    sourcePath: record.sourcePath,
  })),
  warnings: report.warnings,
  output: relativePath(latestJsonPath),
  modeOutput: relativePath(latestModeJsonPath),
}, null, 2));
