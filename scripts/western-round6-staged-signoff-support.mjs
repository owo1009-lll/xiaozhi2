import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const P3_CONTRACT = "western-p3-staged-minimal-recording-protocol-v1";
export const STAGE_A_LINEAGE_CONTRACT =
  "western-round6-stage-a-signoff-lineage-v1";
export const STAGE_A_SAFETY_CONTRACT =
  "western-round6-stage-a-clean-safety-v1";
export const STAGE_A_CONSUMED_CONTRACT =
  "western-round6-stage-a-clean-safety-consumed-v1";
export const STAGE_B_AUTHORIZATION_CONTRACT =
  "western-round6-stage-b-authorization-v1";
export const STAGE_B_LINEAGE_CONTRACT =
  "western-round6-stage-b-signoff-lineage-v1";

export const DEFAULT_STAGED_PATHS = Object.freeze({
  protocol: path.join(
    "docs",
    "evidence",
    "western-strings-p3-minimal-recording-preregistration-20260724.json",
  ),
  contract: path.join(
    "config",
    "western-strings-round6-counterbalanced-contract.json",
  ),
  manifest: path.join(
    "data",
    "private",
    "western-strings-round6-counterbalanced",
    "manifest.csv",
  ),
  truth: path.join(
    "data",
    "private",
    "western-strings-round6-counterbalanced",
    "position-truth.json",
  ),
  positionBalance: path.join(
    "data",
    "experiments",
    "western-strings-round6-counterbalanced-position-balance",
    "report.json",
  ),
  stageALineage: path.join(
    "data",
    "experiments",
    "western-strings-round6-stage-a-signoff",
    "ledger.json",
  ),
  safetyReport: path.join(
    "data",
    "experiments",
    "western-strings-round6-stage-a-safety",
    "report.json",
  ),
  safetyConsumed: path.join(
    "data",
    "experiments",
    "western-strings-round6-stage-a-safety",
    "consumed-ledger.json",
  ),
  safetyModel: path.join(
    "data",
    "experiments",
    "western-strings-round6-stage-a-safety",
    "model.joblib",
  ),
  stageBLineage: path.join(
    "data",
    "experiments",
    "western-strings-round6-stage-b-signoff",
    "ledger.json",
  ),
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const cleanPath = (value) => String(value || "").replace(/\\/g, "/");
const sameIds = (left, right) => (
  JSON.stringify([...(left || [])].map(String).sort())
    === JSON.stringify([...(right || [])].map(String).sort())
);

async function readSource(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`workspace-relative path required: ${relativePath}`);
  }
  const bytes = await fs.readFile(absolute);
  return {
    path: cleanPath(relative),
    bytes,
    sha256: sha256(bytes),
  };
}

function semanticSha(protocol) {
  const core = Object.fromEntries(
    Object.entries(protocol || {}).filter(
      ([key]) => ![
        "schemaVersion",
        "sourceBindings",
        "protocolSemanticSha256",
      ].includes(key),
    ),
  );
  return sha256(Buffer.from(canonicalJson(core), "utf8"));
}

export async function validateStageAAuthorization({
  repoRoot = process.cwd(),
  protocolPath = DEFAULT_STAGED_PATHS.protocol,
  contractPath = DEFAULT_STAGED_PATHS.contract,
  manifestPath = DEFAULT_STAGED_PATHS.manifest,
  truthPath = DEFAULT_STAGED_PATHS.truth,
  positionBalancePath = DEFAULT_STAGED_PATHS.positionBalance,
  stageALineagePath = DEFAULT_STAGED_PATHS.stageALineage,
  safetyReportPath = DEFAULT_STAGED_PATHS.safetyReport,
  safetyConsumedPath = DEFAULT_STAGED_PATHS.safetyConsumed,
  safetyModelPath = DEFAULT_STAGED_PATHS.safetyModel,
} = {}) {
  const root = path.resolve(repoRoot);
  const blockers = [];
  let sources;
  try {
    sources = Object.fromEntries(await Promise.all(
      Object.entries({
        protocol: protocolPath,
        contract: contractPath,
        manifest: manifestPath,
        truth: truthPath,
        positionBalance: positionBalancePath,
        stageALineage: stageALineagePath,
        safetyReport: safetyReportPath,
        safetyConsumed: safetyConsumedPath,
        safetyModel: safetyModelPath,
      }).map(async ([key, sourcePath]) => [key, await readSource(root, sourcePath)]),
    ));
  } catch (error) {
    return {
      ready: false,
      blockingReasons: [
        `round6-stage-b-authorization-source-missing:${error.code || error.name}`,
      ],
    };
  }
  let protocol;
  let lineage;
  let report;
  let consumed;
  try {
    protocol = JSON.parse(sources.protocol.bytes.toString("utf8"));
    lineage = JSON.parse(sources.stageALineage.bytes.toString("utf8"));
    report = JSON.parse(sources.safetyReport.bytes.toString("utf8"));
    consumed = JSON.parse(sources.safetyConsumed.bytes.toString("utf8"));
  } catch {
    return {
      ready: false,
      blockingReasons: ["round6-stage-b-authorization-json-invalid"],
    };
  }
  const semantic = String(protocol?.protocolSemanticSha256 || "");
  if (
    protocol?.contract !== P3_CONTRACT
    || !semantic
    || semanticSha(protocol) !== semantic
  ) {
    blockers.push("round6-stage-b-protocol-invalid");
  }
  const bindingByPath = new Map(
    (protocol?.sourceBindings || []).map(
      (row) => [cleanPath(row?.path), String(row?.sha256 || "")],
    ),
  );
  const mutableKeys = new Map([
    [sources.manifest.path, "manifestSha256"],
    [sources.truth.path, "truthSha256"],
  ]);
  for (const [sourcePath, expected] of bindingByPath) {
    let observed = "";
    try {
      observed = (await readSource(root, sourcePath)).sha256;
    } catch {
      blockers.push(`round6-stage-b-source-missing:${sourcePath}`);
      continue;
    }
    if (observed === expected) continue;
    const lineageKey = mutableKeys.get(sourcePath);
    if (
      !lineageKey
      || lineage?.sourceHashes?.[lineageKey] !== expected
      || lineage?.appliedHashes?.[lineageKey] !== observed
    ) {
      blockers.push(`round6-stage-b-source-binding-stale:${sourcePath}`);
    }
  }
  const stageAIds = protocol?.stageA?.recordingIds || [];
  const stageBIds = protocol?.stageB?.recordingIds || [];
  if (
    lineage?.contract !== STAGE_A_LINEAGE_CONTRACT
    || lineage?.scope?.split !== "calibration"
    || !sameIds(lineage?.scope?.recordingIds, stageAIds)
    || lineage?.stagedProtocol?.protocolSemanticSha256 !== semantic
    || lineage?.appliedHashes?.manifestSha256 !== sources.manifest.sha256
    || lineage?.appliedHashes?.truthSha256 !== sources.truth.sha256
  ) {
    blockers.push("round6-stage-b-stage-a-lineage-invalid");
  }
  const expectedSourceHashes = {
    protocolSha256: sources.protocol.sha256,
    protocolSemanticSha256: semantic,
    contractSha256: sources.contract.sha256,
    manifestSha256: sources.manifest.sha256,
    truthSha256: sources.truth.sha256,
    positionBalanceSha256: sources.positionBalance.sha256,
    signoffLineageSha256: sources.stageALineage.sha256,
  };
  const sourceHashesCurrent = (value) => Object.entries(
    expectedSourceHashes,
  ).every(([key, expected]) => value?.[key] === expected);
  if (
    report?.contract !== STAGE_A_SAFETY_CONTRACT
    || report?.p3ProtocolSemanticSha256 !== semantic
    || !sourceHashesCurrent(report?.sourceHashes)
    || report?.preflightReady !== true
    || report?.executionRequested !== true
    || report?.trainingPerformed !== true
    || report?.cleanSafetyEvaluationPerformed !== true
    || report?.stageAPassed !== true
    || report?.stageBFreshRecordingAuthorized !== true
    || report?.freshAudioRead !== false
    || report?.studentFacing !== false
    || report?.automaticAuthorizationGranted !== false
    || report?.modelArtifact?.sha256 !== sources.safetyModel.sha256
    || report?.blockingReasons?.length !== 0
  ) {
    blockers.push("round6-stage-b-stage-a-safety-report-invalid");
  }
  if (
    consumed?.contract !== STAGE_A_CONSUMED_CONTRACT
    || consumed?.p3ProtocolSemanticSha256 !== semantic
    || !sourceHashesCurrent(consumed?.sourceHashes)
    || consumed?.modelSha256 !== sources.safetyModel.sha256
    || consumed?.cleanSafetyConsumed !== true
    || consumed?.freshAudioRead !== false
    || consumed?.studentFacing !== false
    || consumed?.automaticAuthorizationGranted !== false
  ) {
    blockers.push("round6-stage-b-stage-a-consumed-ledger-invalid");
  }
  if (
    report?.modelArtifact?.path !== sources.safetyModel.path
    || stageAIds.length !== 6
    || stageBIds.length !== 6
  ) {
    blockers.push("round6-stage-b-scope-or-model-path-invalid");
  }
  const authorizationHashes = {
    protocolSha256: sources.protocol.sha256,
    stageALineageSha256: sources.stageALineage.sha256,
    safetyReportSha256: sources.safetyReport.sha256,
    safetyConsumedSha256: sources.safetyConsumed.sha256,
    safetyModelSha256: sources.safetyModel.sha256,
  };
  const paths = {
    protocol: sources.protocol.path,
    stageALineage: sources.stageALineage.path,
    safetyReport: sources.safetyReport.path,
    safetyConsumed: sources.safetyConsumed.path,
    safetyModel: sources.safetyModel.path,
  };
  return {
    ready: blockers.length === 0,
    protocol,
    stageARecordingIds: stageAIds.map(String),
    stageBRecordingIds: stageBIds.map(String),
    sourceHashes: expectedSourceHashes,
    authorizationHashes,
    paths,
    authorizationBinding: {
      contract: STAGE_B_AUTHORIZATION_CONTRACT,
      p3ProtocolSemanticSha256: semantic,
      stageAPassed: true,
      stageBFreshRecordingAuthorized: true,
      sourceHashes: expectedSourceHashes,
      authorizationHashes,
      paths,
    },
    blockingReasons: [...new Set(blockers)].sort(),
  };
}
