from __future__ import annotations

import argparse
import json
from pathlib import Path

STEP = {"1": 0, "2": 2, "3": 4, "4": 5, "5": 7, "6": 9, "7": 11}
KEY = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _token(raw: str) -> tuple[str, float]:
    body, _, weight = raw.partition(":")
    return body.strip(), float(weight or 1.0)


def _midi(token: str, key: str, octave: int) -> int | None:
    if token in {"0", "-"}:
        return None
    degree = token[0]
    if degree not in STEP:
        raise ValueError(f"bad jianpu token: {token}")
    up = token.count("'")
    down = token.count(",")
    return (octave + up - down + 1) * 12 + KEY[key.upper()] + STEP[degree]


def parse_jianpu(text: str, key: str = "D", octave: int = 4, bpm: float = 66.0, beats_per_measure: float = 2.0) -> list[dict]:
    sec_per_beat = 60.0 / bpm
    notes: list[dict] = []
    now = 0.0
    for mi, measure in enumerate(text.replace("\n", " ").split("|"), 1):
        toks = [_token(t) for t in measure.split() if t.strip()]
        if not toks:
            continue
        total = sum(w for _, w in toks)
        unit = beats_per_measure * sec_per_beat / max(total, 1e-9)
        for ni, (tok, weight) in enumerate(toks, 1):
            dur = weight * unit
            midi = _midi(tok, key, octave)
            if tok == "-" and notes:
                notes[-1]["duration"] += dur
            elif midi is not None:
                notes.append({"onset": now, "duration": dur, "midi": midi, "noteId": f"m{mi}-n{ni}"})
            now += dur
    return notes


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--key", default="D")
    p.add_argument("--octave", type=int, default=4)
    p.add_argument("--bpm", type=float, default=66.0)
    p.add_argument("--beats-per-measure", type=float, default=2.0)
    args = p.parse_args()
    notes = parse_jianpu(args.text, args.key, args.octave, args.bpm, args.beats_per_measure)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"notes": notes}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "notes": len(notes), "duration": notes[-1]["onset"] + notes[-1]["duration"] if notes else 0, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
