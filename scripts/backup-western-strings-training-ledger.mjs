import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { trainingLedgerDir } from "../src/server/westernStringsTrainingLedger.js";

// The training ledger lives under data/private and is gitignored on purpose
// (it holds recordings metadata and teacher gold). Version control therefore
// cannot protect it, so it needs its own off-repo copy.
//
//   node scripts/backup-western-strings-training-ledger.mjs [targetRoot]
//
// Default target: %USERPROFILE%/ai-erhu-backups/training-ledger/<timestamp>
// Each backup is a full copy plus a manifest of per-file SHA-256, and the copy
// is re-hashed after writing so a silent truncation is caught here, not later.
const repoRoot = process.cwd();
const sourceDir = trainingLedgerDir(repoRoot);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), "ai-erhu-backups", "training-ledger");
const targetDir = path.join(targetRoot, stamp);

if (!fs.existsSync(sourceDir)) {
  console.log(JSON.stringify({ ok: true, skipped: "ledger directory does not exist yet", source: sourceDir }, null, 2));
  process.exit(0);
}

const files = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".jsonl")).sort();
fs.mkdirSync(targetDir, { recursive: true });

const manifest = [];
const mismatches = [];
for (const name of files) {
  const bytes = fs.readFileSync(path.join(sourceDir, name));
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const destination = path.join(targetDir, name);
  fs.writeFileSync(destination, bytes);
  const verified = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
  if (verified !== sha256) mismatches.push(name);
  manifest.push({
    file: name,
    sha256,
    bytes: bytes.length,
    records: bytes.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).length,
  });
}

const summary = {
  ok: mismatches.length === 0,
  contract: "western-strings-training-ledger-backup-v1",
  createdAt: new Date().toISOString(),
  source: path.relative(repoRoot, sourceDir).replace(/\\/g, "/"),
  target: targetDir,
  fileCount: manifest.length,
  recordCount: manifest.reduce((total, item) => total + item.records, 0),
  verificationMismatches: mismatches,
  files: manifest,
};
fs.writeFileSync(path.join(targetDir, "manifest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
