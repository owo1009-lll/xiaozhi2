import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runRound2MachineAnalysis } from "./run-western-strings-round2.mjs";


const root = await fs.mkdtemp(path.join(os.tmpdir(), "western-round2-machine-test-"));
try {
  const privateRoot = path.join(root, "data", "private", "western-strings-round2");
  const candidateRoot = path.join(root, "data", "candidates");
  await fs.mkdir(privateRoot, { recursive: true });
  await fs.mkdir(candidateRoot, { recursive: true });
  const manifestRows = [];
  const submissions = [];
  const batchItems = [];
  for (let index = 1; index <= 8; index += 1) {
    const recordingId = `round2-test-${index}`;
    const audioRel = `data/private/western-strings-round2/${index}.m4a`;
    const candidateRel = `data/candidates/${index}.json`;
    await fs.writeFile(path.join(root, audioRel), `audio-${index}`, "utf8");
    await fs.writeFile(path.join(root, candidateRel), JSON.stringify({
      candidateRows: [
        { noteId: "n1", measureIndex: 1 },
        { noteId: "n2", measureIndex: 2 },
      ],
    }), "utf8");
    manifestRows.push([
      recordingId,
      `piece-${index}`,
      "correct",
      audioRel,
      `score-${index}`,
      2,
      2,
    ].join(","));
    submissions.push({
      submissionId: `submission-${index}`,
      recordingId,
      scoreId: `score-${index}`,
      status: "accepted_for_batch",
    });
    batchItems.push({
      submissionId: `submission-${index}`,
      recordingId,
      analysisStatus: "offline_feature_review_ready",
      offlineAnalysisProduced: true,
      candidateRowCount: 2,
      candidateRowsPath: candidateRel,
      autoDiagnosisIssued: false,
    });
  }
  await fs.writeFile(path.join(privateRoot, "manifest.csv"), [
    "recordingId,pieceId,scenario,audioPath,scoreId,expectedMeasureCount,expectedPitchedNoteCount",
    ...manifestRows,
    "",
  ].join("\n"), "utf8");
  const dependencies = {
    listSubmissions: async () => ({ submissions }),
    recordReview: async () => ({ ok: true }),
    runBatch: async () => ({ batch: { batchRunId: "batch-test", items: batchItems } }),
  };
  const ready = await runRound2MachineAnalysis({
    repoRoot: root,
    manifestPath: "data/private/western-strings-round2/manifest.csv",
    outPath: "data/out.json",
    markdownPath: "data/out.md",
  }, dependencies);
  assert.equal(ready.ready, true);
  assert(ready.items.every((item) => item.candidateMeasureCount === 2));
  assert(ready.items.every((item) => item.candidateUniqueNoteIdCount === 2));

  await fs.writeFile(path.join(root, "data", "candidates", "1.json"), JSON.stringify({
    candidateRows: [
      { noteId: "n1", measureIndex: 1 },
      { noteId: "n1", measureIndex: 1 },
    ],
  }), "utf8");
  const blocked = await runRound2MachineAnalysis({
    repoRoot: root,
    manifestPath: "data/private/western-strings-round2/manifest.csv",
    outPath: "data/out-blocked.json",
    markdownPath: "data/out-blocked.md",
  }, dependencies);
  assert.equal(blocked.ready, false);
  assert(blocked.blockingReasons.includes("round2-candidate-measure-count-mismatch:round2-test-1:1:2"));
  assert(blocked.blockingReasons.includes("round2-candidate-note-id-count-mismatch:round2-test-1:1:2"));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, checks: ["valid-structure-passes", "collapsed-structure-blocks"] }, null, 2));
