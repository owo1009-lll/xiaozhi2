import path from "node:path";
import {
  REPO_ROOT,
  importTeacherValidationReviews,
} from "./teacher-validation-support.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    repoRoot: REPO_ROOT,
    packDir: "",
    reviewsPath: "",
    studyStorePath: "",
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") parsed.repoRoot = path.resolve(argv[++index] || REPO_ROOT);
    else if (arg === "--pack-dir") parsed.packDir = path.resolve(parsed.repoRoot, argv[++index] || "");
    else if (arg === "--reviews") parsed.reviewsPath = path.resolve(parsed.repoRoot, argv[++index] || "");
    else if (arg === "--study-store") parsed.studyStorePath = path.resolve(parsed.repoRoot, argv[++index] || "");
    else if (arg === "--apply") parsed.apply = true;
  }
  if (!parsed.studyStorePath) {
    parsed.studyStorePath = path.join(parsed.repoRoot, "data", "erhu-study-records.json");
  }
  return parsed;
}

const options = parseArgs();
importTeacherValidationReviews(options)
  .then((result) => {
    console.log(JSON.stringify({
      ok: result.ok,
      dryRun: result.dryRun,
      studyStorePath: result.studyStorePath || options.studyStorePath,
      summary: result.summary,
    }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
