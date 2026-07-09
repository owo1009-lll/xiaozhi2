import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
    scope: "ordinary candidate-evidence auto_pass only; optional first-measure slide/trill M3+ subset",
    notes: "Template only. Copy this to data/experiments/western-strings-controlled-pilot-approval.json and set pilotApproved=true only if the product owner explicitly approves a separate monitored pilot. Default runtime must remain fail-closed.",
    safetyRules: [
      "Do not enable default production/student runtime.",
      "Do not commit WESTERN_STRINGS_ENABLE_ORDINARY_AUTO_GATE=1.",
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
