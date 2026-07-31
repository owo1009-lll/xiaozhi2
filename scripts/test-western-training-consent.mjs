import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TRAINING_CONSENT_CONTRACT,
  TRAINING_CONSENT_VERSION,
  appendTrainingConsent,
  buildTrainingConsentRecord,
  resolveTrainingConsent,
} from "../src/server/westernStringsTrainingConsent.js";

// Training consent is a separate decision from the upload privacy notice, and
// the ledger must not accept a substitute for it. These assertions exist
// because the first ledger record was written on a teacher's checkbox alone,
// which proved nothing about the student.

// --- a teacher can never grant it ------------------------------------------
assert.throws(
  () => buildTrainingConsentRecord({ payload: {
    subjectRef: "anon-01", subjectType: "adult", decision: "granted", grantedByRole: "teacher",
  } }),
  /teacher may not grant/,
  "a teacher must not be able to consent on a student's behalf",
);

// --- a minor needs a guardian ----------------------------------------------
assert.throws(
  () => buildTrainingConsentRecord({ payload: {
    subjectRef: "anon-02", subjectType: "minor", decision: "granted",
  } }),
  /guardianRef/,
  "a minor's training consent must carry a guardian reference",
);

// --- the grant is auditable ------------------------------------------------
const record = buildTrainingConsentRecord({ payload: {
  subjectRef: "anon-03", subjectType: "adult", decision: "granted", capturedVia: "miniprogram",
} });
for (const field of ["consentId", "consentVersion", "purpose", "subjectType", "guardianStatus", "signedAt"]) {
  assert(record[field], `training consent must record ${field}`);
}
assert.equal(record.consentContract, TRAINING_CONSENT_CONTRACT);

// --- resolution honours decline, withdrawal and version bumps --------------
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "training-consent-test-"));
try {
  assert.equal((await resolveTrainingConsent({ repoRoot: tempRoot, subjectRef: "anon-03" })).reason, "no-consent-record");

  await appendTrainingConsent({ repoRoot: tempRoot, payload: {
    subjectRef: "anon-03", subjectType: "adult", decision: "granted", capturedVia: "miniprogram",
  } });
  assert.equal((await resolveTrainingConsent({ repoRoot: tempRoot, subjectRef: "anon-03" })).eligible, true);

  // The ledger is append-only, so a withdrawal has to be honoured here or it
  // would have no effect at all.
  await appendTrainingConsent({ repoRoot: tempRoot, payload: {
    subjectRef: "anon-03", subjectType: "adult", decision: "withdrawn", capturedVia: "miniprogram",
  } });
  const withdrawn = await resolveTrainingConsent({ repoRoot: tempRoot, subjectRef: "anon-03" });
  assert.equal(withdrawn.eligible, false);
  assert.equal(withdrawn.reason, "consent-withdrawn");

  await appendTrainingConsent({ repoRoot: tempRoot, payload: {
    subjectRef: "anon-04", subjectType: "adult", decision: "granted",
    consentVersion: "1999-01-01.1", capturedVia: "miniprogram",
  } });
  const stale = await resolveTrainingConsent({ repoRoot: tempRoot, subjectRef: "anon-04" });
  assert.equal(stale.eligible, false, "consent given against superseded wording must not carry over");
  assert.equal(stale.reason, "consent-version-superseded");
} finally {
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

// --- the ledger refuses a teacher checkbox ---------------------------------
const ledgerSource = fs.readFileSync("src/server/westernStringsTrainingLedger.js", "utf8");
assert(
  ledgerSource.includes("resolveTrainingConsent"),
  "the ledger must resolve consent from the subject's grant, not the review payload",
);
assert(
  !/payload\.consent\)\.trim\(\)\.toLowerCase\(\) !== "yes"/.test(ledgerSource),
  "the ledger must no longer accept a consent string supplied by the reviewer",
);
assert(ledgerSource.includes("trainingEligible: true"), "eligible records must be marked as such");

// --- status separates physical records from trainable ones -----------------
const statusSource = fs.readFileSync("scripts/status-western-strings-training-ledger.mjs", "utf8");
assert(statusSource.includes("physicalRecordFiles"), "status must report physical record files separately");
assert(statusSource.includes("trainingEligibleRecordings"), "status must report training-eligible records separately");
assert(statusSource.includes("legacy-consent-unverified"), "pre-consent records must be flagged, not counted");

console.log(JSON.stringify({
  ok: true,
  consentVersion: TRAINING_CONSENT_VERSION,
  checks: "teacher-cannot-grant, guardian-required-for-minor, auditable-fields, withdrawal, version-supersede, ledger-enforcement, split-counting",
}, null, 2));
