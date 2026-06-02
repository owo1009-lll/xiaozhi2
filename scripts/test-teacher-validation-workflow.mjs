import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildTeacherValidationPack,
  importTeacherValidationReviews,
  readJson,
  writeJson,
} from "./teacher-validation-support.mjs";
import { buildQualitySnapshot, compareQualitySnapshot } from "./quality-baseline-support.mjs";
import { teacherValidationInternals } from "../src/server/teacherValidationService.js";

async function seedFixture(repoRoot) {
  const runDir = path.join(repoRoot, "data", "real-tests", "corpus-runs", "fixture-run");
  const passDir = path.join(repoRoot, "data", "piece-pass", "jobs", "piecepassjob-fixture");
  const scoreDir = path.join(repoRoot, "data", "score-imports", "scorejob-fixture");
  const audioDir = path.join(repoRoot, "data", "analysis-audio-cache");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(passDir, { recursive: true });
  await fs.mkdir(scoreDir, { recursive: true });
  await fs.mkdir(audioDir, { recursive: true });
  const pdfPath = path.join(scoreDir, "source.pdf");
  const audioPath = path.join(audioDir, "fixture.wav");
  await fs.writeFile(pdfPath, "%PDF-1.4\n%%EOF\n", "utf8");
  await fs.writeFile(audioPath, "fixture-audio", "utf8");

  await writeJson(path.join(repoRoot, "data", "erhu-score-imports.json"), {
    jobs: [],
    scores: [{
      scoreId: "score-fixture",
      pieceId: "score-fixture",
      title: "Fixture Piece",
      sourcePdfPath: pdfPath,
      omrStatus: "completed",
      omrConfidence: 0.91,
      sections: [{ sectionId: "section-a-s01" }, { sectionId: "section-a-s02" }],
    }],
  });
  await writeJson(path.join(repoRoot, "data", "erhu-study-records.json"), {
    participants: [],
    analyses: [],
    validationReviews: [],
    adjudications: [],
  });

  const passJsonPath = path.join(passDir, "score-fixture-whole-piece-pass.json");
  await writeJson(passJsonPath, {
    summary: {
      audioCoverage: {
        scanMode: "analyzer-window",
        audioDurationSeconds: 16,
        estimatedPieceDurationSeconds: 16,
      },
    },
    sectionPasses: [
      {
        sectionId: "section-a-s01",
        sectionTitle: "Section 1",
        startSeconds: 0,
        endSeconds: 8,
        durationSeconds: 8,
        confidence: 0.92,
        recommendedPracticePath: "rhythm-first",
        noteFindings: [{ noteId: "n1", measureIndex: 1, rhythmLabel: "rush", severity: "high" }],
        measureFindings: [{ measureIndex: 1, label: "measure rush" }],
      },
      {
        sectionId: "section-a-s02",
        sectionTitle: "Section 2",
        startSeconds: 8,
        endSeconds: 16,
        durationSeconds: 8,
        confidence: 0.9,
        recommendedPracticePath: "pitch-first",
        noteFindings: [{ noteId: "n2", measureIndex: 2, pitchLabel: "flat", severity: "medium" }],
        measureFindings: [],
      },
    ],
  });
  await writeJson(path.join(runDir, "run-summary.json"), {
    createdAt: "2026-05-06T00:00:00.000Z",
    results: [{
      title: "Fixture Piece",
      pdfPath,
      audioPath,
      status: "completed",
      piecePassJobId: "piecepassjob-fixture",
      piecePassJob: {
        jobId: "piecepassjob-fixture",
        participantId: "fixture-student",
        scoreId: "score-fixture",
        pieceId: "score-fixture",
        pieceTitle: "Fixture Piece",
        status: "completed",
        audioHash: "0123456789012345678901234567890123456789",
        passJsonPath,
        summary: { dominantPracticePath: "rhythm-first", weightedConfidence: 0.91 },
        wholePieceAnalysis: {
          analysisId: "piecepassjob-fixture-whole-piece",
          participantId: "fixture-student",
          groupId: "real-corpus",
          sessionStage: "whole-piece",
          scoreId: "score-fixture",
          pieceId: "score-fixture",
          sectionId: "whole-piece",
          pieceTitle: "Fixture Piece",
          audioHash: "0123456789012345678901234567890123456789",
          audioUrl: "/data/analysis-audio-cache/fixture.wav",
          noteFindings: [],
          measureFindings: [],
          recommendedPracticePath: "rhythm-first",
        },
      },
    }],
  });
  const teacherGradeRunDir = path.join(repoRoot, "data", "teacher-validation", "alignment-runs", "fixture-run");
  await fs.mkdir(teacherGradeRunDir, { recursive: true });
  await writeJson(path.join(teacherGradeRunDir, "run-summary.json"), {
    createdAt: "2026-05-06T00:00:00.000Z",
    source: "teacher-grade-alignment",
    results: [{
      title: "Fixture Piece",
      pdfPath,
      audioPath,
      status: "completed",
      piecePassJobId: "piecepassjob-fixture",
      piecePassJob: {
        jobId: "piecepassjob-fixture",
        participantId: "fixture-student",
        scoreId: "score-fixture",
        pieceId: "score-fixture",
        pieceTitle: "Fixture Piece",
        status: "completed",
        audioHash: "0123456789012345678901234567890123456789",
        passJsonPath,
        summary: { dominantPracticePath: "rhythm-first", weightedConfidence: 0.91 },
        wholePieceAnalysis: {
          analysisId: "piecepassjob-fixture-whole-piece",
          participantId: "fixture-student",
          groupId: "teacher-grade-alignment",
          sessionStage: "whole-piece",
          scoreId: "score-fixture",
          pieceId: "score-fixture",
          sectionId: "whole-piece",
          pieceTitle: "Fixture Piece",
          audioHash: "0123456789012345678901234567890123456789",
          audioUrl: "/data/analysis-audio-cache/fixture.wav",
          noteFindings: [],
          measureFindings: [],
          recommendedPracticePath: "rhythm-first",
        },
      },
    }],
  });
}

const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-teacher-validation-"));
try {
  await seedFixture(repoRoot);
  const packDir = path.join(repoRoot, "data", "teacher-validation", "packs", "fixture-pack");
  const pack = await buildTeacherValidationPack({
    repoRoot,
    outputDir: packDir,
    unit: "section",
    sources: "real-runs",
    max: 2,
    min: 2,
  });
  assert.equal(pack.manifest.selectedCount, 2);
  assert.equal(pack.reviewRows.length, 2);
  assert.equal(pack.findingRows.length, 3);
  const teacherGradePack = await buildTeacherValidationPack({
    repoRoot,
    outputDir: path.join(repoRoot, "data", "teacher-validation", "packs", "teacher-grade-fixture-pack"),
    unit: "section",
    sources: "teacher-grade-runs",
    max: 2,
    min: 2,
  });
  assert.equal(teacherGradePack.manifest.selectedCount, 2);
  assert.equal(teacherGradePack.manifest.warnings.length, 0);
  const filteredTeacherGradePack = await buildTeacherValidationPack({
    repoRoot,
    outputDir: path.join(repoRoot, "data", "teacher-validation", "packs", "teacher-grade-filtered-fixture-pack"),
    unit: "section",
    sources: "teacher-grade-runs",
    titles: ["Fixture Piece"],
    max: 2,
    min: 2,
  });
  assert.equal(filteredTeacherGradePack.manifest.selectedCount, 2);
  assert.deepEqual(filteredTeacherGradePack.manifest.titleFilters, ["Fixture Piece"]);
  const techniqueReady = teacherValidationInternals.summarizeTeacherPackReadiness({
    manifest: { reviewMode: "technique-labeling" },
    items: [{
      audioClipPath: "data/teacher-validation/packs/fixture/audio-clips/case.wav",
      sourcePdfPath: "data/teacher-validation/packs/fixture/case.pdf",
      alignmentEvidence: { trusted: true, teacherReadyTrusted: true },
      sourceKind: "teacher-grade-run",
      scoreLocator: { notePositions: [{ noteId: "n1" }] },
    }],
  });
  assert.equal(techniqueReady.reviewReady, true);
  assert.deepEqual(techniqueReady.reviewReadinessReasons, []);
  const techniqueNotReady = teacherValidationInternals.summarizeTeacherPackReadiness({
    manifest: { reviewMode: "technique-labeling" },
    items: [{
      audioClipPath: "data/teacher-validation/packs/fixture/audio-clips/case.wav",
      sourcePdfPath: "data/teacher-validation/packs/fixture/case.pdf",
      alignmentEvidence: { trusted: true, teacherReadyTrusted: false },
      sourceKind: "teacher-grade-run",
      scoreLocator: { notePositions: [{ noteId: "n1" }] },
    }],
  });
  assert.equal(techniqueNotReady.reviewReady, false);
  assert(techniqueNotReady.reviewReadinessReasons.includes("not-teacher-ready-trusted"));
  const techniqueNoPdf = teacherValidationInternals.summarizeTeacherPackReadiness({
    manifest: { reviewMode: "technique-labeling" },
    items: [{
      audioClipPath: "data/teacher-validation/packs/fixture/audio-clips/case.wav",
      alignmentEvidence: { trusted: true, teacherReadyTrusted: true },
      sourceKind: "teacher-grade-run",
      scoreLocator: { notePositions: [{ noteId: "n1" }] },
    }],
  });
  assert.equal(techniqueNoPdf.reviewReady, false);
  assert(techniqueNoPdf.reviewReadinessReasons.includes("missing-pdf-assets"));
  const normalNotReady = teacherValidationInternals.summarizeTeacherPackReadiness({
    manifest: {},
    items: [{
      audioClipPath: "data/teacher-validation/packs/fixture/audio-clips/case.wav",
      alignmentEvidence: { trusted: true },
      sourceKind: "teacher-grade-run",
      scoreLocator: { notePositions: [{ noteId: "n1" }] },
    }],
  });
  assert.equal(normalNotReady.reviewReady, false);
  assert(normalNotReady.reviewReadinessReasons.includes("not-original-score-verified"));

  // --- teacher-ready alignment gate (B2c): full/partial ratio bounds + allowlist ---
  const gate = teacherValidationInternals.buildTeacherAlignmentEvidenceFromPassJson;
  // scattered partial (real 326s span for a 13.3s expected -> ratio ~24): too-high
  const scattered = gate({
    summary: { audioCoverage: {
      scanMode: "content-aligned", audioDurationSeconds: 481.5,
      alignmentCoverageMode: "partial-selected", wholePieceCoverageMode: "partial-piece",
      alignedSpanDurationSeconds: 326.0, expectedAlignedSpanDurationSeconds: 13.33,
    } },
    sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 5, sequenceIndex: 0 }],
  });
  assert.equal(scattered.teacherReadyTrusted, false);
  assert(scattered.teacherReadyReasons.some((r) => r.startsWith("aligned-span-ratio-too-high")));
  // sane partial (span ~= expected): passes the span gate. content-aligned now also
  // requires in-order monotonicity evidence.
  const sanePartial = gate({
    summary: { audioCoverage: {
      scanMode: "content-aligned", audioDurationSeconds: 481.5,
      alignmentCoverageMode: "partial-selected", wholePieceCoverageMode: "partial-piece",
      alignedSpanDurationSeconds: 14.0, expectedAlignedSpanDurationSeconds: 13.33,
      monotonicViolationRate: 0.0, greedyFallbackCount: 0, contentAlignmentMonotonic: true,
    } },
    sectionPasses: [
      { noteFindings: [{}], startSeconds: 0, endSeconds: 6, sequenceIndex: 0 },
      { noteFindings: [{}], startSeconds: 6.5, endSeconds: 13, sequenceIndex: 1 },
    ],
  });
  assert.equal(sanePartial.teacherReadyTrusted, true);
  assert.deepEqual(sanePartial.teacherReadyReasons, []);
  // full coverage with sane durationRatio + in-order content path passes
  const saneFull = gate({
    summary: { audioCoverage: {
      scanMode: "content-aligned", audioDurationSeconds: 100, estimatedPieceDurationSeconds: 95,
      alignmentCoverageMode: "full-selected", wholePieceCoverageMode: "full-piece",
      monotonicViolationRate: 0.0, greedyFallbackCount: 0, contentAlignmentMonotonic: true,
    } },
    sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 50, sequenceIndex: 0 },
                    { noteFindings: [{}], startSeconds: 50, endSeconds: 95, sequenceIndex: 1 }],
  });
  assert.equal(saneFull.teacherReadyTrusted, true);
  // unknown scanMode is NOT trusted (allowlist, not "anything != fast")
  const unknownMode = gate({
    summary: { audioCoverage: { scanMode: "some-future-mode", audioDurationSeconds: 100, estimatedPieceDurationSeconds: 95 } },
    sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 95, sequenceIndex: 0 }],
  });
  assert.equal(unknownMode.scanModeTrusted, false);
  assert.equal(unknownMode.teacherReadyTrusted, false);

  // --- embedded evidence is RE-JUDGED, not trusted blindly (server bypass fix) ---
  const readEmbedded = teacherValidationInternals.readTeacherAlignmentEvidence;
  // an old pack that stored teacherReadyTrusted:true but is actually scattered must fail now
  const staleScattered = readEmbedded({
    alignmentEvidence: {
      trusted: true, scanModeTrusted: true, teacherReadyTrusted: true, teacherReadyReasons: [],
      scanMode: "content-aligned", coverageMode: "partial-piece",
      alignedSpanRatio: 24.5, hasWindowOverlap: false, totalSystemFindings: 3,
    },
  }, {});
  assert.equal(staleScattered.teacherReadyTrusted, false);
  assert(staleScattered.teacherReadyReasons.some((r) => r.startsWith("aligned-span-ratio-too-high")));
  // an old pack with a now-untrusted scanMode but stored trusted:true must fail now
  const staleUntrustedMode = readEmbedded({
    alignmentEvidence: {
      trusted: true, scanModeTrusted: true, teacherReadyTrusted: true, teacherReadyReasons: [],
      scanMode: "fast-sequence-window", coverageMode: "full-piece",
      durationRatio: 1.0, hasWindowOverlap: false, totalSystemFindings: 5,
    },
  }, {});
  assert.equal(staleUntrustedMode.scanModeTrusted, false);
  assert.equal(staleUntrustedMode.teacherReadyTrusted, false);
  // an old pack missing the new fields fails closed (can't verify -> not trusted)
  const staleMissingFields = readEmbedded({
    alignmentEvidence: {
      trusted: true, teacherReadyTrusted: true,
      scanMode: "content-aligned", coverageMode: "partial-piece",
    },
  }, {});
  assert.equal(staleMissingFields.teacherReadyTrusted, false);
  assert(staleMissingFields.teacherReadyReasons.some((r) => r === "aligned-span-ratio-missing"));
  // a genuinely sane embedded record still passes after re-judging (content-aligned
  // now also requires in-order monotonicity evidence)
  const saneEmbedded = readEmbedded({
    alignmentEvidence: {
      trusted: true, teacherReadyTrusted: true,
      scanMode: "content-aligned", coverageMode: "full-piece",
      durationRatio: 0.95, hasWindowOverlap: false, totalSystemFindings: 4,
      monotonicViolationRate: 0.0, greedyFallbackCount: 0, contentAlignmentMonotonic: true,
    },
  }, {});
  assert.equal(saneEmbedded.teacherReadyTrusted, true);
  assert.deepEqual(saneEmbedded.teacherReadyReasons, []);
  // FAIL CLOSED: a content-aligned record with sane ratios/findings but NO
  // monotonicity evidence (old B2 content pack) must be rejected, not skipped.
  const contentMissingMono = readEmbedded({
    alignmentEvidence: {
      trusted: true, teacherReadyTrusted: true,
      scanMode: "content-aligned", coverageMode: "full-piece",
      durationRatio: 0.95, hasWindowOverlap: false, totalSystemFindings: 4,
    },
  }, {});
  assert.equal(contentMissingMono.teacherReadyTrusted, false);
  assert(contentMissingMono.teacherReadyReasons.includes("content-path-monotonicity-missing"));
  // greedy-fallback gate: even when the violation rate is low, a DP that fell back to
  // greedy (greedyFallbackCount>0 / monotonicFeasible=false) is rejected.
  const greedyFallbackLowViol = gate({
    summary: { audioCoverage: {
      scanMode: "content-aligned", audioDurationSeconds: 100, estimatedPieceDurationSeconds: 95,
      alignmentCoverageMode: "full-selected", wholePieceCoverageMode: "full-piece",
      monotonicViolationRate: 0.0, greedyFallbackCount: 2, contentAlignmentMonotonic: false,
    } },
    sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 50, sequenceIndex: 0 },
                    { noteFindings: [{}], startSeconds: 50, endSeconds: 95, sequenceIndex: 1 }],
  });
  assert.equal(greedyFallbackLowViol.teacherReadyTrusted, false);
  assert(greedyFallbackLowViol.teacherReadyReasons.some((r) => r.startsWith("content-path-greedy-fallback")));

  // --- monotonicity gate (Phase 1): scattered content path is rejected ---
  // Real measured violation rates: 2nd rhapsody 0.41, 4th rhapsody 0.46. Both must
  // fail as content-path-not-monotonic, so they never reach the teacher backend.
  for (const rate of [0.41, 0.46]) {
    const scattered = gate({
      summary: { audioCoverage: {
        scanMode: "content-aligned", audioDurationSeconds: 716,
        alignmentCoverageMode: "full-selected", wholePieceCoverageMode: "full-piece",
        estimatedPieceDurationSeconds: 700, monotonicViolationRate: rate,
      } },
      sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 50, sequenceIndex: 0 },
                      { noteFindings: [{}], startSeconds: 50, endSeconds: 100, sequenceIndex: 1 }],
    });
    assert.equal(scattered.teacherReadyTrusted, false);
    assert(scattered.teacherReadyReasons.some((r) => r.startsWith("content-path-not-monotonic")));
  }
  // a content path that IS in order (low violation rate) still passes the gate
  const inOrderContent = gate({
    summary: { audioCoverage: {
      scanMode: "content-aligned", audioDurationSeconds: 100, estimatedPieceDurationSeconds: 95,
      alignmentCoverageMode: "full-selected", wholePieceCoverageMode: "full-piece",
      monotonicViolationRate: 0.0,
    } },
    sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 50, sequenceIndex: 0 },
                    { noteFindings: [{}], startSeconds: 50, endSeconds: 95, sequenceIndex: 1 }],
  });
  assert.equal(inOrderContent.teacherReadyTrusted, true);
  // analyzer-window samples (no content path -> no rate field) are NOT failed by this gate
  const analyzerWindow = gate({
    summary: { audioCoverage: {
      scanMode: "analyzer-window", audioDurationSeconds: 100, estimatedPieceDurationSeconds: 95,
      wholePieceCoverageMode: "full-piece",
    } },
    sectionPasses: [{ noteFindings: [{}], startSeconds: 0, endSeconds: 95, sequenceIndex: 0 }],
  });
  assert.equal(analyzerWindow.teacherReadyTrusted, true);
  assert(!analyzerWindow.teacherReadyReasons.some((r) => r.startsWith("content-path-not-monotonic")));
  // embedded re-judge also applies the monotonicity gate (stale stored true -> fail)
  const staleScatteredMono = readEmbedded({
    alignmentEvidence: {
      trusted: true, teacherReadyTrusted: true,
      scanMode: "content-aligned", coverageMode: "full-piece",
      durationRatio: 1.0, hasWindowOverlap: false, totalSystemFindings: 5,
      monotonicViolationRate: 0.46,
    },
  }, {});
  assert.equal(staleScatteredMono.teacherReadyTrusted, false);
  assert(staleScatteredMono.teacherReadyReasons.some((r) => r.startsWith("content-path-not-monotonic")));

  const filledReviews = {
    schemaVersion: 1,
    reviews: pack.reviewRows.map((row, index) => ({
      ...row,
      reviewStatus: "complete",
      includeInBaseline: "yes",
      overallAgreement: index === 0 ? 5 : 4,
      teacherPrimaryPath: row.systemRecommendedPath,
      teacherIssueNoteIds: row.systemIssueNoteIds,
      teacherIssueMeasureIndexes: row.systemIssueMeasureIndexes,
      comments: "fixture review",
    })),
  };
  const reviewsPath = path.join(packDir, "teacher-review-filled.json");
  await fs.writeFile(reviewsPath, `${JSON.stringify(filledReviews, null, 2)}\n`, "utf8");
  const imported = await importTeacherValidationReviews({
    repoRoot,
    packDir,
    reviewsPath,
    studyStorePath: path.join(repoRoot, "data", "erhu-study-records.json"),
    apply: true,
  });
  assert.equal(imported.summary.acceptedReviewCount, 2);
  const store = readJson(path.join(repoRoot, "data", "erhu-study-records.json"), {});
  assert.equal(store.analyses.length, 2);
  assert.equal(store.validationReviews.length, 2);
  assert.equal(store.validationReviews[0].noteF1, 1);

  const snapshot = buildQualitySnapshot({ repoRoot });
  assert.equal(snapshot.validation.ready, true);
  assert.equal(snapshot.validation.reviewCount, 2);
  const comparison = compareQualitySnapshot(snapshot, snapshot);
  assert.equal(comparison.ok, true);

  const scoreDir = path.join(repoRoot, "data", "score-imports", "scorejob-fixture");
  const pdfPath = path.join(scoreDir, "source.pdf");
  const locator = teacherValidationInternals.buildTeacherScoreLocator(
    {
      scoreId: "score-mixed-locator",
      sourcePdfPath: pdfPath,
      selectedPartId: "erhu",
      partCandidates: [
        { id: "erhu", name: "二胡", staffCount: 1 },
        { id: "piano", name: "钢琴伴奏", staffCount: 2, isLikelyPiano: true },
      ],
      sections: [{
        sectionId: "page-01-s01",
        sourceSectionId: "page-01-s01",
        title: "自动识谱第 1 页 片段 1",
        pageImagePath: path.join(scoreDir, "page-001.png"),
        notes: [
          {
            noteId: "xml-m1-n1",
            measureIndex: 1,
            beatStart: 0,
            beatDuration: 1,
            midiPitch: 72,
            partName: "二胡",
            notePosition: {
              normalizedX: 0.2,
              normalizedY: 0.25,
              pageNumber: 1,
              systemIndex: 1,
              staffIndex: 1,
              localMeasureIndex: 1,
              localNoteId: "xml-m1-n1",
              scoreLineRole: "erhu",
              scoreLineConfidence: 0.9,
            },
          },
          {
            noteId: "xml-m1-n2",
            measureIndex: 1,
            beatStart: 0,
            beatDuration: 1,
            midiPitch: 48,
            partName: "钢琴",
            notePosition: {
              normalizedX: 0.2,
              normalizedY: 0.62,
              pageNumber: 1,
              systemIndex: 1,
              staffIndex: 2,
              localMeasureIndex: 1,
              localNoteId: "xml-m1-n2",
              scoreLineRole: "accompaniment",
              scoreLineConfidence: 0.9,
            },
          },
        ],
        scoreLineStats: {
          erhuNoteCount: 1,
          accompanimentNoteCount: 1,
        },
      }],
    },
    {
      sectionId: "page-01-s01",
      systemIssueNoteIds: ["xml-m1-n1"],
    },
    {
      sectionId: "page-01-s01",
      noteFindings: [{ noteId: "xml-m1-n1", measureIndex: 1 }],
    },
    {
      dataDir: path.join(repoRoot, "data"),
      asciiRuntimeRoot: repoRoot,
    },
  );
  assert.equal(locator.notePositions.length, 1);
  assert.equal(locator.notePositions[0].scoreLineRole, "erhu");
  assert(locator.notePositions[0].y < 0.4, "Teacher locator must not include piano accompaniment coordinates");
  assert.equal(locator.focusRegions.length, 1);
  assert(locator.focusRegions[0].yMax < 0.4, "Teacher focus region must stay on the erhu line");

  const mislabeledLineRankLocator = teacherValidationInternals.buildTeacherScoreLocator(
    {
      scoreId: "score-line-rank-locator",
      sourcePdfPath: pdfPath,
      selectedPartId: "P1",
      selectedPart: "Voice",
      partCandidates: [
        { id: "P1", name: "Voice", staffCount: 1 },
        { id: "P2", name: "Piano", staffCount: 2, isLikelyPiano: true },
      ],
      sections: [{
        sectionId: "page-07-s03",
        sourceSectionId: "page-07-s03",
        title: "自动识谱第 7 页 片段 3",
        pageImagePath: path.join(scoreDir, "page-007.png"),
        selectedPart: "Voice",
        selectedPartId: "P1",
        notes: [
          {
            noteId: "xml-m73-n7",
            measureIndex: 73,
            beatStart: 1,
            beatDuration: 1,
            midiPitch: 65,
            notePosition: {
              normalizedX: 0.7,
              normalizedY: 0.31,
              pageNumber: 7,
              systemIndex: 3,
              staffIndex: 1,
              localMeasureIndex: 9,
              localNoteId: "xml-m9-n7",
              scoreLineRole: "erhu",
              scoreLineConfidence: 0.92,
            },
          },
          {
            noteId: "xml-m74-n5",
            measureIndex: 74,
            beatStart: 1,
            beatDuration: 1,
            midiPitch: 72,
            notePosition: {
              normalizedX: 0.32,
              normalizedY: 0.39,
              pageNumber: 7,
              systemIndex: 4,
              staffIndex: 1,
              localMeasureIndex: 10,
              localNoteId: "xml-m10-n5",
              scoreLineRole: "erhu",
              scoreLineConfidence: 0.92,
            },
          },
        ],
        scoreLineStats: {
          erhuNoteCount: 2,
          accompanimentNoteCount: 0,
        },
      }],
    },
    {
      sectionId: "page-07-s03",
      systemIssueNoteIds: ["xml-m73-n7", "xml-m74-n5"],
    },
    {
      sectionId: "page-07-s03",
      noteFindings: [
        { noteId: "xml-m73-n7", measureIndex: 73 },
        { noteId: "xml-m74-n5", measureIndex: 74 },
      ],
    },
    {
      dataDir: path.join(repoRoot, "data"),
      asciiRuntimeRoot: repoRoot,
    },
  );
  assert.equal(mislabeledLineRankLocator.notePositions.length, 1);
  assert.equal(mislabeledLineRankLocator.notePositions[0].sourceNoteId, "xml-m74-n5");
  assert(mislabeledLineRankLocator.notePositions[0].y > 0.35, "Teacher locator must drop piano line-rank coordinates even when mislabeled erhu");

  const duplicateIssueLineLocator = teacherValidationInternals.buildTeacherScoreLocator(
    {
      scoreId: "score-duplicate-line-locator",
      sourcePdfPath: pdfPath,
      selectedPartId: "P1",
      selectedPart: "Voice",
      partCandidates: [
        { id: "P1", name: "Voice", staffCount: 1 },
        { id: "P2", name: "Piano", staffCount: 2, isLikelyPiano: true },
      ],
      sections: [{
        sectionId: "page-02-s03",
        sourceSectionId: "page-02-s03",
        title: "鑷姩璇嗚氨绗?2 椤?鐗囨 3",
        pageImagePath: path.join(scoreDir, "page-002.png"),
        selectedPart: "Voice",
        selectedPartId: "P1",
        notes: [
          {
            noteId: "xml-m18-n7",
            measureIndex: 18,
            beatStart: 3,
            beatDuration: 1,
            midiPitch: 72,
            notePosition: {
              normalizedX: 0.55,
              normalizedY: 0.32,
              pageNumber: 2,
              systemIndex: 4,
              staffIndex: 1,
              localMeasureIndex: 5,
              localNoteId: "xml-m5-n7",
              scoreLineRole: "erhu",
              scoreLineConfidence: 0.92,
            },
          },
          {
            noteId: "xml-m18-n7",
            measureIndex: 18,
            beatStart: 4,
            beatDuration: 1,
            midiPitch: 69,
            notePosition: {
              normalizedX: 0.46,
              normalizedY: 0.77,
              pageNumber: 2,
              systemIndex: 10,
              staffIndex: 1,
              localMeasureIndex: 5,
              localNoteId: "xml-m5-n7",
              scoreLineRole: "erhu",
              scoreLineConfidence: 0.92,
            },
          },
        ],
        scoreLineStats: {
          erhuNoteCount: 2,
          accompanimentNoteCount: 0,
        },
      }],
    },
    {
      sectionId: "page-02-s03",
      systemIssueNoteIds: ["xml-m18-n7"],
    },
    {
      sectionId: "page-02-s03",
      noteFindings: [{ noteId: "xml-m18-n7", measureIndex: 18 }],
    },
    {
      dataDir: path.join(repoRoot, "data"),
      asciiRuntimeRoot: repoRoot,
    },
  );
  assert.equal(duplicateIssueLineLocator.notePositions.length, 1);
  assert.equal(duplicateIssueLineLocator.lineProjectionGuardApplied, true);
  assert(duplicateIssueLineLocator.notePositions[0].y < 0.4, "Teacher locator must keep one score line when a note is duplicated across lines");
  assert(duplicateIssueLineLocator.measurePositions[0].yMax < 0.4, "Teacher measure box must not span multiple score lines");

  const numericMeasureReview = teacherValidationInternals.normalizeTeacherReviewRow({
    caseId: "numeric-measures",
    analysisId: "numeric-measures-analysis",
    teacherIssueMeasureIndexes: [1, 2],
  });
  assert.equal(numericMeasureReview.teacherIssueMeasureIndexes, "1|2");

  console.log(JSON.stringify({
    ok: true,
    checks: ["pack-build", "review-import", "quality-snapshot", "erhu-only-score-locator", "line-rank-piano-filter", "duplicate-line-guard", "numeric-measure-list"],
    selectedCount: pack.manifest.selectedCount,
    reviewCount: snapshot.validation.reviewCount,
  }, null, 2));
} finally {
  await fs.rm(repoRoot, { recursive: true, force: true });
}
