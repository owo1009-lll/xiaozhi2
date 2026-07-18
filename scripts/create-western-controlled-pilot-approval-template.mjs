import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  REQUIRED_APPROVED_TRACKS,
  SCOPE_CONTRACT,
} from "./record-western-controlled-pilot-decision.mjs";

const DEFAULT_OUT = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-approval.template.json",
);
const APPROVAL_PATH = path.join(
  "data",
  "experiments",
  "western-strings-controlled-pilot-approval.json",
);

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") args.out = argv[++index] || args.out;
  }
  return args;
}

function rel(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function buildTemplate() {
  return {
    pilotApproved: false,
    approvedBy: "",
    approvedAt: "",
    approvedTracks: [...REQUIRED_APPROVED_TRACKS],
    confirmSeparateMonitoredPilot: false,
    confirmDefaultRuntimeFailClosed: false,
    scopeContract: SCOPE_CONTRACT,
    scope: "ordinary dynamic-shadow scope plus M3+ four-zone pitch-safety scope; both remain separate offline monitored-pilot tracks",
    notes: "Template only. Copy this to data/experiments/western-strings-controlled-pilot-approval.json and set pilotApproved=true only if the product owner explicitly approves a separate monitored pilot. Default runtime must remain fail-closed.",
    noGoUsage: "To explicitly defer or reject the pilot, keep pilotApproved=false and fill approvedBy/approvedAt. This records a safe hold and will not start the pilot.",
    safetyRules: [
      "Do not enable default production/student runtime.",
      "Do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1.",
      "Do not revive first-measure slide/trill technique detection; M3+ uses the four-zone pitch-safety contract only.",
      "Both approvedTracks must have a separately audited executor before the combined pilot may start.",
      "Run npm run western:release-review and npm run western:controlled-pilot-decision after any pilot wiring change.",
      "Ask for teacher/professional review only if machine precheck reports unknown or unsafe auto-pass rows.",
    ],
  };
}

export async function writeApprovalTemplate(args = {}) {
  const out = args.out || DEFAULT_OUT;
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(buildTemplate(), null, 2)}\n`, "utf8");
  return {
    ok: true,
    template: rel(out),
    approvalPath: rel(APPROVAL_PATH),
    note: "This is not an approval file. It will not unblock the pilot until copied to the approvalPath with pilotApproved=true and owner fields filled.",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await writeApprovalTemplate(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
