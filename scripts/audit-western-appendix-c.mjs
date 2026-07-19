import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { auditM4aEngineeringAcceptance } from "./audit-western-m4a-engineering-acceptance.mjs";
import { auditM4aRealPhotoAcceptance } from "./audit-western-m4a-real-photo-acceptance.mjs";
import { auditM4aSupportedEditionRegistry } from "./audit-western-m4a-supported-edition-registry.mjs";
import { auditM4bDataset } from "./audit-western-m4b-dataset.mjs";
import { auditM4bFreshBlindIntake } from "./audit-western-m4b-fresh-blind-intake.mjs";
import { auditM4bStructurePoc } from "./audit-western-m4b-structure-poc.mjs";
import { loadM4aGateSplitDecision } from "./m4a-supported-edition-governance.mjs";
import { loadM4bPocPromotionDecision } from "./m4b-poc-promotion-governance.mjs";
import { runM4aRegistrationPreflight } from "./preflight-western-m4a-registration.mjs";
import { buildProjectStatus } from "./status-western-strings-project.mjs";


const DEFAULT_OUT = path.join("data", "experiments", "western-strings-appendix-c-audit.json");

function unique(rows) {
  return [...new Set(rows)];
}

function containsAll(text, fragments) {
  return fragments.every((fragment) => text.includes(fragment));
}

export function evaluateAppendixC({
  status,
  decisions,
  m4a,
  m4b,
  projectPlan,
  projectStatus,
}) {
  const engineeringBlockingReasons = [];
  const m4 = status?.tracks?.m4Omr || {};
  if (decisions?.m4aGateSplit?.ready !== true) engineeringBlockingReasons.push("appendix-c-m4a-gate-split-decision-not-ready");
  if (decisions?.m4bThresholds?.ready !== true) engineeringBlockingReasons.push("appendix-c-m4b-threshold-decision-not-ready");
  if (m4a?.registry?.ready !== true) engineeringBlockingReasons.push("appendix-c-m4a-registry-not-ready");
  if (m4a?.runtime?.ready !== true) engineeringBlockingReasons.push("appendix-c-m4a-runtime-not-ready");
  if (m4a?.engineering?.ready !== true) engineeringBlockingReasons.push("appendix-c-m4a-engineering-not-ready");
  if (m4a?.realPhoto?.operationalReady !== true) engineeringBlockingReasons.push("appendix-c-m4a-real-photo-flow-not-operational");
  if (m4b?.dataset?.ready !== true) engineeringBlockingReasons.push("appendix-c-m4b-data-foundation-not-ready");
  if (m4b?.freshBlind?.operationalReady !== true) engineeringBlockingReasons.push("appendix-c-m4b-fresh-intake-not-operational");
  if (m4b?.structurePoc?.engineeringReady !== true) engineeringBlockingReasons.push("appendix-c-m4b-structure-poc-not-ready");
  if (m4b?.structurePoc?.promotionOperationalReady !== true) engineeringBlockingReasons.push("appendix-c-m4b-promotion-flow-not-operational");
  if (
    m4?.m4bOpenWorldOmrAutomaticAdoptionReady !== false
    || status?.runtimeStudentGate?.m4OmrAutoScoreReady !== false
    || m4b?.structurePoc?.boundary?.automaticAdoptionAuthorized !== false
    || m4b?.structurePoc?.boundary?.studentFacing !== false
  ) {
    engineeringBlockingReasons.push("appendix-c-m4b-safety-boundary-open");
  }
  if ((m4?.m4bPocBlockingReasons || []).includes("m4b-real-structure-labels-below-100")) {
    engineeringBlockingReasons.push("appendix-c-circular-real-label-promotion-blocker-reintroduced");
  }
  if (!containsAll(projectPlan || "", [
    "### C.1 闸门拆分",
    "### C.2 M4a 详细方案",
    "#### C.2.6 谱库规模化扩充计划",
    "#### C.2.7 负责人教材曲目总清单",
    "### C.3 M4b 详细方案",
    "#### C.3.3 晋升门槛",
    "### C.4 决策清单",
    "synthetic-engineering",
    "m4b-fresh-blind-capture-pack",
  ])) {
    engineeringBlockingReasons.push("appendix-c-project-plan-surface-incomplete");
  }
  if (!containsAll(projectStatus || "", [
    "m4bStructurePocEngineeringReady=true",
    "m4bStructurePocPromotionReady=false",
    "m4a-owner-measure-box-confirmation-not-ready",
    "m4b-fresh-blind-capture-pack",
  ])) {
    engineeringBlockingReasons.push("appendix-c-project-status-surface-incomplete");
  }
  const engineeringComplete = engineeringBlockingReasons.length === 0;
  const externalBlockingReasons = unique([
    ...(m4a?.realPhoto?.ready === true ? [] : (m4a?.realPhoto?.blockingReasons || ["m4a-real-photo-acceptance-not-ready"])),
    ...(m4b?.structurePoc?.promotionReady === true ? [] : (m4b?.structurePoc?.promotionBlockingReasons || ["m4b-poc-promotion-not-ready"])),
  ]);
  const appendixAcceptanceComplete = (
    engineeringComplete
    && m4a?.realPhoto?.ready === true
    && m4b?.structurePoc?.promotionReady === true
  );
  return {
    contract: "western-strings-appendix-c-audit-v1",
    auditComplete: true,
    engineeringComplete,
    appendixAcceptanceComplete,
    engineeringBlockingReasons: unique(engineeringBlockingReasons),
    externalBlockingReasons,
    decisions: {
      m4aGateSplitReady: decisions?.m4aGateSplit?.ready === true,
      m4bPromotionThresholdsReady: decisions?.m4bThresholds?.ready === true,
    },
    m4a: {
      registryReady: m4a?.registry?.ready === true,
      registeredEditions: m4a?.registry?.counts?.validEntries ?? 0,
      runtimeReady: m4a?.runtime?.ready === true,
      engineeringReady: m4a?.engineering?.ready === true,
      realPhotoFlowOperationalReady: m4a?.realPhoto?.operationalReady === true,
      realPhotoAcceptanceReady: m4a?.realPhoto?.ready === true,
      scaleCatalog: {
        documented: (projectPlan || "").includes("~600–750 条目/乐章"),
        continuousLifecycleTarget: true,
        blocksInitialM4aAcceptance: false,
      },
    },
    m4b: {
      dataFoundationReady: m4b?.dataset?.ready === true,
      realAnnotationExpansionTargetReady: m4b?.dataset?.realAnnotationTargetReady === true,
      realAnnotationTargetBlocksPocPromotion: false,
      freshBlindIntakeOperationalReady: m4b?.freshBlind?.operationalReady === true,
      freshBlindDatasetReady: m4b?.freshBlind?.ready === true,
      structurePocEngineeringReady: m4b?.structurePoc?.engineeringReady === true,
      promotionOperationalReady: m4b?.structurePoc?.promotionOperationalReady === true,
      promotionReady: m4b?.structurePoc?.promotionReady === true,
      automaticAdoptionReady: m4?.m4bOpenWorldOmrAutomaticAdoptionReady === true,
      syntheticMetrics: m4b?.structurePoc?.metrics || null,
      freshBlindCounts: m4b?.structurePoc?.freshBlindCounts || null,
    },
    runtimeBoundary: {
      studentM4AutoScoreReady: status?.runtimeStudentGate?.m4OmrAutoScoreReady === true,
      m4bAutomaticAdoptionReady: m4?.m4bOpenWorldOmrAutomaticAdoptionReady === true,
      failClosed: (
        status?.runtimeStudentGate?.m4OmrAutoScoreReady === false
        && m4?.m4bOpenWorldOmrAutomaticAdoptionReady === false
      ),
    },
    nextExternalActions: [
      {
        track: "M4a",
        action: "Capture the 10 exact registered-version screen photos, run the frozen evaluator, then sign every projected measure box in the owner review pack.",
        pack: "docs/m4a-real-photo-capture-pack/index.html",
      },
      {
        track: "M4b",
        action: "Capture and structure-label at least 30 valid fresh-blind photos spanning six held-out layouts and three physical devices, then run the frozen promotion evaluator.",
        pack: "docs/m4b-fresh-blind-capture-pack/index.html",
      },
    ],
  };
}

export async function auditAppendixC(repoRoot = process.cwd()) {
  const [
    status,
    m4aGateSplit,
    m4bThresholds,
    registry,
    runtime,
    engineering,
    realPhoto,
    dataset,
    freshBlind,
    structurePoc,
    projectPlan,
    projectStatus,
  ] = await Promise.all([
    buildProjectStatus(),
    loadM4aGateSplitDecision(repoRoot),
    loadM4bPocPromotionDecision(repoRoot),
    auditM4aSupportedEditionRegistry(repoRoot),
    runM4aRegistrationPreflight(repoRoot, { writeReport: false }),
    auditM4aEngineeringAcceptance(repoRoot),
    auditM4aRealPhotoAcceptance(repoRoot),
    auditM4bDataset(repoRoot),
    auditM4bFreshBlindIntake(repoRoot),
    auditM4bStructurePoc(repoRoot),
    fs.readFile(path.join(repoRoot, "docs", "western-strings-project-plan.md"), "utf8"),
    fs.readFile(path.join(repoRoot, "docs", "project-status.md"), "utf8"),
  ]);
  return evaluateAppendixC({
    status,
    decisions: { m4aGateSplit, m4bThresholds },
    m4a: { registry, runtime, engineering, realPhoto },
    m4b: { dataset, freshBlind, structurePoc },
    projectPlan,
    projectStatus,
  });
}

async function main() {
  const result = await auditAppendixC();
  const outputIndex = process.argv.indexOf("--out");
  const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : DEFAULT_OUT);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    engineeringComplete: result.engineeringComplete,
    appendixAcceptanceComplete: result.appendixAcceptanceComplete,
    engineeringBlockingReasons: result.engineeringBlockingReasons,
    externalBlockingReasons: result.externalBlockingReasons,
    output,
  }, null, 2));
  if (!result.engineeringComplete) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
