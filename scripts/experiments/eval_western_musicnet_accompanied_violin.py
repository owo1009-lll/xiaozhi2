from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    evaluate_tolerance,
    filter_events,
    metrics_from_counts,
)
from eval_western_strings_m0_bach10 import basic_pitch_events  # noqa: E402


DEFAULT_ROOT = (
    REPO_ROOT
    / "data"
    / "experiments"
    / "western-strings-musicnet-accompanied-violin"
)
MUSICNET_SAMPLE_RATE = 44_100.0
VIOLIN_INSTRUMENT_ID = 41
ONSET_TOLERANCES = (0.05, 0.10, 0.30)
FILTER_CONFIDENCES = (0.30, 0.35, 0.40, 0.45, 0.50)
FILTER_MIN_DURATIONS = (0.03, 0.05, 0.07, 0.09, 0.12)
GATE = {
    "precisionAt50msMin": 0.90,
    "recallAt50msMin": 0.80,
    "precisionAt100msMin": 0.90,
    "recallAt100msMin": 0.85,
}
SAMPLES = (
    {
        "id": "2330",
        "split": "development",
        "composer": "Beethoven",
        "work": "Violin Sonata No. 1 in D major, I",
        "performerSource": "Timothy Jones",
        "audioSha256": "1e8ee7cc5e96bc6f785753253dc1bfcdfef015981229612217ce1c52ffe5261a",
        "labelsSha256": "cb2ca0e5ee3378c20e46e6de4e55b59cc6527821d57de105e9559d3a6f84cf07",
    },
    {
        "id": "2334",
        "split": "holdout-unseen-performer",
        "composer": "Beethoven",
        "work": "Violin Sonata No. 8 in G major, I",
        "performerSource": "Edward Auer",
        "audioSha256": "464a3a1f0fdec6f17690b9091de2ba1d46d8646fe45ec42815f94a129a6c6bfc",
        "labelsSha256": "89af2a59173bbabbf907577c6d8d613ba63368999aa0555245b6833bd1dcac57",
    },
)
HF_REVISION = "15078b3037afe83bdcacb9cea14232e4debffd2b"
HF_BASE = f"https://huggingface.co/datasets/DreamyWanderer/MusicNet/resolve/{HF_REVISION}/data/train"
OFFICIAL_DATASET = "https://zenodo.org/records/5120004"


def download_file(url: str, destination: Path) -> None:
    if destination.is_file() and destination.stat().st_size > 0:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".partial")
    with urllib.request.urlopen(url) as response, partial.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    partial.replace(destination)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_samples(root: Path) -> None:
    raw_dir = root / "raw"
    for sample in SAMPLES:
        sample_id = str(sample["id"])
        for suffix in ("wav", "csv"):
            download_file(
                f"{HF_BASE}/{sample_id}.{suffix}",
                raw_dir / f"{sample_id}.{suffix}",
            )


def load_violin_reference_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        source_rows = [
            row
            for row in csv.DictReader(handle)
            if int(row.get("instrument") or 0) == VIOLIN_INSTRUMENT_ID
        ]
    onset_counts: dict[int, int] = {}
    for row in source_rows:
        onset = int(row["start_time"])
        onset_counts[onset] = onset_counts.get(onset, 0) + 1
    return [
        {
            "goldTime": str(int(row["start_time"]) / MUSICNET_SAMPLE_RATE),
            "goldOffset": str(int(row["end_time"]) / MUSICNET_SAMPLE_RATE),
            "midi": str(int(row["note"])),
            "doubleStop": str(onset_counts[int(row["start_time"])] >= 2).lower(),
        }
        for row in source_rows
    ]


def summarize(reference_rows: list[dict[str, str]], events: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        f"{int(round(tolerance * 1000))}ms": evaluate_tolerance(
            reference_rows,
            events,
            tolerance,
        )
        for tolerance in ONSET_TOLERANCES
    }


def aggregate(items: list[dict[str, Any]], min_confidence: float, min_duration: float) -> dict[str, Any]:
    per_sample: dict[str, Any] = {}
    counts: dict[str, list[dict[str, Any]]] = {
        f"{int(round(tolerance * 1000))}ms": [] for tolerance in ONSET_TOLERANCES
    }
    for item in items:
        filtered = filter_events(item["events"], min_confidence, min_duration)
        summary = summarize(item["referenceRows"], filtered)
        per_sample[str(item["id"])] = summary
        for key, metrics in summary.items():
            counts[key].append(metrics)

    combined: dict[str, Any] = {}
    for key, metrics_list in counts.items():
        reference = sum(int(metrics["referenceNotes"]) for metrics in metrics_list)
        estimated = sum(int(metrics["estimatedNotes"]) for metrics in metrics_list)
        matched = sum(int(metrics["matchedNotes"]) for metrics in metrics_list)
        metrics = metrics_from_counts(reference, estimated, matched)
        double_reference = 0
        double_matched = 0.0
        for item, item_metrics in zip(items, metrics_list):
            reference_double = sum(
                str(row.get("doubleStop") or "").lower() == "true"
                for row in item["referenceRows"]
            )
            recall = item_metrics.get("doubleStopRecall")
            double_reference += reference_double
            if recall is not None:
                double_matched += float(recall) * reference_double
        metrics["doubleStopReferenceNotes"] = double_reference
        metrics["doubleStopRecall"] = (
            double_matched / double_reference if double_reference else None
        )
        combined[key] = metrics
    return {"aggregate": combined, "perSample": per_sample}


def gate_checks(summary: dict[str, Any]) -> dict[str, bool]:
    strict = summary["aggregate"]["50ms"]
    tolerant = summary["aggregate"]["100ms"]
    return {
        "precisionAt50ms": (strict.get("precision") or 0.0) >= GATE["precisionAt50msMin"],
        "recallAt50ms": (strict.get("recall") or 0.0) >= GATE["recallAt50msMin"],
        "precisionAt100ms": (tolerant.get("precision") or 0.0) >= GATE["precisionAt100msMin"],
        "recallAt100ms": (tolerant.get("recall") or 0.0) >= GATE["recallAt100msMin"],
    }


def candidate_key(candidate: dict[str, Any]) -> tuple[float, ...]:
    metrics = candidate["development"]["aggregate"]["100ms"]
    checks = gate_checks(candidate["development"])
    return (
        float(sum(checks.values())),
        float(metrics.get("f1") or 0.0),
        float(metrics.get("recall") or 0.0),
        float(metrics.get("precision") or 0.0),
        -float(candidate["minConfidence"]),
        -float(candidate["minDurationSeconds"]),
    )


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# MusicNet Accompanied Violin Recognition Baseline",
            "",
            "Basic Pitch reads the full violin+piano mix. Evaluation keeps only MusicNet instrument 41 violin gold; piano predictions therefore count as target-isolation false positives.",
            "",
            f"- selectedFilter: {report['selectedFilter']}",
            f"- development: {report['development']['aggregate']}",
            f"- holdout: {report['holdout']['aggregate']}",
            f"- accompaniedViolinRecognitionReady: {str(report['accompaniedViolinRecognitionReady']).lower()}",
            f"- blockingReasons: {report['blockingReasons']}",
            "",
            "This is a two-recording public-data baseline, not student-domain or release evidence.",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate target-violin recognition on public MusicNet violin+piano mixtures."
    )
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--download", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root)
    if args.download:
        prepare_samples(root)

    items: list[dict[str, Any]] = []
    for sample in SAMPLES:
        sample_id = str(sample["id"])
        audio_path = root / "raw" / f"{sample_id}.wav"
        label_path = root / "raw" / f"{sample_id}.csv"
        if not audio_path.is_file() or not label_path.is_file():
            raise FileNotFoundError(
                f"musicnet-sample-missing:{sample_id}; rerun with --download"
            )
        audio_sha256 = sha256_file(audio_path)
        labels_sha256 = sha256_file(label_path)
        if audio_sha256 != sample["audioSha256"]:
            raise ValueError(f"musicnet-audio-sha256-mismatch:{sample_id}")
        if labels_sha256 != sample["labelsSha256"]:
            raise ValueError(f"musicnet-labels-sha256-mismatch:{sample_id}")
        items.append(
            {
                **sample,
                "referenceRows": load_violin_reference_rows(label_path),
                "events": basic_pitch_events(
                    audio_path,
                    root / "cache" / audio_sha256[:16],
                ),
            }
        )

    development_items = [item for item in items if item["split"] == "development"]
    holdout_items = [item for item in items if item["split"] == "holdout-unseen-performer"]
    candidates = []
    for min_confidence in FILTER_CONFIDENCES:
        for min_duration in FILTER_MIN_DURATIONS:
            candidates.append(
                {
                    "minConfidence": min_confidence,
                    "minDurationSeconds": min_duration,
                    "development": aggregate(
                        development_items,
                        min_confidence,
                        min_duration,
                    ),
                }
            )
    selected = max(candidates, key=candidate_key)
    holdout = aggregate(
        holdout_items,
        float(selected["minConfidence"]),
        float(selected["minDurationSeconds"]),
    )
    checks = gate_checks(holdout)
    ready = all(checks.values())
    report = {
        "schemaVersion": "western-musicnet-accompanied-violin-v1",
        "generatedFrom": "public MusicNet accompanied-violin recordings",
        "officialDataset": OFFICIAL_DATASET,
        "downloadMirror": "https://huggingface.co/datasets/DreamyWanderer/MusicNet",
        "downloadMirrorRevision": HF_REVISION,
        "datasetLicense": "CC-BY-4.0 at the MusicNet Zenodo record; preserve per-recording provenance from musicnet_metadata.csv",
        "evidenceType": "independent-full-mix-audio-event-recognition-against-instrument-labelled-note-gold",
        "targetInstrument": {"musicNetInstrumentId": VIOLIN_INSTRUMENT_ID, "name": "violin"},
        "samples": [
            {
                key: value
                for key, value in sample.items()
                if key not in {"referenceRows", "events"}
            }
            for sample in items
        ],
        "selectionDiscipline": "select one of 25 filters on MusicNet 2330 only; freeze it before evaluating MusicNet 2334 from an unseen performer source",
        "candidateCount": len(candidates),
        "selectedFilter": {
            "minConfidence": selected["minConfidence"],
            "minDurationSeconds": selected["minDurationSeconds"],
        },
        "gate": GATE,
        "development": selected["development"],
        "holdout": holdout,
        "holdoutGateChecks": checks,
        "accompaniedViolinRecognitionReady": ready,
        "studentReleaseEligible": False,
        "blockingReasons": [] if ready else ["musicnet-accompanied-violin-recognition-gate-failed"],
        "caveats": [
            "The baseline intentionally performs no source separation, so piano note events in the shared violin range remain false positives.",
            "Two professional recordings are sufficient to expose the domain gap, not to authorize student-facing accompanied performance feedback.",
            "MusicNet labels are score-aligned and musician-verified; the dataset authors estimate about 4% residual label error.",
        ],
    }
    root.mkdir(parents=True, exist_ok=True)
    (root / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (root / "report.md").write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
