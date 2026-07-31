import fs from "node:fs";
import path from "node:path";

// Merges the imported etude entries into the public library registry.
//
// Every entry keeps its typesetter credit, licence and source URL: all three
// books are CC BY-SA engravings of public-domain music, so the derived
// MusicXML and renders inherit the share-alike terms. Dropping the attribution
// here would make the library non-compliant, not merely impolite.
//
//   node scripts/merge-etude-entries-into-registry.mjs
const REPO = process.cwd();
const REGISTRY = path.join(REPO, "data", "public-score-library", "registry.json");
const RESULT = path.join(REPO, "data", "public-score-sources", "etude-import-result.json");

const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
const result = JSON.parse(fs.readFileSync(RESULT, "utf8"));

const existing = new Map(registry.entries.map((entry) => [entry.pieceId, entry]));
let added = 0;
let updated = 0;

for (const row of result.entries) {
  const entry = {
    catalogSource: "lilypond-source-transcode",
    pieceId: row.pieceId,
    editionId: row.editionId,
    group: row.group,
    workId: "",
    workTitle: row.group,
    movementNumber: 0,
    movement: "",
    title: row.title,
    composer: row.composer,
    meta: `共${row.pageCount}页`,
    musicxmlPath: row.musicxmlPath,
    musicxmlSha256: row.musicxmlSha256,
    renderPaths: row.renderPaths,
    renderSha256: row.renderSha256,
    pageCount: row.pageCount,
    licenseStatus: row.licenseStatus,
    licenseName: row.licenseName,
    sourceLabel: row.sourceLabel,
    sourceUrl: row.sourceUrl,
    attribution: row.attribution,
    sortOrder: 0,
    scoreId: row.scoreId,
    coordinateSidecarPath: row.coordinateSidecarPath,
    coordinateSidecarSha256: row.coordinateSidecarSha256,
    libraryCategory: "exercise",
  };
  if (existing.has(row.pieceId)) {
    Object.assign(existing.get(row.pieceId), entry);
    updated += 1;
  } else {
    registry.entries.push(entry);
    added += 1;
  }
}

const sources = new Map((registry.sources || []).map((source) => [source.url, source]));
for (const source of [
  {
    name: "Sitt Op.32 Book 1 LilyPond source, Mutopia Project #929",
    url: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=929",
    license: "CC BY-SA 2.5; typeset by Mutopia Project contributors",
  },
  {
    name: "Kayser Op.20 LilyPond engraving files, IMSLP #458908",
    url: "https://imslp.org/wiki/36_Violin_Studies,_Op.20_(Kayser,_Heinrich_Ernst)",
    license: "CC BY-SA 4.0; typeset by Philipp Büttgenbach",
  },
  {
    name: "Wohlfahrt Op.45 LilyPond engraving files, IMSLP #449577",
    url: "https://imslp.org/wiki/60_Studies_for_the_Violin,_Op.45_(Wohlfahrt,_Franz)",
    license: "CC BY-SA 4.0; typeset by Philipp Büttgenbach",
  },
]) {
  if (!sources.has(source.url)) registry.sources.push(source);
}

// Pieces whose coordinates could not be verified stay out of the library and
// are recorded here, so the gap is visible rather than looking like an
// oversight.
const plan = JSON.parse(fs.readFileSync(path.join(REPO, "data", "public-score-sources", "etude-import-plan.json"), "utf8"));
registry.quarantined = plan.skipped;
registry.generatedAt = new Date().toISOString();

fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

const analyzable = registry.entries.filter((entry) => entry.scoreId).length;
console.log(JSON.stringify({
  ok: true,
  added,
  updated,
  totalEntries: registry.entries.length,
  analyzableEntries: analyzable,
  quarantined: registry.quarantined.length,
}, null, 2));
