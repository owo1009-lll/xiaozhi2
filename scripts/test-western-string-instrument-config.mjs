import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const configPath = path.join(repoRoot, "config", "western-string-instruments.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

assert.equal(config.version, 1);
assert.ok(config.instruments);

const expected = {
  violin: { minNote: "G3", maxNote: "A7", minMidi: 55, maxMidi: 105, firstVersionSupport: true },
  viola: { minNote: "C3", maxNote: "E7", minMidi: 48, maxMidi: 100, firstVersionSupport: false },
  cello: { minNote: "C2", maxNote: "C6", minMidi: 36, maxMidi: 84, firstVersionSupport: false }
};

for (const [id, spec] of Object.entries(expected)) {
  const actual = config.instruments[id];
  assert.ok(actual, `missing instrument config for ${id}`);
  assert.equal(actual.family, "western-bowed-string", `${id} should be in western bowed string family`);
  assert.equal(actual.trackingRange.minNote, spec.minNote, `${id} min note`);
  assert.equal(actual.trackingRange.maxNote, spec.maxNote, `${id} max note`);
  assert.equal(actual.trackingRange.minMidi, spec.minMidi, `${id} min MIDI`);
  assert.equal(actual.trackingRange.maxMidi, spec.maxMidi, `${id} max MIDI`);
  assert.equal(actual.firstVersionSupport, spec.firstVersionSupport, `${id} first-version support flag`);
  assert.ok(Array.isArray(actual.openStrings) && actual.openStrings.length === 4, `${id} must define four open strings`);
}

console.log(JSON.stringify({ ok: true, instruments: Object.keys(config.instruments) }));
