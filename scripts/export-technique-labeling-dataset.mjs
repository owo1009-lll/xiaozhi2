// Export a per-note teacher-labeling dataset for the erhu technique judge (v1).
//
// Per docs/erhu-technique-labeling-schema.md this is PATH C: it emits only the
// features that real-corpus NoteFindings already persist (centsError, onsetErrorMs,
// rhythmType, ...). It does NOT fabricate the v2-only technique features
// (pitchSpreadCents / glideRunMs / vibratoAmplitudeCents / stablePointCount), so
// it cannot and does not claim to support the n6 case.
//
// It reuses the existing teacher-validation candidate collection rather than a
// parallel dataset, and writes both CSV (via the shared csv writer, so the
// quote/JSON-safe round-trip is identical to teacher packs) and JSON. The teacher
// labeling columns are appended at the end and left blank for the teacher to fill.
//
// Usage:
//   node scripts/export-technique-labeling-dataset.mjs [--unit section|whole-piece|both]
//        [--sources real-runs|teacher-grade-runs|all] [--max N] [--output-dir DIR]
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  collectTeacherValidationCandidates,
  selectTeacherValidationCandidates,
  toCsv,
  getArray,
  numeric,
  safeString,
} from "./teacher-validation-support.mjs";

const DEFAULT_OUTPUT_ROOT = path.join("data", "teacher-validation", "technique-labeling");

// v1 already-landed NoteFinding features (path C). Names match the real corpus
// NoteFinding exactly -- note `confidence`, NOT the internal `estimatedConfidence`.
const LANDED_FEATURE_KEYS = [
  "centsError", "rawCentsError", "pitchToleranceCents", "octaveFlexSemitones",
  "onsetErrorMs", "durationErrorMs", "expectedDurationMs", "observedDurationMs",
  "rhythmType", "rhythmLabel", "pitchLabel", "isUncertain", "severity",
  "evidenceLabel", "confidence",
];

// Empty teacher-labeling columns, appended at the end (schema doc: append-only).
const TEACHER_LABEL_KEYS = [
  "teacherLabel",          // pitch-error | rhythm-error | acceptable | expression-or-technique | review-unclear
  "teacherTechnique",      // none | glide | vibrato | trill | unknown-technique
  "teacherConfidence",     // high | medium | low
  "teacherComment",
];

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    repoRoot: REPO_ROOT,
    unit: "section",
    sources: "real-runs",
    max: 200,
    minSystemFindings: 0,
    requireTrustedAlignment: true,
    requireTeacherReadyTrusted: true,
    outputDir: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") parsed.repoRoot = path.resolve(argv[++index] || REPO_ROOT);
    else if (arg === "--unit") parsed.unit = argv[++index] || parsed.unit;
    else if (arg === "--sources") parsed.sources = argv[++index] || parsed.sources;
    else if (arg === "--max") parsed.max = Math.max(1, Number(argv[++index]) || parsed.max);
    else if (arg === "--min-system-findings") parsed.minSystemFindings = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--allow-untrusted-alignment") parsed.requireTrustedAlignment = false;
    // Escape hatch for diagnostics only; teacher-ready gate is on by default.
    else if (arg === "--allow-not-teacher-ready") parsed.requireTeacherReadyTrusted = false;
    else if (arg === "--output-dir") parsed.outputDir = path.resolve(parsed.repoRoot, argv[++index] || "");
  }
  if (!parsed.outputDir) {
    parsed.outputDir = path.join(parsed.repoRoot, DEFAULT_OUTPUT_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  }
  return parsed;
}

function noteRowsFromCandidate(candidate) {
  const analysis = candidate.analysis || {};
  const findings = getArray(analysis.noteFindings);
  return findings.map((finding) => {
    const row = {
      // Identity / locator
      caseId: candidate.caseId,
      analysisId: candidate.analysisId,
      pieceId: candidate.pieceId,
      pieceTitle: candidate.title,
      sectionId: candidate.sectionId,
      sectionTitle: candidate.sectionTitle,
      noteId: safeString(finding.noteId),
      measureIndex: numeric(finding.measureIndex) ?? "",
      // Audio presentation: whole clip + timestamps (schema doc v1; never empty path)
      sourceAudioPath: candidate.sourceAudioPath,
      sourcePdfPath: candidate.sourcePdfPath,
      noteStartSeconds: numeric(finding.startSeconds) ?? "",
      noteEndSeconds: numeric(finding.endSeconds) ?? "",
      pageNumber: numeric(finding.pageNumber) ?? "",
    };
    // v1 landed analysis features (path C)
    for (const key of LANDED_FEATURE_KEYS) {
      const value = finding[key];
      row[key] = value === undefined || value === null ? "" : value;
    }
    // Teacher columns appended last, blank for the teacher to fill
    for (const key of TEACHER_LABEL_KEYS) row[key] = "";
    return row;
  });
}

function main() {
  const options = parseArgs();
  const candidates = selectTeacherValidationCandidates(
    collectTeacherValidationCandidates({
      repoRoot: options.repoRoot,
      unit: options.unit,
      sources: options.sources,
    }),
    {
      max: options.max,
      minSystemFindings: options.minSystemFindings,
      requireTrustedAlignment: options.requireTrustedAlignment,
      requireTeacherReadyTrusted: options.requireTeacherReadyTrusted,
    },
  );

  const rows = candidates.flatMap(noteRowsFromCandidate);
  // A note row's audio path must never be empty (schema doc v1 guarantee).
  const rowsWithAudio = rows.filter((row) => safeString(row.sourceAudioPath).trim());
  const droppedNoAudio = rows.length - rowsWithAudio.length;

  fs.mkdirSync(options.outputDir, { recursive: true });
  const csvPath = path.join(options.outputDir, "technique-labeling.csv");
  const jsonPath = path.join(options.outputDir, "technique-labeling.json");
  fs.writeFileSync(csvPath, toCsv(rowsWithAudio), "utf8");
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      featureLevel: "v1-landed-only",
      schemaDoc: "docs/erhu-technique-labeling-schema.md",
      unit: options.unit,
      sources: options.sources,
      candidateCount: candidates.length,
      noteRowCount: rowsWithAudio.length,
      droppedNoAudioRows: droppedNoAudio,
      landedFeatureKeys: LANDED_FEATURE_KEYS,
      teacherLabelKeys: TEACHER_LABEL_KEYS,
      rows: rowsWithAudio,
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(JSON.stringify({
    ok: true,
    outputDir: path.relative(options.repoRoot, options.outputDir),
    candidateCount: candidates.length,
    noteRowCount: rowsWithAudio.length,
    droppedNoAudioRows: droppedNoAudio,
    csv: path.relative(options.repoRoot, csvPath),
    json: path.relative(options.repoRoot, jsonPath),
    note: candidates.length === 0
      ? "No teacher-validation candidates found; check real-corpus runs exist."
      : undefined,
  }, null, 2));
}

main();
