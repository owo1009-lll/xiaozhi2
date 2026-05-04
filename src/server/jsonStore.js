import fs from "node:fs/promises";
import path from "node:path";

const storeQueues = new Map();

function storeQueueKey(filePath) {
  return path.resolve(filePath);
}

export async function enqueueStoreOperation(filePath, operation) {
  const key = storeQueueKey(filePath);
  const previous = storeQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const tracked = next.catch(() => {});
  storeQueues.set(key, tracked);
  tracked.finally(() => {
    if (storeQueues.get(key) === tracked) {
      storeQueues.delete(key);
    }
  });
  return next;
}

export async function waitForStoreOperations(filePath) {
  const pending = storeQueues.get(storeQueueKey(filePath));
  if (pending) {
    await pending.catch(() => {});
  }
}

export async function atomicWriteJson(filePath, value, { pretty = true } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${filePath}.${suffix}.tmp`;
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await fs.writeFile(tempPath, body, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function readJsonFile(filePath, fallback) {
  await waitForStoreOperations(filePath);
  return readJsonFileUnlocked(filePath, fallback);
}

export async function readJsonFileUnlocked(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
