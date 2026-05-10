from __future__ import annotations

import argparse
from pathlib import Path

import pretty_midi


def clean_notes(notes, lo: int = 55, hi: int = 93, min_dur: float = 0.05, merge_gap: float = 0.12):
    rows = [n for n in notes if min_dur <= n.end - n.start and lo <= n.pitch <= hi]
    rows.sort(key=lambda n: (n.start, n.pitch))
    fixed = []
    for note in rows:
        if fixed:
            anchor = sorted(n.pitch for n in fixed[-5:])[len(fixed[-5:]) // 2]
            choices = [p for p in (note.pitch - 12, note.pitch, note.pitch + 12) if lo <= p <= hi]
            note.pitch = min(choices, key=lambda p: abs(p - anchor))
        if fixed and fixed[-1].pitch == note.pitch and note.start - fixed[-1].end <= merge_gap:
            fixed[-1].end = max(fixed[-1].end, note.end)
            fixed[-1].velocity = max(fixed[-1].velocity, note.velocity)
        else:
            fixed.append(pretty_midi.Note(note.velocity, note.pitch, note.start, note.end))
    return fixed


def clean_midi(src: str | Path, dst: str | Path) -> dict:
    midi = pretty_midi.PrettyMIDI(str(src))
    notes = [n for inst in midi.instruments if not inst.is_drum for n in inst.notes]
    cleaned = clean_notes(notes)
    out = pretty_midi.PrettyMIDI(initial_tempo=midi.estimate_tempo())
    inst = pretty_midi.Instrument(program=40, name="cleaned_erhu")
    inst.notes = cleaned
    out.instruments.append(inst)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    out.write(str(dst))
    pitches = [n.pitch for n in cleaned]
    return {"inputNotes": len(notes), "cleanedNotes": len(cleaned), "minMidi": min(pitches) if pitches else None, "maxMidi": max(pitches) if pitches else None}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--dst", required=True)
    print(clean_midi(**vars(p.parse_args())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
