import path from "node:path";
import {
  DEFAULT_PACK_ROOT,
  REPO_ROOT,
  buildTeacherValidationPack,
} from "./teacher-validation-support.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    repoRoot: REPO_ROOT,
    outputDir: "",
    unit: "section",
    sources: "real-runs",
    max: 50,
    min: 30,
    minSystemFindings: 0,
    raterId: "teacher-1",
    extractAudio: false,
    strictMin: false,
    requireTrustedAlignment: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") parsed.repoRoot = path.resolve(argv[++index] || REPO_ROOT);
    else if (arg === "--output-dir") parsed.outputDir = path.resolve(parsed.repoRoot, argv[++index] || "");
    else if (arg === "--unit") parsed.unit = argv[++index] || parsed.unit;
    else if (arg === "--sources") parsed.sources = argv[++index] || parsed.sources;
    else if (arg === "--max") parsed.max = Math.max(1, Number(argv[++index]) || parsed.max);
    else if (arg === "--min") parsed.min = Math.max(0, Number(argv[++index]) || parsed.min);
    else if (arg === "--min-system-findings") parsed.minSystemFindings = Math.max(0, Number(argv[++index]) || 0);
    else if (arg === "--rater-id") parsed.raterId = argv[++index] || parsed.raterId;
    else if (arg === "--extract-audio") parsed.extractAudio = true;
    else if (arg === "--strict-min") parsed.strictMin = true;
    else if (arg === "--allow-untrusted-alignment") parsed.requireTrustedAlignment = false;
  }
  if (!parsed.outputDir) {
    parsed.outputDir = path.join(parsed.repoRoot, DEFAULT_PACK_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  }
  return parsed;
}

const options = parseArgs();
buildTeacherValidationPack(options)
  .then((result) => {
    console.log(JSON.stringify({
      ok: true,
      outputDir: result.outputDir,
      selectedCount: result.manifest.selectedCount,
      warnings: result.manifest.warnings,
      files: result.manifest.files,
    }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
