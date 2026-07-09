import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { writeApprovalTemplate } from "./create-western-controlled-pilot-approval-template.mjs";
import { buildControlledPilotDecision } from "./create-western-controlled-pilot-decision.mjs";
import { buildControlledPilotStartPreflight } from "./run-western-controlled-pilot-start-preflight.mjs";

const TEST_DIR = path.join("data", "experiments", "western-strings-controlled-pilot-test");
const TEMPLATE_PATH = path.join(TEST_DIR, "approval.template.json");
const VALID_APPROVAL_PATH = path.join(TEST_DIR, "approval.valid.json");

await fs.mkdir(TEST_DIR, { recursive: true });

const templateResult = await writeApprovalTemplate({ out: TEMPLATE_PATH });
const template = JSON.parse(await fs.readFile(TEMPLATE_PATH, "utf8"));
assert.equal(templateResult.ok, true, "approval template command should succeed");
assert.equal(template.pilotApproved, false, "approval template must not approve the pilot by default");
assert.equal(template.approvedBy, "", "approval template must require an owner name");
assert.equal(template.approvedAt, "", "approval template must require an approval timestamp");

const decisionWithoutApproval = await buildControlledPilotDecision({
  approval: path.join(TEST_DIR, "missing-approval.json"),
});
assert.equal(decisionWithoutApproval.readyForControlledPilotDecision, true, "machine evidence should be ready for owner decision");
assert.equal(decisionWithoutApproval.approvalPresent, false, "missing approval must not be accepted");
assert.equal(decisionWithoutApproval.readyToStartControlledPilot, false, "missing approval must block pilot start");
assert(
  decisionWithoutApproval.blockingReasons.includes("controlled-pilot-approval-missing"),
  "missing approval must be a blocking reason",
);

const preflightWithoutApproval = await buildControlledPilotStartPreflight({
  approval: path.join(TEST_DIR, "missing-approval.json"),
});
assert.equal(preflightWithoutApproval.okToStartControlledPilot, false, "start preflight must fail without approval");
assert(
  preflightWithoutApproval.blockingReasons.includes("approval-not-present"),
  "start preflight must explicitly report missing approval",
);

await fs.writeFile(VALID_APPROVAL_PATH, `${JSON.stringify({
  pilotApproved: true,
  approvedBy: "test-owner",
  approvedAt: "2026-07-10T00:00:00+08:00",
  scope: "ordinary candidate-evidence auto_pass only; optional first-measure slide/trill M3+ subset",
  notes: "Test-only approval file under data/experiments; production/default runtime remains fail-closed.",
}, null, 2)}\n`, "utf8");

const decisionWithApproval = await buildControlledPilotDecision({
  approval: VALID_APPROVAL_PATH,
});
assert.equal(decisionWithApproval.approvalPresent, true, "valid approval should be recognized");
assert.equal(decisionWithApproval.runtimeFailClosed, true, "valid approval must not change default runtime state");
assert.equal(decisionWithApproval.readyToStartControlledPilot, true, "valid approval plus green machine evidence should make a monitored pilot startable");
assert.deepEqual(decisionWithApproval.blockingReasons, [], "valid approval path should have no blocking reasons");

const preflightWithApproval = await buildControlledPilotStartPreflight({
  approval: VALID_APPROVAL_PATH,
});
assert.equal(preflightWithApproval.okToStartControlledPilot, true, "start preflight should pass with valid owner approval");
assert.deepEqual(preflightWithApproval.blockingReasons, [], "passing start preflight should have no blocking reasons");
assert.equal(preflightWithApproval.decision.runtimeFailClosed, true, "passing start preflight must keep default runtime fail-closed");

console.log(JSON.stringify({
  ok: true,
  checks: [
    "template-does-not-approve",
    "decision-blocks-without-approval",
    "preflight-blocks-without-approval",
    "decision-passes-with-valid-temp-approval",
    "preflight-passes-with-valid-temp-approval",
    "default-runtime-remains-fail-closed",
  ],
  artifacts: {
    template: TEMPLATE_PATH.replace(/\\/g, "/"),
    validApproval: VALID_APPROVAL_PATH.replace(/\\/g, "/"),
  },
}, null, 2));
