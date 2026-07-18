import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { auditM4aSupportedEditionRegistry } from "./audit-western-m4a-supported-edition-registry.mjs";

const execFileAsync = promisify(execFile);
export const M4A_REGISTRATION_CONFIG_PATH = path.join("config", "western-m4a-registration.json");
export const M4A_REGISTRATION_PREFLIGHT_PATH = path.join(
  "data",
  "experiments",
  "western-strings-m4a",
  "registration-runtime-preflight.json",
);

const REQUIRED_POLICY = Object.freeze({
  studentFacing: false,
  automaticAdoptionAuthorized: false,
  reviewRequired: true,
  omrAllowedInMainChain: false,
});

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateM4aRegistrationPreflight({ config, registryAudit, host, implementation }) {
  const blockingReasons = [];
  if (config?.contract !== "western-m4a-registration-policy-v1") {
    blockingReasons.push("m4a-registration-policy-contract-mismatch");
  }
  if (!sameJson(config?.policy, REQUIRED_POLICY)) {
    blockingReasons.push("m4a-registration-safety-policy-mismatch");
  }
  if (config?.audioSentinel?.minimumAgreement !== 0.6) {
    blockingReasons.push("m4a-registration-audio-threshold-mismatch");
  }
  if (registryAudit?.ready !== true) {
    blockingReasons.push(...(registryAudit?.blockingReasons || ["m4a-supported-edition-registry-not-ready"]));
  }
  if (!host?.configuredPath) blockingReasons.push("m4a-registration-python-not-configured");
  if (host?.executableExists !== true) blockingReasons.push("m4a-registration-python-missing");
  if (host?.stablePath !== true) blockingReasons.push("m4a-registration-python-path-unstable");
  if (host?.probeOk !== true) blockingReasons.push("m4a-registration-python-probe-failed");
  if (host?.pythonVersion !== config?.runtime?.pythonVersion) {
    blockingReasons.push("m4a-registration-python-version-mismatch");
  }
  for (const [name, expected] of Object.entries(config?.runtime?.requiredPackages || {})) {
    if (host?.packageVersions?.[name] !== expected) {
      blockingReasons.push(`m4a-registration-package-${name}-version-mismatch`);
    }
  }
  if (implementation?.exists !== true) blockingReasons.push("m4a-registration-implementation-missing");
  if (implementation?.omrEngineReferences !== false) {
    blockingReasons.push("m4a-registration-main-chain-omr-reference-detected");
  }
  return { ready: blockingReasons.length === 0, blockingReasons: [...new Set(blockingReasons)] };
}

function resolveConfiguredPython(repoRoot, runtime) {
  const envValue = String(process.env[runtime.pythonPathEnv] || "").trim();
  const configured = envValue || runtime.defaultPythonRelativePath;
  return {
    configured,
    absolute: path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(repoRoot, configured),
  };
}

async function probePython(executable) {
  const script = [
    "import importlib.metadata as m,json,sys",
    "print(json.dumps({'pythonVersion':sys.version.split()[0],'packageVersions':{k:m.version(k) for k in ['numpy','opencv-python','Pillow']}}))",
  ].join(";");
  try {
    const { stdout } = await execFileAsync(executable, ["-c", script], {
      timeout: 30_000,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, PYTHONNOUSERSITE: "1" },
    });
    const value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    return { probeOk: true, ...value, error: "" };
  } catch (error) {
    return { probeOk: false, pythonVersion: "", packageVersions: {}, error: String(error?.message || error) };
  }
}

export async function runM4aRegistrationPreflight(
  repoRoot = process.cwd(),
  { writeReport = false } = {},
) {
  const configAbsolute = path.resolve(repoRoot, M4A_REGISTRATION_CONFIG_PATH);
  let configBytes;
  let config;
  try {
    configBytes = await fs.readFile(configAbsolute);
    config = JSON.parse(configBytes.toString("utf8"));
  } catch (error) {
    return {
      ready: false,
      source: M4A_REGISTRATION_CONFIG_PATH.replace(/\\/g, "/"),
      blockingReasons: ["m4a-registration-policy-missing-or-invalid"],
      error: String(error?.message || error),
    };
  }
  const registryAudit = await auditM4aSupportedEditionRegistry(repoRoot);
  const resolved = resolveConfiguredPython(repoRoot, config.runtime || {});
  let executableExists = false;
  try {
    executableExists = (await fs.stat(resolved.absolute)).isFile();
  } catch {
    executableExists = false;
  }
  const relative = path.relative(repoRoot, resolved.absolute).replace(/\\/g, "/");
  const stablePath = executableExists
    && !relative.startsWith("../")
    && !relative.includes("/experiments/")
    && relative.startsWith("data/tools/");
  const probe = executableExists ? await probePython(resolved.absolute) : {
    probeOk: false,
    pythonVersion: "",
    packageVersions: {},
    error: "executable missing",
  };
  const host = {
    configuredPath: resolved.configured.replace(/\\/g, "/"),
    resolvedPath: relative,
    executableExists,
    stablePath,
    ...probe,
  };
  const implementationPath = path.join("scripts", "western_m4a_registration.py");
  const implementationAbsolute = path.resolve(repoRoot, implementationPath);
  let implementationBytes = null;
  try {
    implementationBytes = await fs.readFile(implementationAbsolute);
  } catch {
    implementationBytes = null;
  }
  const implementationText = implementationBytes?.toString("utf8").toLowerCase() || "";
  const implementation = {
    source: implementationPath.replace(/\\/g, "/"),
    exists: Boolean(implementationBytes),
    sha256: implementationBytes ? sha256(implementationBytes) : "",
    omrEngineReferences: implementationText.includes("audiveris") || implementationText.includes("homr"),
  };
  const evaluation = evaluateM4aRegistrationPreflight({ config, registryAudit, host, implementation });
  const result = {
    contract: "western-m4a-registration-runtime-preflight-v1",
    ...evaluation,
    source: M4A_REGISTRATION_CONFIG_PATH.replace(/\\/g, "/"),
    configSha256: sha256(configBytes),
    registryAudit,
    host,
    implementation,
    policy: config.policy,
  };
  if (writeReport) {
    const report = path.resolve(repoRoot, M4A_REGISTRATION_PREFLIGHT_PATH);
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.writeFile(report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

async function main() {
  const quiet = process.argv.includes("--quiet");
  const result = await runM4aRegistrationPreflight(process.cwd(), { writeReport: true });
  if (!quiet) console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
