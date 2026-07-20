import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTENT_SAFETY_REJECTED_MESSAGE,
  ContentSafetyError,
  createWechatContentSafetyService,
} from "../src/server/wechatContentSafety.js";

function signature(token, timestamp, nonce) {
  return crypto.createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-content-safety-"));
const photoDir = path.join(root, "score-photos");
const photoPath = path.join(photoDir, "sample.jpg");
await fs.mkdir(photoDir, { recursive: true });
await fs.writeFile(photoPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));

try {
  const calls = [];
  let releasedSubmission = null;
  let mediaCheckCount = 0;
  const service = createWechatContentSafetyService({
    dataDir: root,
    scorePhotoCacheDir: photoDir,
    appId: "wx-test-app",
    appSecret: "test-secret",
    publicBaseUrl: "https://api.example.test",
    callbackToken: "test-callback-token",
    requestJson: async (url, request = {}) => {
      calls.push({ url, request });
      if (url.includes("jscode2session")) return { openid: "openid-test" };
      if (url.includes("/cgi-bin/token")) return { access_token: "access-token", expires_in: 7200 };
      if (url.includes("msg_sec_check")) return { errcode: 0, result: { suggest: "pass" } };
      if (url.includes("media_check_async")) {
        mediaCheckCount += 1;
        return { errcode: 0, trace_id: `trace-test-00${mediaCheckCount}` };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    releaseSubmission: async (submission) => {
      releasedSubmission = submission;
    },
  });

  const submission = { piece: "练习曲", scorePhotoPath: photoPath, studentRef: "stu-test" };
  const started = await service.moderateMiniProgramSubmission({
    loginCode: "login-code",
    content: submission.piece,
    submission,
  });
  assert.equal(started.status, "pending");
  assert.ok(started.ticket);
  assert.equal(calls.some((call) => call.url.includes("msg_sec_check")), true);
  const mediaCall = calls.find((call) => call.url.includes("media_check_async"));
  assert.match(mediaCall.request.body.media_url, /^https:\/\/api\.example\.test\/api\/wechat\/content-safety-media\//);

  const mediaToken = mediaCall.request.body.media_url.split("/").at(-1);
  const temporaryMediaResponse = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    type(value) { this.headers.type = value; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    end() { this.ended = true; return this; },
    sendFile(value) { this.sentFile = value; return this; },
  };
  await service.sendPendingMedia({ token: mediaToken, res: temporaryMediaResponse });
  assert.equal(temporaryMediaResponse.sentFile, photoPath);
  assert.equal(temporaryMediaResponse.headers["Cache-Control"], "no-store, private");

  const ticketBeforeCallback = await service.getPublicStatus(started.ticket);
  assert.equal(ticketBeforeCallback.status, "pending");

  const timestamp = "1714037059";
  const nonce = "486452656";
  const callbackResult = await service.receiveCallback({
    query: { timestamp, nonce, signature: signature("test-callback-token", timestamp, nonce) },
    body: {
      Event: "wxa_media_check",
      appid: "wx-test-app",
      trace_id: "trace-test-001",
      errcode: 0,
      result: { suggest: "pass" },
    },
  });
  assert.equal(callbackResult.ok, true);
  assert.deepEqual(releasedSubmission, submission);
  assert.equal((await service.getPublicStatus(started.ticket)).status, "released");

  const blocked = await service.moderateMiniProgramSubmission({
    loginCode: "login-code",
    content: submission.piece,
    submission,
  });
  const blockedCallback = await service.receiveCallback({
    query: { timestamp, nonce, signature: signature("test-callback-token", timestamp, nonce) },
    body: {
      Event: "wxa_media_check",
      appid: "wx-test-app",
      trace_id: "trace-test-002",
      errcode: 0,
      result: { suggest: "review" },
    },
  });
  assert.equal(blockedCallback.ok, true);
  assert.deepEqual(await service.getPublicStatus(blocked.ticket), {
    status: "blocked",
    message: CONTENT_SAFETY_REJECTED_MESSAGE,
  });

  const invalidCallback = await service.receiveCallback({ query: {}, body: {} });
  assert.equal(invalidCallback.statusCode, 403);

  const unsafeService = createWechatContentSafetyService({
    dataDir: root,
    scorePhotoCacheDir: photoDir,
    appId: "wx-test-app",
    appSecret: "test-secret",
    publicBaseUrl: "https://api.example.test",
    callbackToken: "test-callback-token",
    requestJson: async (url) => {
      if (url.includes("jscode2session")) return { openid: "openid-test" };
      if (url.includes("/cgi-bin/token")) return { access_token: "access-token", expires_in: 7200 };
      if (url.includes("msg_sec_check")) return { errcode: 0, result: { suggest: "risky" } };
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  await assert.rejects(
    unsafeService.moderateMiniProgramSubmission({ loginCode: "login-code", content: "unsafe", submission: {} }),
    (error) => error instanceof ContentSafetyError
      && error.message === CONTENT_SAFETY_REJECTED_MESSAGE
      && error.code === "CONTENT_SAFETY_REJECTED",
  );

  console.log("wechat content safety tests passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
