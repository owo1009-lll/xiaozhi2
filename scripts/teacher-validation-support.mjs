import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseXmlNoteId, repairMojibakeText } from "../src/analysisLabels.js";
import {
  getErhuMelodyNotes,
  hasAccompanimentPartCandidate,
  noteIdMatchesIssue,
  noteMeasureMatchesIssue,
} from "../src/scoreIssue/scoreIssueProjection.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PACK_ROOT = path.join("data", "teacher-validation", "packs");

export function safeString(value, fallback = "") {
  const text = value == null ? "" : String(value);
  return text || fallback;
}

export function getArray(value) {
  return Array.isArray(value) ? value : [];
}

export function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

// Teacher-ready gate thresholds. Must stay in sync with the same constants in
// src/server/teacherValidationService.js so pack-time and server-time agree.
const TEACHER_READY_MIN_DURATION_RATIO = envNumber("ERHU_TEACHER_READY_MIN_DURATION_RATIO", 0.5);
// Mild padding overlap between adjacent windows is normal; only a SEVERE overlap
// (absolute seconds OR fraction of the shorter window) signals unreliable windows.
const TEACHER_READY_OVERLAP_MIN_SECONDS = envNumber("ERHU_TEACHER_READY_OVERLAP_MIN_SECONDS", 4.0);
const TEACHER_READY_OVERLAP_MIN_RATIO = envNumber("ERHU_TEACHER_READY_OVERLAP_MIN_RATIO", 0.25);
const TEACHER_READY_MIN_SYSTEM_FINDINGS = Math.max(0, Math.round(envNumber("ERHU_TEACHER_READY_MIN_SYSTEM_FINDINGS", 1)));
// Span/duration ratio upper bound: too-high = a few short sections scattered across
// far too much audio (content-DTW spreading similar passages over the whole piece).
const TEACHER_READY_MAX_DURATION_RATIO = envNumber("ERHU_TEACHER_READY_MAX_DURATION_RATIO", 2.0);
// Content alignment that fails the monotonic DP scatters its windows; reject a
// content path with too many out-of-order windows. Must match the server gate.
const TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE = envNumber(
  "ERHU_TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE",
  0.05,
);
// Coverage / largest inter-window gap: a monotonic content path can still skip large
// stretches of audio (ordered but wrong). Conservative fail-closed bounds; must match
// src/server/teacherValidationService.js.
const TEACHER_READY_MIN_COVERAGE_RATIO = envNumber("ERHU_TEACHER_READY_MIN_COVERAGE_RATIO", 0.6);
const TEACHER_READY_MAX_GAP_RATIO = envNumber("ERHU_TEACHER_READY_MAX_GAP_RATIO", 2.0);
// Trusted scan modes allowlist (not "anything != fast") so a new mode is not
// silently trusted. Must match src/server/teacherValidationService.js.
const TEACHER_READY_TRUSTED_SCAN_MODES = new Set(["analyzer-window", "content-aligned", "manual-anchor"]);

export function cleanText(value, fallback = "") {
  return repairMojibakeText(value) || safeString(value, fallback) || fallback;
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function toRepoRelative(repoRoot, filePath) {
  if (!filePath) return "";
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : absolute;
}

function normalizePathForCurrentRepo(repoRoot, filePath) {
  const text = safeString(filePath);
  if (!text) return "";
  if (!path.isAbsolute(text)) return path.resolve(repoRoot, text);
  if (fs.existsSync(text)) return text;
  const marker = `${path.sep}data${path.sep}`;
  const index = text.toLowerCase().lastIndexOf(marker);
  if (index >= 0) {
    const candidate = path.join(repoRoot, text.slice(index + 1));
    if (fs.existsSync(candidate)) return candidate;
  }
  return text;
}

function collectFiles(rootDir, predicate, out = []) {
  if (!rootDir || !fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const next = path.join(rootDir, entry.name);
    if (entry.isDirectory()) collectFiles(next, predicate, out);
    else if (entry.isFile() && predicate(next, entry)) out.push(next);
  }
  return out;
}

export function parseList(value) {
  if (Array.isArray(value)) return Array.from(new Set(value.map((item) => safeString(item).trim()).filter(Boolean)));
  return Array.from(new Set(safeString(value).split(/[\s,;|，；]+/).map((item) => item.trim()).filter(Boolean)));
}

export function parseNumberList(value) {
  return Array.from(
    new Set(
      parseList(value)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
        .map((item) => Math.round(item)),
    ),
  );
}

export function calculateBinaryMetrics(systemValues = [], teacherValues = []) {
  const systemSet = new Set(systemValues);
  const teacherSet = new Set(teacherValues);
  const matched = Array.from(teacherSet).filter((item) => systemSet.has(item));
  const precision = systemSet.size ? matched.length / systemSet.size : null;
  const recall = teacherSet.size ? matched.length / teacherSet.size : null;
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return {
    matched,
    matchedCount: matched.length,
    missedTeacherValues: Array.from(teacherSet).filter((item) => !systemSet.has(item)),
    extraSystemValues: Array.from(systemSet).filter((item) => !teacherSet.has(item)),
    precision,
    recall,
    f1,
  };
}

export function getSystemNoteIds(analysis = {}) {
  return Array.from(new Set(getArray(analysis.noteFindings).map((item) => safeString(item?.noteId)).filter(Boolean)));
}

export function getSystemMeasureIndexes(analysis = {}) {
  return Array.from(
    new Set(
      getArray(analysis.measureFindings)
        .map((item) => numeric(item?.measureIndex))
        .filter((item) => item != null)
        .map((item) => Math.round(item)),
    ),
  );
}

export function getRecommendedPracticePath(analysis = {}) {
  return safeString(analysis.recommendedPracticePath)
    || safeString(getArray(analysis.practiceTargets)[0]?.practicePath)
    || "review-first";
}

function collectRunSummaryFiles(repoRoot) {
  return collectFiles(path.join(repoRoot, "data", "real-tests", "corpus-runs"), (filePath) => path.basename(filePath) === "run-summary.json")
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      return rightStat.mtimeMs - leftStat.mtimeMs;
    });
}

function collectTeacherGradeRunSummaryFiles(repoRoot) {
  return collectFiles(path.join(repoRoot, "data", "teacher-validation", "alignment-runs"), (filePath) => path.basename(filePath) === "run-summary.json")
    .sort((left, right) => {
      const leftStat = fs.statSync(left);
      const rightStat = fs.statSync(right);
      return rightStat.mtimeMs - leftStat.mtimeMs;
    });
}

function loadScoreMap(repoRoot) {
  const scoreStore = readJson(path.join(repoRoot, "data", "erhu-score-imports.json"), {});
  return new Map(getArray(scoreStore.scores).map((score) => [safeString(score.scoreId), score]));
}

// Manual-anchor jobs (Plan C): human-anchored short windows written by
// scripts/build-manual-anchor-pack.mjs. Same job shape as the piece-pass store, so
// candidatesFromPieceJob handles them; their pass.json carries scanMode manual-anchor
// + manualAnchorConfirmed.
function collectManualAnchorJobs(repoRoot) {
  const store = readJson(path.join(repoRoot, "data", "teacher-manual-anchors", "manual-anchor-jobs.json"), {});
  return getArray(store.jobs);
}

function findTeacherScoreSection(score = {}, sectionId = "") {
  const sections = getArray(score.sections);
  if (!sections.length) return null;
  const targetSectionId = safeString(sectionId);
  if (targetSectionId) {
    const exact = sections.find((section) =>
      safeString(section.sectionId) === targetSectionId || safeString(section.sourceSectionId) === targetSectionId,
    );
    if (exact) return exact;
    const pageMatch = targetSectionId.match(/\bpage-(\d+)/i);
    if (pageMatch) {
      const pageNumber = Math.max(1, Math.round(numeric(pageMatch[1]) || 1));
      const pageSection = sections.find((section) => {
        const descriptor = `${safeString(section.sectionId)} ${safeString(section.sourceSectionId)}`;
        const match = descriptor.match(/\bpage-(\d+)/i);
        return match && Math.max(1, Math.round(numeric(match[1]) || 1)) === pageNumber;
      });
      if (pageSection) return pageSection;
    }
  }
  return sections[0] || null;
}

function isTeacherPagewiseSection(section = {}) {
  return /\bpage-\d+/i.test(`${safeString(section.sectionId)} ${safeString(section.sourceSectionId)} ${safeString(section.title)}`);
}

function hasGenericVoiceSelectedPart(section = {}, score = {}) {
  const labels = [
    section.selectedPart,
    section.selectedPartId,
    score.selectedPart,
    score.selectedPartId,
    ...getArray(section.partCandidates).flatMap((candidate) => [candidate?.id, candidate?.name, candidate?.label]),
    ...getArray(score.partCandidates).flatMap((candidate) => [candidate?.id, candidate?.name, candidate?.label]),
  ].map((value) => safeString(value)).join(" ");
  const explicitErhu = /\berhu\b|二胡/i.test(labels);
  return !explicitErhu && /\bvoice\b/i.test(labels);
}

function nullablePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function shouldUseTeacherFullScoreLineRankFilter(section = {}, score = {}) {
  if (!isTeacherPagewiseSection(section)) return false;
  const notes = getArray(section.notes);
  const lineRanks = new Set();
  let hasNonFirstStaff = false;
  for (const note of notes) {
    const position = note?.notePosition || {};
    const systemIndex = nullablePositiveInteger(position.systemIndex);
    if (systemIndex) lineRanks.add(systemIndex);
    if ((nullablePositiveInteger(position.staffIndex) || 1) !== 1) hasNonFirstStaff = true;
  }
  if (lineRanks.size < 2 || hasNonFirstStaff) return false;
  return hasAccompanimentPartCandidate(score)
    || hasAccompanimentPartCandidate(section)
    || hasGenericVoiceSelectedPart(section, score);
}

function isTeacherErhuLineRank(note = {}) {
  const systemIndex = nullablePositiveInteger(note?.notePosition?.systemIndex);
  return !systemIndex || (systemIndex - 1) % 3 === 0;
}

function filterTeacherLocatorNotesToErhuLineRank(notes = [], section = {}, score = {}) {
  if (!shouldUseTeacherFullScoreLineRankFilter(section, score)) return notes;
  return getArray(notes).filter((note) => isTeacherErhuLineRank(note));
}

function findingToIssue(finding = {}) {
  const noteId = safeString(finding.noteId);
  const parsed = parseXmlNoteId(noteId);
  return {
    ...finding,
    noteId,
    measureIndex: numeric(finding.measureIndex) || parsed?.measureIndex || 1,
  };
}

function filterAnalysisFindingsToProjectableErhu(score = {}, analysis = {}) {
  const section = findTeacherScoreSection(score, analysis.sectionId);
  const sectionNotes = getArray(section?.notes);
  if (!section || !sectionNotes.length) return analysis;
  const melodyNotes = filterTeacherLocatorNotesToErhuLineRank(getErhuMelodyNotes(section, score), section, score);
  if (!melodyNotes.length) {
    return {
      ...analysis,
      noteFindings: [],
      measureFindings: [],
    };
  }
  const isProjectable = (finding) => {
    const issue = findingToIssue(finding);
    return melodyNotes.some((note) => noteMeasureMatchesIssue(note, issue) && (!issue.noteId || noteIdMatchesIssue(note, issue)));
  };
  return {
    ...analysis,
    noteFindings: getArray(analysis.noteFindings).filter(isProjectable),
    measureFindings: getArray(analysis.measureFindings).filter((finding) => {
      const issue = findingToIssue(finding);
      return melodyNotes.some((note) => noteMeasureMatchesIssue(note, issue));
    }),
  };
}

function stableCaseId(parts = []) {
  return parts
    .map((part) => safeString(part).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("__")
    .slice(0, 180);
}

function buildOriginalAudio(repoRoot, result = {}, job = {}, wholeAnalysis = {}) {
  const existing = wholeAnalysis.originalAudio || job.primaryAnalysis?.originalAudio || null;
  if (existing?.url || existing?.audioHash) return existing;
  const audioPath = normalizePathForCurrentRepo(repoRoot, result.audioPath || job.audioPath || "");
  return {
    url: safeString(wholeAnalysis.audioUrl || wholeAnalysis.originalAudioUrl),
    filename: path.basename(audioPath || safeString(result.audioPath)),
    audioHash: safeString(job.audioHash || wholeAnalysis.audioHash),
    durationSeconds: numeric(wholeAnalysis.audioDurationSeconds),
  };
}

function buildAlignmentEvidence(passJson = {}) {
  const coverage = passJson?.summary?.audioCoverage || passJson?.audioCoverage || {};
  const sectionPasses = getArray(passJson?.sectionPasses);
  const scanMode = safeString(coverage.scanMode, "");
  const audioDurationSeconds = numeric(coverage.audioDurationSeconds);
  const estimatedPieceDurationSeconds = numeric(coverage.estimatedPieceDurationSeconds);
  const durationRatio =
    audioDurationSeconds && estimatedPieceDurationSeconds
      ? Number((estimatedPieceDurationSeconds / audioDurationSeconds).toFixed(3))
      : null;
  const scanModeTrusted = TEACHER_READY_TRUSTED_SCAN_MODES.has(scanMode);
  const totalSystemFindings = sectionPasses.reduce(
    (total, section) => total + getArray(section?.noteFindings).length + getArray(section?.measureFindings).length,
    0,
  );
  const windows = sectionPasses
    .map((section, index) => ({
      order: Number.isFinite(Number(section?.sequenceIndex)) ? Number(section.sequenceIndex) : index,
      start: numeric(section?.startSeconds),
      end: numeric(section?.endSeconds),
    }))
    .filter((window) => window.start != null && window.end != null && window.end > window.start)
    .sort((left, right) => left.order - right.order);
  const hasWindowOverlap = windows.some((window, index) => {
    if (index <= 0) return false;
    const prev = windows[index - 1];
    const overlap = prev.end - window.start;
    if (overlap <= 0) return false;
    const shorter = Math.min(prev.end - prev.start, window.end - window.start);
    const ratio = shorter > 0 ? overlap / shorter : 1;
    return overlap >= TEACHER_READY_OVERLAP_MIN_SECONDS || ratio >= TEACHER_READY_OVERLAP_MIN_RATIO;
  });
  // Coverage / largest inter-window gap (content-path "ordered but skips audio" guard).
  let alignedWindowCoverageRatio = null;
  let maxInterWindowGapSeconds = null;
  let maxInterWindowGapRatio = null;
  if (windows.length >= 1) {
    const sumDurations = windows.reduce((total, w) => total + (w.end - w.start), 0);
    const windowSpan = Math.max(...windows.map((w) => w.end)) - Math.min(...windows.map((w) => w.start));
    alignedWindowCoverageRatio = windowSpan > 0 ? Number((sumDurations / windowSpan).toFixed(3)) : null;
    let maxGap = 0;
    for (let index = 1; index < windows.length; index += 1) {
      maxGap = Math.max(maxGap, Math.max(0, windows[index].start - windows[index - 1].end));
    }
    maxInterWindowGapSeconds = Number(maxGap.toFixed(2));
    const durations = windows.map((w) => w.end - w.start).sort((a, b) => a - b);
    const medianDuration = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
    maxInterWindowGapRatio = medianDuration > 0 ? Number((maxGap / medianDuration).toFixed(3)) : null;
  }
  // Coverage-aware ratio: full uses estimatedPieceDuration/audio; partial uses
  // alignedSpan/expectedAlignedSpan. Both bounded -- too-low = crammed, too-high =
  // scattered (e.g. a 13s expected span aligned across 326s). Must match
  // src/server/teacherValidationService.js.
  const coverageMode = safeString(coverage.wholePieceCoverageMode || coverage.alignmentCoverageMode);
  const isPartialCoverage = coverageMode.startsWith("partial");
  const alignedSpanDurationSeconds = numeric(coverage.alignedSpanDurationSeconds);
  const expectedAlignedSpanDurationSeconds = numeric(coverage.expectedAlignedSpanDurationSeconds);
  const alignedSpanRatio = (alignedSpanDurationSeconds != null && expectedAlignedSpanDurationSeconds && expectedAlignedSpanDurationSeconds > 0)
    ? Number((alignedSpanDurationSeconds / expectedAlignedSpanDurationSeconds).toFixed(3))
    : null;
  // manual-anchor = human-verified audio/score window (technique-labeling from scratch);
  // the human verification IS the alignment evidence, so the automatic alignment gates
  // and no-system-findings do not apply -- BUT only when an explicit manualAnchorConfirmed
  // field is present (editing scanMode alone must not bypass). Must match the server gate.
  const isManualAnchor = scanMode === "manual-anchor";
  const manualAnchorConfirmed = coverage.manualAnchorConfirmed === true;
  const teacherReadyReasons = [];
  if (isManualAnchor) {
    if (!manualAnchorConfirmed) teacherReadyReasons.push("manual-anchor-unconfirmed");
  } else {
    if (isPartialCoverage) {
      if (alignedSpanRatio == null) {
        teacherReadyReasons.push("aligned-span-ratio-missing");
      } else {
        if (alignedSpanRatio < TEACHER_READY_MIN_DURATION_RATIO) teacherReadyReasons.push(`aligned-span-ratio-too-low:${alignedSpanRatio}`);
        if (alignedSpanRatio > TEACHER_READY_MAX_DURATION_RATIO) teacherReadyReasons.push(`aligned-span-ratio-too-high:${alignedSpanRatio}`);
      }
    } else if (durationRatio == null) {
      teacherReadyReasons.push("duration-ratio-too-low:missing");
    } else {
      if (durationRatio < TEACHER_READY_MIN_DURATION_RATIO) teacherReadyReasons.push(`duration-ratio-too-low:${durationRatio}`);
      if (durationRatio > TEACHER_READY_MAX_DURATION_RATIO) teacherReadyReasons.push(`duration-ratio-too-high:${durationRatio}`);
    }
    if (hasWindowOverlap) teacherReadyReasons.push("section-windows-overlap");
    if (totalSystemFindings < TEACHER_READY_MIN_SYSTEM_FINDINGS) teacherReadyReasons.push("no-system-findings");
  }
  // Monotonicity gate (Phase 1), applied ONLY to content-aligned scans. FAIL CLOSED:
  // an old content pack without these fields cannot be confirmed in-order, so it is
  // rejected rather than skipped. Must match src/server/teacherValidationService.js.
  const monotonicViolationRate = numeric(coverage.monotonicViolationRate);
  const greedyFallbackCount = numeric(coverage.greedyFallbackCount);
  const contentAlignmentMonotonic =
    typeof coverage.contentAlignmentMonotonic === "boolean" ? coverage.contentAlignmentMonotonic : null;
  if (scanMode === "content-aligned") {
    if (monotonicViolationRate == null) {
      teacherReadyReasons.push("content-path-monotonicity-missing");
    } else if (monotonicViolationRate > TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE) {
      teacherReadyReasons.push(`content-path-not-monotonic:${monotonicViolationRate}`);
    }
    const hasGreedyEvidence = greedyFallbackCount != null || typeof contentAlignmentMonotonic === "boolean";
    if (!hasGreedyEvidence) {
      teacherReadyReasons.push("content-path-greedy-evidence-missing");
    } else if ((greedyFallbackCount != null && greedyFallbackCount > 0) || contentAlignmentMonotonic === false) {
      teacherReadyReasons.push(`content-path-greedy-fallback:${greedyFallbackCount != null ? greedyFallbackCount : "unknown"}`);
    }
    // Coverage / gap: ordered windows that skip large stretches of audio. Fail closed
    // when the evidence is absent.
    if (alignedWindowCoverageRatio == null) {
      teacherReadyReasons.push("content-path-coverage-missing");
    } else if (alignedWindowCoverageRatio < TEACHER_READY_MIN_COVERAGE_RATIO) {
      teacherReadyReasons.push(`content-path-coverage-too-low:${alignedWindowCoverageRatio}`);
    }
    if (maxInterWindowGapRatio != null && maxInterWindowGapRatio > TEACHER_READY_MAX_GAP_RATIO) {
      teacherReadyReasons.push(`content-path-gap-too-large:${maxInterWindowGapRatio}`);
    }
  }
  const teacherReadyTrusted = scanModeTrusted && teacherReadyReasons.length === 0;
  return {
    trusted: scanModeTrusted,
    scanModeTrusted,
    teacherReadyTrusted,
    teacherReadyReasons,
    scanMode: scanMode || "unknown",
    audioDurationSeconds,
    estimatedPieceDurationSeconds,
    durationRatio,
    alignedSpanDurationSeconds,
    expectedAlignedSpanDurationSeconds,
    alignedSpanRatio,
    coverageMode: coverageMode || null,
    totalSystemFindings,
    hasWindowOverlap,
    monotonicViolationRate,
    greedyFallbackCount,
    contentAlignmentMonotonic,
    alignedWindowCoverageRatio,
    maxInterWindowGapSeconds,
    maxInterWindowGapRatio,
    manualAnchorConfirmed,
    teacherReadyThresholds: {
      minDurationRatio: TEACHER_READY_MIN_DURATION_RATIO,
      maxDurationRatio: TEACHER_READY_MAX_DURATION_RATIO,
      overlapMinSeconds: TEACHER_READY_OVERLAP_MIN_SECONDS,
      overlapMinRatio: TEACHER_READY_OVERLAP_MIN_RATIO,
      minSystemFindings: TEACHER_READY_MIN_SYSTEM_FINDINGS,
      maxMonotonicViolationRate: TEACHER_READY_MAX_MONOTONIC_VIOLATION_RATE,
      minCoverageRatio: TEACHER_READY_MIN_COVERAGE_RATIO,
      maxGapRatio: TEACHER_READY_MAX_GAP_RATIO,
    },
    reason: isManualAnchor
      ? "human-confirmed manual anchor (technique-labeling sample), not an analyzer scan"
      : scanModeTrusted
        ? "segment windows came from an analyzer-backed scan"
        : scanMode === "fast-sequence-window"
          ? "fast sequence windows are score-order estimates, not teacher-grade audio/PDF alignment"
          : "missing analyzer-backed alignment evidence",
  };
}

function normalizeAnalysisBase({ repoRoot, result = {}, job = {}, score = {}, analysis = {}, sectionPass = null, sourceKind = "unknown", alignmentEvidence = null }) {
  const whole = job.wholePieceAnalysis || analysis || {};
  const sectionId = safeString(sectionPass?.sectionId || analysis.sectionId || "whole-piece");
  const jobId = safeString(job.jobId || result.piecePassJobId || analysis.analysisId || "analysis");
  const audioHash = safeString(job.audioHash || analysis.audioHash || result.audioHash || whole.audioHash);
  const analysisId = safeString(
    sectionPass
      ? `${jobId}-${sectionId}`
      : analysis.analysisId || whole.analysisId || `${jobId}-whole-piece`,
  );
  const audioSegment = sectionPass
    ? {
        startSeconds: numeric(sectionPass.startSeconds),
        endSeconds: numeric(sectionPass.endSeconds),
        durationSeconds: numeric(sectionPass.durationSeconds),
      }
    : null;
  return {
    analysisId,
    participantId: safeString(job.participantId || analysis.participantId || whole.participantId, `teacher-corpus-${audioHash.slice(0, 8) || "unknown"}`),
    groupId: "teacher-validation-corpus",
    sessionStage: sectionPass ? "teacher-validation-section" : "teacher-validation-whole-piece",
    scoreId: safeString(job.scoreId || analysis.scoreId || score.scoreId),
    pieceId: safeString(job.pieceId || analysis.pieceId || score.pieceId || job.scoreId || score.scoreId),
    sectionId,
    pieceTitle: cleanText(job.pieceTitle || result.title || analysis.pieceTitle || score.title, "Untitled"),
    sectionTitle: cleanText(sectionPass?.sectionTitle || analysis.sectionTitle || "Whole piece", sectionId),
    audioHash,
    audioSubmission: job.audioSubmission || analysis.audioSubmission || whole.audioSubmission || null,
    originalAudio: buildOriginalAudio(repoRoot, result, job, whole),
    audioUrl: safeString(analysis.audioUrl || whole.audioUrl || whole.originalAudioUrl),
    originalAudioUrl: safeString(analysis.originalAudioUrl || whole.originalAudioUrl || whole.audioUrl),
    audioDurationSeconds: numeric(analysis.audioDurationSeconds ?? whole.audioDurationSeconds ?? job.summary?.audioCoverage?.audioDurationSeconds),
    audioSegment,
    overallPitchScore: numeric(sectionPass?.overallPitchScore ?? analysis.overallPitchScore),
    overallRhythmScore: numeric(sectionPass?.overallRhythmScore ?? analysis.overallRhythmScore),
    studentPitchScore: numeric(sectionPass?.studentPitchScore ?? analysis.studentPitchScore),
    studentRhythmScore: numeric(sectionPass?.studentRhythmScore ?? analysis.studentRhythmScore),
    studentCombinedScore: numeric(sectionPass?.studentCombinedScore ?? analysis.studentCombinedScore),
    confidence: numeric(sectionPass?.confidence ?? analysis.confidence ?? job.summary?.weightedConfidence),
    recommendedPracticePath: safeString(sectionPass?.recommendedPracticePath || analysis.recommendedPracticePath || job.summary?.dominantPracticePath, "review-first"),
    measureFindings: getArray(sectionPass?.measureFindings ?? analysis.measureFindings),
    noteFindings: getArray(sectionPass?.noteFindings ?? analysis.noteFindings),
    demoSegments: getArray(sectionPass?.demoSegments ?? analysis.demoSegments),
    summaryText: cleanText(sectionPass?.summaryText || analysis.summaryText),
    teacherComment: cleanText(sectionPass?.teacherComment || analysis.teacherComment),
    practiceTargets: getArray(sectionPass?.practiceTargets ?? analysis.practiceTargets),
    diagnostics: sectionPass?.diagnostics || analysis.diagnostics || {},
    sourceMetadata: {
      sourceKind,
      runSummaryPath: result.runSummaryPath ? toRepoRelative(repoRoot, result.runSummaryPath) : "",
      passJsonPath: job.passJsonPath ? toRepoRelative(repoRoot, normalizePathForCurrentRepo(repoRoot, job.passJsonPath)) : "",
      sourcePdfPath: toRepoRelative(repoRoot, normalizePathForCurrentRepo(repoRoot, result.pdfPath || job.pdfPath || job.scorePdfPath || score.sourcePdfPath || "")),
      sourceAudioPath: toRepoRelative(repoRoot, normalizePathForCurrentRepo(repoRoot, result.audioPath || job.audioPath || "")),
      sourceType: sectionPass ? "section" : "whole-piece",
      alignmentEvidence,
    },
  };
}

function candidateFromAnalysis({ repoRoot, result = {}, job = {}, score = {}, analysis, sectionPass = null, sourceKind, alignmentEvidence = null }) {
  const normalized = filterAnalysisFindingsToProjectableErhu(
    score,
    normalizeAnalysisBase({ repoRoot, result, job, score, analysis, sectionPass, sourceKind, alignmentEvidence }),
  );
  const noteIds = getSystemNoteIds(normalized);
  const measureIndexes = getSystemMeasureIndexes(normalized);
  const caseId = stableCaseId([normalized.scoreId, normalized.audioHash, normalized.sectionId, normalized.analysisId]);
  return {
    caseId,
    analysisId: normalized.analysisId,
    scoreId: normalized.scoreId,
    pieceId: normalized.pieceId,
    title: normalized.pieceTitle,
    sectionId: normalized.sectionId,
    sectionTitle: normalized.sectionTitle,
    audioHash: normalized.audioHash,
    audioSegment: normalized.audioSegment,
    sourcePdfPath: normalized.sourceMetadata.sourcePdfPath,
    sourceAudioPath: normalized.sourceMetadata.sourceAudioPath,
    sourceKind,
    sourceType: normalized.sourceMetadata.sourceType,
    systemRecommendedPath: getRecommendedPracticePath(normalized),
    systemIssueNoteIds: noteIds,
    systemIssueMeasureIndexes: measureIndexes,
    noteFindingCount: noteIds.length,
    measureFindingCount: measureIndexes.length,
    confidence: normalized.confidence,
    alignmentEvidence,
    riskScore: noteIds.length + measureIndexes.length * 2 + (normalized.confidence != null ? Math.max(0, 1 - normalized.confidence) * 4 : 1),
    analysis: normalized,
  };
}

function candidatesFromPieceJob({ repoRoot, job, result = {}, scoreMap, sourceKind, unit }) {
  const score = scoreMap.get(safeString(job.scoreId)) || {};
  const candidates = [];
  if (unit === "whole-piece" || unit === "both") {
    const analysis = job.wholePieceAnalysis || job.primaryAnalysis;
    if (analysis) {
      candidates.push(candidateFromAnalysis({ repoRoot, result, job, score, analysis, sourceKind }));
    }
  }
  if (unit === "section" || unit === "both") {
    const passJsonPath = normalizePathForCurrentRepo(repoRoot, job.passJsonPath || "");
    const passJson = readJson(passJsonPath, null);
    const alignmentEvidence = buildAlignmentEvidence(passJson || {});
    for (const sectionPass of getArray(passJson?.sectionPasses)) {
      candidates.push(candidateFromAnalysis({
        repoRoot,
        result,
        job,
        score,
        analysis: job.wholePieceAnalysis || job.primaryAnalysis || {},
        sectionPass,
        sourceKind,
        alignmentEvidence,
      }));
    }
  }
  return candidates;
}

export function collectTeacherValidationCandidates({ repoRoot = REPO_ROOT, unit = "section", sources = "real-runs" } = {}) {
  const scoreMap = loadScoreMap(repoRoot);
  const candidates = [];
  if (sources === "real-runs" || sources === "all") {
    for (const runSummaryPath of collectRunSummaryFiles(repoRoot)) {
      const summary = readJson(runSummaryPath, {});
      for (const result of getArray(summary.results)) {
        const job = result.piecePassJob || {};
        if (result.status !== "completed" || job.status !== "completed") continue;
        candidates.push(...candidatesFromPieceJob({
          repoRoot,
          job,
          result: { ...result, runSummaryPath },
          scoreMap,
          sourceKind: "real-corpus-run",
          unit,
        }));
      }
    }
  }
  if (sources === "teacher-grade-runs" || sources === "all") {
    for (const runSummaryPath of collectTeacherGradeRunSummaryFiles(repoRoot)) {
      const summary = readJson(runSummaryPath, {});
      for (const result of getArray(summary.results)) {
        const job = result.piecePassJob || {};
        if (result.status !== "completed" || job.status !== "completed") continue;
        candidates.push(...candidatesFromPieceJob({
          repoRoot,
          job,
          result: { ...result, runSummaryPath },
          scoreMap,
          sourceKind: "teacher-grade-alignment-run",
          unit,
        }));
      }
    }
  }
  if (sources === "piece-jobs" || sources === "all") {
    const pieceJobStore = readJson(path.join(repoRoot, "data", "erhu-piece-pass-jobs.json"), {});
    for (const job of getArray(pieceJobStore.jobs)) {
      if (job.status !== "completed") continue;
      candidates.push(...candidatesFromPieceJob({
        repoRoot,
        job,
        result: {},
        scoreMap,
        sourceKind: "piece-pass-store",
        unit,
      }));
    }
  }
  if (sources === "manual-anchors" || sources === "all") {
    for (const job of collectManualAnchorJobs(repoRoot)) {
      if (job.status !== "completed") continue;
      candidates.push(...candidatesFromPieceJob({
        repoRoot,
        job,
        result: {},
        scoreMap,
        sourceKind: "manual-anchor",
        unit,
      }));
    }
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const key = [candidate.scoreId, candidate.audioHash, candidate.sectionId, candidate.sourceType].join("|");
    const previous = deduped.get(key);
    if (!previous || candidate.riskScore > previous.riskScore) {
      deduped.set(key, candidate);
    }
  }
  return Array.from(deduped.values());
}

export function selectTeacherValidationCandidates(candidates, { max = 50, minSystemFindings = 0, requireTrustedAlignment = true, requireTeacherReadyTrusted = false } = {}) {
  const filtered = candidates
    .filter((candidate) => candidate.noteFindingCount + candidate.measureFindingCount >= minSystemFindings)
    .filter((candidate) => !requireTrustedAlignment || candidate.alignmentEvidence?.trusted === true)
    // teacher-ready gate: only samples whose audio window is trustworthy enough to
    // put in front of a teacher (duration scale sane, no severe window overlap,
    // has system findings). Keeps unreliable-window samples out of the pack itself
    // rather than letting the server hide the whole pack afterwards.
    .filter((candidate) => !requireTeacherReadyTrusted || candidate.alignmentEvidence?.teacherReadyTrusted === true)
    .sort((left, right) => right.riskScore - left.riskScore || left.title.localeCompare(right.title, "zh-Hans-CN"));
  const byTitle = new Map();
  for (const candidate of filtered) {
    const key = candidate.title || "Untitled";
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(candidate);
  }
  const groups = Array.from(byTitle.values()).sort((left, right) => right[0].riskScore - left[0].riskScore);
  const selected = [];
  while (selected.length < max && groups.some((group) => group.length)) {
    for (const group of groups) {
      if (!group.length || selected.length >= max) continue;
      selected.push(group.shift());
    }
  }
  return selected;
}

function filterCandidatesByTitle(candidates, titles = []) {
  const filters = titles.map((item) => cleanText(item).toLowerCase()).filter(Boolean);
  if (!filters.length) return candidates;
  return candidates.filter((candidate) => {
    const haystack = [
      cleanText(candidate.title),
      cleanText(candidate.sectionTitle),
      cleanText(candidate.sourcePdfPath),
      cleanText(candidate.sourceAudioPath),
    ].join(" ").toLowerCase();
    return filters.some((title) => haystack.includes(title));
  });
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join("|") : safeString(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows.filter((item) => item.some((cell) => safeString(cell).trim()));
  return dataRows.map((dataRow) => Object.fromEntries(headers.map((header, index) => [header, dataRow[index] ?? ""])));
}

function reviewTemplateRow(candidate, raterId = "teacher-1") {
  return {
    caseId: candidate.caseId,
    analysisId: candidate.analysisId,
    raterId,
    reviewStatus: "pending",
    includeInBaseline: "yes",
    overallAgreement: "",
    teacherPrimaryPath: "",
    teacherIssueNoteIds: "",
    teacherIssueMeasureIndexes: "",
    comments: "",
    title: candidate.title,
    sectionId: candidate.sectionId,
    sectionTitle: candidate.sectionTitle,
    audioStartSeconds: candidate.audioSegment?.startSeconds ?? "",
    audioEndSeconds: candidate.audioSegment?.endSeconds ?? "",
    audioDurationSeconds: candidate.audioSegment?.durationSeconds ?? "",
    sourceAudioPath: candidate.sourceAudioPath,
    sourcePdfPath: candidate.sourcePdfPath,
    systemRecommendedPath: candidate.systemRecommendedPath,
    systemIssueNoteIds: candidate.systemIssueNoteIds.join("|"),
    systemIssueMeasureIndexes: candidate.systemIssueMeasureIndexes.join("|"),
    noteFindingCount: candidate.noteFindingCount,
    measureFindingCount: candidate.measureFindingCount,
    alignmentTrusted: candidate.alignmentEvidence?.trusted === true ? "yes" : "no",
    alignmentScanMode: candidate.alignmentEvidence?.scanMode || "",
    alignmentReason: candidate.alignmentEvidence?.reason || "",
  };
}

function systemFindingRows(candidates) {
  return candidates.flatMap((candidate) => {
    const noteRows = getArray(candidate.analysis.noteFindings).map((finding) => ({
      caseId: candidate.caseId,
      analysisId: candidate.analysisId,
      findingType: "note",
      findingId: safeString(finding.noteId),
      measureIndex: finding.measureIndex ?? "",
      expectedMidi: finding.expectedMidi ?? "",
      centsError: finding.centsError ?? "",
      onsetErrorMs: finding.onsetErrorMs ?? "",
      durationErrorMs: finding.durationErrorMs ?? "",
      label: cleanText(finding.pitchLabel || finding.rhythmLabel || finding.issueKind || finding.severity),
      severity: safeString(finding.severity),
      isUncertain: finding.isUncertain === true ? "yes" : "no",
      why: cleanText(finding.why),
      action: cleanText(finding.action),
    }));
    const measureRows = getArray(candidate.analysis.measureFindings).map((finding) => ({
      caseId: candidate.caseId,
      analysisId: candidate.analysisId,
      findingType: "measure",
      findingId: safeString(finding.measureIndex),
      measureIndex: finding.measureIndex ?? "",
      expectedMidi: "",
      centsError: "",
      onsetErrorMs: "",
      durationErrorMs: "",
      label: cleanText(finding.label || finding.rhythmLabel || finding.issueKind || finding.severity),
      severity: safeString(finding.severity),
      isUncertain: finding.isUncertain === true ? "yes" : "no",
      why: cleanText(finding.why || finding.summary),
      action: cleanText(finding.action),
    }));
    return [...noteRows, ...measureRows];
  });
}

function extractAudioClip({ sourceAudioPath, outputPath, startSeconds, endSeconds }) {
  if (!sourceAudioPath || !fs.existsSync(sourceAudioPath)) return { ok: false, reason: "missing-source-audio" };
  const args = ["-y"];
  if (Number.isFinite(startSeconds) && startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", sourceAudioPath);
  if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
    args.push("-t", String(endSeconds - startSeconds));
  }
  args.push("-vn", "-acodec", "pcm_s16le", outputPath);
  const result = spawnSync("ffmpeg", args, { stdio: "ignore" });
  return result.status === 0 ? { ok: true } : { ok: false, reason: "ffmpeg-failed" };
}

export async function buildTeacherValidationPack({
  repoRoot = REPO_ROOT,
  outputDir,
  unit = "section",
  sources = "real-runs",
  max = 50,
  min = 30,
  minSystemFindings = 0,
  raterId = "teacher-1",
  reviewMode = "",
  titles = [],
  extractAudio = false,
  strictMin = false,
  requireTrustedAlignment = true,
  requireTeacherReadyTrusted = null,
} = {}) {
  const resolvedOutputDir = outputDir || path.join(repoRoot, DEFAULT_PACK_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  // technique-labeling packs go straight to teachers, so they require the stricter
  // teacher-ready gate by default; other review modes keep the old behaviour.
  const teacherReadyRequired = requireTeacherReadyTrusted == null
    ? safeString(reviewMode) === "technique-labeling"
    : Boolean(requireTeacherReadyTrusted);
  const allCandidates = filterCandidatesByTitle(collectTeacherValidationCandidates({ repoRoot, unit, sources }), titles);
  const rejectedUntrustedAlignmentCount = allCandidates.filter((candidate) => candidate.alignmentEvidence?.trusted !== true).length;
  const rejectedNotTeacherReadyCount = teacherReadyRequired
    ? allCandidates.filter((candidate) => candidate.alignmentEvidence?.trusted === true && candidate.alignmentEvidence?.teacherReadyTrusted !== true).length
    : 0;
  const candidates = selectTeacherValidationCandidates(
    allCandidates,
    { max, minSystemFindings, requireTrustedAlignment, requireTeacherReadyTrusted: teacherReadyRequired },
  );
  const warnings = [];
  if (requireTrustedAlignment && rejectedUntrustedAlignmentCount) {
    warnings.push(`rejected ${rejectedUntrustedAlignmentCount} candidate(s) without analyzer-backed audio/PDF alignment`);
  }
  if (teacherReadyRequired && rejectedNotTeacherReadyCount) {
    warnings.push(`rejected ${rejectedNotTeacherReadyCount} trusted candidate(s) that failed the teacher-ready gate (duration scale / window overlap / no findings)`);
  }
  if (candidates.length < min) {
    const message = `selected ${candidates.length} candidate(s), below requested minimum ${min}`;
    if (strictMin) throw new Error(message);
    warnings.push(message);
  }
  await fsp.mkdir(resolvedOutputDir, { recursive: true });

  if (extractAudio) {
    const audioDir = path.join(resolvedOutputDir, "audio-clips");
    await fsp.mkdir(audioDir, { recursive: true });
    for (const candidate of candidates) {
      const sourceAudio = normalizePathForCurrentRepo(repoRoot, candidate.sourceAudioPath);
      const clipPath = path.join(audioDir, `${candidate.caseId}.wav`);
      const result = extractAudioClip({
        sourceAudioPath: sourceAudio,
        outputPath: clipPath,
        startSeconds: numeric(candidate.audioSegment?.startSeconds),
        endSeconds: numeric(candidate.audioSegment?.endSeconds),
      });
      if (result.ok) {
        candidate.audioClipPath = toRepoRelative(repoRoot, clipPath);
      } else {
        candidate.audioClipPath = "";
        warnings.push(`audio clip skipped for ${candidate.caseId}: ${result.reason}`);
      }
    }
  }

  const manifestItems = candidates.map(({ analysis, ...item }) => item);
  const analyses = candidates.map((candidate) => candidate.analysis);
  const reviewRows = candidates.map((candidate) => reviewTemplateRow(candidate, raterId));
  const findingRows = systemFindingRows(candidates);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    unit,
    sources,
    requestedMin: min,
    requestedMax: max,
    selectedCount: candidates.length,
    warningCount: warnings.length,
    warnings,
    reviewMode: safeString(reviewMode),
    titleFilters: getArray(titles).map((item) => safeString(item)).filter(Boolean),
    files: {
      analyses: "analyses.json",
      teacherReviewJson: "teacher-review-template.json",
      teacherReviewCsv: "teacher-review-template.csv",
      systemFindingsCsv: "system-findings.csv",
      readme: "README.md",
    },
    items: manifestItems,
  };
  await writeJson(path.join(resolvedOutputDir, "manifest.json"), manifest);
  await writeJson(path.join(resolvedOutputDir, "analyses.json"), { schemaVersion: 1, analyses });
  await writeJson(path.join(resolvedOutputDir, "teacher-review-template.json"), { schemaVersion: 1, reviews: reviewRows });
  await fsp.writeFile(path.join(resolvedOutputDir, "teacher-review-template.csv"), toCsv(reviewRows), "utf8");
  await fsp.writeFile(path.join(resolvedOutputDir, "system-findings.csv"), toCsv(findingRows), "utf8");
  await fsp.writeFile(path.join(resolvedOutputDir, "README.md"), [
    "# Teacher Validation Pack",
    "",
    "Fill `teacher-review-template.csv` or `teacher-review-template.json`, then import it with:",
    "",
    "```powershell",
    "npm run teacher:validation-import -- --pack-dir <this-folder> --reviews <filled-review-file> --apply",
    "```",
    "",
    "Required fields per row:",
    "- `reviewStatus`: set to `complete` when the row is ready to import.",
    "- `includeInBaseline`: keep `yes` for valid samples; set `no` to exclude unsuitable performances.",
    "- `overallAgreement`: 1-5 teacher agreement score.",
    "- `teacherPrimaryPath`: one of `pitch-first`, `rhythm-first`, `review-first`.",
    "- `teacherIssueNoteIds`: pipe/comma/space separated note IDs that truly need feedback.",
    "- `teacherIssueMeasureIndexes`: pipe/comma/space separated measure indexes that truly need feedback.",
    "",
    "Use `system-findings.csv` as the checklist of system-reported issues. Add missed note IDs or measure indexes when the teacher finds obvious false negatives.",
    "",
  ].join("\n"), "utf8");
  return { manifest, analyses, reviewRows, findingRows, outputDir: resolvedOutputDir };
}

function normalizeReviewRow(row = {}) {
  return {
    caseId: safeString(row.caseId),
    analysisId: safeString(row.analysisId),
    raterId: safeString(row.raterId, "teacher-1"),
    reviewStatus: safeString(row.reviewStatus, "pending").toLowerCase(),
    includeInBaseline: !/^no|false|0$/i.test(safeString(row.includeInBaseline, "yes")),
    overallAgreement: numeric(row.overallAgreement),
    teacherPrimaryPath: safeString(row.teacherPrimaryPath, "review-first"),
    teacherIssueNoteIds: parseList(row.teacherIssueNoteIds),
    teacherIssueMeasureIndexes: parseNumberList(row.teacherIssueMeasureIndexes),
    comments: safeString(row.comments),
  };
}

export function loadReviewRows(reviewPath) {
  const text = fs.readFileSync(reviewPath, "utf8");
  if (/\.csv$/i.test(reviewPath)) return parseCsv(text).map(normalizeReviewRow);
  const json = JSON.parse(text);
  return getArray(json.reviews || json).map(normalizeReviewRow);
}

function createValidationReviewFromAnalysis(analysis, row) {
  const teacherIssueNoteIds = parseList(row.teacherIssueNoteIds);
  const teacherIssueMeasureIndexes = parseNumberList(row.teacherIssueMeasureIndexes);
  const noteMetrics = calculateBinaryMetrics(getSystemNoteIds(analysis), teacherIssueNoteIds);
  const measureMetrics = calculateBinaryMetrics(getSystemMeasureIndexes(analysis), teacherIssueMeasureIndexes);
  const systemRecommendedPath = getRecommendedPracticePath(analysis);
  const raterId = safeString(row.raterId, "teacher-1");
  return {
    reviewId: stableCaseId(["validation", analysis.analysisId, raterId]),
    analysisId: analysis.analysisId,
    participantId: safeString(analysis.participantId),
    groupId: safeString(analysis.groupId, "teacher-validation-corpus"),
    sessionStage: safeString(analysis.sessionStage),
    pieceId: safeString(analysis.pieceId),
    sectionId: safeString(analysis.sectionId),
    raterId,
    overallAgreement: Math.max(0, Math.min(5, numeric(row.overallAgreement) ?? 0)),
    teacherPrimaryPath: safeString(row.teacherPrimaryPath, "review-first"),
    teacherIssueNoteIds,
    teacherIssueMeasureIndexes,
    comments: safeString(row.comments),
    noteMatchedCount: noteMetrics.matchedCount,
    notePrecision: noteMetrics.precision,
    noteRecall: noteMetrics.recall,
    noteF1: noteMetrics.f1,
    measureMatchedCount: measureMetrics.matchedCount,
    measurePrecision: measureMetrics.precision,
    measureRecall: measureMetrics.recall,
    measureF1: measureMetrics.f1,
    missedTeacherNoteIds: noteMetrics.missedTeacherValues,
    extraSystemNoteIds: noteMetrics.extraSystemValues,
    missedTeacherMeasureIndexes: measureMetrics.missedTeacherValues,
    extraSystemMeasureIndexes: measureMetrics.extraSystemValues,
    systemRecommendedPath,
    pathAgreement: safeString(row.teacherPrimaryPath, "review-first") === systemRecommendedPath,
    submittedAt: new Date().toISOString(),
  };
}

function mergeById(items, incoming, keyFn) {
  const map = new Map(getArray(items).map((item) => [keyFn(item), item]));
  for (const item of incoming) map.set(keyFn(item), { ...(map.get(keyFn(item)) || {}), ...item });
  return Array.from(map.values());
}

export async function importTeacherValidationReviews({
  repoRoot = REPO_ROOT,
  packDir,
  reviewsPath,
  studyStorePath = path.join(repoRoot, "data", "erhu-study-records.json"),
  apply = false,
} = {}) {
  if (!packDir) throw new Error("--pack-dir is required");
  const analysesPayload = readJson(path.join(packDir, "analyses.json"), {});
  const analyses = getArray(analysesPayload.analyses);
  const analysisById = new Map(analyses.map((analysis) => [safeString(analysis.analysisId), analysis]));
  const reviewRows = loadReviewRows(reviewsPath || path.join(packDir, "teacher-review-template.json"));
  const acceptedRows = reviewRows.filter((row) => row.reviewStatus === "complete" && row.includeInBaseline);
  const skippedRows = reviewRows.filter((row) => row.reviewStatus !== "complete" || !row.includeInBaseline);
  const missingAnalysisIds = acceptedRows.map((row) => row.analysisId).filter((analysisId) => !analysisById.has(analysisId));
  if (missingAnalysisIds.length) {
    throw new Error(`review rows reference missing analyses: ${missingAnalysisIds.join(", ")}`);
  }
  const reviews = acceptedRows.map((row) => createValidationReviewFromAnalysis(analysisById.get(row.analysisId), row));
  const participants = mergeById([], analyses.map((analysis) => ({
    participantId: safeString(analysis.participantId),
    groupId: safeString(analysis.groupId, "teacher-validation-corpus"),
    enrollmentCode: safeString(analysis.participantId),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  })).filter((item) => item.participantId), (item) => item.participantId);
  const summary = {
    acceptedReviewCount: reviews.length,
    skippedReviewCount: skippedRows.length,
    importedAnalysisCount: analyses.length,
    missingAnalysisIds,
  };
  if (!apply) {
    return { ok: true, dryRun: true, summary, reviews, analyses };
  }
  const existingStore = readJson(studyStorePath, { participants: [], analyses: [], validationReviews: [], adjudications: [] });
  const nextStore = {
    ...existingStore,
    participants: mergeById(existingStore.participants, participants, (item) => safeString(item.participantId)),
    analyses: mergeById(existingStore.analyses, analyses, (item) => safeString(item.analysisId)),
    validationReviews: mergeById(
      existingStore.validationReviews,
      reviews,
      (item) => `${safeString(item.analysisId)}|${safeString(item.raterId)}`,
    ),
    adjudications: getArray(existingStore.adjudications),
  };
  await writeJson(studyStorePath, nextStore);
  return { ok: true, dryRun: false, summary, reviews, analyses, studyStorePath };
}
