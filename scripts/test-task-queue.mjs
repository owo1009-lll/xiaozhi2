import { createTaskGate, killProcessTree } from "../src/server/taskQueue.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise;
  } catch (error) {
    assert(predicate(error), message);
    return;
  }
  throw new Error(message);
}

async function testBoundedQueue() {
  const gate = createTaskGate({ name: "test", concurrency: 1, maxPending: 1 });
  const first = await gate.enter("first");
  const secondPromise = gate.enter("second");
  await assertRejects(
    gate.enter("third"),
    (error) => error?.statusCode === 429 && error?.queue?.pending === 1,
    "third task should be rejected when running plus pending reaches capacity",
  );
  assert(gate.stats().running === 1 && gate.stats().pending === 1, "queue stats should include running and pending tasks");
  gate.release(first);
  const second = await secondPromise;
  assert(gate.stats().running === 1 && gate.stats().pending === 0, "pending task should start after release");
  gate.release(second);
  assert(gate.stats().running === 0 && gate.stats().pending === 0, "queue should be empty after release");
}

async function testCancelPending() {
  const gate = createTaskGate({ name: "cancel-test", concurrency: 1, maxPending: 2 });
  const first = await gate.enter("first");
  const pending = gate.enter("pending");
  assert(gate.cancel("pending"), "cancel should remove a pending task");
  await assertRejects(pending, (error) => error?.cancelled === true, "cancelled pending task should reject with cancelled flag");
  gate.release(first);
  assert(gate.stats().running === 0 && gate.stats().pending === 0, "cancelled queue should drain cleanly");
}

async function main() {
  await testBoundedQueue();
  await testCancelPending();
  assert(killProcessTree(null) === false, "killProcessTree should safely ignore missing child processes");
  console.log(JSON.stringify({ ok: true, checks: ["bounded-queue", "pending-cancel", "safe-tree-kill-noop"] }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
