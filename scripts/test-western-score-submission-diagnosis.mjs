import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildScoreDiagnosis,
  listSupportedEditions,
} from "../src/server/westernScoreEditions.js";
import {
  recordWesternControlledSubmissionReview,
} from "../src/server/westernStringsAlignmentService.js";

const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "western-score-submission-diagnosis-"));
const libraryRoot = path.join(repoRoot, "data", "public-score-library");
const editionRoot = path.join(libraryRoot, "editions", "piece-1", "edition-1");
const controlledRoot = path.join(repoRoot, "data", "experiments", "western-strings-m3");
await fs.mkdir(editionRoot, { recursive: true });
await fs.mkdir(controlledRoot, { recursive: true });
await fs.writeFile(path.join(libraryRoot, "registry.json"), JSON.stringify({
  entries: [{
    pieceId: "piece-1",
    scoreId: "score-1",
    editionId: "edition-1",
    title: "Test score",
    renderPaths: ["page-1.png", "page-2.png"],
    coordinateSidecarPath: "editions/piece-1/edition-1/coordinates.json",
  }],
}), "utf8");
await fs.writeFile(path.join(libraryRoot, "registry-mutopia-violin.json"), JSON.stringify({
  entries: [],
}), "utf8");
await fs.writeFile(path.join(editionRoot, "coordinates.json"), JSON.stringify({
  pages: [{ pageNumber: 1 }, { pageNumber: 2 }],
  measures: [
    { globalMeasureIndex: 1, pageNumber: 1, bboxNormalized: [0.1, 0.1, 0.9, 0.2] },
    { globalMeasureIndex: 2, pageNumber: 2, bboxNormalized: [0.1, 0.3, 0.9, 0.4] },
  ],
  notes: [
    {
      noteId: "xml-m1-n1",
      noteIds: ["xml-m1-n1"],
      globalMeasureIndex: 1,
      pageNumber: 1,
      bboxNormalized: [0.2, 0.12, 0.24, 0.18],
    },
    {
      noteId: "xml-m2-n1",
      noteIds: ["xml-m2-n1", "xml-m1-n9"],
      globalMeasureIndex: 2,
      pageNumber: 2,
      bboxNormalized: [0.3, 0.32, 0.34, 0.38],
    },
  ],
}), "utf8");
await fs.writeFile(path.join(controlledRoot, "controlled-submissions.jsonl"), `${JSON.stringify({
  submissionId: "submission-1",
  pieceId: "piece-1",
  scoreId: "score-1",
  status: "review_required",
})}\n`, "utf8");
await fs.writeFile(path.join(controlledRoot, "controlled-submission-reviews.jsonl"), "", "utf8");

const editions = await listSupportedEditions({ repoRoot });
assert.equal(editions.editions[0].hasCoordinates, true);

const beforeRelease = await buildScoreDiagnosis({
  repoRoot,
  pieceId: "piece-1",
  editionId: "edition-1",
  submissionId: "submission-1",
});
assert.equal(beforeRelease.hasData, false, "unreleased machine output must remain hidden");

await assert.rejects(
  recordWesternControlledSubmissionReview({
    repoRoot,
    payload: {
      submissionId: "submission-1",
      action: "feedback_released",
      studentMessage: "请复查。",
      releaseToStudent: true,
      studentIssues: [{ noteId: "invalid", noteIndex: 1, category: "pitch" }],
    },
  }),
  /studentIssues/,
);

await recordWesternControlledSubmissionReview({
  repoRoot,
  payload: {
    submissionId: "submission-1",
    action: "feedback_released",
    studentMessage: "请复查第二页的节奏。",
    releaseToStudent: true,
    studentIssues: [{
      noteId: "xml-m1-n9",
      noteIndex: 1,
      category: "rhythm",
    }],
  },
});

const released = await buildScoreDiagnosis({
  repoRoot,
  pieceId: "piece-1",
  editionId: "edition-1",
  submissionId: "submission-1",
});
assert.equal(released.hasData, true);
assert.equal(released.diagnosisMode, "teacher-released-submission");
assert.equal(released.noteIssues.length, 1);
assert.equal(released.noteIssues[0].pageNumber, 2);
assert.equal(released.noteIssues[0].verdict, "rhythm");
assert.equal(released.measureIssues[0].pageNumber, 2);

const wrongPiece = await buildScoreDiagnosis({
  repoRoot,
  pieceId: "another-piece",
  editionId: "edition-1",
  submissionId: "submission-1",
});
assert.equal(wrongPiece.hasData, false);

await fs.rm(repoRoot, { recursive: true, force: true });
console.log("western score submission diagnosis tests passed");
