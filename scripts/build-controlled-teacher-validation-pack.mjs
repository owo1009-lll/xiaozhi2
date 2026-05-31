import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { toCsv, writeJson } from "./teacher-validation-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index < process.argv.length - 1 ? process.argv[index + 1] : fallback;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeId(value) {
  return String(value || "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function relativeDataWebPath(filePath) {
  const relative = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  return `/${relative}`;
}

function beatsPerMeasure(meter = "4/4") {
  return Math.max(1, numberValue(String(meter).split("/")[0], 4));
}

function sectionIssues(sectionPass = {}) {
  const targets = getArray(sectionPass.practiceTargets);
  const noteTargets = targets.filter((item) => item.targetType === "note" && item.targetId);
  const measureTargets = targets.filter((item) => item.targetType === "measure" && item.measureIndex);
  const noteFindings = noteTargets.map((target) => ({
    noteId: target.targetId,
    measureIndex: Math.max(1, Math.round(numberValue(target.measureIndex, 1))),
    issueLabel: target.evidenceLabel || target.title || "note issue",
    severity: target.severity || "medium",
    why: target.why || "",
    action: target.action || "",
  }));
  const measureFindings = measureTargets.map((target) => ({
    measureIndex: Math.max(1, Math.round(numberValue(target.measureIndex, 1))),
    issueLabel: target.evidenceLabel || target.title || "measure issue",
    severity: target.severity || "medium",
    why: target.why || "",
    action: target.action || "",
  }));
  return { noteFindings, measureFindings };
}

function renderSectionScore({ imagePath, section, sectionPass, noteIssueIds }) {
  const width = 1200;
  const height = 520;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fffdfa";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111827";
  context.font = "bold 34px 'Microsoft YaHei', 'SimHei', Arial";
  context.fillText(sectionPass.sectionTitle || section.title || section.sectionId, 64, 64);
  context.font = "20px 'Microsoft YaHei', 'SimHei', Arial";
  context.fillStyle = "#4b5563";
  context.fillText("桃花坞测试片段", 64, 98);

  const staffTop = 190;
  const lineGap = 18;
  const left = 96;
  const right = width - 96;
  const measureCount = Math.max(1, ...getArray(section.notes).map((note) => Math.round(numberValue(note.measureIndex, 1))));
  const measureWidth = (right - left) / measureCount;
  context.strokeStyle = "#111827";
  context.lineWidth = 2;
  for (let line = 0; line < 5; line += 1) {
    const y = staffTop + line * lineGap;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
  }
  context.font = "20px 'Microsoft YaHei', 'SimHei', Arial";
  for (let measure = 0; measure <= measureCount; measure += 1) {
    const x = left + measure * measureWidth;
    context.beginPath();
    context.moveTo(x, staffTop - 10);
    context.lineTo(x, staffTop + 4 * lineGap + 10);
    context.stroke();
    if (measure < measureCount) context.fillText(String(measure + 1), x + 10, staffTop + 4 * lineGap + 42);
  }

  const perMeasureOrdinal = new Map();
  const notePositions = [];
  const notes = getArray(section.notes).slice().sort((a, b) =>
    numberValue(a.measureIndex, 1) - numberValue(b.measureIndex, 1) || numberValue(a.beatStart, 0) - numberValue(b.beatStart, 0),
  );
  for (const note of notes) {
    const measureIndex = Math.max(1, Math.round(numberValue(note.measureIndex, 1)));
    const ordinal = (perMeasureOrdinal.get(measureIndex) || 0) + 1;
    perMeasureOrdinal.set(measureIndex, ordinal);
    const beat = numberValue(note.beatStart, 0);
    const x = left + (measureIndex - 1) * measureWidth + (beat / beatsPerMeasure(section.meter)) * measureWidth + 24;
    const y = Math.max(staffTop - 60, Math.min(staffTop + 4 * lineGap + 60, staffTop + 2 * lineGap - (numberValue(note.midiPitch, 76) - 76) * 4));
    const isIssue = noteIssueIds.has(note.noteId);
    context.fillStyle = isIssue ? "#dc2626" : "#111827";
    context.beginPath();
    context.ellipse(x, y, 13, 9, -0.28, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = context.fillStyle;
    context.beginPath();
    context.moveTo(x + 12, y);
    context.lineTo(x + 12, y - 54);
    context.stroke();
    if (isIssue) {
      context.font = "bold 18px 'Microsoft YaHei', 'SimHei', Arial";
      context.fillText("!", x - 5, y - 64);
    }
    notePositions.push({
      noteId: `xml-m${measureIndex}-n${ordinal}`,
      sourceNoteId: note.noteId,
      measureIndex,
      globalMeasureIndex: measureIndex,
      displayMeasureIndex: measureIndex,
      noteOrdinal: ordinal,
      label: `第 ${measureIndex} 小节 · 第 ${ordinal} 个音`,
      x: Number((x / width).toFixed(6)),
      y: Number((y / height).toFixed(6)),
      pageNumber: 1,
      systemIndex: 1,
      staffIndex: 1,
      scoreLineRole: "erhu",
      scoreLineConfidence: 1,
      midiPitch: Math.round(numberValue(note.midiPitch, 0)),
      beatStart: numberValue(note.beatStart, 0),
      beatDuration: numberValue(note.beatDuration, 1),
    });
  }

  const measurePositions = Array.from({ length: measureCount }, (_, index) => ({
    measureIndex: index + 1,
    globalMeasureIndex: index + 1,
    displayMeasureIndex: index + 1,
    label: `第 ${index + 1} 小节`,
    xMin: Number(((left + index * measureWidth) / width).toFixed(6)),
    xMax: Number(((left + (index + 1) * measureWidth) / width).toFixed(6)),
    yMin: Number(((staffTop - 58) / height).toFixed(6)),
    yMax: Number(((staffTop + 4 * lineGap + 62) / height).toFixed(6)),
    noteCount: notePositions.filter((note) => note.measureIndex === index + 1).length,
    estimatedBeats: beatsPerMeasure(section.meter),
    pageNumber: 1,
    systemIndex: 1,
    staffIndex: 1,
  }));

  fsSync.mkdirSync(path.dirname(imagePath), { recursive: true });
  fsSync.writeFileSync(imagePath, canvas.toBuffer("image/png"));
  return {
    pageImagePath: relativeDataWebPath(imagePath),
    pageNumber: 1,
    sectionId: section.sectionId,
    sectionTitle: section.title,
    noteCount: notePositions.length,
    lineRankFilterApplied: false,
    focusRegions: [{
      pageNumber: 1,
      systemIndex: 1,
      staffIndex: 1,
      label: "二胡定位行",
      xMin: Number((left / width).toFixed(6)),
      xMax: Number((right / width).toFixed(6)),
      yMin: Number(((staffTop - 64) / height).toFixed(6)),
      yMax: Number(((staffTop + 4 * lineGap + 68) / height).toFixed(6)),
      noteCount: notePositions.length,
    }],
    notePositions,
    measurePositions,
  };
}

function extractAudioClip({ ffmpeg, sourceAudioPath, outputPath, startSeconds, endSeconds }) {
  fsSync.mkdirSync(path.dirname(outputPath), { recursive: true });
  const durationSeconds = Math.max(0.1, numberValue(endSeconds) - numberValue(startSeconds));
  const args = ["-y", "-ss", String(startSeconds), "-i", sourceAudioPath, "-t", String(durationSeconds), "-vn", "-acodec", "pcm_s16le", outputPath];
  const result = spawnSync(ffmpeg || "ffmpeg", args, { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${path.basename(outputPath)}`);
}

async function main() {
  const passJsonPath = path.resolve(repoRoot, arg("--piece-pass-json", "data/piece-pass/taohuawu-whole-v3/taohuawu-test-fragment-whole-piece-pass.json"));
  const notesJsonPath = path.resolve(repoRoot, arg("--notes-json", "data/score-exports/taohuawu-test-fragment/taohuawu-test-fragment.notes.json"));
  const max = Math.max(1, Math.round(numberValue(arg("--max", "8"), 8)));
  const outputDir = path.resolve(repoRoot, arg("--output-dir", path.join("data", "teacher-validation", "packs", `controlled-taohuawu-${new Date().toISOString().replace(/[:.]/g, "-")}`)));

  const pass = JSON.parse(await fs.readFile(passJsonPath, "utf8"));
  const notesJson = JSON.parse(await fs.readFile(notesJsonPath, "utf8"));
  const sectionsById = new Map(getArray(notesJson.sections).map((section) => [section.sectionId, section]));
  const candidates = getArray(pass.sectionPasses)
    .map((sectionPass) => ({ sectionPass, issues: sectionIssues(sectionPass) }))
    .filter(({ sectionPass, issues }) => sectionsById.has(sectionPass.sectionId) && issues.noteFindings.length + issues.measureFindings.length > 0)
    .sort((left, right) => numberValue(left.sectionPass.combinedScore, 999) - numberValue(right.sectionPass.combinedScore, 999))
    .slice(0, max);
  if (!candidates.length) throw new Error("no controlled section candidates with findings");

  const audioPath = path.resolve(repoRoot, notesJson.sourceAudio || pass.audio || "data/test_audio_mix.mp3");
  const pdfPath = path.resolve(repoRoot, notesJson.sourceScore || "data/test_score.pdf");
  const ffmpeg = candidates[0].sectionPass?.diagnostics?.ffmpegPath || "ffmpeg";
  const items = [];
  const analyses = [];
  const reviewRows = [];
  const findingRows = [];

  for (const { sectionPass, issues } of candidates) {
    const section = sectionsById.get(sectionPass.sectionId);
    const caseId = `controlled-taohuawu__${safeId(sectionPass.sectionId)}`;
    const imagePath = path.join(outputDir, "score-pages", `${caseId}.png`);
    const audioClipPath = path.join(outputDir, "audio-clips", `${caseId}.wav`);
    extractAudioClip({
      ffmpeg,
      sourceAudioPath: audioPath,
      outputPath: audioClipPath,
      startSeconds: sectionPass.startSeconds,
      endSeconds: sectionPass.endSeconds,
    });
    const scoreLocator = renderSectionScore({
      imagePath,
      section,
      sectionPass,
      noteIssueIds: new Set(issues.noteFindings.map((finding) => finding.noteId)),
    });
    const audioSegment = {
      startSeconds: numberValue(sectionPass.startSeconds),
      endSeconds: numberValue(sectionPass.endSeconds),
      durationSeconds: numberValue(sectionPass.durationSeconds, numberValue(sectionPass.endSeconds) - numberValue(sectionPass.startSeconds)),
    };
    const alignmentEvidence = {
      trusted: true,
      scanMode: "controlled-piece-pass",
      audioDurationSeconds: audioSegment.durationSeconds,
      estimatedPieceDurationSeconds: audioSegment.durationSeconds,
      durationRatio: 1,
      reason: "controlled pack uses repository test audio, structured score notes, and melody-focus piece-pass windows",
    };
    const analysis = {
      analysisId: `${caseId}-analysis`,
      participantId: "controlled-taohuawu-test",
      groupId: "teacher-validation-controlled",
      sessionStage: "controlled-section",
      scoreId: "controlled-taohuawu-score",
      pieceId: notesJson.pieceId,
      sectionId: section.sectionId,
      pieceTitle: notesJson.title,
      sectionTitle: section.title,
      audioHash: "controlled-taohuawu-audio",
      audioSegment,
      audioDurationSeconds: audioSegment.durationSeconds,
      overallPitchScore: sectionPass.overallPitchScore,
      overallRhythmScore: sectionPass.overallRhythmScore,
      studentCombinedScore: sectionPass.combinedScore,
      confidence: sectionPass.confidence,
      recommendedPracticePath: sectionPass.recommendedPracticePath || "review-first",
      noteFindings: issues.noteFindings,
      measureFindings: issues.measureFindings,
      summaryText: sectionPass.summaryText || "",
      teacherComment: sectionPass.teacherComment || "",
      practiceTargets: getArray(sectionPass.practiceTargets),
      diagnostics: sectionPass.diagnostics || {},
      sourceMetadata: {
        sourceKind: "controlled-piece-pass",
        passJsonPath: path.relative(repoRoot, passJsonPath).replace(/\\/g, "/"),
        sourcePdfPath: path.relative(repoRoot, pdfPath).replace(/\\/g, "/"),
        sourceAudioPath: path.relative(repoRoot, audioPath).replace(/\\/g, "/"),
        sourceType: "section",
        alignmentEvidence,
      },
      scoreLocator,
    };
    const item = {
      caseId,
      analysisId: analysis.analysisId,
      scoreId: analysis.scoreId,
      pieceId: analysis.pieceId,
      title: analysis.pieceTitle,
      sectionId: analysis.sectionId,
      sectionTitle: analysis.sectionTitle,
      audioHash: analysis.audioHash,
      audioSegment,
      sourcePdfPath: path.relative(repoRoot, pdfPath).replace(/\\/g, "/"),
      sourceAudioPath: path.relative(repoRoot, audioPath).replace(/\\/g, "/"),
      audioClipPath: path.relative(repoRoot, audioClipPath).replace(/\\/g, "/"),
      sourceKind: "controlled-piece-pass",
      sourceType: "section",
      systemRecommendedPath: analysis.recommendedPracticePath,
      systemIssueNoteIds: issues.noteFindings.map((finding) => finding.noteId),
      systemIssueMeasureIndexes: issues.measureFindings.map((finding) => finding.measureIndex),
      noteFindingCount: issues.noteFindings.length,
      measureFindingCount: issues.measureFindings.length,
      confidence: analysis.confidence,
      alignmentEvidence,
      riskScore: issues.noteFindings.length + issues.measureFindings.length * 2,
      scoreLocator,
    };
    items.push(item);
    analyses.push(analysis);
    reviewRows.push({
      caseId,
      analysisId: analysis.analysisId,
      raterId: "teacher-1",
      reviewStatus: "pending",
      includeInBaseline: "yes",
      overallAgreement: "",
      teacherPrimaryPath: "",
      teacherIssueNoteIds: "",
      teacherIssueMeasureIndexes: "",
      comments: "",
      title: item.title,
      sectionId: item.sectionId,
      sectionTitle: item.sectionTitle,
      audioStartSeconds: audioSegment.startSeconds,
      audioEndSeconds: audioSegment.endSeconds,
      audioDurationSeconds: audioSegment.durationSeconds,
      sourceAudioPath: item.sourceAudioPath,
      audioClipPath: item.audioClipPath,
      sourcePdfPath: item.sourcePdfPath,
      systemRecommendedPath: item.systemRecommendedPath,
      systemIssueNoteIds: item.systemIssueNoteIds.join("|"),
      systemIssueMeasureIndexes: item.systemIssueMeasureIndexes.join("|"),
      noteFindingCount: item.noteFindingCount,
      measureFindingCount: item.measureFindingCount,
      alignmentTrusted: "yes",
      alignmentScanMode: alignmentEvidence.scanMode,
      alignmentReason: alignmentEvidence.reason,
    });
    findingRows.push(...issues.noteFindings.map((finding) => ({
      caseId,
      analysisId: analysis.analysisId,
      findingType: "note",
      findingId: finding.noteId,
      measureIndex: finding.measureIndex,
      label: finding.issueLabel,
      severity: finding.severity,
      why: finding.why,
      action: finding.action,
    })));
    findingRows.push(...issues.measureFindings.map((finding) => ({
      caseId,
      analysisId: analysis.analysisId,
      findingType: "measure",
      findingId: `measure-${finding.measureIndex}`,
      measureIndex: finding.measureIndex,
      label: finding.issueLabel,
      severity: finding.severity,
      why: finding.why,
      action: finding.action,
    })));
  }

  const manifest = {
    schemaVersion: 1,
    reviewMode: "controlled",
    generatedAt: new Date().toISOString(),
    unit: "section",
    sources: "controlled-piece-pass",
    requestedMin: candidates.length,
    requestedMax: max,
    selectedCount: items.length,
    warningCount: 0,
    warnings: [],
    files: {
      analyses: "analyses.json",
      teacherReviewJson: "teacher-review-template.json",
      teacherReviewCsv: "teacher-review-template.csv",
      systemFindingsCsv: "system-findings.csv",
      readme: "README.md",
    },
    items,
  };

  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  await writeJson(path.join(outputDir, "analyses.json"), { schemaVersion: 1, analyses });
  await writeJson(path.join(outputDir, "teacher-review-template.json"), { schemaVersion: 1, reviews: reviewRows });
  await fs.writeFile(path.join(outputDir, "teacher-review-template.csv"), toCsv(reviewRows), "utf8");
  await fs.writeFile(path.join(outputDir, "system-findings.csv"), toCsv(findingRows), "utf8");
  await fs.writeFile(path.join(outputDir, "README.md"), "# Controlled Teacher Validation Pack\n\nThis pack uses only repository test audio, structured score notes, and generated section score pages.\n", "utf8");

  console.log(JSON.stringify({ ok: true, outputDir, selectedCount: items.length, sources: manifest.sources }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
