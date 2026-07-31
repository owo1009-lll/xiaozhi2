import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Publishes LilyPond-sourced etudes into the public score library.
//
// Per etude: the exact MusicXML (transcoded from the publisher's .ly, never
// recognised) is imported through the existing score-import route so the store
// gets `xml-mN-nM` note ids, and the coordinate sidecar plus the render pages
// built from the SAME LilyPond pass are copied in beside it.
//
// The sidecar's notes carry no noteId when built (geometry does not know the
// numbering), so ids are bound here from the imported score, in score order.
// The counts must agree exactly or the entry is refused: a silent off-by-one
// would highlight the wrong note on the page for every student afterwards.
//
//   node scripts/import-etude-library-entries.mjs --plan <plan.json> [--limit N]
const args = process.argv.slice(2);
const readArg = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const REPO = process.cwd();
const LIBRARY = path.join(REPO, "data", "public-score-library", "editions");
const SERVER = process.env.ETUDE_IMPORT_SERVER || "http://127.0.0.1:3000";
const plan = JSON.parse(fs.readFileSync(path.resolve(readArg("--plan")), "utf8"));
const limit = Number.parseInt(readArg("--limit", "0"), 10) || 0;

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function importMusicXml(musicxmlPath, title) {
  const form = new FormData();
  form.append("musicxml", new Blob([fs.readFileSync(musicxmlPath)]), path.basename(musicxmlPath));
  form.append("titleHint", title);
  form.append("instrument", "violin");
  form.append("selectedPartHint", "violin");
  const response = await fetch(`${SERVER}/api/erhu/scores/import-musicxml`, { method: "POST", body: form });
  const json = await response.json();
  if (!json?.ok || json?.job?.omrStatus !== "completed") {
    throw new Error(`import failed: ${json?.error || json?.job?.error || response.status}`);
  }
  return json.job.scoreId;
}

const { readScoreStoreFromSqlite } = await import("../src/server/scoreStoreSqlite.js");

function scoreNoteIds(scoreId) {
  const store = readScoreStoreFromSqlite(path.join(REPO, "data", "erhu-score-imports.sqlite"));
  const scores = store.scores || store;
  const score = scores.find((item) => item.scoreId === scoreId);
  if (!score) throw new Error(`score ${scoreId} not found after import`);
  return (score.sections || []).flatMap((section) => section.notes || []).map((note) => note.noteId);
}

const results = [];
const failures = [];
const pieces = limit ? plan.pieces.slice(0, limit) : plan.pieces;

for (const piece of pieces) {
  try {
    const coordPath = path.join(REPO, piece.coordinatesDir, "coordinates.json");
    const sidecar = JSON.parse(fs.readFileSync(coordPath, "utf8"));
    if (!sidecar.verification?.passed) throw new Error("sidecar verification did not pass");

    const scoreId = await importMusicXml(path.join(REPO, piece.musicxml), piece.title);
    const noteIds = scoreNoteIds(scoreId);
    if (noteIds.length !== sidecar.notes.length) {
      throw new Error(`note count mismatch: score ${noteIds.length} vs sidecar ${sidecar.notes.length}`);
    }
    sidecar.notes.forEach((note, index) => {
      note.noteId = noteIds[index];
      note.noteIds = [noteIds[index]];
    });

    const destination = path.join(LIBRARY, piece.pieceId, piece.editionId);
    fs.mkdirSync(destination, { recursive: true });
    const renderPaths = [];
    const renderSha = [];
    for (const [index, render] of (sidecar.pages || []).entries()) {
      const from = path.join(REPO, piece.coordinatesDir, render.render);
      const to = path.join(destination, `render-page-${String(index + 1).padStart(2, "0")}.png`);
      fs.copyFileSync(from, to);
      renderPaths.push(path.relative(path.join(REPO, "data", "public-score-library"), to).replace(/\\/g, "/"));
      renderSha.push(sha256(to));
    }
    const musicxmlOut = path.join(destination, "score.musicxml");
    fs.copyFileSync(path.join(REPO, piece.musicxml), musicxmlOut);
    const sidecarOut = path.join(destination, "coordinates.json");
    fs.writeFileSync(sidecarOut, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

    results.push({
      pieceId: piece.pieceId,
      editionId: piece.editionId,
      scoreId,
      title: piece.title,
      group: piece.group,
      composer: piece.composer,
      notes: noteIds.length,
      pageCount: renderPaths.length,
      musicxmlPath: path.relative(path.join(REPO, "data", "public-score-library"), musicxmlOut).replace(/\\/g, "/"),
      musicxmlSha256: sha256(musicxmlOut),
      renderPaths,
      renderSha256: renderSha,
      coordinateSidecarPath: path.relative(path.join(REPO, "data", "public-score-library"), sidecarOut).replace(/\\/g, "/"),
      coordinateSidecarSha256: sha256(sidecarOut),
      licenseName: piece.licenseName,
      licenseStatus: "public-domain-source-cc-by-sa-typeset",
      sourceLabel: piece.sourceLabel,
      sourceUrl: piece.sourceUrl,
      attribution: piece.attribution,
    });
  } catch (error) {
    failures.push({ pieceId: piece.pieceId, reason: String(error?.message || error).slice(0, 200) });
  }
}

const outPath = path.join(REPO, "data", "public-score-sources", "etude-import-result.json");
fs.writeFileSync(outPath, `${JSON.stringify({ ok: failures.length === 0, imported: results.length, failures, entries: results }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: failures.length === 0, imported: results.length, failed: failures.length, failures: failures.slice(0, 5), out: path.relative(REPO, outPath).replace(/\\/g, "/") }, null, 2));
if (failures.length) process.exitCode = 1;
