#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = path.join(REPO_ROOT, "config", "western-ordinary-audio-runtime.json");
export const ORDINARY_AUDIO_RUNTIME_ANCHORS = Object.freeze({
  runtimeId: "western-ordinary-dynamic-shadow-audio-py311",
  scope: "ordinary-upload-dynamic-shadow-review-only",
  configSemanticSha256: "1f3a47f5cfe2b2d2e427be9a03ab43b4b4aa09a5db0edeed0b55e610a42ac6f9",
  requirementsLockSha256: "4120a811da1ecb1aa93ceabcbb5aa0b45a37c08e5ee3138d2b793e38f2828d04",
  modelVersion: "basic-pitch-0.4.0-default-model",
  modelTreeSha256: "c6595f299ff83c52e89555789f7e3e829a6a0f25b6a88f7e99073af5a2470dc4",
});
const RUNTIME_ATTESTATION_ENV_KEYS = [
  "WESTERN_ORDINARY_AUDIO_RUNTIME_ATTESTED",
  "WESTERN_ORDINARY_AUDIO_RUNTIME_ID",
  "WESTERN_ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256",
  "WESTERN_ORDINARY_AUDIO_RUNTIME_LOCK_SHA256",
  "WESTERN_ORDINARY_AUDIO_RUNTIME_MODEL_SHA256",
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function managedPythonEnv(attestation = {}) {
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.PYTHONUSERBASE;
  for (const key of RUNTIME_ATTESTATION_ENV_KEYS) delete env[key];
  return {
    ...env,
    CUDA_VISIBLE_DEVICES: "-1",
    ERHU_CPU_THREAD_LIMIT: env.ERHU_CPU_THREAD_LIMIT || "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
    PYTHONUTF8: "1",
    TF_CPP_MIN_LOG_LEVEL: env.TF_CPP_MIN_LOG_LEVEL || "3",
    TF_DETERMINISTIC_OPS: "1",
    TF_ENABLE_ONEDNN_OPTS: "0",
    ...attestation,
  };
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const control = separator >= 0 ? argv.slice(0, separator) : argv;
  const pythonArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const args = {
    config: DEFAULT_CONFIG,
    preflightOnly: false,
    script: "",
    pythonArgs,
  };
  for (let index = 0; index < control.length; index += 1) {
    const arg = control[index];
    if (arg === "--config") args.config = control[++index] || args.config;
    else if (arg === "--preflight-only") args.preflightOnly = true;
    else if (arg === "--script") args.script = control[++index] || "";
    else throw new Error(`unknown-argument:${arg}`);
  }
  return args;
}

function failure(reason, detail = "", extra = {}) {
  return {
    ok: false,
    runtimeReady: false,
    reason,
    detail,
    blockingReasons: [reason],
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    fallbackInterpreterUsed: false,
    ...extra,
  };
}

function readConfig(configPath) {
  try {
    const bytes = fs.readFileSync(configPath);
    return {
      ok: true,
      bytes,
      sha256: sha256(bytes),
      value: JSON.parse(bytes.toString("utf8")),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function resolvePython(repoRoot, spec, env) {
  const envName = String(spec?.pathEnv || "").trim();
  const explicit = envName ? String(env?.[envName] || "").trim() : "";
  const configured = explicit || String(spec?.defaultRelativePath || "").trim();
  if (!configured) return { ok: false, reason: "ordinary-audio-python-not-configured" };
  const absolute = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(repoRoot, configured);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    return {
      ok: false,
      reason: explicit
        ? "ordinary-audio-python-explicit-path-missing"
        : "ordinary-audio-python-default-path-missing",
      path: normalizePath(absolute),
    };
  }
  const realRepoRoot = fs.realpathSync(repoRoot);
  const realAbsolute = fs.realpathSync(absolute);
  if (spec?.allowOutsideRepository !== true && !isInside(realRepoRoot, realAbsolute)) {
    return { ok: false, reason: "ordinary-audio-python-outside-repository", path: normalizePath(realAbsolute) };
  }
  return {
    ok: true,
    absolute: realAbsolute,
    source: explicit ? "environment" : "manifest-default",
    envName,
  };
}

function probePython(pythonPath, timeoutMs = 30000) {
  const source = [
    "import importlib.metadata as m, json, re, site, sys",
    "norm = lambda s: re.sub(r'[-_.]+', '-', s).lower()",
    "dists = [(norm(d.metadata['Name']), d) for d in m.distributions() if d.metadata.get('Name')]",
    "print(json.dumps({'pythonVersion': sys.version.split()[0], 'prefix': sys.prefix, 'basePrefix': sys.base_prefix, 'enableUserSite': site.ENABLE_USER_SITE, 'packages': {n: d.version for n, d in dists}, 'packageLocations': {n: str(d.locate_file('')) for n, d in dists}}, sort_keys=True))",
  ].join("; ");
  const result = spawnSync(pythonPath, ["-c", source], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    env: managedPythonEnv(),
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: String(result.error?.message || result.stderr || `exit-${result.status}`),
    };
  }
  try {
    return { ok: true, value: JSON.parse(String(result.stdout || "").trim()) };
  } catch (error) {
    return { ok: false, error: `probe-json-invalid:${String(error?.message || error)}` };
  }
}

function canonicalPackageName(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function readVenvIsolation(runtimeRoot) {
  const configPath = path.join(runtimeRoot, "pyvenv.cfg");
  try {
    const textValue = fs.readFileSync(configPath, "utf8");
    const match = textValue.match(/^include-system-site-packages\s*=\s*(.+)$/im);
    return {
      ok: true,
      path: configPath,
      includeSystemSitePackages: String(match?.[1] || "").trim().toLowerCase() === "true",
    };
  } catch (error) {
    return { ok: false, path: configPath, error: String(error?.message || error) };
  }
}

export function evaluateOrdinaryAudioRuntime({
  repoRoot = REPO_ROOT,
  configPath = DEFAULT_CONFIG,
  env = process.env,
  probe = probePython,
} = {}) {
  const configRead = readConfig(configPath);
  if (!configRead.ok) {
    return failure("ordinary-audio-runtime-config-invalid", configRead.error, {
      config: normalizePath(path.relative(repoRoot, configPath)),
    });
  }
  const config = configRead.value || {};
  const configSemanticSha256 = sha256(Buffer.from(canonicalJson(config), "utf8"));
  const policy = config.policy || {};
  const blockingReasons = [];
  if (configSemanticSha256 !== ORDINARY_AUDIO_RUNTIME_ANCHORS.configSemanticSha256) {
    blockingReasons.push("ordinary-audio-runtime-config-identity-mismatch");
  }
  if (config.runtimeId !== ORDINARY_AUDIO_RUNTIME_ANCHORS.runtimeId) {
    blockingReasons.push("ordinary-audio-runtime-id-mismatch");
  }
  if (config.schemaVersion !== 2) blockingReasons.push("ordinary-audio-runtime-schema-unsupported");
  if (config.scope !== "ordinary-upload-dynamic-shadow-review-only") {
    blockingReasons.push("ordinary-audio-runtime-scope-mismatch");
  }
  if (config.requirementsLock?.normalizedSha256 !== ORDINARY_AUDIO_RUNTIME_ANCHORS.requirementsLockSha256) {
    blockingReasons.push("ordinary-audio-runtime-requirements-lock-anchor-mismatch");
  }
  if (config.modelIdentity?.modelVersion !== ORDINARY_AUDIO_RUNTIME_ANCHORS.modelVersion
      || config.modelIdentity?.treeSha256 !== ORDINARY_AUDIO_RUNTIME_ANCHORS.modelTreeSha256) {
    blockingReasons.push("ordinary-audio-runtime-model-anchor-mismatch");
  }
  if (policy.studentFacing !== false) blockingReasons.push("ordinary-audio-runtime-student-facing-must-be-false");
  if (policy.automaticAdoptionAuthorized !== false) {
    blockingReasons.push("ordinary-audio-runtime-automatic-adoption-must-be-false");
  }
  if (policy.fallbackInterpreterAllowed !== false) {
    blockingReasons.push("ordinary-audio-runtime-fallback-must-be-false");
  }
  if (policy.homrRuntimeShared !== false) blockingReasons.push("ordinary-audio-runtime-must-not-share-homr-runtime");
  if (config.python?.allowOutsideRepository !== false) {
    blockingReasons.push("ordinary-audio-runtime-outside-repository-must-be-forbidden");
  }
  if (config.python?.requireIsolatedVenv !== true) {
    blockingReasons.push("ordinary-audio-runtime-isolated-venv-check-must-be-required");
  }
  if (config.python?.requireUserSiteDisabled !== true) {
    blockingReasons.push("ordinary-audio-runtime-user-site-check-must-be-required");
  }
  if (config.python?.requirePackagesInsideRuntime !== true) {
    blockingReasons.push("ordinary-audio-runtime-package-location-check-must-be-required");
  }
  if (config.strictPackageSet !== true) {
    blockingReasons.push("ordinary-audio-runtime-strict-package-set-must-be-required");
  }

  const requirementsLockPath = path.resolve(repoRoot, String(config.requirementsLock?.path || ""));
  let requirementsLockSha256 = "";
  try {
    if (!isInside(repoRoot, requirementsLockPath)) throw new Error("lock-outside-repository");
    const normalizedLock = fs.readFileSync(requirementsLockPath, "utf8").replace(/\r\n/g, "\n");
    requirementsLockSha256 = sha256(Buffer.from(normalizedLock, "utf8"));
    if (requirementsLockSha256 !== ORDINARY_AUDIO_RUNTIME_ANCHORS.requirementsLockSha256) {
      blockingReasons.push("ordinary-audio-runtime-requirements-lock-mismatch");
    }
  } catch {
    blockingReasons.push("ordinary-audio-runtime-requirements-lock-unreadable");
  }

  const resolved = resolvePython(repoRoot, config.python || {}, env);
  if (!resolved.ok) blockingReasons.push(resolved.reason);
  const probeResult = resolved.ok ? probe(resolved.absolute) : { ok: false, error: "python-not-resolved" };
  if (resolved.ok && !probeResult.ok) blockingReasons.push("ordinary-audio-runtime-probe-failed");
  const observed = probeResult.value || {};
  const runtimeRoot = resolved.ok ? path.resolve(path.dirname(resolved.absolute), "..") : "";
  const venvIsolation = runtimeRoot ? readVenvIsolation(runtimeRoot) : { ok: false };
  if (resolved.ok && probeResult.ok && observed.pythonVersion !== config.python?.version) {
    blockingReasons.push("ordinary-audio-runtime-python-version-mismatch");
  }
  if (resolved.ok && probeResult.ok) {
    if (!samePath(observed.prefix, runtimeRoot) || samePath(observed.prefix, observed.basePrefix)) {
      blockingReasons.push("ordinary-audio-runtime-venv-isolation-invalid");
    }
    if (!venvIsolation.ok || venvIsolation.includeSystemSitePackages !== false) {
      blockingReasons.push("ordinary-audio-runtime-system-site-packages-enabled");
    }
  }
  if (resolved.ok && probeResult.ok && observed.enableUserSite !== false) {
    blockingReasons.push("ordinary-audio-runtime-user-site-enabled");
  }

  const expectedPackages = Object.fromEntries(
    Object.entries(config.requiredPackages || {}).map(([name, version]) => [canonicalPackageName(name), version]),
  );
  const observedPackages = Object.fromEntries(
    Object.entries(observed.packages || {}).map(([name, version]) => [canonicalPackageName(name), version]),
  );
  const packageLocations = Object.fromEntries(
    Object.entries(observed.packageLocations || {}).map(([name, location]) => [canonicalPackageName(name), location]),
  );
  for (const [name, expected] of Object.entries(expectedPackages)) {
    if (resolved.ok && probeResult.ok && observedPackages[name] !== expected) {
      blockingReasons.push(`ordinary-audio-runtime-package-version-mismatch:${name}`);
    }
    if (resolved.ok && probeResult.ok
        && (!packageLocations[name] || !isInside(runtimeRoot, packageLocations[name]))) {
      blockingReasons.push(`ordinary-audio-runtime-package-outside-runtime:${name}`);
    }
  }
  if (resolved.ok && probeResult.ok) {
    for (const name of Object.keys(observedPackages)) {
      if (!Object.hasOwn(expectedPackages, name)) {
        blockingReasons.push(`ordinary-audio-runtime-unlocked-package:${name}`);
      }
    }
    for (const name of Object.keys(expectedPackages)) {
      if (!Object.hasOwn(observedPackages, name)) {
        blockingReasons.push(`ordinary-audio-runtime-locked-package-missing:${name}`);
      }
    }
  }

  const modelArtifacts = [];
  const modelTreeHash = crypto.createHash("sha256");
  for (const artifact of [...(config.modelArtifacts || [])].sort((left, right) => (
    String(left.relativePath || "").localeCompare(String(right.relativePath || ""))
  ))) {
    const packageName = canonicalPackageName(artifact.package);
    const packageRoot = packageLocations[packageName] || "";
    const artifactPath = packageRoot ? path.resolve(packageRoot, String(artifact.relativePath || "")) : "";
    let actualSha256 = "";
    let actualSize = -1;
    if (!artifactPath || !isInside(runtimeRoot, artifactPath) || !fs.existsSync(artifactPath)) {
      blockingReasons.push(`ordinary-audio-runtime-model-artifact-missing:${artifact.relativePath}`);
    } else {
      const bytes = fs.readFileSync(artifactPath);
      actualSha256 = sha256(bytes);
      actualSize = bytes.length;
      if (actualSha256 !== artifact.sha256 || actualSize !== artifact.size) {
        blockingReasons.push(`ordinary-audio-runtime-model-artifact-mismatch:${artifact.relativePath}`);
      }
      modelTreeHash.update(String(artifact.relativePath || "").replace(/\\/g, "/"));
      modelTreeHash.update(Buffer.from([0]));
      modelTreeHash.update(Buffer.from(actualSha256, "hex"));
    }
    modelArtifacts.push({
      package: packageName,
      relativePath: String(artifact.relativePath || "").replace(/\\/g, "/"),
      sha256: actualSha256,
      size: actualSize,
    });
  }
  const observedModelTreeSha256 = modelArtifacts.length ? modelTreeHash.digest("hex") : "";
  if (!modelArtifacts.length
      || observedModelTreeSha256 !== ORDINARY_AUDIO_RUNTIME_ANCHORS.modelTreeSha256) {
    blockingReasons.push("ordinary-audio-runtime-model-tree-mismatch");
  }
  const runtimeReady = blockingReasons.length === 0;
  return {
    ok: runtimeReady,
    runtimeReady,
    generatedAt: new Date().toISOString(),
    runtimeId: String(config.runtimeId || ""),
    scope: String(config.scope || ""),
    config: normalizePath(path.relative(repoRoot, configPath)),
    configSha256: configRead.sha256,
    configSemanticSha256,
    python: {
      path: resolved.ok ? normalizePath(path.relative(repoRoot, resolved.absolute)) : normalizePath(resolved.path || ""),
      source: resolved.source || "",
      version: observed.pythonVersion || "",
      prefix: runtimeRoot ? normalizePath(path.relative(repoRoot, runtimeRoot)) : "",
      isolatedVenv: Boolean(
        runtimeRoot
        && samePath(observed.prefix, runtimeRoot)
        && !samePath(observed.prefix, observed.basePrefix)
        && venvIsolation.ok
        && venvIsolation.includeSystemSitePackages === false,
      ),
      userSiteEnabled: observed.enableUserSite === true,
    },
    packages: observedPackages,
    packageSetLocked: config.strictPackageSet === true
      && Object.keys(expectedPackages).length === Object.keys(observedPackages).length,
    requirementsLock: {
      path: normalizePath(path.relative(repoRoot, requirementsLockPath)),
      normalizedSha256: requirementsLockSha256,
    },
    modelIdentity: {
      modelVersion: String(config.modelIdentity?.modelVersion || ""),
      treeSha256: observedModelTreeSha256,
      artifacts: modelArtifacts,
    },
    blockingReasons,
    detail: probeResult.ok ? "" : String(probeResult.error || ""),
    studentFacing: false,
    automaticAdoptionAuthorized: false,
    fallbackInterpreterUsed: false,
    homrRuntimeShared: false,
    executionTimeoutMs: Math.max(10000, Math.round(Number(config.executionTimeoutMs) || 180000)),
    resolvedPython: resolved.ok ? resolved.absolute : "",
  };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function runCli() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    writeJson(failure("ordinary-audio-runtime-arguments-invalid", String(error?.message || error)));
    return 2;
  }
  const report = evaluateOrdinaryAudioRuntime({ configPath: path.resolve(args.config) });
  if (args.preflightOnly) {
    const { resolvedPython: _resolvedPython, ...publicReport } = report;
    writeJson(publicReport);
    return report.runtimeReady ? 0 : 1;
  }
  if (!report.runtimeReady) {
    const { resolvedPython: _resolvedPython, ...publicReport } = report;
    writeJson(publicReport);
    return 1;
  }
  if (!args.script) {
    writeJson(failure("ordinary-audio-runtime-script-missing"));
    return 2;
  }
  const scriptPath = path.resolve(args.script);
  const realRepoRoot = fs.realpathSync(REPO_ROOT);
  const realScriptPath = fs.existsSync(scriptPath) ? fs.realpathSync(scriptPath) : "";
  if (!realScriptPath || !isInside(realRepoRoot, realScriptPath) || !fs.statSync(realScriptPath).isFile()) {
    writeJson(failure("ordinary-audio-runtime-script-invalid", normalizePath(scriptPath)));
    return 2;
  }
  const child = spawnSync(report.resolvedPython, [realScriptPath, ...args.pythonArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: report.executionTimeoutMs,
    env: managedPythonEnv({
      WESTERN_ORDINARY_AUDIO_RUNTIME_ATTESTED: "1",
      WESTERN_ORDINARY_AUDIO_RUNTIME_ID: report.runtimeId,
      WESTERN_ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256: report.configSemanticSha256,
      WESTERN_ORDINARY_AUDIO_RUNTIME_LOCK_SHA256: report.requirementsLock.normalizedSha256,
      WESTERN_ORDINARY_AUDIO_RUNTIME_MODEL_SHA256: report.modelIdentity.treeSha256,
    }),
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) {
    writeJson(failure("ordinary-audio-runtime-execution-failed", String(child.error.message || child.error)));
    return 1;
  }
  return Number.isInteger(child.status) ? child.status : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = runCli();
}
