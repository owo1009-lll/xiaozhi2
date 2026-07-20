from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import subprocess
import warnings
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import cv2
import numpy as np
from PIL import Image

from audit_western_m4_clean_structure_failures import parse_measure_info
from eval_western_strings_m4_omr_benchmark import Note, align_notes, parse_notes, safe_rate


REPO = Path(__file__).resolve().parents[2]
NOTE_AUDIT = REPO / "data/experiments/western-strings-m4/render-gold-omr/render-gold-note-level-audit.json"
ATTRIBUTION = REPO / "data/experiments/western-strings-m4/clean-failure-modes/structure-attribution.json"
OUTPUT_ROOT = REPO / "data/experiments/western-strings-m4/perfect-observation-upper-bound"
RENDERER = REPO / "scripts/experiments/render_western_m4_perfect_observation_masks.mjs"
MASK_NAMES = ("staff", "symbols", "stems_rests", "notehead", "clefs_keys")
DRAWABLE_TAGS = {"path", "use", "ellipse", "circle", "rect", "polygon", "polyline", "line", "text"}
SEMANTIC_CLASSES = {
    "notehead": {"notehead"},
    "stems_rests": {"stem", "rest", "barLine"},
    "clefs_keys": {"clef", "keySig", "keyAccid"},
    "symbols": {
        "notehead", "stem", "beam", "flag", "dots", "barLine", "rest",
        "clef", "keySig", "keyAccid", "accid", "meterSig", "artic", "tie",
        "slur", "trill", "fermata", "ledgerLines",
    },
}
ONSET_TOLERANCE_QUARTERS = 0.25
STRICT_THRESHOLD = 0.95
STOP_LOSS_TARGET = 0.80
TARGET_PIXELS = 3_675_000
MASK_WHITE_THRESHOLD = 250


def portable(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def keep_drawable(layer_name: str, ancestors: list[set[str]]) -> bool:
    if layer_name == "staff":
        return bool(ancestors and "staff" in ancestors[-1])
    selected = SEMANTIC_CLASSES[layer_name]
    return any(classes & selected for classes in ancestors)


def semantic_mask_svg(source: bytes, layer_name: str) -> bytes:
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    root = ET.fromstring(source)
    inner = next(
        (
            row
            for row in root.iter()
            if local(str(row.tag)) == "svg"
            and "definition-scale" in str(row.attrib.get("class") or "").split()
        ),
        None,
    )
    if inner is None:
        raise ValueError("definition-scale-svg-missing")

    def prune(parent: ET.Element, ancestors: list[set[str]]) -> None:
        parent_classes = set(str(parent.attrib.get("class") or "").split())
        next_ancestors = [*ancestors, parent_classes]
        for child in list(parent):
            if local(str(child.tag)) in DRAWABLE_TAGS:
                if not keep_drawable(layer_name, next_ancestors):
                    parent.remove(child)
                continue
            prune(child, next_ancestors)

    prune(inner, [])
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def target_size(size: tuple[int, int]) -> tuple[int, int]:
    width, height = size
    ratio = math.sqrt(TARGET_PIXELS / (width * height))
    return round(width * ratio), round(height * ratio)


def build_mask_manifest(note_audit: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for source in note_audit["rows"]:
        if source.get("status") != "ok":
            continue
        piece_id = source["piece"]
        piece_root = REPO / "data/experiments/western-strings-m4/render-gold-omr" / piece_id
        for page_index, svg_path in enumerate(sorted((piece_root / "render").glob("page-*.svg")), start=1):
            width, height = target_size(Image.open(svg_path.with_suffix(".png")).size)
            mask_root = OUTPUT_ROOT / "masks" / piece_id / f"page-{page_index:02d}"
            rows.append(
                {
                    "pieceId": piece_id,
                    "page": page_index,
                    "svgPath": str(svg_path),
                    "svgSha256": sha256(svg_path),
                    "width": width,
                    "height": height,
                    "outputs": {
                        name: str(mask_root / f"{name}.png") for name in MASK_NAMES
                    },
                    "maskSvgs": {
                        name: str(mask_root / f"{name}.svg") for name in MASK_NAMES
                    },
                }
            )
    return {
        "contract": "western-m4-perfect-observation-mask-manifest-v1",
        "targetPixels": TARGET_PIXELS,
        "rows": rows,
    }


def render_masks(manifest: dict[str, Any]) -> Path:
    manifest_path = OUTPUT_ROOT / "mask-manifest.json"
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    for row in manifest["rows"]:
        source = Path(row["svgPath"]).read_bytes()
        for name in MASK_NAMES:
            mask_svg = Path(row["maskSvgs"][name])
            mask_svg.parent.mkdir(parents=True, exist_ok=True)
            mask_svg.write_bytes(semantic_mask_svg(source, name))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = subprocess.run(
        ["node", str(RENDERER), str(manifest_path)],
        cwd=REPO,
        text=True,
        capture_output=True,
        timeout=900,
    )
    if result.returncode != 0:
        raise RuntimeError(f"mask-render-failed:{result.stderr[-500:]}")
    return manifest_path


def load_binary(path: Path) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(path.read_bytes(), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"mask-unreadable:{path}")
    return np.where(image < MASK_WHITE_THRESHOLD, 1, 0).astype(np.uint8)


def staff_line_bands(staff_mask: np.ndarray) -> list[list[int]]:
    active = np.where(np.count_nonzero(staff_mask, axis=1) >= staff_mask.shape[1] * 0.1)[0]
    bands: list[list[int]] = []
    for value in active:
        if not bands or value > bands[-1][-1] + 1:
            bands.append([int(value)])
        else:
            bands[-1].append(int(value))
    return bands


def perfect_staff_groups(staff_mask: np.ndarray) -> list[list[list[int]]]:
    bands = staff_line_bands(staff_mask)
    centres = [sum(band) / len(band) for band in bands]
    if len(centres) < 5 or len(centres) % 5:
        raise ValueError(f"perfect-staff-line-count-invalid:{len(centres)}")
    groups = [bands[index : index + 5] for index in range(0, len(bands), 5)]
    for group in groups:
        gaps = [
            sum(right) / len(right) - sum(left) / len(left)
            for left, right in zip(group, group[1:])
        ]
        if max(gaps) > min(gaps) * 1.25:
            raise ValueError(f"perfect-staff-interline-inconsistent:{gaps}")
    return groups


def build_perfect_staffs(staff_mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    from oemer.staffline_extraction import Line, LineLabel, Staff, init_zones

    staffs = []
    for group_index, bands in enumerate(perfect_staff_groups(staff_mask)):
        staff = Staff()
        for line_index, band in enumerate(bands):
            line = Line()
            ys, xs = np.where(staff_mask[band, :] > 0)
            for relative_y, x in zip(ys, xs):
                line.add_point(band[int(relative_y)], int(x))
            line.label = LineLabel(line_index)
            staff.add_line(line)
        staff.track = 0
        staff.group = group_index
        staffs.append(staff)
    zones, *_ = init_zones(staff_mask, splits=8)
    return np.array([staffs], dtype=object), zones


def decode_page(source_image: Path, masks: dict[str, Path], output_path: Path) -> dict[str, Any]:
    from oemer import layers
    from oemer.build_system import MusicXMLBuilder
    from oemer.ete import clear_data, register_note_id
    from oemer.note_group_extraction import extract as group_extract
    from oemer.notehead_extraction import extract as note_extract
    from oemer.rhythm_extraction import extract as rhythm_extract
    from oemer.symbol_extraction import extract as symbol_extract

    clear_data()
    data = {name: load_binary(path) for name, path in masks.items()}
    shape = data["staff"].shape
    if any(row.shape != shape for row in data.values()):
        raise ValueError("perfect-mask-shape-mismatch")
    original = cv2.imdecode(np.frombuffer(source_image.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)
    if original is None:
        raise ValueError("source-image-unreadable")
    original = cv2.resize(original, (shape[1], shape[0]))
    symbols = np.maximum.reduce([data["symbols"], data["clefs_keys"], data["stems_rests"]])
    layers.register_layer("stems_rests_pred", data["stems_rests"])
    layers.register_layer("clefs_keys_pred", data["clefs_keys"])
    layers.register_layer("notehead_pred", data["notehead"])
    layers.register_layer("symbols_pred", symbols)
    layers.register_layer("staff_pred", data["staff"])
    layers.register_layer("original_image", original)

    staffs, zones = build_perfect_staffs(data["staff"])
    layers.register_layer("staffs", staffs)
    layers.register_layer("zones", zones)
    notes = note_extract()
    layers.register_layer("notes", np.array(notes))
    layers.register_layer("note_id", np.zeros(symbols.shape, dtype=np.int64) - 1)
    register_note_id()
    groups, group_map = group_extract()
    layers.register_layer("note_groups", np.array(groups))
    layers.register_layer("group_map", group_map)
    barlines, clefs, sfns, rests = symbol_extract()
    layers.register_layer("barlines", np.array(barlines))
    layers.register_layer("clefs", np.array(clefs))
    layers.register_layer("sfns", np.array(sfns))
    layers.register_layer("rests", np.array(rests))
    rhythm_extract()
    builder = MusicXMLBuilder(title=source_image.stem)
    builder.build()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(builder.to_musicxml())
    return {
        "staffCount": int(staffs.size),
        "noteheadCount": len(notes),
        "noteGroupCount": len(groups),
        "barlineCount": len(barlines),
        "restCount": len(rests),
    }


def combine_notes(paths: list[Path]) -> list[Note]:
    combined: list[Note] = []
    onset_offset = 0.0
    measure_offset = 0
    for path in paths:
        notes = parse_notes(path)
        combined.extend(
            Note(
                midi=note.midi,
                onset_quarters=note.onset_quarters + onset_offset,
                duration_quarters=note.duration_quarters,
                measure_index=note.measure_index + measure_offset,
            )
            for note in notes
        )
        measures = parse_measure_info(path)
        onset_offset += sum(row.duration_quarters for row in measures)
        measure_offset += len(measures)
    return combined


def evaluate_piece(gold_path: Path, draft_paths: list[Path]) -> dict[str, Any]:
    gold = parse_notes(gold_path)
    draft = combine_notes(draft_paths)
    pairs = align_notes(gold, draft)
    aligned = [(left, right) for left, right in pairs if left is not None and right is not None]
    pitch_exact = 0
    onset_exact = 0
    measure_exact = 0
    for left, right in aligned:
        gold_note = gold[int(left)]
        draft_note = draft[int(right)]
        pitch_exact += int(gold_note.midi == draft_note.midi)
        onset_exact += int(
            abs(gold_note.onset_quarters - draft_note.onset_quarters)
            <= ONSET_TOLERANCE_QUARTERS
        )
        measure_exact += int(gold_note.measure_index == draft_note.measure_index)
    missing = sum(left is not None and right is None for left, right in pairs)
    extra = sum(left is None and right is not None for left, right in pairs)
    onset_accuracy = safe_rate(onset_exact, len(gold))
    measure_accuracy = safe_rate(measure_exact, len(gold))
    return {
        "goldNotes": len(gold),
        "draftNotes": len(draft),
        "pitchExact": pitch_exact,
        "onsetExact": onset_exact,
        "measureExact": measure_exact,
        "missingNotes": missing,
        "extraNotes": extra,
        "pitchPrecision": round(safe_rate(pitch_exact, len(draft)), 6),
        "pitchRecall": round(safe_rate(pitch_exact, len(gold)), 6),
        "onsetQuarterAccuracy": round(onset_accuracy, 6),
        "measureAccuracy": round(measure_accuracy, 6),
        "onsetPassed": onset_accuracy >= STRICT_THRESHOLD,
        "measurePassed": measure_accuracy >= STRICT_THRESHOLD,
        "structurePassed": onset_accuracy >= STRICT_THRESHOLD and measure_accuracy >= STRICT_THRESHOLD,
    }


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    usable = [row for row in rows if row["status"] == "ok"]
    gold = sum(row["metrics"]["goldNotes"] for row in usable)
    draft = sum(row["metrics"]["draftNotes"] for row in usable)
    onset_passed = sum(row["metrics"]["onsetPassed"] for row in usable)
    measure_passed = sum(row["metrics"]["measurePassed"] for row in usable)
    structure_passed = sum(row["metrics"]["structurePassed"] for row in usable)
    piece_count = len(usable)
    return {
        "requestedPieceCount": len(rows),
        "decodedPieceCount": piece_count,
        "failedPieceCount": len(rows) - piece_count,
        "goldNotes": gold,
        "draftNotes": draft,
        "pitchPrecision": round(safe_rate(sum(row["metrics"]["pitchExact"] for row in usable), draft), 6),
        "pitchRecall": round(safe_rate(sum(row["metrics"]["pitchExact"] for row in usable), gold), 6),
        "onsetQuarterAccuracy": round(safe_rate(sum(row["metrics"]["onsetExact"] for row in usable), gold), 6),
        "measureAccuracy": round(safe_rate(sum(row["metrics"]["measureExact"] for row in usable), gold), 6),
        "onsetPassedPieceCount": onset_passed,
        "onsetPassedPieceRate": round(safe_rate(onset_passed, piece_count), 6),
        "measurePassedPieceCount": measure_passed,
        "measurePassedPieceRate": round(safe_rate(measure_passed, piece_count), 6),
        "structurePassedPieceCount": structure_passed,
        "structurePassedPieceRate": round(safe_rate(structure_passed, piece_count), 6),
    }


def main() -> int:
    try:
        from sklearn.exceptions import InconsistentVersionWarning

        warnings.filterwarnings("ignore", category=InconsistentVersionWarning)
    except ImportError:
        pass
    parser = argparse.ArgumentParser(description="Run Oemer post-segmentation decoding on perfect SVG masks.")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    note_audit = json.loads(NOTE_AUDIT.read_text(encoding="utf-8"))
    attribution = json.loads(ATTRIBUTION.read_text(encoding="utf-8"))
    if args.limit > 0:
        allowed = {row["piece"] for row in note_audit["rows"][: args.limit]}
        note_audit = {**note_audit, "rows": [row for row in note_audit["rows"] if row["piece"] in allowed]}
    manifest = build_mask_manifest(note_audit)
    manifest_path = render_masks(manifest)
    masks_by_piece: dict[str, list[dict[str, Any]]] = {}
    for row in manifest["rows"]:
        masks_by_piece.setdefault(row["pieceId"], []).append(row)

    rows: list[dict[str, Any]] = []
    for source in note_audit["rows"]:
        piece_id = source["piece"]
        page_rows: list[dict[str, Any]] = []
        outputs: list[Path] = []
        try:
            for page in sorted(masks_by_piece[piece_id], key=lambda row: row["page"]):
                image_path = (
                    REPO
                    / "data/experiments/western-strings-m4/render-gold-omr"
                    / piece_id
                    / "render"
                    / f"page-{page['page']:02d}.png"
                )
                output_path = OUTPUT_ROOT / "decoded" / piece_id / f"page-{page['page']:02d}.musicxml"
                diagnostics = decode_page(
                    image_path,
                    {name: Path(page["outputs"][name]) for name in MASK_NAMES},
                    output_path,
                )
                outputs.append(output_path)
                page_rows.append({"page": page["page"], **diagnostics, "output": portable(output_path)})
            metrics = evaluate_piece(REPO / source["goldScore"], outputs)
            rows.append({"pieceId": piece_id, "status": "ok", "pages": page_rows, "metrics": metrics})
        except Exception as exc:
            rows.append(
                {
                    "pieceId": piece_id,
                    "status": "error",
                    "error": f"{type(exc).__name__}:{str(exc)[:300]}",
                    "pages": page_rows,
                }
            )
    summary = aggregate(rows)
    clean_target_reached = bool(
        summary["decodedPieceCount"] == summary["requestedPieceCount"]
        and summary["onsetPassedPieceRate"] >= STOP_LOSS_TARGET
        and summary["measurePassedPieceRate"] >= STOP_LOSS_TARGET
    )
    baseline = {
        "pieceCount": attribution["aggregate"]["pieceCount"],
        "onsetPassedPieceCount": attribution["aggregate"]["pieceCount"]
        - attribution["aggregate"]["onset"]["failedPieceCount"],
        "measurePassedPieceCount": attribution["aggregate"]["pieceCount"]
        - attribution["aggregate"]["measure"]["failedPieceCount"],
    }
    baseline["onsetPassedPieceRate"] = round(baseline["onsetPassedPieceCount"] / baseline["pieceCount"], 6)
    baseline["measurePassedPieceRate"] = round(baseline["measurePassedPieceCount"] / baseline["pieceCount"], 6)
    report = {
        "contract": "western-m4-perfect-observation-upper-bound-v1",
        "evidenceRole": "clean-render-post-segmentation-decoder-upper-bound",
        "sources": {
            "noteAudit": {"path": portable(NOTE_AUDIT), "sha256": sha256(NOTE_AUDIT)},
            "attribution": {"path": portable(ATTRIBUTION), "sha256": sha256(ATTRIBUTION)},
            "maskManifest": {"path": portable(manifest_path), "sha256": sha256(manifest_path)},
        },
        "thresholds": {
            "strictPerPieceMetricMin": STRICT_THRESHOLD,
            "cleanStopLossPerPiecePassRateMin": STOP_LOSS_TARGET,
            "onsetToleranceQuarters": ONSET_TOLERANCE_QUARTERS,
            "maskWhiteThreshold": MASK_WHITE_THRESHOLD,
        },
        "baselineAudiveris": baseline,
        "perfectObservationOemer": summary,
        "branchDecision": {
            "clean80TargetReached": clean_target_reached,
            "route": "soft-constraint-error-tolerance" if clean_target_reached else "constraint-solver-poc",
            "reason": (
                "perfect segmentation reaches the clean target; observed detector errors are structurally amplified"
                if clean_target_reached
                else "perfect segmentation remains below the clean target; post-segmentation classification/decoding is defective"
            ),
        },
        "method": {
            "observation": "five exact Verovio SVG-derived segmentation layers replace both Oemer UNet outputs",
            "staffObservation": "Staff/Line objects are built directly from the exact five-line mask; Oemer staff recovery is bypassed.",
            "decoder": "unchanged Oemer 0.1.8 note/group/symbol/rhythm extraction and MusicXML builder",
            "domains": ["clean-digital-render"],
        },
        "runtime": {
            "oemerVersion": importlib.metadata.version("oemer"),
            "scikitLearnVersion": importlib.metadata.version("scikit-learn"),
            "compatibilityEvidence": "docs/western-strings-m4-omr-independent-benchmark.md records byte-identical Oemer MusicXML under sklearn 1.2.0, 1.2.2, and 1.8.0",
        },
        "limitations": [
            "The baseline is Audiveris while the upper bound is Oemer; the comparison selects a Route-B decoder branch, not an within-engine gain claim.",
            "Perfect segmentation removes pixel detection error but retains Oemer morphology, SVM symbol classification, grouping, rhythm parsing, and MusicXML construction.",
            "No real-photo image is used for tuning or iteration in this experiment.",
        ],
        "studentGateReady": False,
        "automaticAdoptionAuthorized": False,
        "rows": rows,
    }
    output = OUTPUT_ROOT / "report.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": portable(output), **summary, **report["branchDecision"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
