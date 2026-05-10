from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from clean_basic_pitch_midi import clean_midi
from metrics import evaluate
from run_manifest import _path
from score_io import read_notes
from sihsm_extract import Config, estimate_pitch, extract_file, load_audio
from sihsm_posterior import cents


def _stats(path):
    notes = read_notes(path)
    pitches = [n.midi for n in notes]
    return {"notes": len(notes), "minMidi": min(pitches) if pitches else "", "maxMidi": max(pitches) if pitches else ""}


def _oracle_score(target, out_path, instrument):
    import json
    import numpy as np
    y, sr = load_audio(target)
    frames = np.arange(0, len(y) / sr, 0.02)
    freqs, confs = estimate_pitch(y, sr, frames, instrument)
    notes, start, last_midi = [], None, None
    for t, f, c in zip(frames, freqs, confs):
        midi = int(round(69 + 12 * np.log2(f / 440.0))) if f > 0 and c > 0.12 else None
        if midi == last_midi or (midi and last_midi and abs(cents(440 * 2 ** ((midi - 69) / 12), 440 * 2 ** ((last_midi - 69) / 12))) < 40):
            continue
        if last_midi is not None and start is not None and t - start >= 0.05:
            notes.append({"onset": float(start), "duration": float(t - start), "midi": int(last_midi)})
        start, last_midi = (float(t), midi) if midi is not None else (None, None)
    if last_midi is not None and start is not None:
        notes.append({"onset": float(start), "duration": float(len(y) / sr - start), "midi": int(last_midi)})
    Path(out_path).write_text(json.dumps({"notes": notes}, ensure_ascii=False), encoding="utf-8")
    return str(out_path)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--contains", default="良宵")
    p.add_argument("--subset", default="piano_medium")
    p.add_argument("--score-weight", type=float, default=0.4)
    p.add_argument("--manual-score")
    args = p.parse_args()
    manifest = Path(args.manifest)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    item = next(x for x in data["items"] if args.contains in x["itemId"] and x["subset"] == args.subset)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    scores = {"basic_pitch": _path(manifest.parent, item, "scorePath")}
    cleaned = out / "liangxiao_cleaned.mid"
    clean_info = clean_midi(scores["basic_pitch"], cleaned)
    scores["cleaned"] = str(cleaned)
    scores["oracle_target_pitch"] = _oracle_score(_path(manifest.parent, item, "targetPath"), out / "liangxiao_oracle_target_pitch.json", item["instrument"])
    if args.manual_score:
        scores["manual"] = args.manual_score
    rows = []
    mix = _path(manifest.parent, item, "mixturePath")
    target = _path(manifest.parent, item, "targetPath")
    accomp = _path(manifest.parent, item, "accompanimentPath")
    for label, score in scores.items():
        est = extract_file(mix, score, out / label, item["instrument"], "full", item.get("targetPart"), Config(trace_stride=64, score_weight=args.score_weight))["outputPath"]
        rows.append({"score": label, "scoreWeight": args.score_weight, **_stats(score), **evaluate(est, target, accomp, item["instrument"])})
    with (out / "score-quality-contrast.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    lines = ["| Score | Notes | MIDI range | SI-SDR | SIR | SAR | Pitch@50c |", "|---|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        lines.append(f"| {r['score']} | {r['notes']} | {r['minMidi']}-{r['maxMidi']} | {r['SI_SDR']:.3f} | {r['SIR']:.3f} | {r['SAR']:.3f} | {r['pitchAccuracy50c']:.3f} |")
    (out / "score-quality-contrast.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "itemId": item["itemId"], "cleanInfo": clean_info, "csv": str(out / "score-quality-contrast.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
