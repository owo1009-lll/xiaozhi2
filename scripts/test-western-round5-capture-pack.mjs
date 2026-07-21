import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  gates,
  manifestTemplateCsv,
  tasks,
  truthTemplate,
} from "../docs/round5-targeted-diagnosis-capture-pack/capture-plan.mjs";

assert.equal(tasks.length, 12);
assert.equal(new Set(tasks.map((task) => task.recordingId)).size, 12);
assert.equal(new Set(tasks.map((task) => task.performerId)).size, 2);
assert.equal(new Set(tasks.map((task) => task.deviceId)).size, 3);
assert.equal(new Set(tasks.map((task) => task.roomId)).size, 2);
assert.equal(tasks.filter((task) => task.split === "calibration").length, 6);
assert.equal(tasks.filter((task) => task.split === "fresh-blind").length, 6);

const contexts = (split) => new Set(tasks
  .filter((task) => task.split === split)
  .map((task) => `${task.performerId}/${task.deviceId}/${task.roomId}`));
const calibrationContexts = contexts("calibration");
const freshContexts = contexts("fresh-blind");
assert.equal(calibrationContexts.size, 6);
assert.equal(freshContexts.size, 6);
assert.deepEqual([...calibrationContexts].filter((context) => freshContexts.has(context)), []);

for (const gate of gates) {
  const all = tasks.flatMap((task) => task.eventSlots.filter((event) => event.gate === gate));
  const fresh = tasks
    .filter((task) => task.split === "fresh-blind")
    .flatMap((task) => task.eventSlots.filter((event) => event.gate === gate));
  assert.equal(all.filter((event) => event.label === "positive").length, 12);
  assert.equal(all.filter((event) => event.label === "confusion_negative").length, 24);
  assert.equal(fresh.filter((event) => event.label === "positive").length, 6);
  assert.equal(fresh.filter((event) => event.label === "confusion_negative").length, 12);
}

const truth = truthTemplate();
assert.equal(Object.keys(truth.recordings).length, 12);
for (const recording of Object.values(truth.recordings)) {
  assert.equal(recording.completeErrorInventory, false);
  assert.equal(recording.events.length, 12);
  assert.equal(new Set(recording.events.map((event) => event.eventId)).size, 12);
  assert(recording.events.every((event) => event.measure === ""));
}

assert.equal(
  await fs.readFile("docs/round5-targeted-diagnosis-capture-pack/manifest.template.csv", "utf8"),
  manifestTemplateCsv(),
);
assert.deepEqual(
  JSON.parse(await fs.readFile("docs/round5-targeted-diagnosis-capture-pack/truth.template.json", "utf8")),
  truth,
);
const html = await fs.readFile("docs/round5-targeted-diagnosis-capture-pack/index.html", "utf8");
assert(html.includes("下载 manifest.csv"));
assert(html.includes("下载 position-truth.json"));
assert(html.includes("不会开启自动判分"));
assert(html.includes("completeErrorInventory"));
console.log(JSON.stringify({ ok: true, checks: [
  "exact-contract-minimum-matrix",
  "split-contexts-disjoint",
  "templates-fail-closed-until-human-complete-inventory",
  "download-pack-present",
] }));
