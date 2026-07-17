import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OUT = path.join("data", "experiments", "western-strings-controlled-pilot-approval.json");
// Contract version the approval binds to. Bumping this (e.g. after the
// 2026-07-17 M3+ rescope superseded the first-measure slide/trill contract)
// invalidates every earlier approval and forces a fresh owner decision.
export const SCOPE_CONTRACT = "m3plus-rescope-four-zone-v1";
const DEFAULT_SCOPE = "ordinary candidate-evidence auto_pass only; M3+ four-zone pitch-safety scope (rescope contract) only if explicitly included in the pilot";

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    scope: DEFAULT_SCOPE,
    notes: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--decision") args.decision = argv[++index] || args.decision;
    else if (arg === "--by") args.by = argv[++index] || args.by;
    else if (arg === "--at") args.at = argv[++index] || args.at;
    else if (arg === "--scope") args.scope = argv[++index] || args.scope;
    else if (arg === "--notes") args.notes = argv[++index] || args.notes;
    else if (arg === "--out") args.out = argv[++index] || args.out;
    else if (arg === "--confirm-separate-monitored-pilot") args.confirmSeparateMonitoredPilot = true;
    else if (arg === "--confirm-default-runtime-fail-closed") args.confirmDefaultRuntimeFailClosed = true;
  }
  return args;
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function validateArgs(args) {
  const decision = String(args.decision || "").trim().toLowerCase();
  const errors = [];
  if (!["approve", "defer"].includes(decision)) {
    errors.push("decision-must-be-approve-or-defer");
  }
  if (String(args.by || "").trim() === "") {
    errors.push("approved-by-required");
  }
  if (decision === "approve") {
    if (args.confirmSeparateMonitoredPilot !== true) {
      errors.push("approve-requires-confirm-separate-monitored-pilot");
    }
    if (args.confirmDefaultRuntimeFailClosed !== true) {
      errors.push("approve-requires-confirm-default-runtime-fail-closed");
    }
  }
  return { decision, errors };
}

export async function writeControlledPilotApprovalDecision(args = {}) {
  const resolved = {
    out: args.out || DEFAULT_OUT,
    scope: args.scope || DEFAULT_SCOPE,
    notes: args.notes || "",
    decision: args.decision,
    by: args.by,
    at: args.at,
    confirmSeparateMonitoredPilot: args.confirmSeparateMonitoredPilot,
    confirmDefaultRuntimeFailClosed: args.confirmDefaultRuntimeFailClosed,
  };
  const { decision, errors } = validateArgs(resolved);
  if (errors.length) {
    return {
      ok: false,
      out: rel(resolved.out),
      errors,
      usage: [
        "Defer/no-go:",
        "node scripts/record-western-controlled-pilot-decision.mjs --decision defer --by owner-name",
        "Approve monitored pilot:",
        "node scripts/record-western-controlled-pilot-decision.mjs --decision approve --by owner-name --confirm-separate-monitored-pilot --confirm-default-runtime-fail-closed",
      ],
    };
  }
  const approval = {
    pilotApproved: decision === "approve",
    approvedBy: String(resolved.by || "").trim(),
    approvedAt: resolved.at || new Date().toISOString(),
    scope: resolved.scope,
    scopeContract: SCOPE_CONTRACT,
    notes: resolved.notes || (
      decision === "approve"
        ? "Owner explicitly approved a separate monitored pilot. Default production/student runtime remains fail-closed."
        : "Owner explicitly deferred the monitored pilot. Default production/student runtime remains fail-closed."
    ),
    safetyRules: [
      "This file does not enable any runtime gate.",
      "Default production/student runtime remains fail-closed.",
      "Run npm run western:controlled-pilot-decision after recording this decision.",
      "Run npm run western:controlled-pilot-start-preflight immediately before any approved monitored pilot.",
      "Ask for teacher/professional review only if machine precheck reports unknown or unsafe auto-pass rows.",
    ],
  };
  await fs.mkdir(path.dirname(resolved.out), { recursive: true });
  await fs.writeFile(resolved.out, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  return {
    ok: true,
    out: rel(resolved.out),
    decision,
    pilotApproved: approval.pilotApproved,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    runtimeChanged: false,
    nextCommand: "npm run western:controlled-pilot-decision",
  };
}

async function main() {
  const result = await writeControlledPilotApprovalDecision(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
