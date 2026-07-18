import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const M4B_POC_PROMOTION_DECISION = "western-m4b-poc-promotion-thresholds-v1";
export const M4B_POC_PROMOTION_DECISION_PATH = path.join(
  "data",
  "experiments",
  "western-strings-m4b-poc-promotion-threshold-decision.json",
);

const REQUIRED_MINIMUMS = Object.freeze({ pages: 30, piecesOrLayouts: 6, devices: 3 });
const REQUIRED_THRESHOLDS = Object.freeze({
  measureBoxF1: 0.95,
  exactPageStructureRate: 0.8,
  structureConflictReviewRequiredRate: 1,
  meterRegionF1: 0.95,
});

export function evaluateM4bPocPromotionDecision(decision) {
  const blockingReasons = [];
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ready: false, blockingReasons: ["m4b-poc-promotion-decision-missing"] };
  }
  if (decision.decision !== M4B_POC_PROMOTION_DECISION) {
    blockingReasons.push("m4b-poc-promotion-decision-contract-mismatch");
  }
  if (decision.approved !== true) blockingReasons.push("m4b-poc-promotion-not-approved");
  if (decision.promotionScope !== "m4b-poc-to-expanded-investment-only") {
    blockingReasons.push("m4b-poc-promotion-scope-mismatch");
  }
  for (const [field, expected] of Object.entries(REQUIRED_MINIMUMS)) {
    if (decision.freshBlindMinimums?.[field] !== expected) {
      blockingReasons.push(`m4b-poc-fresh-blind-${field}-minimum-mismatch`);
    }
  }
  for (const [field, expected] of Object.entries(REQUIRED_THRESHOLDS)) {
    if (decision.thresholds?.[field] !== expected) {
      blockingReasons.push(`m4b-poc-${field}-threshold-mismatch`);
    }
  }
  if (decision.confirmNoRetroactiveThresholdTuning !== true) {
    blockingReasons.push("m4b-poc-no-retroactive-tuning-confirmation-missing");
  }
  if (decision.confirmThresholdFailureKeepsM4bResearchOnly !== true) {
    blockingReasons.push("m4b-poc-failure-disposition-confirmation-missing");
  }
  if (decision.confirmDoesNotAuthorizeAutomaticAdoption !== true) {
    blockingReasons.push("m4b-poc-automatic-adoption-boundary-missing");
  }
  if (decision.m4bOpenWorldOmrAutomaticAdoptionReady !== false) {
    blockingReasons.push("m4b-poc-open-world-automatic-adoption-not-closed");
  }
  if (!String(decision.decidedBy || "").trim() || !String(decision.decidedAt || "").trim()) {
    blockingReasons.push("m4b-poc-owner-identity-missing");
  }
  return { ready: blockingReasons.length === 0, blockingReasons };
}

export async function loadM4bPocPromotionDecision(repoRoot = process.cwd()) {
  const absolute = path.resolve(repoRoot, M4B_POC_PROMOTION_DECISION_PATH);
  try {
    const bytes = await fs.readFile(absolute);
    const decision = JSON.parse(bytes.toString("utf8"));
    return {
      ...evaluateM4bPocPromotionDecision(decision),
      source: M4B_POC_PROMOTION_DECISION_PATH.replace(/\\/g, "/"),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      decision,
    };
  } catch (error) {
    return {
      ready: false,
      source: M4B_POC_PROMOTION_DECISION_PATH.replace(/\\/g, "/"),
      sha256: "",
      decision: null,
      blockingReasons: [
        String(error?.code || "") === "ENOENT"
          ? "m4b-poc-promotion-decision-missing"
          : "m4b-poc-promotion-decision-invalid",
      ],
    };
  }
}
