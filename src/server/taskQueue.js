import { spawn } from "node:child_process";

export function createTaskGate({ name = "task", concurrency = 1, maxPending = 4 } = {}) {
  const normalizedConcurrency = Math.max(1, Math.round(Number(concurrency) || 1));
  const normalizedMaxPending = Math.max(0, Math.round(Number(maxPending) || 0));
  const pending = [];
  let running = 0;

  function stats() {
    return {
      name,
      running,
      pending: pending.length,
      concurrency: normalizedConcurrency,
      maxPending: normalizedMaxPending,
      capacity: normalizedConcurrency + normalizedMaxPending,
    };
  }

  function canAccept() {
    return running + pending.length < normalizedConcurrency + normalizedMaxPending;
  }

  function makeQueueFullError() {
    const error = new Error(`${name} queue is full`);
    error.statusCode = 429;
    error.queue = stats();
    return error;
  }

  async function enter(id = "") {
    if (!canAccept()) {
      throw makeQueueFullError();
    }
    if (running < normalizedConcurrency) {
      running += 1;
      return { id, released: false };
    }
    return new Promise((resolve, reject) => {
      pending.push({ id, resolve, reject });
    }).then(() => {
      running += 1;
      return { id, released: false };
    });
  }

  function drain() {
    if (running >= normalizedConcurrency) return;
    const next = pending.shift();
    if (next) {
      next.resolve();
    }
  }

  function release(ticket) {
    if (!ticket || ticket.released) return;
    ticket.released = true;
    running = Math.max(0, running - 1);
    drain();
  }

  function cancel(id = "") {
    const index = pending.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [item] = pending.splice(index, 1);
    const error = new Error(`${name} task cancelled`);
    error.cancelled = true;
    item.reject(error);
    return true;
  }

  return { canAccept, cancel, enter, release, stats };
}

export function queueFullPayload(gate) {
  return {
    ok: false,
    error: "当前任务较多，队列已满，请稍后再试。",
    queue: gate.stats(),
  };
}

export function killProcessTree(childProcess, { force = true } = {}) {
  const pid = Number(childProcess?.pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return true;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      childProcess.kill("SIGTERM");
    } catch {
      return false;
    }
  }
  return true;
}
