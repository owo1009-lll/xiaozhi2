import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  atomicWriteJson,
  enqueueStoreOperation,
  readJsonFile,
  readJsonFileUnlocked,
  waitForStoreOperations,
} from "../src/server/jsonStore.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-erhu-json-store-"));
  const storePath = path.join(tempDir, "store.json");

  const order = [];
  const first = enqueueStoreOperation(storePath, async () => {
    await sleep(40);
    order.push("first");
    await atomicWriteJson(storePath, { steps: ["first"] });
    return "first-result";
  });
  const second = enqueueStoreOperation(storePath, async () => {
    order.push("second");
    const current = await readJsonFileUnlocked(storePath, { steps: [] });
    await atomicWriteJson(storePath, { steps: [...current.steps, "second"] });
    return "second-result";
  });

  assert((await first) === "first-result", "first queued operation should resolve its own result");
  assert((await second) === "second-result", "second queued operation should resolve its own result");
  assert(JSON.stringify(order) === JSON.stringify(["first", "second"]), `queued writes ran out of order: ${order}`);
  assert(
    JSON.stringify(await readJsonFile(storePath, {})) === JSON.stringify({ steps: ["first", "second"] }),
    "queued writes should persist in order",
  );

  const waitPath = path.join(tempDir, "wait.json");
  const pending = enqueueStoreOperation(waitPath, async () => {
    await sleep(40);
    await atomicWriteJson(waitPath, { ready: true });
  });
  const waitedRead = await readJsonFile(waitPath, { ready: false });
  await pending;
  assert(waitedRead.ready === true, "readJsonFile should wait for pending writes on the same file");

  const failedPath = path.join(tempDir, "failed.json");
  let failed = false;
  try {
    await enqueueStoreOperation(failedPath, async () => {
      throw new Error("intentional failure");
    });
  } catch {
    failed = true;
  }
  assert(failed, "failed queued operation should reject to the caller");
  await enqueueStoreOperation(failedPath, async () => {
    await atomicWriteJson(failedPath, { recovered: true });
  });
  await waitForStoreOperations(failedPath);
  assert((await readJsonFile(failedPath, {})).recovered === true, "queue should continue after a failed operation");

  const directoryTarget = path.join(tempDir, "directory-target");
  await fs.mkdir(directoryTarget);
  let renameFailed = false;
  try {
    await atomicWriteJson(directoryTarget, { impossible: true });
  } catch {
    renameFailed = true;
  }
  const directoryStat = await fs.stat(directoryTarget);
  assert(renameFailed && directoryStat.isDirectory(), "atomicWriteJson should fail instead of replacing a directory target");

  await fs.rm(tempDir, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, checks: ["queue-order", "read-waits", "failure-recovery", "rename-failure"] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
