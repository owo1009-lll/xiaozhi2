import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  writeRound5TruthSignoffPack,
  writeTruthSignoffPack,
} from "./generate-western-round5-truth-signoff-pack.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "round5-truth-signoff-"));

try {
  await fs.mkdir(path.join(root, "private"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(
    path.join(root, "config", "western-strings-round5-targeted-contract.json"),
    `${JSON.stringify({ contractVersion: "western-round5-targeted-diagnosis-intake-v1" })}\n`,
  );
  await fs.writeFile(
    path.join(root, "config", "western-strings-round6-counterbalanced-contract.json"),
    `${JSON.stringify({ contractVersion: "western-round6-counterbalanced-diagnosis-v1" })}\n`,
  );
  await fs.writeFile(path.join(root, "private", "take.wav"), Buffer.from("audio"));
  await fs.writeFile(path.join(root, "private", "manifest.csv"), [
    "\uFEFFrecordingId,pieceId,performerId,deviceId,roomId,split,audioPath,scorePath,consent,licenseStatus",
    "r5-test,piece,performer,device,room,fresh-blind,private/take.wav,private/score.musicxml,yes,local-only",
    "",
  ].join("\n"));
  const truth = {
    contractVersion: "western-round5-targeted-diagnosis-intake-v1",
    recordings: {
      "r5-test": {
        completeErrorInventory: false,
        events: [{
          eventId: "missing-positive",
          gate: "missing",
          label: "positive",
          measure: 2,
          beat: 1,
          scoreMidi: 69,
          asPerformed: "",
          plannedPerformance: "skip the note",
        }],
      },
    },
  };
  await fs.writeFile(
    path.join(root, "private", "truth.json"),
    `${JSON.stringify(truth)}\n`,
  );
  await fs.writeFile(
    path.join(root, "private", "truth-round6.json"),
    `${JSON.stringify({
      ...truth,
      contractVersion: "western-round6-counterbalanced-diagnosis-v1",
    })}\n`,
  );

  const result = await writeRound5TruthSignoffPack({
    repoRoot: root,
    manifestPath: "private/manifest.csv",
    truthPath: "private/truth.json",
    outDir: "private/signoff",
  });
  assert.equal(result.ok, true);
  assert.equal(result.readyForSignoff, true);
  assert.equal(result.recordingCount, 1);
  assert.equal(result.eventCount, 1);
  assert.equal(result.audioHashesBound, 1);
  assert.equal(result.machinePredictionsIncluded, false);
  const html = await fs.readFile(path.join(root, "private", "signoff", "index.html"), "utf8");
  assert(html.includes("本页不展示任何机器预测"));
  assert(html.includes("../take.wav"));
  assert(html.includes("western-round\"+PACK.roundNumber+\"-truth-signoff.completed.json"));
  assert(html.includes("sourceContractSha256:PACK.contractSha256"));
  assert(html.includes("audioSha256ByRecording"));
  assert(html.includes("data-metadata-confirmed"));
  assert(html.includes("truth.recordings[id]={completeErrorInventory:true,events}"));
  assert(html.includes("追加计划外错误"));
  assert(html.includes("混淆负例必须填写 confusionKind"));
  const browserScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert(browserScript);
  new Function(browserScript); // eslint-disable-line no-new-func

  const round6 = await writeTruthSignoffPack({
    repoRoot: root,
    manifestPath: "private/manifest.csv",
    truthPath: "private/truth-round6.json",
    outDir: "private/signoff-round6",
    roundNumber: 6,
  });
  assert.equal(round6.readyForSignoff, true);
  const round6Html = await fs.readFile(
    path.join(root, "private", "signoff-round6", "index.html"),
    "utf8",
  );
  assert(round6Html.includes("Round 6 逐条试听与真值签署"));
  assert(round6Html.includes("western-round6-truth-signoff:"));
  assert(round6Html.includes("本页不展示任何机器预测"));

  await fs.rm(path.join(root, "private", "take.wav"));
  const missing = await writeTruthSignoffPack({
    repoRoot: root,
    manifestPath: "private/manifest.csv",
    truthPath: "private/truth-round6.json",
    outDir: "private/missing",
    roundNumber: 6,
  });
  assert.equal(missing.ok, false);
  assert(missing.blockingReasons.includes("round6-signoff-audio-missing:r5-test"));

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "source-audio-sha-bound",
      "no-machine-predictions",
      "complete-inventory-required-before-download",
      "unplanned-error-entry-available",
      "round6-reuse-keeps-no-prediction-boundary",
      "missing-audio-fail-closed",
    ],
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
