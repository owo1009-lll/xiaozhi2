import assert from "node:assert/strict";
import fs from "node:fs";

// Guards the one property that makes the Stage A model safe to expose at all:
// it is a suggestion list for a teacher who has already committed their own
// labels, never a finding, and never anything a student can see.
//
// The model failed its clean-domain safety gate with roughly one false positive
// per hundred notes. That is tolerable behind a listening teacher and
// intolerable anywhere else, so the boundary is asserted rather than assumed.

const service = fs.readFileSync("src/server/westernStringsAlignmentService.js", "utf8");
const routes = fs.readFileSync("src/server/westernStringsRoutes.js", "utf8");
const guard = fs.readFileSync("src/server/publicAccessGuard.js", "utf8");
const scorer = fs.readFileSync("scripts/experiments/score_submission_with_stage_a_model.py", "utf8");
const projectStatus = fs.readFileSync("scripts/status-western-strings-project.mjs", "utf8");

// --- withheld until the teacher signs -------------------------------------
assert(
  service.includes("listWesternControlledSubmissionModelSuggestions"),
  "the service must expose model suggestions through a dedicated reviewer-only reader",
);
assert(
  service.includes('withheldReason: "teacher-signoff-pending"'),
  "suggestions must be withheld until the teacher has signed their own labels",
);
assert(
  /const signed = await fileExists\(ledgerPath\);\s*if \(!signed\) \{/.test(service),
  "the withholding must be keyed on the presence of the teacher's ledger signature",
);

// --- never student facing, never a gate -----------------------------------
assert(service.includes("studentFacing: false"), "model suggestions must never be student facing");
assert(
  service.includes("automaticAccusationAuthorized: false"),
  "model suggestions must never authorize an automatic accusation",
);
assert(
  !projectStatus.includes("modelSuggestions") && !projectStatus.includes("model-suggestions"),
  "project status must not consume model suggestions as evidence",
);

// --- the scorer refuses to run on an unverified model ---------------------
assert(
  scorer.includes("stage-a model artifact sha mismatch"),
  "the scorer must fail closed when the model artifact does not match the Stage A run",
);
assert(
  scorer.includes('"isEvidence": False') || scorer.includes('"isEvidence": False,'),
  "the scorer output must declare itself not to be evidence",
);
assert(
  scorer.includes('"changesStrictConfirmedRecall": False'),
  "the scorer must declare that it does not move strict confirmed recall",
);
assert(
  scorer.includes("stage-a feature names disagree"),
  "the scorer must refuse when report and artifact disagree on feature order",
);

// --- reviewer-only over the network ---------------------------------------
assert(
  routes.includes("/api/strings/controlled-submissions/:submissionId/model-suggestions"),
  "the reviewer console needs a route for model suggestions",
);
assert(
  !guard.includes("model-suggestions"),
  "the model-suggestion route must stay off the public allowlist so tunnel traffic gets 403",
);

console.log(JSON.stringify({
  ok: true,
  checks: "withheld-until-signoff, never-student-facing, not-evidence, model-sha-bound, reviewer-only",
}, null, 2));
