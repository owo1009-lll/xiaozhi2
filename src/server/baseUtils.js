import crypto from "node:crypto";

export function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function hashJson(value) {
  return sha1(JSON.stringify(value));
}

export function safeString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function repairMojibakeText(value, fallback = "") {
  const text = safeString(value, fallback).trim();
  if (!text || !/[\u00c0-\u00ff]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, "latin1").toString("utf8").trim();
    return repaired && !/[\u00c0-\u00ff]/.test(repaired) ? repaired : text;
  } catch {
    return text;
  }
}

export function getArray(value) {
  return Array.isArray(value) ? value : [];
}

export function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function medianNumber(values = [], fallback = 0) {
  const cleaned = getArray(values)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!cleaned.length) return fallback;
  const mid = Math.floor(cleaned.length / 2);
  return cleaned.length % 2 ? cleaned[mid] : (cleaned[mid - 1] + cleaned[mid]) / 2;
}

export function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

export function normalizeStringList(value = []) {
  return getArray(value)
    .map((item) => safeString(item).trim())
    .filter(Boolean);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function nullableRatio(value) {
  const numeric = safeNumber(value, NaN);
  return Number.isFinite(numeric) ? clamp(numeric, 0, 1) : null;
}

export function nullableInteger(value) {
  const numeric = safeNumber(value, NaN);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseTimestampMs(value) {
  const parsed = Date.parse(safeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function firstPositiveNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

export function createId(prefix) {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
}

export function sortNewestFirst(left = {}, right = {}) {
  const leftMs = parseTimestampMs(left.updatedAt) || parseTimestampMs(left.createdAt) || 0;
  const rightMs = parseTimestampMs(right.updatedAt) || parseTimestampMs(right.createdAt) || 0;
  return rightMs - leftMs;
}
