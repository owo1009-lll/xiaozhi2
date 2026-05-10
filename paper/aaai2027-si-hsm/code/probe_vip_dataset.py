from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from metrics import evaluate, si_sdr
from score_io import Note, notes_as_dicts, read_notes
from sihsm_extract import extract_file, load_audio, write_audio


def _item_id(name: str) -> str:
    return name.replace("张咏音 - ", "").replace("_basic_pitch", "").replace(" ", "-")


def _clip_notes(notes: list[Note], seconds: float) -> list[Note]:
    return [Note(n.onset, min(n.duration, max(0.0, seconds - n.onset)), n.midi, n.note_id, n.part) for n in notes if n.onset < seconds]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--seconds", type=float, default=20.0)
    args = p.parse_args()
    root, out = Path(args.dir), Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest, rows = {"schemaVersion": 1, "items": []}, []
    for mid in sorted(root.glob("*_basic_pitch.mid")):
        stem = mid.name.replace("_basic_pitch.mid", "")
        mp3, ncm = root / f"{stem}.mp3", root / f"{stem}.ncm"
        if not mp3.exists():
            continue
        item_id = _item_id(stem)
        item = {
            "itemId": item_id,
            "title": stem.replace("张咏音 - ", ""),
            "instrument": "erhu",
            "subset": "piano",
            "mixturePath": str(mp3),
            "targetPath": str(mp3),
            "scorePath": str(mid),
            "licenseStatus": "internal_only",
            "gtStatus": "target_only",
            "sourceType": "unknown",
            "evaluationUse": "objective_target",
            "notes": f"Target-only solo reference; ncm={ncm if ncm.exists() else ''}",
        }
        manifest["items"].append(item)
        y, sr = load_audio(mp3)
        notes = read_notes(mid)
        clip_n = int(min(len(y), args.seconds * sr))
        work = out / item_id
        work.mkdir(exist_ok=True)
        clip_wav, clip_score = work / "clip-target.wav", work / "clip-score.json"
        write_audio(clip_wav, y[:clip_n], sr)
        clip_score.write_text(json.dumps({"notes": notes_as_dicts(_clip_notes(notes, args.seconds))}, ensure_ascii=False), encoding="utf-8")
        result = extract_file(clip_wav, clip_score, work / "sihsm", "erhu", "full")
        m = evaluate(result["outputPath"], clip_wav, profile="erhu")
        rows.append({
            "itemId": item_id,
            "durationSeconds": round(len(y) / sr, 2),
            "sampleRate": sr,
            "midiNotes": len(notes),
            "clipSeconds": round(clip_n / sr, 2),
            "clipNotes": len(_clip_notes(notes, args.seconds)),
            "soloInputSI_SDR": round(si_sdr(y[:clip_n], y[:clip_n]), 3),
            "sihsmClipSI_SDR": round(m["SI_SDR"], 3),
            "pitchAccuracy50c": m["pitchAccuracy50c"],
            "mp3": str(mp3),
            "mid": str(mid),
        })
    (out / "vip-target-only.local.manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    with (out / "vip-data-test.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, rows[0].keys() if rows else ["itemId"])
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({"ok": True, "items": len(rows), "manifest": str(out / "vip-target-only.local.manifest.json"), "csv": str(out / "vip-data-test.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
