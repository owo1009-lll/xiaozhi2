import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "unknown";
}

export async function ingestM4aPhotos({
  repoRoot = process.cwd(),
  sourceRoot,
  replace = false,
} = {}) {
  const resolvedSource = path.resolve(sourceRoot || path.join(repoRoot, "..", "m4a-photo-acceptance"));
  const config = JSON.parse(await fs.readFile(
    path.join(repoRoot, "config", "western-m4a-real-photo-acceptance.json"),
    "utf8",
  ));
  const rows = [];
  for (const task of config.positiveCaptureTasks || []) {
    const fileName = path.basename(task.photoPath);
    const source = path.join(resolvedSource, fileName);
    const destination = path.resolve(repoRoot, task.photoPath);
    let bytes;
    try {
      bytes = await fs.readFile(source);
    } catch {
      rows.push({ caseId: task.caseId, fileName, status: "missing", source });
      continue;
    }
    const detectedType = imageType(bytes);
    if (detectedType === "unknown") {
      rows.push({ caseId: task.caseId, fileName, status: "invalid-image-signature", source });
      continue;
    }
    const incomingHash = sha256(bytes);
    let existingHash = "";
    try {
      existingHash = sha256(await fs.readFile(destination));
    } catch {
      existingHash = "";
    }
    if (existingHash && existingHash !== incomingHash && !replace) {
      rows.push({ caseId: task.caseId, fileName, status: "different-destination-exists", sha256: incomingHash });
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (!existingHash || existingHash !== incomingHash) await fs.copyFile(source, destination);
    rows.push({
      caseId: task.caseId,
      fileName,
      status: existingHash === incomingHash ? "already-current" : "ingested",
      imageType: detectedType,
      bytes: bytes.length,
      sha256: incomingHash,
      destination: path.relative(repoRoot, destination).replace(/\\/g, "/"),
    });
  }
  const readyCount = rows.filter((row) => ["ingested", "already-current"].includes(row.status)).length;
  const result = {
    contract: "western-m4a-real-photo-intake-v1",
    ready: readyCount === config.positiveCaptureTasks.length,
    sourceRoot: resolvedSource,
    expectedCount: config.positiveCaptureTasks.length,
    readyCount,
    rows,
  };
  const output = path.join(
    repoRoot,
    "data",
    "private",
    "western-strings-m4a-real-photo-acceptance",
    "intake.json",
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function main() {
  const result = await ingestM4aPhotos({
    sourceRoot: argumentValue("--from") || undefined,
    replace: process.argv.includes("--replace"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
