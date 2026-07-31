import fs from "node:fs";
import path from "node:path";

// Builds the import plan for the LilyPond-sourced etude books.
//
// Attribution is not decoration here: all three books are CC BY-SA typesets of
// public-domain music, so every entry has to carry the typesetter credit, the
// licence and the source URL through into the library registry. The music is
// public domain; the engraving is not.
//
//   node scripts/build-etude-import-plan.mjs > data/public-score-sources/etude-import-plan.json
const REPO = process.cwd();

const BOOKS = [
  {
    prefix: "sitt-op32-book1",
    coordsRoot: "data/public-score-sources/sitt-op32/coords",
    midiRoot: "data/public-score-sources/sitt-op32/solo-midi",
    editionId: "mutopia-cc-by-sa-2.5",
    group: "西特 Op.32 · 第一册（第一把位 No.1–20）",
    composer: "汉斯·西特",
    titleFor: (n) => `西特 Op.32 No.${n}`,
    licenseName: "CC BY-SA 2.5",
    sourceLabel: "Mutopia Project #929",
    sourceUrl: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=929",
    attribution: "Typeset by the Mutopia Project contributors; licensed CC BY-SA 2.5. Music by Hans Sitt is public domain.",
  },
  {
    prefix: "kayser-op20",
    coordsRoot: "data/public-score-sources/kayser-op20/coords",
    midiRoot: "data/public-score-sources/kayser-op20/solo-midi",
    editionId: "buettgenbach-cc-by-sa-4.0",
    group: "开塞 Op.20 · 36首小提琴练习曲",
    composer: "海因里希·恩斯特·开塞",
    titleFor: (n) => `开塞 Op.20 No.${n}`,
    licenseName: "CC BY-SA 4.0",
    sourceLabel: "IMSLP #458908 (engraving files)",
    sourceUrl: "https://imslp.org/wiki/36_Violin_Studies,_Op.20_(Kayser,_Heinrich_Ernst)",
    attribution: "Engraved by Philipp Büttgenbach; licensed CC BY-SA 4.0. Music by H. E. Kayser is public domain.",
  },
  {
    prefix: "wohlfahrt-op45",
    coordsRoot: "data/public-score-sources/wohlfahrt-op45/coords",
    midiRoot: "data/public-score-sources/wohlfahrt-op45/solo-midi",
    editionId: "buettgenbach-cc-by-sa-4.0",
    group: "沃尔法特 Op.45 · 60首小提琴练习曲",
    composer: "弗朗茨·沃尔法特",
    titleFor: (n) => `沃尔法特 Op.45 No.${n}`,
    licenseName: "CC BY-SA 4.0",
    sourceLabel: "IMSLP #449577 (engraving files)",
    sourceUrl: "https://imslp.org/wiki/60_Studies_for_the_Violin,_Op.45_(Wohlfahrt,_Franz)",
    attribution: "Engraved by Philipp Büttgenbach; licensed CC BY-SA 4.0. Music by Franz Wohlfahrt is public domain.",
  },
];

const pieces = [];
const skipped = [];
for (const book of BOOKS) {
  const root = path.join(REPO, book.coordsRoot);
  if (!fs.existsSync(root)) { skipped.push({ book: book.prefix, reason: "coords root missing" }); continue; }
  for (const dir of fs.readdirSync(root).sort()) {
    const coordinatesDir = path.join(book.coordsRoot, dir);
    const sidecar = path.join(REPO, coordinatesDir, "coordinates.json");
    const musicxml = path.join(coordinatesDir, "score.musicxml");
    if (!fs.existsSync(sidecar)) { skipped.push({ pieceId: dir, reason: "no coordinates.json" }); continue; }
    if (!fs.existsSync(path.join(REPO, musicxml))) { skipped.push({ pieceId: dir, reason: "no musicxml" }); continue; }
    // Only entries whose coordinates were verified against the MIDI are
    // publishable. An unverified sidecar would highlight the wrong note on the
    // page for every student who ever opens the piece, silently, so a failed
    // check quarantines the entry instead of shipping it.
    const sidecarJson = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    if (!sidecarJson.verification?.passed) {
      skipped.push({
        pieceId: dir,
        reason: "coordinate verification failed",
        midiNotes: sidecarJson.verification?.midiNotes,
        noteheads: sidecarJson.verification?.noteheads,
        correlation: sidecarJson.verification?.worstSystemPitchYCorrelation,
      });
      continue;
    }
    const number = Number.parseInt(dir.slice(dir.lastIndexOf("-no") + 3), 10);
    pieces.push({
      pieceId: dir,
      editionId: book.editionId,
      title: book.titleFor(number),
      group: book.group,
      composer: book.composer,
      coordinatesDir,
      musicxml,
      licenseName: book.licenseName,
      sourceLabel: book.sourceLabel,
      sourceUrl: book.sourceUrl,
      attribution: book.attribution,
    });
  }
}

// Written directly rather than piped: a PowerShell redirect adds a BOM, which
// makes the plan unparseable for the importer that reads it back.
const outPath = path.join(REPO, "data", "public-score-sources", "etude-import-plan.json");
fs.writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), pieces, skipped }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, pieces: pieces.length, skipped: skipped.length, out: path.relative(REPO, outPath).replace(/\\/g, "/") }, null, 2));
