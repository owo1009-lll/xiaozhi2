# Teacher manual-anchor short samples (Plan C)

Long-recording **automatic** section alignment is shelved as a known limitation
(pure chroma-DTW scatters; coarse grouping is ordered-but-wrong on real mixes — see
`scripts/experiments/align-piece-coarse-sections-experiment.py`). Plan C instead
sources teacher-labeling samples from **human-anchored** short windows: a person
listens, marks the start/end of a clean erhu passage, notes the matching score
location, and confirms the audio matches the score. That human verification is the
alignment evidence — stronger than any automatic check — so these samples carry the
trusted `scanMode: "manual-anchor"`.

One 6–10 min piece yields many valid short samples (≈6–10 each), so 3–5 pieces can
reach the 30+ candidate target — while covering multiple pieces so the evidence is
not one piece sliced thin.

## Workflow

1. Pick a clear erhu melody passage in a recording (aim for 20–60 s).
2. Listen and mark the audio start/end seconds.
3. Note the matching score location: page, measure range, and a phrase note.
4. Confirm the audio actually matches that score location (`humanMatched = yes`).
5. Add a row to the manifest (below). Only `humanMatched = yes` rows are used.
6. Run the generator (next milestone) to produce teacher-backend samples.
7. The teacher's FIRST judgement is still "does it match" — a mismatch is excluded.

## Manifest

A CSV at `data/teacher-manual-anchors/manifest.csv` (the `data/` tree is gitignored;
this is your input, version it separately if needed). One row per anchored window.

| column | required | meaning |
|---|---|---|
| `pieceTitle` | yes | Human-readable piece name (display). |
| `sourceLongPiece` | yes | Which recording/piece this slice came from (provenance for reporting "片段数 vs 曲目数"). |
| `sourceAudioPath` | yes | Path to the source recording (repo-relative). |
| `scorePdfPath` | yes | Path to the score PDF (repo-relative). |
| `scoreId` | yes | scoreId in `data/erhu-score-imports.json` (gives the section notes/positions). |
| `audioStartSeconds` | yes | Window start in the recording. |
| `audioEndSeconds` | yes | Window end (keep 20–60 s). |
| `scorePage` | yes | Score page number for the passage. |
| `measureRange` | yes | e.g. `12-19` (printed measure numbers, NOT raw OMR measureIndex — those inflate on 散板/free-rhythm). |
| `phraseNote` | no | Free text, e.g. "散板引子" / "主题第一句". |
| `humanMatched` | yes | `yes` once you have confirmed audio↔score; anything else is skipped. |

### Example row

```csv
pieceTitle,sourceLongPiece,sourceAudioPath,scorePdfPath,scoreId,audioStartSeconds,audioEndSeconds,scorePage,measureRange,phraseNote,humanMatched
第二号狂想曲,second-rhapsody,data/real-tests/originals/second-rhapsody-full.mp3,data/score-imports/scorejob-momnhibn-4ha9k0/source.pdf,score-moef6aiw-f1evny,0.0,52.0,1,1-2,散板引子,yes
```

## Trust model (teacher-ready gate)

`scanMode: "manual-anchor"` is in the trusted allowlist. For it the gate WAIVES the
automatic alignment checks (duration/span ratio, window overlap, content-path
monotonicity/coverage) and the `no-system-findings` check (these are
technique-labeling samples the teacher labels from scratch, not system-finding
validations). The waiver is sound only because the generator emits `manual-anchor`
ONLY for `humanMatched = yes` rows. Kept in sync in both
`src/server/teacherValidationService.js` and `scripts/teacher-validation-support.mjs`.

## Status

- Gate support for `manual-anchor`: DONE (this milestone).
- Generator (`manifest -> teacher-backend samples`): NEXT — reads the manifest, cuts
  each audio window, attaches the score locator, and builds a technique-labeling pack
  via the existing `buildTeacherValidationPack`. No analyzer required.
