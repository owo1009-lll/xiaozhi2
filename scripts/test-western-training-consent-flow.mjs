import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

import { buildWesternStudentAnalysis } from "../src/server/westernStringsAlignmentService.js";
import {
  appendTrainingConsent,
  resolveTrainingConsent,
  trainingConsentPath,
} from "../src/server/westernStringsTrainingConsent.js";
import { createWesternStringsRouter } from "../src/server/westernStringsRoutes.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "western-training-consent-"));
const base = {
  scoreId: "score-test",
  audioPath: "data/analysis-audio-cache/test.m4a",
  audioHash: "a".repeat(40),
  clientPlatform: "western-student-web",
};

try {
  const adult = await buildWesternStudentAnalysis({
    repoRoot: root,
    submissionPayload: {
      ...base,
      studentRef: "stu-v2-11111111111111111111111111111111",
      trainingConsent: { subjectType: "adult", decision: "granted", guardianRef: "" },
    },
  });
  assert.equal(adult.submissionAccepted, true);
  assert.equal(adult.submission.trainingConsent.decision, "granted");
  assert.equal((await resolveTrainingConsent({ repoRoot: root, subjectRef: adult.submission.studentRef })).eligible, true);

  const declined = await buildWesternStudentAnalysis({
    repoRoot: root,
    submissionPayload: {
      ...base,
      studentRef: "stu-v2-22222222222222222222222222222222",
      trainingConsent: { subjectType: "adult", decision: "declined", guardianRef: "" },
    },
  });
  assert.equal(declined.submissionAccepted, true, "declining training must not block teacher diagnosis");
  assert.equal((await resolveTrainingConsent({ repoRoot: root, subjectRef: declined.submission.studentRef })).eligible, false);

  await assert.rejects(
    () => buildWesternStudentAnalysis({
      repoRoot: root,
      submissionPayload: {
        ...base,
        studentRef: "stu-v2-33333333333333333333333333333333",
        trainingConsent: { subjectType: "minor", decision: "granted", guardianRef: "" },
      },
    }),
    /guardianRef/,
    "a minor grant without a guardian confirmation must fail closed",
  );

  await assert.rejects(
    () => appendTrainingConsent({
      repoRoot: root,
      payload: {
        subjectRef: "stu-v2-44444444444444444444444444444444",
        subjectType: "minor",
        decision: "granted",
        guardianRef: "guardian-1",
        grantedByRole: "teacher",
      },
    }),
    /teacher may not grant/,
  );
  const minorGrant = await appendTrainingConsent({
    repoRoot: root,
    payload: {
      subjectRef: "stu-v2-44444444444444444444444444444444",
      subjectType: "minor",
      decision: "granted",
      guardianRef: "guardian-private-confirmation",
      capturedVia: "test-minor",
    },
  });
  assert.equal(minorGrant.guardianStatus, "guardian-confirmed");
  assert.equal(typeof minorGrant.guardianRefHash, "string");
  assert.equal(Object.hasOwn(minorGrant, "guardianRef"), false, "raw guardian identifiers must not be persisted");

  await appendTrainingConsent({
    repoRoot: root,
    payload: {
      subjectRef: adult.submission.studentRef,
      subjectType: "adult",
      decision: "withdrawn",
      capturedVia: "test-withdrawal",
    },
  });
  const withdrawn = await resolveTrainingConsent({ repoRoot: root, subjectRef: adult.submission.studentRef });
  assert.equal(withdrawn.eligible, false);
  assert.equal(withdrawn.reason, "consent-withdrawn");

  const teacherUi = fs.readFileSync("src/WesternStringsApp.jsx", "utf8");
  const webUi = fs.readFileSync("src/WesternStudentApp.jsx", "utf8");
  const miniUi = fs.readFileSync("小程序/minicode-1/pages/upload/upload.wxml", "utf8");
  assert(!teacherUi.includes("已获得知情同意"), "teacher console must not contain a proxy-consent checkbox");
  assert(!teacherUi.includes("draft.performerId"), "teacher console must not choose the consent subject");
  assert(webUi.includes("这与上传和获得老师反馈的隐私授权相互独立"));
  assert(miniUi.includes("不同意也能正常提交并获得老师反馈"));
  assert(webUi.includes("请选择是否同意用于模型训练（必选）"), "web must require an explicit grant/decline choice");
  assert(miniUi.includes("<radio-group"), "Mini Program must not treat an unchecked box as an implicit decline");

  const app = express();
  app.use(express.json());
  app.use(createWesternStringsRouter({
    repoRoot: root,
    contentSafety: {
      resolveMiniProgramStudentRef: async () => "wx-subject-bound-by-server",
    },
  }));
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const post = (body, tunnel = true) => fetch(`http://127.0.0.1:${port}/api/strings/training-consent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(tunnel ? { "cf-connecting-ip": "203.0.113.9" } : {}),
      },
      body: JSON.stringify(body),
    });
    const unbound = await post({ studentRef: "attacker-chosen", subjectType: "adult", decision: "granted" });
    assert.equal(unbound.status, 401, "public web consent must require the secure student capability");
    const webGrant = await post({
      studentRef: "stu-v2-55555555555555555555555555555555",
      subjectType: "adult",
      decision: "granted",
    });
    assert.equal(webGrant.status, 200);
    const wechatGrant = await post({
      clientPlatform: "wechat-mini-program",
      wechatLoginCode: "one-time-code",
      studentRef: "client-must-not-win",
      subjectType: "adult",
      decision: "granted",
    });
    assert.equal(wechatGrant.status, 200);
    assert.equal((await resolveTrainingConsent({ repoRoot: root, subjectRef: "wx-subject-bound-by-server" })).eligible, true);
    assert.equal((await resolveTrainingConsent({ repoRoot: root, subjectRef: "client-must-not-win" })).eligible, false);
    const consentPath = trainingConsentPath(root);
    const lines = (await fsp.readFile(consentPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const tampered = JSON.parse(lines[lines.length - 1]);
    tampered.decision = "declined";
    lines[lines.length - 1] = JSON.stringify(tampered);
    await fsp.writeFile(consentPath, `${lines.join("\n")}\n`);
    assert.equal(
      (await resolveTrainingConsent({ repoRoot: root, subjectRef: "wx-subject-bound-by-server" })).reason,
      "consent-record-hash-mismatch",
      "editing an append-only consent decision must fail closed",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  checks: "student-owned-grant, server-bound-identity, decline-does-not-block-diagnosis, guardian-required, teacher-proxy-rejected, withdrawal, tamper-fail-closed",
}, null, 2));
