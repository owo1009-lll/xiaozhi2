import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const M4A_GATE_SPLIT_DECISION = "western-m4a-m4b-gate-split-v1";
export const M4A_GATE_SPLIT_DECISION_PATH = path.join(
  "data",
  "experiments",
  "western-strings-m4a-gate-split-decision.json",
);

export function evaluateM4aGateSplitDecision(decision) {
  const blockingReasons = [];
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ready: false, blockingReasons: ["m4a-gate-split-decision-missing"] };
  }
  if (decision.decision !== M4A_GATE_SPLIT_DECISION) {
    blockingReasons.push("m4a-gate-split-decision-contract-mismatch");
  }
  if (decision.approved !== true) blockingReasons.push("m4a-gate-split-not-approved");
  if (decision.projectGateBinding !== "m4a-supported-edition-registration") {
    blockingReasons.push("m4a-gate-split-project-binding-mismatch");
  }
  if (decision.m4bOpenWorldOmrAutomaticAdoptionReady !== false) {
    blockingReasons.push("m4a-gate-split-open-world-omr-not-closed");
  }
  if (decision.confirmM4aDoesNotAuthorizeOpenWorldOmr !== true) {
    blockingReasons.push("m4a-gate-split-scope-confirmation-missing");
  }
  if (decision.confirmStudentRuntimeRemainsFailClosed !== true) {
    blockingReasons.push("m4a-gate-split-runtime-confirmation-missing");
  }
  if (!String(decision.decidedBy || "").trim() || !String(decision.decidedAt || "").trim()) {
    blockingReasons.push("m4a-gate-split-owner-identity-missing");
  }
  return { ready: blockingReasons.length === 0, blockingReasons };
}

export async function loadM4aGateSplitDecision(repoRoot = process.cwd()) {
  const absolute = path.resolve(repoRoot, M4A_GATE_SPLIT_DECISION_PATH);
  try {
    const bytes = await fs.readFile(absolute);
    const decision = JSON.parse(bytes.toString("utf8"));
    const evaluation = evaluateM4aGateSplitDecision(decision);
    return {
      ...evaluation,
      source: M4A_GATE_SPLIT_DECISION_PATH.replace(/\\/g, "/"),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      decision,
    };
  } catch (error) {
    return {
      ready: false,
      source: M4A_GATE_SPLIT_DECISION_PATH.replace(/\\/g, "/"),
      sha256: "",
      decision: null,
      blockingReasons: [
        String(error?.code || "") === "ENOENT"
          ? "m4a-gate-split-decision-missing"
          : "m4a-gate-split-decision-invalid",
      ],
    };
  }
}
