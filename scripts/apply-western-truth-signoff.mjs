import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMPLETED_CONTRACT = "western-truth-signoff-completed-v1";
const STAGED_PROTOCOL_CONTRACT = "western-p3-staged-minimal-recording-protocol-v1";
const DEFAULT_STAGED_PROTOCOL = path.join(
  "docs",
  "evidence",
  "western-strings-p3-minimal-recording-preregistration-20260724.json",
);
const DEFAULT_STAGE_A_LEDGER = path.join(
  "data",
  "experiments",
  "western-strings-round6-stage-a-signoff",
  "ledger.json",
);
const REQUIRED_MANIFEST_FIELDS = [
  "recordingId",
  "pieceId",
  "performerId",
  "deviceId",
  "roomId",
  "split",
  "audioPath",
  "scorePath",
  "consent",
  "licenseStatus",
];

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const clean = (value) => String(value ?? "").trim();
const posixPath = (value) => value.replace(/\\/g, "/");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseCsv(text) {
  const rows = [];
  let current = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      current.push(value);
      value = "";
    } else if (char === "\n") {
      current.push(value);
      rows.push(current);
      current = [];
      value = "";
    } else if (char !== "\r") value += char;
  }
  if (current.length || value) {
    current.push(value);
    rows.push(current);
  }
  const nonempty = rows.filter((row) => row.some((cell) => cell.trim()));
  const [rawHeaders = [], ...body] = nonempty;
  const headers = rawHeaders.map((header) => header.replace(/^\uFEFF/, ""));
  return {
    bom: text.startsWith("\uFEFF"),
    headers,
    rows: body.map((row) => Object.fromEntries(
      headers.map((header, index) => [header, row[index] ?? ""]),
    )),
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeCsv({ bom, headers, rows }) {
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  return `${bom ? "\uFEFF" : ""}${lines.join("\n")}\n`;
}

async function readSource(repoRoot, sourcePath) {
  const absolute = path.resolve(repoRoot, sourcePath);
  const bytes = await fs.readFile(absolute);
  return { absolute, bytes, sha256: sha256(bytes) };
}

function sameIds(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateTruth({
  currentTruth,
  completedTruth,
  recordingIds,
  allowedGates,
  allowedLabels,
  blockers,
}) {
  if (!completedTruth || typeof completedTruth !== "object") {
    blockers.push("completed-truth-invalid");
    return;
  }
  if (completedTruth.contractVersion !== currentTruth.contractVersion) {
    blockers.push("completed-truth-contract-mismatch");
  }
  const currentTopLevel = { ...currentTruth };
  const completedTopLevel = { ...completedTruth };
  delete currentTopLevel.recordings;
  delete completedTopLevel.recordings;
  if (JSON.stringify(completedTopLevel) !== JSON.stringify(currentTopLevel)) {
    blockers.push("completed-truth-top-level-changed");
  }
  const currentRecordings = currentTruth.recordings || {};
  const completedRecordings = completedTruth.recordings || {};
  const truthIds = Object.keys(completedRecordings).sort();
  if (!sameIds(recordingIds, truthIds)) blockers.push("completed-truth-recording-set-mismatch");

  for (const recordingId of recordingIds) {
    const source = currentRecordings[recordingId];
    const completed = completedRecordings[recordingId];
    if (!source || !completed) continue;
    if (completed.completeErrorInventory !== true) {
      blockers.push(`complete-error-inventory-missing:${recordingId}`);
    }
    const sourceEvents = Array.isArray(source.events) ? source.events : [];
    const completedEvents = Array.isArray(completed.events) ? completed.events : [];
    if (!Array.isArray(completed.events)) {
      blockers.push(`completed-events-invalid:${recordingId}`);
      continue;
    }
    const byEventId = new Map();
    const usedPositions = new Set();
    for (const [index, event] of completedEvents.entries()) {
      if (!event || typeof event !== "object") {
        blockers.push(`completed-event-invalid:${recordingId}:${index}`);
        continue;
      }
      const eventId = clean(event.eventId);
      if (!eventId) blockers.push(`event-id-missing:${recordingId}:${index}`);
      else if (byEventId.has(eventId)) blockers.push(`event-id-duplicate:${recordingId}:${eventId}`);
      else byEventId.set(eventId, event);
      const gate = clean(event.gate);
      const label = clean(event.label);
      if (!allowedGates.has(gate)) blockers.push(`gate-invalid:${recordingId}:${eventId || index}`);
      if (!allowedLabels.has(label)) blockers.push(`label-invalid:${recordingId}:${eventId || index}`);
      const measure = Number(event.measure);
      const beat = Number(event.beat);
      const scoreMidi = Number(event.scoreMidi);
      if (
        !Number.isInteger(measure) || measure < 1
        || !Number.isFinite(beat) || beat <= 0
        || !Number.isInteger(scoreMidi) || scoreMidi < 0 || scoreMidi > 127
      ) {
        blockers.push(`position-invalid:${recordingId}:${eventId || index}`);
      } else {
        const position = `${measure}|${beat.toFixed(6)}|${scoreMidi}`;
        if (usedPositions.has(position)) {
          blockers.push(`position-duplicate:${recordingId}:${eventId || index}`);
        }
        usedPositions.add(position);
      }
      if (!clean(event.asPerformed)) blockers.push(`as-performed-missing:${recordingId}:${eventId || index}`);
      if (label === "confusion_negative" && !clean(event.confusionKind)) {
        blockers.push(`confusion-kind-missing:${recordingId}:${eventId || index}`);
      }
    }
    for (const sourceEvent of sourceEvents) {
      const eventId = clean(sourceEvent.eventId);
      const completedEvent = byEventId.get(eventId);
      if (!completedEvent) {
        blockers.push(`planned-event-missing:${recordingId}:${eventId}`);
        continue;
      }
      for (const field of ["measure", "beat", "scoreMidi"]) {
        if (Number(completedEvent[field]) !== Number(sourceEvent[field])) {
          blockers.push(`planned-position-changed:${recordingId}:${eventId}:${field}`);
        }
      }
      for (const field of ["plannedPerformance", "scoreTag"]) {
        if (JSON.stringify(completedEvent[field]) !== JSON.stringify(sourceEvent[field])) {
          blockers.push(`planned-field-changed:${recordingId}:${eventId}:${field}`);
        }
      }
    }
  }
}

async function writeBackup(absolute, bytes, sourceSha256) {
  const backup = `${absolute}.pre-signoff-${sourceSha256.slice(0, 12)}.bak`;
  try {
    await fs.writeFile(backup, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return backup;
}

export async function applyTruthSignoff({
  repoRoot = process.cwd(),
  contractPath = path.join("config", "western-strings-round6-counterbalanced-contract.json"),
  manifestPath = path.join("data", "private", "western-strings-round6-counterbalanced", "manifest.csv"),
  truthPath = path.join("data", "private", "western-strings-round6-counterbalanced", "position-truth.json"),
  completedPath,
  roundNumber = 6,
  apply = false,
  scopeSplit,
  stagedProtocolPath = DEFAULT_STAGED_PROTOCOL,
  ledgerPath = DEFAULT_STAGE_A_LEDGER,
} = {}) {
  if (!completedPath) throw new Error("--completed is required");
  const root = path.resolve(repoRoot);
  const selectedScope = clean(scopeSplit);
  if (selectedScope && (
    Number(roundNumber) !== 6 || selectedScope !== "calibration"
  )) {
    throw new Error(`unsupported truth-signoff apply scope: ${selectedScope}`);
  }
  const [
    contractSource,
    manifestSource,
    truthSource,
    completedSource,
    stagedProtocolSource,
  ] = await Promise.all([
    readSource(root, contractPath),
    readSource(root, manifestPath),
    readSource(root, truthPath),
    readSource(root, completedPath),
    selectedScope ? readSource(root, stagedProtocolPath) : null,
  ]);
  const contract = JSON.parse(contractSource.bytes.toString("utf8"));
  const currentTruth = JSON.parse(truthSource.bytes.toString("utf8"));
  const completed = JSON.parse(completedSource.bytes.toString("utf8"));
  const manifest = parseCsv(manifestSource.bytes.toString("utf8"));
  const stagedProtocol = stagedProtocolSource
    ? JSON.parse(stagedProtocolSource.bytes.toString("utf8"))
    : null;
  const blockers = [];

  if (completed.contractVersion !== COMPLETED_CONTRACT) blockers.push("completed-contract-invalid");
  if (Number(completed.roundNumber) !== Number(roundNumber)) blockers.push("completed-round-mismatch");
  if (completed.sourceContractSha256 !== contractSource.sha256) blockers.push("source-contract-sha-mismatch");
  if (completed.sourceManifestSha256 !== manifestSource.sha256) blockers.push("source-manifest-sha-mismatch");
  if (completed.sourceTruthSha256 !== truthSource.sha256) blockers.push("source-truth-sha-mismatch");
  if (contract.contractVersion !== currentTruth.contractVersion) blockers.push("current-contract-truth-mismatch");
  const completedScope = completed.scope && typeof completed.scope === "object"
    ? completed.scope : null;
  if (selectedScope) {
    if (completedScope?.split !== selectedScope) {
      blockers.push("completed-scope-mismatch");
    }
    if (stagedProtocol?.contract !== STAGED_PROTOCOL_CONTRACT) {
      blockers.push("staged-protocol-contract-invalid");
    }
    const protocolCore = stagedProtocol
      ? Object.fromEntries(
        Object.entries(stagedProtocol).filter(
          ([key]) => ![
            "schemaVersion",
            "sourceBindings",
            "protocolSemanticSha256",
          ].includes(key),
        ),
      )
      : null;
    const observedProtocolSemanticSha256 = protocolCore
      ? sha256(Buffer.from(canonicalJson(protocolCore), "utf8"))
      : "";
    if (
      !stagedProtocol?.protocolSemanticSha256
      || observedProtocolSemanticSha256
        !== stagedProtocol.protocolSemanticSha256
    ) {
      blockers.push("staged-protocol-semantic-sha-mismatch");
    }
    const bindingByPath = new Map(
      (stagedProtocol?.sourceBindings || []).map(
        (binding) => [posixPath(clean(binding?.path)), clean(binding?.sha256)],
      ),
    );
    for (const [sourcePath, source] of [
      [contractPath, contractSource],
      [manifestPath, manifestSource],
      [truthPath, truthSource],
    ]) {
      if (bindingByPath.get(posixPath(clean(sourcePath))) !== source.sha256) {
        blockers.push(`staged-protocol-source-binding-mismatch:${
          posixPath(clean(sourcePath))
        }`);
      }
    }
  } else if (completedScope) {
    blockers.push("completed-scope-unexpected");
  }

  const missingHeaders = REQUIRED_MANIFEST_FIELDS.filter((field) => !manifest.headers.includes(field));
  if (missingHeaders.length) blockers.push(`manifest-fields-missing:${missingHeaders.join(",")}`);
  const manifestIds = manifest.rows.map((row) => clean(row.recordingId));
  if (manifestIds.some((id) => !id)) blockers.push("manifest-recording-id-missing");
  if (new Set(manifestIds).size !== manifestIds.length) blockers.push("manifest-recording-id-duplicate");
  const allRecordingIds = [...new Set(manifestIds)].sort();
  const currentTruthIds = Object.keys(currentTruth.recordings || {}).sort();
  if (!sameIds(allRecordingIds, currentTruthIds)) {
    blockers.push("current-manifest-truth-recording-set-mismatch");
  }
  const scopedRows = selectedScope
    ? manifest.rows.filter((row) => clean(row.split) === selectedScope)
    : manifest.rows;
  const recordingIds = scopedRows.map((row) => clean(row.recordingId)).sort();
  if (selectedScope) {
    const protocolRecordingIds = (
      stagedProtocol?.stageA?.recordingIds || []
    ).map(clean).sort();
    if (!sameIds(recordingIds, protocolRecordingIds)) {
      blockers.push("staged-protocol-recording-set-mismatch");
    }
    const completedScopeIds = (
      completedScope?.recordingIds || []
    ).map(clean).sort();
    if (!sameIds(recordingIds, completedScopeIds)) {
      blockers.push("completed-scope-recording-set-mismatch");
    }
  }

  const metadata = completed.recordingMetadata && typeof completed.recordingMetadata === "object"
    ? completed.recordingMetadata : {};
  const metadataIds = Object.keys(metadata).sort();
  if (!sameIds(recordingIds, metadataIds)) blockers.push("recording-metadata-set-mismatch");
  const audioHashes = completed.audioSha256ByRecording
    && typeof completed.audioSha256ByRecording === "object"
    ? completed.audioSha256ByRecording : {};
  if (!sameIds(recordingIds, Object.keys(audioHashes).sort())) {
    blockers.push("audio-sha-set-mismatch");
  }

  const selectedRecordingIds = new Set(recordingIds);
  const updatedRows = manifest.rows.map((row) => {
    const recordingId = clean(row.recordingId);
    if (!selectedRecordingIds.has(recordingId)) return row;
    const item = metadata[recordingId] || {};
    for (const field of ["performerId", "deviceId", "roomId"]) {
      if (!clean(item[field])) blockers.push(`recording-metadata-missing:${recordingId}:${field}`);
    }
    if (clean(item.consent).toLowerCase() !== clean(contract.privacy?.requiredConsent).toLowerCase()) {
      blockers.push(`recording-consent-invalid:${recordingId}`);
    }
    if (clean(item.licenseStatus) !== clean(contract.privacy?.requiredLicenseStatus)) {
      blockers.push(`recording-license-invalid:${recordingId}`);
    }
    const split = clean(row.split);
    if (!(contract.allowedSplits || []).includes(split)) blockers.push(`recording-split-invalid:${recordingId}`);
    return {
      ...row,
      performerId: clean(item.performerId),
      deviceId: clean(item.deviceId),
      roomId: clean(item.roomId),
      consent: clean(item.consent).toLowerCase(),
      licenseStatus: clean(item.licenseStatus),
    };
  });

  const expectedAudioIds = selectedRecordingIds;
  for (const row of manifest.rows) {
    const recordingId = clean(row.recordingId);
    if (!expectedAudioIds.has(recordingId)) continue;
    try {
      const audio = await readSource(root, row.audioPath);
      if (audio.sha256 !== audioHashes[recordingId]) blockers.push(`audio-sha-mismatch:${recordingId}`);
    } catch (error) {
      blockers.push(`audio-${error?.code === "ENOENT" ? "missing" : "unreadable"}:${recordingId}`);
    }
  }

  const minimums = selectedScope
    ? {
      performers: stagedProtocol?.stageA?.profile?.performerIds?.length,
      devices: stagedProtocol?.stageA?.profile?.deviceIds?.length,
      rooms: stagedProtocol?.stageA?.profile?.roomIds?.length,
    }
    : contract.minimums || {};
  const coverageRows = selectedScope
    ? updatedRows.filter((row) => selectedRecordingIds.has(clean(row.recordingId)))
    : updatedRows;
  for (const [field, floorKey] of [
    ["performerId", "performers"],
    ["deviceId", "devices"],
    ["roomId", "rooms"],
  ]) {
    const count = new Set(coverageRows.map((row) => clean(row[field])).filter(Boolean)).size;
    const floor = Number(minimums[floorKey] || 0);
    if (count < floor) blockers.push(`${floorKey}-below-floor:${count}/${floor}`);
  }
  if (
    !selectedScope
    && contract.splitDiscipline?.calibrationAndFreshPerformersDisjoint === true
  ) {
    const calibration = new Set(
      updatedRows.filter((row) => clean(row.split) === "calibration").map((row) => row.performerId),
    );
    for (const row of updatedRows.filter((item) => clean(item.split) === "fresh-blind")) {
      if (calibration.has(row.performerId)) blockers.push(`performer-split-leak:${row.performerId}`);
    }
  }

  validateTruth({
    currentTruth,
    completedTruth: completed.truth,
    recordingIds,
    allowedGates: new Set(contract.allowedGates || []),
    allowedLabels: new Set(contract.allowedLabels || []),
    blockers,
  });

  const uniqueBlockers = [...new Set(blockers)].sort();
  if (uniqueBlockers.length) {
    return {
      ok: false,
      readyToApply: false,
      applied: false,
      blockingReasons: uniqueBlockers,
    };
  }

  const updatedTruth = selectedScope
    ? {
      ...currentTruth,
      recordings: {
        ...(currentTruth.recordings || {}),
        ...(completed.truth?.recordings || {}),
      },
    }
    : completed.truth;
  const manifestBytes = Buffer.from(serializeCsv({ ...manifest, rows: updatedRows }), "utf8");
  const truthBytes = Buffer.from(`${JSON.stringify(updatedTruth, null, 2)}\n`, "utf8");
  const proposedHashes = {
    manifestSha256: sha256(manifestBytes),
    truthSha256: sha256(truthBytes),
  };
  const result = {
    ok: true,
    readyToApply: true,
    applied: false,
    roundNumber: Number(roundNumber),
    recordingCount: recordingIds.length,
    eventCount: Object.values(completed.truth?.recordings || {})
      .reduce((sum, spec) => sum + (spec.events || []).length, 0),
    scope: selectedScope
      ? { split: selectedScope, recordingIds }
      : null,
    sourceHashes: {
      contractSha256: contractSource.sha256,
      manifestSha256: manifestSource.sha256,
      truthSha256: truthSource.sha256,
      completedSha256: completedSource.sha256,
    },
    proposedHashes,
    blockingReasons: [],
  };
  if (!apply) return result;

  const manifestBackup = await writeBackup(
    manifestSource.absolute,
    manifestSource.bytes,
    manifestSource.sha256,
  );
  const truthBackup = await writeBackup(truthSource.absolute, truthSource.bytes, truthSource.sha256);
  const absoluteLedgerPath = selectedScope
    ? path.resolve(root, ledgerPath)
    : null;
  try {
    await fs.writeFile(truthSource.absolute, truthBytes);
    await fs.writeFile(manifestSource.absolute, manifestBytes);
    if (absoluteLedgerPath) {
      const ledger = {
        schemaVersion: 1,
        contract: "western-round6-stage-a-signoff-lineage-v1",
        scope: { split: selectedScope, recordingIds },
        stagedProtocol: {
          path: posixPath(clean(stagedProtocolPath)),
          sha256: stagedProtocolSource.sha256,
          protocolSemanticSha256:
            stagedProtocol.protocolSemanticSha256,
        },
        sourceHashes: {
          contractSha256: contractSource.sha256,
          manifestSha256: manifestSource.sha256,
          truthSha256: truthSource.sha256,
          completedSha256: completedSource.sha256,
        },
        audioSha256ByRecording: Object.fromEntries(
          recordingIds.map(
            (recordingId) => [recordingId, audioHashes[recordingId]],
          ),
        ),
        appliedHashes: proposedHashes,
        studentFacing: false,
        automaticAuthorizationGranted: false,
      };
      await fs.mkdir(path.dirname(absoluteLedgerPath), { recursive: true });
      await fs.writeFile(
        absoluteLedgerPath,
        `${JSON.stringify(ledger, null, 2)}\n`,
        "utf8",
      );
    }
  } catch (error) {
    await Promise.all([
      fs.writeFile(truthSource.absolute, truthSource.bytes),
      fs.writeFile(manifestSource.absolute, manifestSource.bytes),
    ]);
    if (absoluteLedgerPath) {
      await fs.rm(absoluteLedgerPath, { force: true });
    }
    throw error;
  }
  return {
    ...result,
    applied: true,
    backups: {
      manifest: posixPath(path.relative(root, manifestBackup)),
      truth: posixPath(path.relative(root, truthBackup)),
    },
    ...(absoluteLedgerPath
      ? { ledger: posixPath(path.relative(root, absoluteLedgerPath)) }
      : {}),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--contract") args.contractPath = argv[++index];
    else if (arg === "--manifest") args.manifestPath = argv[++index];
    else if (arg === "--truth") args.truthPath = argv[++index];
    else if (arg === "--completed") args.completedPath = argv[++index];
    else if (arg === "--round") args.roundNumber = Number(argv[++index]);
    else if (arg === "--scope") args.scopeSplit = argv[++index];
    else if (arg === "--staged-protocol") args.stagedProtocolPath = argv[++index];
    else if (arg === "--ledger") args.ledgerPath = argv[++index];
    else if (arg === "--apply") args.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  applyTruthSignoff(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
