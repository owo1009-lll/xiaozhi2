from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from metrics import evaluate
from score_io import Note, read_notes
from sihsm_extract import Config, extract_file, load_audio, write_audio
from validate_manifest import validate

METHODS = ("mixture", "hpss", "score_only", "pitch_only", "full")
ALPHA_BY_SCORE_SOURCE = {"auto_transcribed": 4.0, "manual_aligned": 0.5, "oracle": 0.0, "unknown": 4.0}


def _path(base: Path, item: dict, key: str) -> str | None:
    value = item.get(key)
    if not value:
        return None
    path = Path(value)
    if path.is_absolute() or path.exists():
        return str(path)
    return str((base / path).resolve())


def _perturb(notes: list[Note], kind: str, value: float) -> list[Note]:
    if kind == "shift":
        return [Note(n.onset + value, n.duration, n.midi, n.note_id, n.part) for n in notes]
    step = max(1, round(100 / max(value, 1))) if value else 10**9
    out = []
    for i, n in enumerate(notes):
        if kind == "missing" and i % step == 0:
            continue
        drift = (1 if (i // step) % 2 == 0 else -1) if kind == "drift" and i % step == 0 else 0
        midi = n.midi + drift + (12 if kind == "octave" and i % step == 0 else 0)
        out.append(Note(n.onset, n.duration, midi, n.note_id, n.part))
    return out


def _oracle(item, base: Path, out_dir: Path, binary: bool):
    import numpy as np
    from scipy import signal
    from sihsm_extract import Config, _istft, _stft
    target, sr = load_audio(_path(base, item, "targetPath"))
    accomp, _ = load_audio(_path(base, item, "accompanimentPath"))
    n = min(len(target), len(accomp))
    target, accomp = target[:n], accomp[:n]
    cfg = Config()
    _, _, st = _stft(target, sr, cfg)
    _, _, sa = _stft(accomp, sr, cfg)
    mt = np.abs(st)
    ma = np.abs(sa)
    mask = (mt >= ma).astype(float) if binary else mt / (mt + ma + 1e-9)
    wav = out_dir / ("oracle_ibm.wav" if binary else "oracle_irm.wav")
    write_audio(wav, _istft((st + sa) * mask, sr, cfg, n), sr)
    return str(wav)


def _cfg(args, item: dict) -> Config:
    alpha = ALPHA_BY_SCORE_SOURCE.get(item.get("scoreSource", "unknown"), 4.0) if args.score_source_aware else args.reliability_alpha
    return Config(
        bandwidth_cents=args.bandwidth_cents,
        residual=args.residual,
        score_weight=args.score_weight,
        reliability_gating=args.reliability_gating or args.score_source_aware,
        reliability_alpha=alpha,
        score_branch_mode=args.score_branch_mode,
        detector_policy=args.detector_policy,
        score_admission_threshold=args.score_admission_threshold,
    )


def run_item(item: dict, base: Path, out_root: Path, methods: list[str], robustness: bool, args) -> list[dict]:
    rows, item_dir = [], out_root / item["itemId"]
    mix, score = _path(base, item, "mixturePath"), _path(base, item, "scorePath")
    target, accomp = _path(base, item, "targetPath"), _path(base, item, "accompanimentPath")
    objective = item.get("gtStatus") in {"clean_stems", "synthetic_mix", "target_only"} and target
    mixture_metrics = evaluate(mix, target, accomp, item["instrument"]) if objective else {}
    for method in methods:
        out_dir = item_dir / method
        out_dir.mkdir(parents=True, exist_ok=True)
        if method == "mixture":
            est = mix
        else:
            est = extract_file(mix, score, out_dir, item["instrument"], method, item.get("targetPart"), _cfg(args, item))["outputPath"]
        row = {"itemId": item["itemId"], "instrument": item["instrument"], "subset": item["subset"], "method": method, "scoreSource": item.get("scoreSource", ""), "status": "ok", "estimatePath": est}
        if objective:
            row.update(evaluate(est, target, accomp, item["instrument"]))
            row["mixtureSI_SDR"] = mixture_metrics.get("SI_SDR")
        rows.append(row)
    if objective and accomp and args.oracle != "none":
        for method, binary in (("oracle_irm", False), ("oracle_ibm", True)):
            if args.oracle != "both" and method != f"oracle_{args.oracle}":
                continue
            est = _oracle(item, base, item_dir / method, binary)
            rows.append({"itemId": item["itemId"], "instrument": item["instrument"], "subset": item["subset"], "method": method, "scoreSource": item.get("scoreSource", ""), "status": "ok", "estimatePath": est, "mixtureSI_SDR": mixture_metrics.get("SI_SDR"), **evaluate(est, target, accomp, item["instrument"])})
    if robustness:
        notes = read_notes(score, item.get("targetPart"))
        for kind, values in {"shift": [0, 0.5, 1, 2, 3], "missing": [10, 20], "drift": [10, 20], "octave": [10, 20]}.items():
            for value in values:
                method = f"robust_{kind}_{value}"
                est = extract_file(mix, score, item_dir / method, item["instrument"], "full", item.get("targetPart"), _cfg(args, item), notes=_perturb(notes, kind, float(value)))["outputPath"]
                row = {"itemId": item["itemId"], "instrument": item["instrument"], "subset": item["subset"], "method": method, "scoreSource": item.get("scoreSource", ""), "status": "ok", "estimatePath": est}
                if objective:
                    row.update(evaluate(est, target, accomp, item["instrument"]))
                    row["mixtureSI_SDR"] = mixture_metrics.get("SI_SDR")
                rows.append(row)
    return rows


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--methods", default=",".join(METHODS))
    p.add_argument("--robustness", action="store_true")
    p.add_argument("--score-weight", type=float, default=1.0)
    p.add_argument("--reliability-gating", action="store_true")
    p.add_argument("--reliability-alpha", type=float, default=1.0)
    p.add_argument("--score-source-aware", action="store_true")
    p.add_argument("--score-branch-mode", choices=["always", "conditional", "none"], default="always")
    p.add_argument("--detector-policy", choices=["posterior", "raw"], default="posterior")
    p.add_argument("--bandwidth-cents", type=float, default=38.0)
    p.add_argument("--residual", type=float, default=0.05)
    p.add_argument("--score-admission-threshold", type=float, default=0.6)
    p.add_argument("--oracle", choices=["none", "irm", "ibm", "both"], default="both")
    args = p.parse_args()
    manifest = Path(args.manifest)
    errors = validate(manifest, strict_paths=True)
    if errors:
        print(json.dumps({"ok": False, "errors": errors}, ensure_ascii=False, indent=2)); return 1
    data = json.loads(manifest.read_text(encoding="utf-8"))
    rows = []
    for item in data["items"]:
        rows.extend(run_item(item, manifest.parent, Path(args.out_dir), [m for m in args.methods.split(",") if m], args.robustness, args))
    keys = sorted({k for row in rows for k in row})
    Path(args.out_dir).mkdir(parents=True, exist_ok=True)
    with (Path(args.out_dir) / "results.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, keys); writer.writeheader(); writer.writerows(rows)
    print(json.dumps({"ok": True, "rows": len(rows), "results": str(Path(args.out_dir) / "results.csv")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
