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

  console.log(JSON.stringify({
    ok: true,
    checks: ["pack-build", "review-import", "quality-snapshot"],
    selectedCount: pack.manifest.selectedCount,
    reviewCount: snapshot.validation.reviewCount,
  }, null, 2));
} finally {
  await fs.rm(repoRoot, { recursive: true, force: true });
}
