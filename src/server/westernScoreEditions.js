import fs from "node:fs/promises";
import path from "node:path";

import { safeString } from "./baseUtils.js";

// The built-in "supported editions" registry: for each piece, a confirmed
// MusicXML + locked render image + coordinate sidecar. These reference scores
// are what the student score view displays, and what future on-score error
// highlighting maps onto (via the coordinate sidecar). Everything served here
// is reference material, never student data.
function editionsRoot(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m4a", "supported-editions");
}

function publicLibraryRoot(repoRoot) {
  return path.join(repoRoot, "data", "public-score-library");
}

function controlledSubmissionsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submissions.jsonl");
}

function controlledSubmissionReviewsPath(repoRoot) {
  return path.join(repoRoot, "data", "experiments", "western-strings-m3", "controlled-submission-reviews.jsonl");
}

async function readJsonlRecords(targetPath) {
  try {
    return (await fs.readFile(targetPath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readRegistryFile(registryPath) {
  try {
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

async function readRegistryAt(root) {
  return readRegistryFile(path.join(root, "registry.json"));
}

async function readPublicRegistry(repoRoot) {
  const root = publicLibraryRoot(repoRoot);
  const registryNames = ["registry.json", "registry-mutopia-violin.json"];
  const registries = await Promise.all(
    registryNames.map((name) => readRegistryFile(path.join(root, name))),
  );
  return registries.flat();
}

async function readRegistry(repoRoot) {
  return readRegistryAt(editionsRoot(repoRoot));
}

function findEntry(entries, pieceId, editionId) {
  const piece = safeString(pieceId).trim();
  const edition = safeString(editionId).trim();
  if (!piece) return null;
  return entries.find(
    (entry) => safeString(entry.pieceId).trim() === piece
      && (!edition || safeString(entry.editionId).trim() === edition),
  ) || null;
}

const BACH_WORK_TITLES_ZH = {
  BWV1001: "G小调第一无伴奏小提琴奏鸣曲",
  BWV1002: "B小调第一无伴奏小提琴组曲",
  BWV1003: "A小调第二无伴奏小提琴奏鸣曲",
  BWV1004: "D小调第二无伴奏小提琴组曲",
  BWV1005: "C大调第三无伴奏小提琴奏鸣曲",
  BWV1006: "E大调第三无伴奏小提琴组曲",
  BWV1041: "A小调第一小提琴协奏曲",
};
const MOVEMENT_TITLES_ZH = {
  Adagio: "柔板",
  "Fuga (Allegro)": "赋格（快板）",
  Siciliana: "西西里舞曲",
  Presto: "急板",
  Allemande: "阿勒曼德舞曲",
  Allemanda: "阿勒曼德舞曲",
  Double: "变奏",
  Corrente: "库朗特舞曲",
  "Double (Presto)": "变奏（急板）",
  Sarabande: "萨拉班德舞曲",
  Sarabanda: "萨拉班德舞曲",
  "Tempo di Borea": "布列舞曲速度",
  Grave: "庄板",
  Fuga: "赋格",
  Andante: "行板",
  Allegro: "快板",
  Giga: "吉格舞曲",
  Gigue: "吉格舞曲",
  Ciaccona: "恰空舞曲",
  Largo: "广板",
  "Allegro assai": "很快的快板",
  Preludio: "前奏曲",
  Loure: "卢尔舞曲",
  "Gavotte en Rondeau": "回旋加沃特舞曲",
  "Menuet I": "第一小步舞曲",
  "Menuet II": "第二小步舞曲",
  "Bourrée": "布列舞曲",
};
function localizePublicEntry(entry) {
  const localized = { ...entry };
  localized.meta = safeString(entry.meta).replace(
    /\s*·\s*(?:公共领域|知识共享.*|Public Domain|CC BY-SA.*)$/,
    "",
  );
  localized.sourceLabel = "";
  localized.licenseName = "";

  if (/^bwv\d+-mov\d+$/.test(entry.pieceId)) {
    const movementNumber = Number(entry.movementNumber) || 1;
    const movement = MOVEMENT_TITLES_ZH[entry.movement] || entry.movement;
    const workTitle = BACH_WORK_TITLES_ZH[entry.workId] || "巴赫小提琴作品";
    localized.group = `巴赫·${workTitle}`;
    localized.workTitle = workTitle;
    localized.movement = movement;
    localized.title = `第${movementNumber}乐章：${movement}`;
    localized.composer = "约翰·塞巴斯蒂安·巴赫";
    localized.meta = `${movement} · 共${entry.pageCount}页`;
    return localized;
  }

  const exerciseMatch = safeString(entry.pieceId).match(
    /^(wohlfahrt-op45|kayser-op20|sitt-op32)-no(\d+)$/,
  );
  if (!exerciseMatch) return localized;
  const number = Number(exerciseMatch[2]);
  const series = {
    "wohlfahrt-op45": {
      composer: "弗朗茨·沃尔法特",
      title: "第四十五号练习曲",
      group: number <= 30
        ? "沃尔法特六十首小提琴练习曲·第一册"
        : "沃尔法特六十首小提琴练习曲·第二册",
    },
    "kayser-op20": {
      composer: "海因里希·恩斯特·开塞",
      title: "第二十号练习曲",
      group: "开塞三十六首小提琴练习曲",
    },
    "sitt-op32": {
      composer: "汉斯·西特",
      title: "第三十二号练习曲",
      group: "西特一百首小提琴练习曲·第一册",
    },
  }[exerciseMatch[1]];
  localized.group = series.group;
  localized.workTitle = series.group;
  localized.movement = `第${number}首练习曲`;
  localized.title = `${series.title}·第${number}首`;
  localized.composer = series.composer;
  localized.meta = `练习曲·第${number}首 · 共${entry.pageCount}页`;
  return localized;
}

// Only paths listed inside the registry are servable, and only when they resolve
// back inside the supported-editions directory — no caller-supplied path reaches disk.
function resolveInsideRoot(root, relativePath) {
  const resolved = path.resolve(root, safeString(relativePath));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return resolved;
}

export async function listSupportedEditions({ repoRoot = process.cwd() } = {}) {
  const builtInEntries = await readRegistry(repoRoot);
  const publicEntries = await readPublicRegistry(repoRoot);
  const entries = [...builtInEntries, ...publicEntries.map(localizePublicEntry)];
  return {
    ok: true,
    editions: entries.map((entry) => ({
      pieceId: safeString(entry.pieceId),
      scoreId: safeString(entry.scoreId),
      editionId: safeString(entry.editionId),
      title: safeString(entry.title),
      group: safeString(entry.group, "诊断练习曲"),
      libraryCategory: safeString(entry.libraryCategory, "repertoire"),
      workId: safeString(entry.workId),
      workTitle: safeString(entry.workTitle),
      movement: safeString(entry.movement),
      composer: safeString(entry.composer),
      meta: safeString(entry.meta, `${Number(entry.pageCount) || 1}页`),
      sourceLabel: safeString(entry.sourceLabel),
      sourceUrl: safeString(entry.sourceUrl),
      licenseName: safeString(entry.licenseName, entry.licenseStatus),
      pageCount: Array.isArray(entry.renderPaths) && entry.renderPaths.length
        ? entry.renderPaths.length
        : Number(entry.pageCount) || 1,
      hasCoordinates: Boolean(safeString(entry.coordinateSidecarPath)),
    })),
  };
}

export async function findEditionRenderPath({
  repoRoot = process.cwd(),
  pieceId = "",
  editionId = "",
  page = 1,
} = {}) {
  const builtInEntries = await readRegistry(repoRoot);
  let root = editionsRoot(repoRoot);
  let entry = findEntry(builtInEntries, pieceId, editionId);
  if (!entry) {
    root = publicLibraryRoot(repoRoot);
    entry = findEntry(await readPublicRegistry(repoRoot), pieceId, editionId);
  }
  if (!entry) return "";
  const renderPaths = Array.isArray(entry.renderPaths) && entry.renderPaths.length
    ? entry.renderPaths
    : [entry.renderPath];
  const pageNumber = Number(page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > renderPaths.length) return "";
  const resolved = resolveInsideRoot(root, renderPaths[pageNumber - 1]);
  if (!resolved) return "";
  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return "";
  }
}

export async function findEditionCoordinates({ repoRoot = process.cwd(), pieceId = "", editionId = "" } = {}) {
  const builtInEntries = await readRegistry(repoRoot);
  let root = editionsRoot(repoRoot);
  let entry = findEntry(builtInEntries, pieceId, editionId);
  if (!entry) {
    root = publicLibraryRoot(repoRoot);
    entry = findEntry(await readPublicRegistry(repoRoot), pieceId, editionId);
  }
  if (!entry) return null;
  const resolved = resolveInsideRoot(root, entry.coordinateSidecarPath);
  if (!resolved) return null;
  try {
    return JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch {
    return null;
  }
}

// Pre-generated real diagnosis results (research-grade verdicts on old recordings,
// used to test on-score localization until the safety-gated automatic pipeline
// ships). Stored as verdict JSON only — never the recording audio.
const VERDICT_LABELS = {
  "pitch-mismatch": "音准不符",
  "no-audio-evidence": "未听到 / 漏音",
  "beyond-recording": "超出录音",
  "anchor-uncertain": "对齐存疑",
};
const DEMO_INJECTION_LABELS = {
  missing: { verdict: "no-audio-evidence", label: "未听到 / 漏音" },
  wrong: { verdict: "pitch-mismatch", label: "音准不符" },
  drag: { verdict: "rhythm-drag", label: "节奏拖拍" },
};
const STUDENT_ISSUE_LABELS = {
  pitch: "音准",
  rhythm: "节奏",
  tone: "音质",
  missing: "漏音 / 错音",
};

async function readDiagnosis(repoRoot, pieceId) {
  const piece = safeString(pieceId).trim();
  if (!piece || piece.includes("/") || piece.includes("\\") || piece.includes("..")) return null;
  const p = path.join(repoRoot, "data", "experiments", "western-strings-m4a", "score-diagnosis", `${piece}.json`);
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function readInjectedDemo(repoRoot, pieceId) {
  if (safeString(pieceId).trim() !== "r2-01") return null;
  const demoPath = path.join(
    repoRoot,
    "data",
    "experiments",
    "western-strings-injected-errors",
    "r2-01-injected-v2-20260717.labels.json",
  );
  try {
    return JSON.parse(await fs.readFile(demoPath, "utf8"));
  } catch {
    return null;
  }
}

async function readReleasedSubmissionDiagnosis(repoRoot, submissionId, pieceId) {
  const targetId = safeString(submissionId).trim();
  const targetPiece = safeString(pieceId).trim();
  if (!targetId || !targetPiece) return null;
  const [submissions, reviews] = await Promise.all([
    readJsonlRecords(controlledSubmissionsPath(repoRoot)),
    readJsonlRecords(controlledSubmissionReviewsPath(repoRoot)),
  ]);
  const submission = submissions.find(
    (row) => safeString(row?.submissionId).trim() === targetId,
  );
  if (!submission || safeString(submission.pieceId).trim() !== targetPiece) return null;
  const latestReview = reviews
    .filter((row) => safeString(row?.submissionId).trim() === targetId)
    .at(-1);
  const released = latestReview?.action === "feedback_released"
    && latestReview?.releaseToStudent === true
    && Boolean(safeString(latestReview?.studentMessage).trim());
  if (!released) return null;
  return {
    submission,
    review: latestReview,
  };
}

function buildLocatedIssues(issueRows, coordNotes, coordMeasures) {
  const noteIssues = [];
  const problemMeasures = new Map();
  const coordinatesByNoteId = new Map();
  for (const note of coordNotes) {
    const noteIds = Array.isArray(note?.noteIds) ? note.noteIds : [note?.noteId];
    for (const noteId of noteIds) {
      const key = safeString(noteId).trim();
      if (key) coordinatesByNoteId.set(key, note);
    }
  }
  for (const issue of issueRows) {
    const coordNote = coordinatesByNoteId.get(safeString(issue.noteId).trim())
      || coordNotes[issue.noteIndex];
    if (!coordNote) continue;
    const measure = coordNote.globalMeasureIndex;
    const pageNumber = Math.max(1, Math.round(Number(coordNote.pageNumber) || 1));
    noteIssues.push({
      bbox: coordNote.bboxNormalized,
      verdict: issue.verdict,
      label: issue.label,
      measure,
      pageNumber,
    });
    const measureKey = `${pageNumber}:${measure}`;
    if (!problemMeasures.has(measureKey)) {
      problemMeasures.set(measureKey, { pageNumber, measure, labels: new Set() });
    }
    problemMeasures.get(measureKey).labels.add(issue.label);
  }
  const measureIssues = [];
  for (const problem of problemMeasures.values()) {
    const coordMeasure = coordMeasures.find((item) => (
      item.globalMeasureIndex === problem.measure
      && Math.max(1, Math.round(Number(item.pageNumber) || 1)) === problem.pageNumber
    ));
    if (coordMeasure) {
      measureIssues.push({
        bbox: coordMeasure.bboxNormalized,
        measure: problem.measure,
        pageNumber: problem.pageNumber,
        labels: Array.from(problem.labels),
      });
    }
  }
  return { noteIssues, measureIssues };
}

// Fuse per-note verdicts with the coordinate sidecar (same note order) into
// on-score localization: each non-confirmed note becomes a boxed issue, and the
// measures that contain them become highlighted measures.
export async function buildScoreDiagnosis({
  repoRoot = process.cwd(),
  pieceId = "",
  editionId = "",
  submissionId = "",
  demo = false,
} = {}) {
  const coords = await findEditionCoordinates({ repoRoot, pieceId, editionId });
  if (!coords) {
    return {
      ok: true,
      hasData: false,
      pieceId: safeString(pieceId),
      submissionId: safeString(submissionId),
      noteIssues: [],
      measureIssues: [],
    };
  }
  const coordNotes = Array.isArray(coords.notes) ? coords.notes : [];
  const coordMeasures = Array.isArray(coords.measures) ? coords.measures : [];

  if (safeString(submissionId).trim()) {
    const released = await readReleasedSubmissionDiagnosis(
      repoRoot,
      submissionId,
      pieceId,
    );
    if (!released) {
      return {
        ok: true,
        hasData: false,
        pieceId: safeString(pieceId),
        submissionId: safeString(submissionId),
        noteIssues: [],
        measureIssues: [],
      };
    }
    const issueRows = (Array.isArray(released.review.studentIssues)
      ? released.review.studentIssues
      : [])
      .map((issue) => {
        const category = safeString(issue?.category).trim();
        const label = STUDENT_ISSUE_LABELS[category];
        if (!label) return null;
        return {
          noteId: safeString(issue?.noteId).trim(),
          noteIndex: Number(issue?.noteIndex),
          verdict: category,
          label,
        };
      })
      .filter(Boolean);
    const located = buildLocatedIssues(issueRows, coordNotes, coordMeasures);
    const verdictCounts = {};
    for (const issue of located.noteIssues) {
      verdictCounts[issue.verdict] = (verdictCounts[issue.verdict] || 0) + 1;
    }
    return {
      ok: true,
      hasData: true,
      diagnosisMode: "teacher-released-submission",
      pieceId: safeString(pieceId),
      submissionId: safeString(submissionId),
      verdictCounts,
      audioAgreementHeard: null,
      ...located,
    };
  }

  const diagnosis = await readDiagnosis(repoRoot, pieceId);
  if (!diagnosis) {
    return {
      ok: true,
      hasData: false,
      pieceId: safeString(pieceId),
      submissionId: "",
      noteIssues: [],
      measureIssues: [],
    };
  }

  if (demo === true) {
    const injectedDemo = await readInjectedDemo(repoRoot, pieceId);
    const issueRows = (injectedDemo?.injections || [])
      .map((injection) => {
        const mapped = DEMO_INJECTION_LABELS[safeString(injection.type).trim()];
        if (!mapped) return null;
        return {
          noteIndex: Number(injection.scoreEventIndex),
          verdict: mapped.verdict,
          label: mapped.label,
        };
      })
      .filter(Boolean);
    const located = buildLocatedIssues(issueRows, coordNotes, coordMeasures);
    const verdictCounts = {};
    for (const issue of located.noteIssues) {
      verdictCounts[issue.verdict] = (verdictCounts[issue.verdict] || 0) + 1;
    }
    return {
      ok: true,
      hasData: true,
      isDemo: true,
      diagnosisMode: "synthetic-injected-demo",
      pieceId: safeString(pieceId),
      verdictCounts,
      audioAgreementHeard: null,
      ...located,
    };
  }

  const diagNotes = Array.isArray(diagnosis.notes) ? diagnosis.notes : [];
  const issueRows = [];
  for (let i = 0; i < diagNotes.length && i < coordNotes.length; i++) {
    const verdict = safeString(diagNotes[i].verdict).trim();
    if (!verdict || verdict === "confirmed") continue;
    const label = VERDICT_LABELS[verdict] || verdict;
    issueRows.push({ noteIndex: i, verdict, label });
  }
  const located = buildLocatedIssues(issueRows, coordNotes, coordMeasures);
  return {
    ok: true,
    hasData: true,
    pieceId: safeString(pieceId),
    verdictCounts: diagnosis.verdictCounts || {},
    audioAgreementHeard: diagnosis.audioAgreementHeard ?? null,
    ...located,
  };
}
