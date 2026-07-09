import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { buildProjectStatus, writeProjectStatus } from "./status-western-strings-project.mjs";
import { DEFAULT_OUT as DEFAULT_HANDOFF_OUT, renderHandoff } from "./create-western-strings-next-action-handoff.mjs";

const DEFAULT_STATUS_OUT = path.join("data", "experiments", "western-strings-project-status.json");

function parseArgs(argv) {
  const args = {
    priority: 1,
    statusOut: DEFAULT_STATUS_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--priority") args.priority = Number(argv[++index] || args.priority);
    else if (arg === "--status-out") args.statusOut = argv[++index] || args.statusOut;
  }
  return args;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function openPath(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Start-Process -LiteralPath $args[0]",
        filePath,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function shouldOpenHandoff(action) {
  return action?.track === "M2/M3 ordinary upload candidate gate"
    && (action.reason || []).includes("ordinary-auto-gate-disabled-by-default");
}

async function writeHandoff(status) {
  const outPath = path.resolve(process.cwd(), DEFAULT_HANDOFF_OUT);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, renderHandoff(status), "utf8");
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = await buildProjectStatus();
  await writeProjectStatus(status, args.statusOut);
  const action = (status.nextActions || []).find((item) => Number(item.priority) === args.priority)
    || (status.nextActions || [])[0];
  if (!action) {
    throw new Error("No next-action artifact is available to open.");
  }
  if (!shouldOpenHandoff(action) && !action.artifact) {
    throw new Error("No next-action artifact is available to open.");
  }
  const artifactPath = shouldOpenHandoff(action)
    ? await writeHandoff(status)
    : path.resolve(process.cwd(), action.artifact);
  if (!(await fileExists(artifactPath))) {
    throw new Error(`Next-action artifact does not exist: ${path.relative(process.cwd(), artifactPath)}`);
  }
  await openPath(artifactPath);
  console.log(JSON.stringify({
    ok: true,
    opened: path.relative(process.cwd(), artifactPath).replace(/\\/g, "/"),
    fileUrl: pathToFileURL(artifactPath).href,
    priority: action.priority,
    track: action.track,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
