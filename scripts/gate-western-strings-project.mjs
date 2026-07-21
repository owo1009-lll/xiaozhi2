import { pathToFileURL } from "node:url";

import { buildProjectStatus, writeProjectStatus } from "./status-western-strings-project.mjs";

function parseArgs(argv) {
  const args = {
    out: "data/experiments/western-strings-project-gate.json",
    require: new Set(["ordinary", "m3plus", "m4"]),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--require") {
      args.require = new Set(String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return args;
}

export function evaluateProjectGate(status, requiredTracks) {
  const failures = [];
  const controlled = status.tracks?.controlledCandidate || {};
  const m3plus = status.tracks?.m3plusPitchModes || {};
  const m4 = status.tracks?.m4Omr || {};
  const publicValidation = status.publicModelValidation || {};

  const ordinaryDynamicShadow = controlled.ordinaryDynamicShadow || {};
  if (requiredTracks.has("ordinary") && ordinaryDynamicShadow.studentGateReady !== true) {
    const ordinaryReasons = ordinaryDynamicShadow.blockingReasons || [];
    failures.push({
      track: "M2/M3 ordinary upload candidate gate",
      reason: ordinaryReasons.length
        ? ordinaryReasons
        : ["ordinary-dynamic-shadow-student-gate-closed"],
      artifact: ordinaryDynamicShadow.acceptanceEvidence?.source || "",
    });
  }
  const m3plusReleaseBlockingReasons = [...new Set([
    ...(m3plus.blockingReasons || []),
    ...(m3plus.offlineEvidenceReady !== true ? ["m3plus-offline-evidence-not-ready"] : []),
    ...(m3plus.reviewOnlyRuntimeWired !== true ? ["m3plus-review-only-runtime-not-wired"] : []),
    ...(m3plus.runtimeFoundationReady !== true ? ["m3plus-runtime-foundation-not-ready"] : []),
    ...(m3plus.runtimeAuditReady !== true ? ["m3plus-runtime-audit-not-ready"] : []),
    ...(m3plus.authorizationReady !== true ? ["m3plus-authorization-closed"] : []),
    ...(m3plus.studentGateReady !== true ? ["m3plus-student-gate-closed"] : []),
  ])];
  const m3plusReleaseReady = m3plus.m3plusPitchSafetyReady === true
    && m3plus.offlineEvidenceReady === true
    && m3plus.reviewOnlyRuntimeWired === true
    && m3plus.runtimeFoundationReady === true
    && m3plus.runtimeAuditReady === true
    && m3plus.authorizationReady === true
    && m3plus.studentGateReady === true;
  if (requiredTracks.has("m3plus") && !m3plusReleaseReady) {
    failures.push({
      track: "M3+ pitch safety rescope",
      reason: m3plusReleaseBlockingReasons.length
        ? m3plusReleaseBlockingReasons
        : ["m3plus-release-gate-not-ready"],
      artifact: m3plus.monitoredPilotAudit?.source
        || m3plus.rescopeGate?.source
        || m3plus.reviewArtifacts?.rescopeGateJson
        || "",
    });
  }
  if (
    requiredTracks.has("m4")
    && m4.m4GateSplitDecisionReady === true
    && m4.m4aSupportedEditionRegistrationReady !== true
  ) {
    failures.push({
      track: "M4a supported-edition registration",
      reason: m4.m4aBlockingReasons || ["m4a-supported-edition-registration-not-ready"],
      artifact:
        m4.artifacts?.m4aRegistrationAuditJson
        || m4.artifacts?.m4aGateSplitDecisionJson
        || "",
    });
  }
  if (
    requiredTracks.has("m4")
    && m4.m4GateSplitDecisionReady !== true
    && !m4.m4OmrAutomaticAdoptionReady
  ) {
    const reasons = m4.automaticAdoptionBlockingReasons || m4.blockingReasons || ["m4-omr-automatic-adoption-not-ready"];
    const artifact = reasons.includes("m4-same-edition-homr-independent-page-count-below-floor")
      ? m4.artifacts?.sameEditionBenchmarkJson
      : m4.artifacts?.independentBenchmarkJson;
    failures.push({
      track: "M4 OMR automatic adoption",
      reason: reasons,
      artifact: artifact || m4.artifacts?.independentGoldTodoHtml || m4.artifacts?.independentGoldTodo || "",
    });
  }
  if (
    requiredTracks.has("m4")
    && m4.m4GateSplitDecisionReady !== true
    && !m4.m4HomrProductionPoolReady
  ) {
    failures.push({
      track: "M4 photo-score deployment/governance",
      reason: m4.homrGovernance?.blockingReasons || ["homr-production-pool-not-ready"],
      artifact:
        m4.artifacts?.photoScoreDeploymentPreflightJson
        || m4.artifacts?.homrReviewRecordJson
        || "",
    });
  }
  if (
    requiredTracks.has("public")
    && publicValidation.gates?.publicProfessionalMonophonicV2CandidateReady !== true
  ) {
    failures.push({
      track: "Public professional monophonic V2 validation",
      reason: publicValidation.blockingReasons || ["public-professional-v2-validation-not-ready"],
      artifact: publicValidation.artifacts?.muscFreshConfirmation || "",
    });
  }

  return {
    projectReleaseReady: failures.length === 0,
    gateScope: requiredTracks.size === 1 && requiredTracks.has("public")
      ? "public-professional-research-candidate"
      : "configured-project-tracks",
    requiredTracks: [...requiredTracks],
    failures,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildProjectStatus();
  const gate = evaluateProjectGate(status, args.require);
  const report = {
    ...status,
    projectGate: gate,
  };
  const outPath = await writeProjectStatus(report, args.out);
  console.log(JSON.stringify({
    ok: true,
    projectReleaseReady: gate.projectReleaseReady,
    gateScope: gate.gateScope,
    defaultStudentReleaseEligible:
      status.runtimeStudentGate?.ordinaryUploadAutoFeedbackReady === true,
    nearPerfectReady: status.publicModelValidation?.gates?.nearPerfectReady === true,
    requiredTracks: gate.requiredTracks,
    failures: gate.failures,
    out: outPath.replace(process.cwd(), ".").replace(/\\/g, "/"),
  }, null, 2));
  if (!gate.projectReleaseReady) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
