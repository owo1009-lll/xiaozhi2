import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { safeString } from "./baseUtils.js";

export const CONTENT_SAFETY_REJECTED_MESSAGE = "你发布的内容含违规信息";
export const CONTENT_SAFETY_UNAVAILABLE_MESSAGE = "内容安全服务暂不可用，请稍后再试。";
export const CONTENT_SAFETY_RETRY_MESSAGE = "内容安全审核未完成，请重新提交。";

const WECHAT_API_BASE = "https://api.weixin.qq.com";
const MEDIA_TICKET_TTL_MS = 35 * 60 * 1000;
const MODERATION_TICKET_TTL_MS = 45 * 60 * 1000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,160}$/;
const SAFE_TRACE_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const IMAGE_MIME_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);

export class ContentSafetyError extends Error {
  constructor(message, { statusCode = 503, code = "CONTENT_SAFETY_UNAVAILABLE", internalMessage = "" } = {}) {
    super(message);
    this.name = "ContentSafetyError";
    this.statusCode = statusCode;
    this.code = code;
    this.internalMessage = internalMessage;
  }
}

function unavailableError(internalMessage = "") {
  return new ContentSafetyError(CONTENT_SAFETY_UNAVAILABLE_MESSAGE, { internalMessage });
}

function rejectedError() {
  return new ContentSafetyError(CONTENT_SAFETY_REJECTED_MESSAGE, {
    statusCode: 422,
    code: "CONTENT_SAFETY_REJECTED",
  });
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function normalizedBaseUrl(value) {
  const raw = safeString(value).trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function callbackSignature({ token, timestamp, nonce, signature, encrypted = "" }) {
  const parts = encrypted
    ? [token, timestamp, nonce, encrypted]
    : [token, timestamp, nonce];
  return sha1(parts.map((value) => safeString(value)).sort().join("")) === safeString(signature);
}

function aesKeyFromEncodingKey(encodingAesKey) {
  const source = safeString(encodingAesKey).trim();
  if (!source || !/^[A-Za-z0-9+/]{43}$/.test(source)) return null;
  try {
    const key = Buffer.from(`${source}=`, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function decryptWechatPayload(encrypted, encodingAesKey, appId) {
  const key = aesKeyFromEncodingKey(encodingAesKey);
  if (!key) throw unavailableError("WECHAT_CONTENT_SAFETY_ENCODING_AES_KEY is invalid.");
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    const decoded = Buffer.concat([decipher.update(Buffer.from(safeString(encrypted), "base64")), decipher.final()]);
    if (decoded.length < 20) throw new Error("decrypted payload too short");
    const messageLength = decoded.readUInt32BE(16);
    const messageStart = 20;
    const messageEnd = messageStart + messageLength;
    if (messageEnd > decoded.length) throw new Error("decrypted payload message length is invalid");
    const receivedAppId = decoded.subarray(messageEnd).toString("utf8");
    if (receivedAppId !== appId) throw new Error("decrypted payload appid mismatch");
    return decoded.subarray(messageStart, messageEnd).toString("utf8");
  } catch (error) {
    if (error instanceof ContentSafetyError) throw error;
    throw unavailableError(`Unable to decrypt WeChat callback: ${safeString(error?.message)}`);
  }
}

async function defaultRequestJson(url, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw unavailableError(`WeChat request failed: ${safeString(error?.message)}`);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    throw unavailableError(`WeChat returned a non-JSON response (${response.status}).`);
  }
  if (!response.ok) throw unavailableError(`WeChat returned HTTP ${response.status}.`);
  return payload || {};
}

function weChatResponseIsError(payload = {}) {
  return Number(payload?.errcode || 0) !== 0;
}

function moderationSuggestion(payload = {}) {
  return safeString(payload?.result?.suggest).trim().toLowerCase();
}

function ticketStatusView(record) {
  const status = safeString(record?.status).trim();
  if (status === "blocked") return { status: "blocked", message: CONTENT_SAFETY_REJECTED_MESSAGE };
  if (status === "released") return { status: "released" };
  if (status === "failed" || status === "expired") return { status: "failed", message: CONTENT_SAFETY_RETRY_MESSAGE };
  return { status: "pending" };
}

export function createWechatContentSafetyService({
  dataDir = process.cwd(),
  scorePhotoCacheDir = "",
  appId = process.env.WECHAT_MINIPROGRAM_APPID,
  appSecret = process.env.WECHAT_MINIPROGRAM_SECRET,
  publicBaseUrl = process.env.WECHAT_CONTENT_SAFETY_PUBLIC_BASE_URL,
  callbackToken = process.env.WECHAT_CONTENT_SAFETY_CALLBACK_TOKEN,
  encodingAesKey = process.env.WECHAT_CONTENT_SAFETY_ENCODING_AES_KEY,
  requestJson = defaultRequestJson,
  releaseSubmission = null,
  logger = console,
} = {}) {
  const config = {
    appId: safeString(appId).trim(),
    appSecret: safeString(appSecret).trim(),
    publicBaseUrl: normalizedBaseUrl(publicBaseUrl),
    callbackToken: safeString(callbackToken).trim(),
    encodingAesKey: safeString(encodingAesKey).trim(),
  };
  const recordsDir = path.join(dataDir, "wechat-content-safety", "records");
  const pendingReleases = new Map();
  let cachedAccessToken = "";
  let cachedAccessTokenExpiresAt = 0;
  let release = releaseSubmission;

  function isConfigured() {
    return Boolean(config.appId && config.appSecret && config.publicBaseUrl && config.callbackToken);
  }

  function ensureConfigured() {
    if (!isConfigured()) throw unavailableError("WeChat content safety environment variables are incomplete.");
  }

  async function writeRecord(record) {
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(path.join(recordsDir, `${record.ticket}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async function readRecord(ticket) {
    if (!SAFE_TOKEN_PATTERN.test(safeString(ticket))) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(recordsDir, `${ticket}.json`), "utf8"));
      return parsed && parsed.ticket === ticket ? parsed : null;
    } catch {
      return null;
    }
  }

  async function listRecords() {
    try {
      const files = await fs.readdir(recordsDir, { withFileTypes: true });
      const records = await Promise.all(files
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return JSON.parse(await fs.readFile(path.join(recordsDir, entry.name), "utf8"));
          } catch {
            return null;
          }
        }));
      return records.filter(Boolean);
    } catch {
      return [];
    }
  }

  async function findRecordByMediaToken(mediaToken) {
    if (!SAFE_TOKEN_PATTERN.test(safeString(mediaToken))) return null;
    const records = await listRecords();
    return records.find((record) => safeString(record?.mediaToken) === mediaToken) || null;
  }

  async function findRecordByTraceId(traceId) {
    if (!SAFE_TRACE_PATTERN.test(safeString(traceId))) return null;
    const records = await listRecords();
    return records.find((record) => safeString(record?.traceId) === traceId) || null;
  }

  async function getAccessToken() {
    ensureConfigured();
    if (cachedAccessToken && cachedAccessTokenExpiresAt > Date.now()) return cachedAccessToken;
    const url = new URL(`${WECHAT_API_BASE}/cgi-bin/token`);
    url.searchParams.set("grant_type", "client_credential");
    url.searchParams.set("appid", config.appId);
    url.searchParams.set("secret", config.appSecret);
    const payload = await requestJson(url.toString());
    if (weChatResponseIsError(payload) || !safeString(payload?.access_token).trim()) {
      throw unavailableError(`Unable to obtain WeChat access token (errcode ${safeString(payload?.errcode)}).`);
    }
    cachedAccessToken = safeString(payload.access_token).trim();
    const expiresInSeconds = Math.max(60, Number(payload.expires_in || 7200) - 300);
    cachedAccessTokenExpiresAt = Date.now() + (expiresInSeconds * 1000);
    return cachedAccessToken;
  }

  async function getOpenId(loginCode) {
    ensureConfigured();
    const code = safeString(loginCode).trim();
    if (!code) throw unavailableError("The Mini Program login code is missing.");
    const url = new URL(`${WECHAT_API_BASE}/sns/jscode2session`);
    url.searchParams.set("appid", config.appId);
    url.searchParams.set("secret", config.appSecret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");
    const payload = await requestJson(url.toString());
    if (weChatResponseIsError(payload) || !safeString(payload?.openid).trim()) {
      throw unavailableError(`Unable to obtain WeChat openid (errcode ${safeString(payload?.errcode)}).`);
    }
    return safeString(payload.openid).trim();
  }

  async function checkText({ content, openid }) {
    const value = safeString(content).trim();
    if (!value) return;
    const token = await getAccessToken();
    const payload = await requestJson(`${WECHAT_API_BASE}/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: { content: value.slice(0, 2500), version: 2, scene: 1, openid },
    });
    if (weChatResponseIsError(payload)) {
      throw unavailableError(`WeChat text check failed (errcode ${safeString(payload?.errcode)}).`);
    }
    if (moderationSuggestion(payload) !== "pass") throw rejectedError();
  }

  async function startPhotoCheck({ openid, submission }) {
    const scorePhotoPath = path.resolve(safeString(submission?.scorePhotoPath));
    const extension = path.extname(scorePhotoPath).toLowerCase();
    if (!scorePhotoCacheDir || !isPathInside(scorePhotoCacheDir, scorePhotoPath) || !IMAGE_MIME_TYPES.has(extension)) {
      throw unavailableError("The score photo is not a supported JPG or PNG image.");
    }
    let stats;
    try {
      stats = await fs.stat(scorePhotoPath);
    } catch {
      throw unavailableError("The score photo is unavailable for moderation.");
    }
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_MEDIA_BYTES) {
      throw unavailableError("The score photo exceeds WeChat's 10 MB limit.");
    }

    const ticket = randomToken();
    const mediaToken = randomToken();
    const now = Date.now();
    const record = {
      ticket,
      mediaToken,
      status: "creating",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + MODERATION_TICKET_TTL_MS).toISOString(),
      mediaExpiresAt: new Date(now + MEDIA_TICKET_TTL_MS).toISOString(),
      submission,
      traceId: "",
    };
    await writeRecord(record);

    const token = await getAccessToken();
    const mediaUrl = `${config.publicBaseUrl}/api/wechat/content-safety-media/${encodeURIComponent(mediaToken)}`;
    const response = await requestJson(`${WECHAT_API_BASE}/wxa/media_check_async?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: {
        media_url: mediaUrl,
        media_type: 2,
        version: 2,
        scene: 1,
        openid,
      },
    });
    const traceId = safeString(response?.trace_id).trim();
    if (weChatResponseIsError(response) || !SAFE_TRACE_PATTERN.test(traceId)) {
      record.status = "failed";
      await writeRecord(record);
      throw unavailableError(`WeChat media check failed (errcode ${safeString(response?.errcode)}).`);
    }
    record.traceId = traceId;
    record.status = "pending";
    await writeRecord(record);
    return { ticket };
  }

  async function moderateMiniProgramSubmission({ loginCode, content, submission }) {
    ensureConfigured();
    const openid = await getOpenId(loginCode);
    await checkText({ content, openid });
    if (!safeString(submission?.scorePhotoPath).trim()) return { status: "pass" };
    return { status: "pending", ...(await startPhotoCheck({ openid, submission })) };
  }

  async function releasePassedSubmission(record) {
    if (typeof release !== "function") {
      record.status = "failed";
      await writeRecord(record);
      return;
    }
    if (pendingReleases.has(record.ticket)) return pendingReleases.get(record.ticket);
    const releasePromise = (async () => {
      try {
        await release(record.submission);
        record.status = "released";
        record.releasedAt = new Date().toISOString();
      } catch (error) {
        record.status = "failed";
        record.failedAt = new Date().toISOString();
        logger.error("WeChat content safety passed but submission release failed.", error);
      }
      await writeRecord(record);
    })().finally(() => pendingReleases.delete(record.ticket));
    pendingReleases.set(record.ticket, releasePromise);
    return releasePromise;
  }

  function parseVerifiedCallback(query = {}, body = {}) {
    ensureConfigured();
    const encrypted = safeString(body?.Encrypt).trim();
    const isEncrypted = Boolean(encrypted || safeString(query?.encrypt_type).toLowerCase() === "aes");
    const signature = isEncrypted
      ? safeString(query?.msg_signature || body?.MsgSignature).trim()
      : safeString(query?.signature).trim();
    const timestamp = safeString(query?.timestamp || body?.TimeStamp).trim();
    const nonce = safeString(query?.nonce || body?.Nonce).trim();
    if (!signature || !timestamp || !nonce) throw new ContentSafetyError("", { statusCode: 403, code: "INVALID_WECHAT_CALLBACK" });
    if (!callbackSignature({ token: config.callbackToken, timestamp, nonce, signature, encrypted: isEncrypted ? encrypted : "" })) {
      throw new ContentSafetyError("", { statusCode: 403, code: "INVALID_WECHAT_CALLBACK" });
    }
    if (!isEncrypted) return body || {};
    const decoded = decryptWechatPayload(encrypted, config.encodingAesKey, config.appId);
    try {
      return JSON.parse(decoded);
    } catch {
      throw new ContentSafetyError("", { statusCode: 400, code: "INVALID_WECHAT_CALLBACK" });
    }
  }

  async function verifyCallbackUrl(query = {}) {
    ensureConfigured();
    const encryptedEcho = safeString(query?.echostr).trim();
    const isEncrypted = safeString(query?.encrypt_type).toLowerCase() === "aes";
    const signature = isEncrypted ? safeString(query?.msg_signature).trim() : safeString(query?.signature).trim();
    const timestamp = safeString(query?.timestamp).trim();
    const nonce = safeString(query?.nonce).trim();
    if (!signature || !timestamp || !nonce || !encryptedEcho) return null;
    if (!callbackSignature({ token: config.callbackToken, timestamp, nonce, signature, encrypted: isEncrypted ? encryptedEcho : "" })) return null;
    return isEncrypted ? decryptWechatPayload(encryptedEcho, config.encodingAesKey, config.appId) : encryptedEcho;
  }

  async function receiveCallback({ query = {}, body = {} } = {}) {
    let callback;
    try {
      callback = parseVerifiedCallback(query, body);
    } catch (error) {
      return { ok: false, statusCode: Number(error?.statusCode) || 403 };
    }
    if (safeString(callback?.Event) !== "wxa_media_check" || safeString(callback?.appid) !== config.appId) {
      return { ok: true };
    }
    const record = await findRecordByTraceId(safeString(callback?.trace_id));
    if (!record || safeString(record.status) !== "pending") return { ok: true };

    const suggestion = moderationSuggestion(callback);
    if (Number(callback?.errcode || 0) !== 0) {
      record.status = "failed";
      record.failedAt = new Date().toISOString();
      await writeRecord(record);
      return { ok: true };
    }
    if (suggestion !== "pass") {
      record.status = "blocked";
      record.blockedAt = new Date().toISOString();
      await writeRecord(record);
      return { ok: true };
    }
    await releasePassedSubmission(record);
    return { ok: true };
  }

  async function sendPendingMedia({ token, res }) {
    const record = await findRecordByMediaToken(token);
    const now = Date.now();
    const mediaExpiresAt = Date.parse(safeString(record?.mediaExpiresAt));
    const scorePhotoPath = path.resolve(safeString(record?.submission?.scorePhotoPath));
    const extension = path.extname(scorePhotoPath).toLowerCase();
    if (!record
      || safeString(record.status) !== "pending"
      || !Number.isFinite(mediaExpiresAt)
      || mediaExpiresAt < now
      || !scorePhotoCacheDir
      || !isPathInside(scorePhotoCacheDir, scorePhotoPath)
      || !IMAGE_MIME_TYPES.has(extension)) {
      return res.status(404).end();
    }
    try {
      await fs.access(scorePhotoPath);
    } catch {
      return res.status(404).end();
    }
    res.type(IMAGE_MIME_TYPES.get(extension));
    res.set("Cache-Control", "no-store, private");
    res.set("X-Content-Type-Options", "nosniff");
    return res.sendFile(scorePhotoPath);
  }

  async function getPublicStatus(ticket) {
    const record = await readRecord(ticket);
    if (!record) return { status: "unknown" };
    const expiresAt = Date.parse(safeString(record.expiresAt));
    if (safeString(record.status) === "pending" && Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      record.status = "expired";
      await writeRecord(record);
    }
    return ticketStatusView(record);
  }

  return {
    isConfigured,
    moderateMiniProgramSubmission,
    receiveCallback,
    sendPendingMedia,
    getPublicStatus,
    verifyCallbackUrl,
    setReleaseSubmission(nextRelease) {
      release = nextRelease;
    },
  };
}
