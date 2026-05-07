import fs from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT, buildQualitySnapshot } from "./quality-baseline-support.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const outputPath = path.resolve(REPO_ROOT, readArg("--output", "docs/quality-baseline.json"));
const snapshot = buildQualitySnapshot({ repoRoot: REPO_ROOT });
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ok: true, outputPath, validation: snapshot.validation, performance: snapshot.performance }, null, 2));
