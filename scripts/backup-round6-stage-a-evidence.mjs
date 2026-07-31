import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Backs up the Round 6 Stage A evidence off-repo.
//
// This matters more than an ordinary backup: the staged protocol allows the
// clean-domain safety evaluation to run exactly once, and the consumed ledger
// forbids a rerun even after a crash. The report is therefore not reproducible
// — losing it loses the only record of what the candidate actually did. It all
// lives under data/, which is gitignored, so version control cannot protect it.
//
//   node scripts/backup-round6-stage-a-evidence.mjs [targetRoot]
const REPO = process.cwd();
const SOURCES = [
  "data/experiments/western-strings-round6-stage-a-safety/report.json",
  "data/experiments/western-strings-round6-stage-a-safety/consumed-ledger.json",
  "data/experiments/western-strings-round6-stage-a-safety/model.joblib",
  "data/experiments/western-strings-round6-stage-a-signoff/ledger.json",
  "data/experiments/western-strings-round6-counterbalanced-position-balance/report.json",
  "data/experiments/western-strings-round6-counterbalanced-intake.json",
  "data/private/western-strings-round6-counterbalanced/manifest.csv",
  "data/private/western-strings-round6-counterbalanced/position-truth.json",
  "data/private/western-strings-round6-counterbalanced/stage-a-truth-signoff/completed.json",
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), "ai-erhu-backups", "round6-stage-a");
const targetDir = path.join(targetRoot, stamp);
fs.mkdirSync(targetDir, { recursive: true });

const manifest = [];
const missing = [];
const mismatches = [];
for (const relative of SOURCES) {
  const source = path.join(REPO, relative);
  if (!fs.existsSync(source)) { missing.push(relative); continue; }
  const bytes = fs.readFileSync(source);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const destination = path.join(targetDir, relative.replace(/[\\/]/g, "__"));
  fs.writeFileSync(destination, bytes);
  // Re-hash the copy: a silent truncation must fail here, not years later.
  const verified = crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
  if (verified !== sha256) mismatches.push(relative);
  manifest.push({ source: relative, sha256, bytes: bytes.length });
}

// The recordings themselves are the other irreplaceable half: they cannot be
// re-performed identically, and the signoff is bound to their exact hashes.
const audioDir = path.join(REPO, "data", "private", "western-strings-round6-counterbalanced");
const audioTarget = path.join(targetDir, "audio");
fs.mkdirSync(audioTarget, { recursive: true });
for (const name of fs.readdirSync(audioDir).filter((n) => /^r6-cal-.*\.m4a$/.test(n))) {
  const bytes = fs.readFileSync(path.join(audioDir, name));
  fs.writeFileSync(path.join(audioTarget, name), bytes);
  manifest.push({
    source: `audio/${name}`,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}

const summary = {
  ok: missing.length === 0 && mismatches.length === 0,
  contract: "western-round6-stage-a-evidence-backup-v1",
  createdAt: new Date().toISOString(),
  target: targetDir,
  note: "Stage A safety evaluation is one-shot and its consumed ledger forbids reruns; this evidence is not reproducible.",
  fileCount: manifest.length,
  missing,
  verificationMismatches: mismatches,
  files: manifest,
};
fs.writeFileSync(path.join(targetDir, "manifest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  ok: summary.ok,
  target: targetDir,
  fileCount: manifest.length,
  missing,
  verificationMismatches: mismatches,
}, null, 2));
if (!summary.ok) process.exitCode = 1;
