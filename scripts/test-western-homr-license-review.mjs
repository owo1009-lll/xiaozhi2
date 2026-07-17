import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditHomrBoundary } from "./audit-homr-boundary.mjs";
import {
  validateHomrLicenseDecisionArgs,
  writeHomrLicenseReviewDecision,
} from "./record-western-homr-license-review.mjs";

const repoRoot = process.cwd();
const authoritativePath = path.join(repoRoot, "config", "third-party", "homr-0.7.0-review.json");
const authoritative = JSON.parse(await fs.readFile(authoritativePath, "utf8"));
const checks = [];

function check(name, condition) {
  assert(condition, name);
  checks.push(name);
}

check("authoritative-record-remains-pending", authoritative.decision?.status === "pending");
check("pending-record-has-no-reviewer", authoritative.decision?.reviewedBy === "");
check("pending-record-approves-no-scope", authoritative.decision?.controlledOfflineReviewApproved === false);
check("reviewed-runtime-is-stable-target", authoritative.evidence?.localDistribution?.runtimeRoot === authoritative.deployment?.targetRuntimeRoot);
check("portable-record-binding-is-path-independent", authoritative.evidence?.localDistribution?.executable?.observedHostSha256IsApprovalBinding === false);
check("complete-runtime-model-set-is-recorded", authoritative.modelArtifacts?.length === 6);

const currentAudit = auditHomrBoundary({ root: repoRoot });
check("boundary-audit-passes-while-pending", currentAudit.ok === true);
check("pending-review-is-not-ready", currentAudit.licenseReviewReady === false);
check("mainline-remains-non-executable", currentAudit.homrExecutesInMainline === false);
check("offline-v3-boundary-is-visible", currentAudit.homrOfflineV3Executable === true);

const missingApproval = validateHomrLicenseDecisionArgs({ decision: "approve", by: "reviewer" });
check("approve-requires-model-license-basis", missingApproval.errors.includes("model-license-basis-required"));
check(
  "approve-requires-offline-confirmation",
  missingApproval.errors.includes("approve-requires-confirm-controlled-offline-only"),
);
check(
  "approve-requires-model-license-confirmation",
  missingApproval.errors.includes("approve-requires-confirm-model-license-basis"),
);
check(
  "approve-requires-no-redistribution-confirmation",
  missingApproval.errors.includes("approve-requires-confirm-no-model-redistribution"),
);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "homr-license-review-"));
try {
  const approvedPath = path.join(tempRoot, "approved.json");
  await fs.writeFile(approvedPath, `${JSON.stringify(authoritative, null, 2)}\n`, "utf8");
  const approved = await writeHomrLicenseReviewDecision({
    out: approvedPath,
    decision: "approve",
    by: "test-reviewer",
    at: "2026-07-17T12:00:00+08:00",
    modelLicenseBasis: "test-only reviewed basis; no redistribution",
    confirmControlledOfflineOnly: true,
    confirmModelLicenseBasis: true,
    confirmNoModelRedistribution: true,
  });
  check("explicit-approval-records-named-reviewer", approved.ok === true && approved.reviewedBy === "test-reviewer");
  check("approval-is-bounded-offline", approved.controlledOfflineReviewApproved === true);
  check("approval-never-opens-network-use", approved.studentFacingNetworkUseApproved === false);
  check("approval-never-opens-redistribution", approved.redistributionApproved === false);

  const approvedRelative = path.relative(repoRoot, approvedPath);
  const approvedAudit = auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative });
  check("fully-confirmed-temp-approval-is-ready", approvedAudit.licenseReviewReady === true);

  const approvedRecord = JSON.parse(await fs.readFile(approvedPath, "utf8"));
  check("approval-binding-version-is-two", approvedRecord.decision.approvalBinding?.bindingVersion === 2);
  check("approval-binds-complete-model-set", approvedRecord.decision.approvalBinding?.modelArtifacts?.length === 6);
  check("approval-does-not-bind-path-sensitive-launcher-hash", !Object.hasOwn(approvedRecord.decision.approvalBinding || {}, "executableSha256"));
  check("approval-binds-portable-record", approvedRecord.decision.approvalBinding?.portableRecord?.sha256 === authoritative.evidence.localDistribution.portableRecord.sha256);
  check("approval-binds-retained-wheel", approvedRecord.decision.approvalBinding?.wheelArchive?.sha256 === authoritative.evidence.localDistribution.wheelArchive.sha256);

  const extraScope = structuredClone(approvedRecord);
  extraScope.decision.approvedScopes.push("unreviewed-extra-scope");
  await fs.writeFile(approvedPath, `${JSON.stringify(extraScope, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /approval scope must be controlled offline review only/,
  );
  checks.push("extra-approval-scope-is-rejected");

  const changedExecutableBinding = structuredClone(approvedRecord);
  changedExecutableBinding.decision.approvalBinding.executable.consoleEntryPoint = "homr=other.module:main";
  await fs.writeFile(approvedPath, `${JSON.stringify(changedExecutableBinding, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /executable contract change/,
  );
  checks.push("executable-contract-change-invalidates-approval");

  const changedPortableRecord = structuredClone(approvedRecord);
  changedPortableRecord.evidence.localDistribution.portableRecord.sha256 = "1".repeat(64);
  await fs.writeFile(approvedPath, `${JSON.stringify(changedPortableRecord, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /portable RECORD change/,
  );
  checks.push("portable-record-change-invalidates-approval");

  const changedWheel = structuredClone(approvedRecord);
  changedWheel.evidence.localDistribution.wheelArchive.sha256 = "2".repeat(64);
  await fs.writeFile(approvedPath, `${JSON.stringify(changedWheel, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /retained-wheel change/,
  );
  checks.push("retained-wheel-change-invalidates-approval");

  const changedContract = structuredClone(approvedRecord);
  changedContract.integration.contractVersion += 1;
  await fs.writeFile(approvedPath, `${JSON.stringify(changedContract, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /integration-contract change/,
  );
  checks.push("contract-change-invalidates-approval");

  const changedModel = structuredClone(approvedRecord);
  changedModel.modelArtifacts[0].sha256 = "0".repeat(64);
  await fs.writeFile(approvedPath, `${JSON.stringify(changedModel, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /model manifest change/,
  );
  checks.push("model-hash-change-invalidates-approval");

  const changedTarget = structuredClone(approvedRecord);
  changedTarget.deployment.targetRuntimeRoot = "data/tools/another-runtime";
  await fs.writeFile(approvedPath, `${JSON.stringify(changedTarget, null, 2)}\n`, "utf8");
  assert.throws(
    () => auditHomrBoundary({ root: repoRoot, reviewPath: approvedRelative }),
    /stable runtime target/,
  );
  checks.push("deployment-target-change-invalidates-approval");

  const deferredPath = path.join(tempRoot, "deferred.json");
  await fs.writeFile(deferredPath, `${JSON.stringify(authoritative, null, 2)}\n`, "utf8");
  const deferred = await writeHomrLicenseReviewDecision({
    out: deferredPath,
    decision: "defer",
    by: "test-reviewer",
    at: "2026-07-17T12:00:00+08:00",
  });
  check("named-defer-is-recorded", deferred.ok === true && deferred.status === "deferred");
  check("defer-approves-no-scope", deferred.controlledOfflineReviewApproved === false);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, checks }, null, 2));
