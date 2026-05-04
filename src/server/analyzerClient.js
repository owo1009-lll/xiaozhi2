import http from "node:http";
import https from "node:https";

import { safeString } from "./baseUtils.js";

function analyzerBaseUrl(env) {
  return safeString(env?.ERHU_ANALYZER_URL).replace(/\/+$/, "");
}

function transportForUrl(target) {
  return target.protocol === "https:" ? https : http;
}

async function postJsonLongTimeout(url, payload, { timeoutMs, timeoutMessage, upstreamMessage }) {
  const target = new URL(url);
  const transport = transportForUrl(target);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "POST",
        agent: false,
        headers: {
          "Connection": "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(`${upstreamMessage}: ${response.statusCode || 500}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(timeoutMessage));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function buildAnalyzePayload(payload, section, analyzerAudioPath) {
  return {
    participantId: payload.participantId,
    groupId: payload.groupId,
    sessionStage: payload.sessionStage,
    scoreId: payload.scoreId,
    pieceId: section?.pieceId || payload.pieceId,
    sectionId: section?.sectionId || payload.sectionId,
    preprocessMode: payload.preprocessMode,
    separationMode: payload.separationMode,
    piecePack: section,
    audioSubmission: payload.audioSubmission,
    audioPath: analyzerAudioPath || payload.audioPath,
    audioDataUrl: analyzerAudioPath || payload.audioPath ? null : payload.audioDataUrl,
    windowStartSeconds: Number.isFinite(Number(payload.windowStartSeconds)) ? Number(payload.windowStartSeconds) : null,
    windowEndSeconds: Number.isFinite(Number(payload.windowEndSeconds)) ? Number(payload.windowEndSeconds) : null,
  };
}

export function createAnalyzerClient({ env = process.env, toAnalyzerPath = async (value) => value, appendPerfTrace = () => {} } = {}) {
  async function callExternalAnalyzer(payload, section) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl) return null;
    const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
    const response = await fetch(`${analyzerUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildAnalyzePayload(payload, section, analyzerAudioPath)),
    });
    if (!response.ok) {
      throw new Error(`external analyzer request failed: ${response.status}`);
    }
    const json = await response.json();
    return json?.analysis || null;
  }

  async function callExternalScoreImport(payload) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl) return null;
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(20 * 60 * 1000)
      : undefined;
    const response = await fetch(`${analyzerUrl}/score/import-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`score import upstream failed: ${response.status}`);
    }
    const json = await response.json();
    return json?.job || null;
  }

  async function callExternalScoreImportLongTimeout(payload) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl) return null;
    const json = await postJsonLongTimeout(`${analyzerUrl}/score/import-pdf`, payload, {
      timeoutMs: 20 * 60 * 1000,
      timeoutMessage: "score import timed out",
      upstreamMessage: "score import upstream failed",
    });
    return json?.job || null;
  }

  async function callExternalMusicXmlImportLongTimeout(payload) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl) return null;
    const json = await postJsonLongTimeout(`${analyzerUrl}/score/import-musicxml`, payload, {
      timeoutMs: 5 * 60 * 1000,
      timeoutMessage: "musicxml import timed out",
      upstreamMessage: "musicxml import upstream failed",
    });
    return json?.job || null;
  }

  async function callExternalAnalyzerLongTimeout(payload, section) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl) return null;
    const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
    appendPerfTrace(
      `[upstream-analyze] sectionId=${safeString(section?.sectionId)} audioPath=${safeString(analyzerAudioPath || payload.audioPath)}`,
    );
    const json = await postJsonLongTimeout(`${analyzerUrl}/analyze`, buildAnalyzePayload(payload, section, analyzerAudioPath), {
      timeoutMs: 30 * 60 * 1000,
      timeoutMessage: "analysis timed out",
      upstreamMessage: "analysis upstream failed",
    });
    return json?.analysis || null;
  }

  async function callExternalSectionRankLongTimeout(payload, sections, piece) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl || !Array.isArray(sections) || !sections.length) return null;
    const analyzerAudioPath = await toAnalyzerPath(payload.audioPath);
    appendPerfTrace(
      `[upstream-detect] pieceId=${safeString(piece?.pieceId)} sectionCount=${sections.length} audioPath=${safeString(analyzerAudioPath || payload.audioPath)}`,
    );
    const json = await postJsonLongTimeout(`${analyzerUrl}/detect-sections`, {
      participantId: payload.participantId,
      groupId: payload.groupId,
      sessionStage: payload.sessionStage,
      scoreId: payload.scoreId,
      pieceId: safeString(piece?.pieceId, payload.pieceId),
      preprocessMode: payload.preprocessMode,
      separationMode: payload.separationMode,
      audioSubmission: payload.audioSubmission,
      audioPath: analyzerAudioPath || payload.audioPath,
      audioDataUrl: analyzerAudioPath || payload.audioPath ? null : payload.audioDataUrl,
      piecePacks: sections,
    }, {
      timeoutMs: 30 * 60 * 1000,
      timeoutMessage: "section rank timed out",
      upstreamMessage: "section rank upstream failed",
    });
    return Array.isArray(json?.candidates) ? json.candidates : [];
  }

  async function callPatchTempos(pages) {
    const analyzerUrl = analyzerBaseUrl(env);
    if (!analyzerUrl || !pages.length) return {};
    try {
      const response = await fetch(`${analyzerUrl}/score/patch-tempos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages }),
      });
      if (!response.ok) return {};
      const json = await response.json();
      return json?.patches || {};
    } catch {
      return {};
    }
  }

  return {
    callExternalAnalyzer,
    callExternalScoreImport,
    callExternalScoreImportLongTimeout,
    callExternalMusicXmlImportLongTimeout,
    callExternalAnalyzerLongTimeout,
    callExternalSectionRankLongTimeout,
    callPatchTempos,
  };
}
