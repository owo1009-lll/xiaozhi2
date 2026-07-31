import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { nowIso, safeString } from "./baseUtils.js";

// Training-data consent, kept separate from the upload privacy notice.
//
// Agreeing to upload a recording so a teacher can give feedback is not the same
// decision as agreeing that the recording may train a model. Collapsing the two
// is what made the first ledger record unusable: it proves a teacher ticked a
// box, not that the student agreed to anything.
//
// A teacher can never grant this. They sign for label completeness; the subject
// (or their guardian) signs for training use. That separation is the whole
// point, so it is enforced here rather than left to the console.
export const TRAINING_CONSENT_CONTRACT = "western-strings-training-consent-v1";

// Bump when the wording changes: consent is only meaningful against the text
// the person actually saw, so old grants must not silently cover new terms.
export const TRAINING_CONSENT_VERSION = "2026-07-31.1";
export const TRAINING_CONSENT_PURPOSE = "model-training-and-research-on-practice-diagnosis";

const SUBJECT_TYPES = new Set(["adult", "minor"]);
const DECISIONS = new Set(["granted", "declined", "withdrawn"]);

export function trainingConsentPath(repoRoot = process.cwd()) {
  return path.join(repoRoot, "data", "private", "western-strings-training-consent.jsonl");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function buildTrainingConsentRecord({ payload = {} } = {}) {
  const subjectRef = safeString(payload.subjectRef).trim();
  if (!subjectRef) throw new Error("training consent requires a subjectRef.");

  const subjectType = safeString(payload.subjectType).trim().toLowerCase();
  if (!SUBJECT_TYPES.has(subjectType)) {
    throw new Error("training consent subjectType must be adult or minor.");
  }

  const decision = safeString(payload.decision).trim().toLowerCase();
  if (!DECISIONS.has(decision)) {
    throw new Error("training consent decision must be granted, declined or withdrawn.");
  }

  // A minor cannot grant this alone, and a teacher standing in for a guardian
  // is exactly the failure this module exists to prevent.
  const guardianRef = safeString(payload.guardianRef).trim();
  if (subjectType === "minor" && decision === "granted" && !guardianRef) {
    throw new Error("training consent for a minor requires a guardianRef.");
  }
  if (safeString(payload.grantedByRole).trim().toLowerCase() === "teacher") {
    throw new Error("a teacher may not grant training consent on a student's behalf.");
  }

  const version = safeString(payload.consentVersion, TRAINING_CONSENT_VERSION).trim();
  const record = {
    consentContract: TRAINING_CONSENT_CONTRACT,
    consentVersion: version,
    purpose: TRAINING_CONSENT_PURPOSE,
    subjectRef,
    subjectType,
    guardianRef,
    guardianStatus: subjectType === "minor"
      ? (guardianRef ? "guardian-confirmed" : "guardian-absent")
      : "not-required",
    decision,
    signedAt: safeString(payload.signedAt, nowIso()),
    // Recorded so a later audit can tell a real submission apart from a
    // back-filled assertion; never used to authorise anything by itself.
    capturedVia: safeString(payload.capturedVia, "unknown"),
  };
  return { ...record, consentId: crypto.createHash("sha256").update(canonical(record)).digest("hex").slice(0, 32) };
}

export async function appendTrainingConsent({ repoRoot = process.cwd(), payload = {} } = {}) {
  const record = buildTrainingConsentRecord({ payload });
  const filePath = trainingConsentPath(repoRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

// Latest decision wins, so a withdrawal after a grant genuinely revokes: the
// ledger is append-only and cannot be edited, so the block has to happen here,
// before anything new is written.
export async function resolveTrainingConsent({ repoRoot = process.cwd(), subjectRef = "" } = {}) {
  const target = safeString(subjectRef).trim();
  if (!target) return { eligible: false, reason: "subject-ref-missing" };

  let lines = [];
  try {
    lines = (await fs.readFile(trainingConsentPath(repoRoot), "utf8")).split(/\r?\n/).filter((l) => l.trim());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { eligible: false, reason: "no-consent-record" };
  }

  let latest = null;
  for (const line of lines) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (safeString(record?.subjectRef).trim() !== target) continue;
    if (record?.consentContract !== TRAINING_CONSENT_CONTRACT) continue;
    latest = record;
  }
  if (!latest) return { eligible: false, reason: "no-consent-record" };
  if (latest.decision !== "granted") return { eligible: false, reason: `consent-${latest.decision}`, consent: latest };
  if (latest.consentVersion !== TRAINING_CONSENT_VERSION) {
    return { eligible: false, reason: "consent-version-superseded", consent: latest };
  }
  if (latest.subjectType === "minor" && latest.guardianStatus !== "guardian-confirmed") {
    return { eligible: false, reason: "guardian-confirmation-missing", consent: latest };
  }
  return { eligible: true, consent: latest };
}
