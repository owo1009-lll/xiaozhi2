import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REVIEW = path.join("config", "third-party", "homr-0.7.0-review.json");
const APPROVED_SCOPE = "controlled-offline-review-only";

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(root, relativePath) {
  return JSON.parse(readText(root, relativePath));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedExecutableBinding(record) {
  const executable = record?.evidence?.localDistribution?.executable || {};
  return {
    bindingMode: executable.bindingMode,
    relativePath: executable.relativePath,
    recordEntry: executable.recordEntry,
    consoleEntryPoint: executable.consoleEntryPoint,
  };
}

function expectedPortableRecordBinding(record) {
  const distribution = record?.evidence?.localDistribution || {};
  const portable = distribution.portableRecord || {};
  return {
    algorithm: portable.algorithm,
    excludedEntry: portable.excludedEntry,
    lineCount: portable.lineCount,
    sha256: portable.sha256,
    hashedFileCount: distribution.wheelRecordHashedFileCount,
  };
}

function expectedModelBinding(record) {
  return record?.modelArtifacts?.map(({
    package: packageName,
    relativePath,
    name,
    bytes,
    sha256,
  }) => ({ package: packageName, relativePath, name, bytes, sha256 }));
}

function validateReviewRecord(record) {
  const distribution = record?.evidence?.localDistribution || {};
  const executable = distribution.executable || {};
  const portableRecord = distribution.portableRecord || {};
  const wheelArchive = distribution.wheelArchive || {};
  requireCondition(record?.schemaVersion === 1, "HOMR review schema must be version 1.");
  requireCondition(record?.component?.name === "homr", "HOMR review component must be homr.");
  requireCondition(record?.component?.version === "0.7.0", "HOMR review must bind version 0.7.0.");
  requireCondition(record?.component?.declaredLicense === "AGPL-3.0", "HOMR review must record AGPL-3.0.");
  requireCondition(
    record?.integration?.mode === "unmodified-external-cli-subprocess",
    "HOMR review must bind the external CLI subprocess boundary.",
  );
  requireCondition(record?.integration?.sourceModified === false, "HOMR review must not claim modified upstream source.");
  requireCondition(
    record?.integration?.packageImportedInProjectProcess === false,
    "HOMR review must keep HOMR out of the project process.",
  );
  requireCondition(
    record?.integration?.controlledProductionRequiresCompleteEnginePool === true &&
      record?.integration?.controlledProductionWrapper === "scripts/run-western-photo-score-python.ps1" &&
      record?.integration?.controlledProductionRequiredFlag === "--require-complete-engine-pool",
    "HOMR review must bind the controlled production complete-engine-pool guard.",
  );
  requireCondition(
    record?.integration?.missingExecutableBehavior?.controlledProductionWrapper ===
      "fail-before-analysis-with-required-engine-pool-incomplete" &&
      record?.integration?.missingExecutableBehavior?.directResearchRunWithoutRequiredFlag ===
      "audiveris-only-degraded-pool-with-explicit-audit",
    "HOMR review must distinguish controlled-production failure from direct-research degradation.",
  );
  requireCondition(
    record?.deployment?.targetRuntimeRoot === "data/tools/homr-0.7.0-ort1.27.0",
    "HOMR review must bind the stable runtime target.",
  );
  requireCondition(
    distribution.runtimeRoot === record.deployment.targetRuntimeRoot,
    "HOMR reviewed distribution must be the stable deployment target.",
  );
  requireCondition(
    executable.bindingMode === "record-verified-console-entry-point" &&
      executable.relativePath === "Scripts/homr.exe" &&
      executable.recordEntry === "../../Scripts/homr.exe" &&
      executable.consoleEntryPoint === "homr=homr.main:main" &&
      executable.observedHostSha256IsApprovalBinding === false,
    "HOMR executable must use the path-independent RECORD and console-entry-point binding.",
  );
  requireCondition(
    portableRecord.algorithm === "sha256-normalized-lf-excluding-path-sensitive-launcher-row-v1" &&
      portableRecord.excludedEntry === executable.recordEntry &&
      /^[a-f0-9]{64}$/i.test(String(portableRecord.sha256 || "")) &&
      Number.isInteger(portableRecord.lineCount) && portableRecord.lineCount > 0 &&
      distribution.wheelRecordHashedFileCount === 49 &&
      distribution.wheelRecordVerifiedHashedFileCount === distribution.wheelRecordHashedFileCount &&
      distribution.wheelRecordMismatchCount === 0,
    "HOMR review must record a complete portable RECORD binding with zero observed mismatches.",
  );
  requireCondition(
    Number.isInteger(wheelArchive.bytes) && wheelArchive.bytes > 0 &&
      /^[a-f0-9]{64}$/i.test(String(wheelArchive.sha256 || "")),
    "HOMR review must bind the retained wheel archive.",
  );
  requireCondition(
    Array.isArray(record?.modelArtifacts) && record.modelArtifacts.length === 6,
    "HOMR runtime must bind the complete six-file model manifest.",
  );

  const status = record?.decision?.status;
  requireCondition(
    ["pending", "deferred", "approved-with-conditions"].includes(status),
    `Unsupported HOMR review status: ${status}`,
  );
  if (status !== "approved-with-conditions") {
    requireCondition(record?.decision?.controlledOfflineReviewApproved === false, "Unapproved review cannot approve offline use.");
    requireCondition(record?.decision?.studentFacingNetworkUseApproved === false, "Unapproved review cannot approve network use.");
    requireCondition(record?.decision?.redistributionApproved === false, "Unapproved review cannot approve redistribution.");
    return false;
  }

  requireCondition(String(record.decision.reviewedBy || "").trim() !== "", "Approved HOMR review requires a named reviewer.");
  requireCondition(Number.isFinite(Date.parse(record.decision.reviewedAt)), "Approved HOMR review requires a valid timestamp.");
  requireCondition(
    JSON.stringify(record.decision.approvedScopes) === JSON.stringify([APPROVED_SCOPE]),
    "HOMR approval scope must be controlled offline review only.",
  );
  requireCondition(record.decision.controlledOfflineReviewApproved === true, "Controlled offline approval flag is required.");
  requireCondition(record.decision.studentFacingNetworkUseApproved === false, "Student-facing network use must stay unapproved.");
  requireCondition(record.decision.redistributionApproved === false, "Redistribution must stay unapproved.");
  requireCondition(record.decision.confirmations?.controlledOfflineOnly === true, "Offline-only confirmation is required.");
  requireCondition(record.decision.confirmations?.modelLicenseBasisReviewed === true, "Model-license review confirmation is required.");
  requireCondition(record.decision.confirmations?.noModelRedistribution === true, "No-redistribution confirmation is required.");
  requireCondition(
    record.modelLicenseReview?.status === "reviewer-confirmed-for-controlled-offline-use",
    "Model-license basis must be reviewer-confirmed for controlled offline use.",
  );
  requireCondition(String(record.modelLicenseReview?.basis || "").trim() !== "", "Model-license basis cannot be empty.");
  requireCondition(record.modelLicenseReview?.redistributionAllowed === false, "Model redistribution must remain disallowed.");
  requireCondition(record.decision.approvalBinding?.bindingVersion === 2, "HOMR approval binding must be version 2.");
  requireCondition(
    record.decision.approvalBinding?.componentVersion === record.component.version,
    "HOMR approval is invalidated by a component-version change.",
  );
  requireCondition(
    record.decision.approvalBinding?.integrationContractVersion === record.integration.contractVersion,
    "HOMR approval is invalidated by an integration-contract change.",
  );
  requireCondition(
    sameJson(record.decision.approvalBinding?.executable, expectedExecutableBinding(record)),
    "HOMR approval is invalidated by an executable contract change.",
  );
  requireCondition(
    sameJson(record.decision.approvalBinding?.wheelArchive, {
      bytes: wheelArchive.bytes,
      sha256: wheelArchive.sha256,
    }),
    "HOMR approval is invalidated by a retained-wheel change.",
  );
  requireCondition(
    sameJson(record.decision.approvalBinding?.portableRecord, expectedPortableRecordBinding(record)),
    "HOMR approval is invalidated by a portable RECORD change.",
  );
  requireCondition(
    record.decision.approvalBinding?.metadataSha256 === record.evidence?.localDistribution?.metadataSha256,
    "HOMR approval is invalidated by a METADATA hash change.",
  );
  requireCondition(
    record.decision.approvalBinding?.licenseSha256 === record.evidence?.localDistribution?.licenseSha256,
    "HOMR approval is invalidated by a LICENSE hash change.",
  );
  requireCondition(
    record.decision.approvalBinding?.deploymentTargetRuntimeRoot === record.deployment?.targetRuntimeRoot,
    "HOMR approval is invalidated by a deployment-target change.",
  );
  requireCondition(
    sameJson(record.decision.approvalBinding?.modelArtifacts, expectedModelBinding(record)),
    "HOMR approval is invalidated by a model manifest change.",
  );
  return true;
}

export function auditHomrBoundary(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const reviewPath = options.reviewPath || DEFAULT_REVIEW;
  const scoreImportSource = readText(root, "python-service/analyzer_score_import.py");
  const analyzerSource = readText(root, "python-service/analyzer.py");
  const runtimeSource = readText(root, "python-service/analyzer_runtime.py");
  const configSource = readText(root, "python-service/config.py");
  const offlinePipelineSource = readText(root, "scripts/western_photo_score_pipeline.py");
  const controlledBatchSource = readText(root, "scripts/run-western-photo-score-batch.mjs");
  const productionWrapperSource = readText(root, "scripts/run-western-photo-score-python.ps1");
  const review = readJson(root, reviewPath);

  const homrExecutionPatterns = [
    /def\s+_run_homr\b/i,
    /\b_run_homr\s*\(/i,
    /subprocess\.(?:run|Popen)\s*\([^)]*homr/i,
    /homr_cli\s*,/i,
  ];
  const scannedMainlineSources = {
    "python-service/analyzer_score_import.py": scoreImportSource,
    "python-service/analyzer.py": analyzerSource,
    "python-service/analyzer_runtime.py": runtimeSource,
  };
  const executionMatches = [];
  for (const [relativePath, source] of Object.entries(scannedMainlineSources)) {
    for (const pattern of homrExecutionPatterns) {
      if (pattern.test(source)) executionMatches.push({ file: relativePath, pattern: String(pattern) });
    }
  }

  requireCondition(
    scoreImportSource.includes('"provider": "audiveris"') && scoreImportSource.includes('"role": "primary"'),
    "Audiveris must remain the primary mainline OMR provider.",
  );
  requireCondition(
    scoreImportSource.includes('"provider": "homr"') && scoreImportSource.includes('"role": "secondary-candidate"'),
    "HOMR must remain a secondary mainline diagnostic candidate.",
  );
  requireCondition(scoreImportSource.includes('"mainlineExecutable": False'), "HOMR must remain non-executable in the mainline.");
  requireCondition(
    scoreImportSource.includes("_run_audiveris(pdf_path, output_dir)") &&
      scoreImportSource.includes('_run_audiveris_pagewise(pdf_path, output_dir / "pagewise")'),
    "PDF score import must still execute the Audiveris whole/pagewise path.",
  );
  requireCondition(configSource.includes("ERHU_HOMR_CLI"), "HOMR CLI setting should remain diagnostic-only configuration.");
  requireCondition(runtimeSource.includes('"homr"'), "Dependency report should still expose HOMR availability.");
  requireCondition(executionMatches.length === 0, `HOMR mainline execution path found: ${JSON.stringify(executionMatches)}`);

  requireCondition(
    offlinePipelineSource.includes("def recognize_homr(") &&
      offlinePipelineSource.includes("subprocess.run([str(homr_exe), local.name]"),
    "Offline v3 must invoke HOMR only through its external CLI subprocess.",
  );
  requireCondition(
    !/^\s*(?:from\s+homr\b|import\s+homr\b)/m.test(offlinePipelineSource),
    "Offline v3 must not import HOMR into the project process.",
  );
  requireCondition(offlinePipelineSource.includes("shutil.copyfile(photo, local)"), "Offline v3 must pass a local image file to HOMR.");
  requireCondition(
    offlinePipelineSource.includes('vdir.glob("*.musicxml")') && offlinePipelineSource.includes('vdir.glob("*.mxl")'),
    "Offline v3 must consume HOMR through MusicXML files.",
  );
  requireCondition(
    offlinePipelineSource.includes('"status": "homr-unavailable"'),
    "Direct research v3 must keep its missing-executable state explicit in the audit.",
  );
  requireCondition(
    offlinePipelineSource.includes('"--require-complete-engine-pool"') &&
      offlinePipelineSource.includes('if args.require_complete_engine_pool and not pool["complete"]') &&
      offlinePipelineSource.includes('"reason": "required-engine-pool-incomplete"'),
    "Controlled production must fail before analysis when its required engine pool is incomplete.",
  );
  requireCondition(
    controlledBatchSource.includes('latestAction.get(s.submissionId) === "accepted_for_batch"'),
    "Controlled HOMR batch must retain accepted_for_batch intake.",
  );
  requireCondition(
    controlledBatchSource.includes("autoDiagnosisIssued: false") && controlledBatchSource.includes("studentFacing: false"),
    "Controlled HOMR batch must remain review-only and non-student-facing.",
  );
  requireCondition(
    controlledBatchSource.includes('"run-western-photo-score-python.ps1"'),
    "Controlled HOMR batch must invoke the governed production wrapper.",
  );
  requireCondition(
    controlledBatchSource.includes("res.status === 0 && parsed"),
    "Controlled HOMR batch must not accept parsed output from a failed wrapper.",
  );
  requireCondition(
    productionWrapperSource.includes('"--audiveris", "--homr", "--require-complete-engine-pool"') &&
      productionWrapperSource.includes("--require-complete-engine-pool") &&
      productionWrapperSource.includes("photo-score-deployment-preflight-failed"),
    "Production wrapper must reserve engine arguments, pass the complete-pool flag, and fail on deployment preflight.",
  );

  const licenseReviewReady = validateReviewRecord(review);
  return {
    ok: true,
    primaryProvider: "audiveris",
    homrMainlineRole: "secondary-candidate",
    homrExecutesInMainline: false,
    homrMainlineExecutable: false,
    homrOfflineV3Executable: true,
    offlineIntegrationMode: review.integration.mode,
    controlledProductionMissingEngineBehavior: "fail-before-analysis",
    directResearchMissingEngineBehavior: "explicit-audiveris-only-degraded-pool",
    deploymentTargetRuntimeRoot: review.deployment?.targetRuntimeRoot,
    controlledBatchStudentFacing: false,
    licenseReviewStatus: review.decision.status,
    licenseReviewReady,
    controlledOfflineReviewApproved: review.decision.controlledOfflineReviewApproved === true,
    studentFacingNetworkUseApproved: false,
    redistributionApproved: false,
    modelLicenseStatus: review.modelLicenseReview.status,
    deploymentReady: false,
    deploymentReadyAuthority: "live-photo-score-deployment-preflight",
    deploymentRecordStatus: review.deployment?.status || "missing",
    reviewArtifact: reviewPath.replace(/\\/g, "/"),
    checkedFiles: [
      ...Object.keys(scannedMainlineSources),
      "scripts/western_photo_score_pipeline.py",
      "scripts/run-western-photo-score-batch.mjs",
      "scripts/run-western-photo-score-python.ps1",
      reviewPath.replace(/\\/g, "/"),
    ],
  };
}

function main() {
  console.log(JSON.stringify(auditHomrBoundary(), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
