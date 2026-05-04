import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrateScoreStoreToSqlite } from "../src/server/scoreStoreSqlite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.dirname(__dirname);

function parseArgs(argv) {
  const args = {
    dataDir: path.join(repoRoot, "data"),
    dbPath: "",
    dryRun: false,
    force: false,
    backup: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") args.dataDir = path.resolve(argv[++index] || args.dataDir);
    else if (arg === "--db") args.dbPath = path.resolve(argv[++index] || "");
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--no-backup") args.backup = false;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node scripts/migrate-score-imports-sqlite.mjs [--dry-run] [--force] [--data-dir <dir>] [--db <path>] [--no-backup]",
        "",
        "Migrates data/erhu-score-imports.json and data/store-archive/erhu-score-imports-archive-*.json into SQLite.",
        "Dry-run creates a temporary SQLite database, validates the import, then deletes it.",
      ].join("\n"));
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir);
const report = await migrateScoreStoreToSqlite({
  storePath: path.join(dataDir, "erhu-score-imports.json"),
  archiveDir: path.join(dataDir, "store-archive"),
  dbPath: args.dbPath || path.join(dataDir, "erhu-score-imports.sqlite"),
  dryRun: args.dryRun,
  force: args.force,
  backup: args.backup,
});

console.log(JSON.stringify(report, null, 2));
