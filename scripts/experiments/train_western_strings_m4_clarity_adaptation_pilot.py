#!/usr/bin/env python3
"""Run a bounded Clarity DoRA pilot and compare held-out token metrics."""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import random
import hashlib
import traceback
from pathlib import Path

from western_strings_m4_clarity_adaptation_common import load_pretrained_dora_model


REPO = Path(__file__).resolve().parents[2]
M4_ROOT = REPO / "data" / "experiments" / "western-strings-m4"
DEFAULT_TRAIN_ROOT = M4_ROOT / "clarity-train-source-audit"
DEFAULT_WEIGHTS = M4_ROOT / "clarity-pretrained" / "model.safetensors"
DEFAULT_DATASET_ROOT = M4_ROOT / "clarity-adaptation-dataset"
DEFAULT_REPORT = M4_ROOT / "clarity-adaptation-training-pilot" / "training-pilot.json"
BLIND_GOLD_ROOT = M4_ROOT / "independent-real-photo-gold"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clarity-train-root", type=Path, default=DEFAULT_TRAIN_ROOT)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument(
        "--train-manifest",
        type=Path,
        default=DEFAULT_DATASET_ROOT / "clarity-adaptation-train-tokens.jsonl",
    )
    parser.add_argument(
        "--validation-manifest",
        type=Path,
        default=DEFAULT_DATASET_ROOT / "clarity-adaptation-validation-tokens.jsonl",
    )
    parser.add_argument(
        "--test-manifest",
        type=Path,
        default=DEFAULT_DATASET_ROOT / "clarity-adaptation-synthetic-test-tokens.jsonl",
    )
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--merged-checkpoint", type=Path)
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--eval-samples", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--image-height", type=int, default=128)
    parser.add_argument("--image-width", type=int, default=768)
    parser.add_argument("--sequence-length", type=int, default=256)
    parser.add_argument("--dora-rank", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--augment", action="store_true")
    return parser.parse_args()


def read_manifest(path: Path, expected_split: str) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(f"Adaptation token manifest not found: {path}")
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not rows:
        raise RuntimeError(f"Adaptation token manifest is empty: {path}")
    bad_splits = sorted({str(row.get("split", "")) for row in rows} - {expected_split})
    if bad_splits:
        raise RuntimeError(f"Unexpected split values in {path}: {bad_splits}")
    blind_root = BLIND_GOLD_ROOT.resolve()
    for row in rows:
        for field in ("image_path", "source_path", "source_score_path"):
            value = str(row.get(field, "")).strip()
            if value and Path(value).resolve().is_relative_to(blind_root):
                raise RuntimeError("Blind real-photo gold must never enter adaptation training.")
    return rows


def write_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


def choose_eval_rows(rows: list[dict], count: int, seed: int) -> list[dict]:
    selected = list(rows)
    random.Random(seed).shuffle(selected)
    return selected[: min(len(selected), max(1, count))]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_dataset_splits(split_rows: dict[str, list[dict]]) -> dict:
    work_ids_by_split: dict[str, set[str]] = {}
    image_hashes_by_split: dict[str, set[str]] = {}
    for split, rows in split_rows.items():
        work_ids = {str(row.get("work_id", "")).strip() for row in rows}
        if "" in work_ids:
            raise RuntimeError(f"Adaptation {split} manifest contains a blank work_id.")
        work_ids_by_split[split] = work_ids
        image_hashes: set[str] = set()
        for row in rows:
            image_path = Path(str(row.get("image_path", ""))).resolve()
            if not image_path.is_file():
                raise FileNotFoundError(f"Adaptation image missing: {image_path}")
            declared_hash = str(row.get("image_sha256", "")).strip().lower()
            actual_hash = sha256_file(image_path)
            if declared_hash and declared_hash != actual_hash:
                raise RuntimeError(f"Adaptation image hash mismatch: {image_path}")
            image_hashes.add(actual_hash)
        image_hashes_by_split[split] = image_hashes

    split_names = tuple(split_rows)
    work_overlap: dict[str, list[str]] = {}
    image_overlap: dict[str, list[str]] = {}
    for index, left in enumerate(split_names):
        for right in split_names[index + 1 :]:
            key = f"{left}:{right}"
            shared_works = sorted(work_ids_by_split[left] & work_ids_by_split[right])
            shared_images = sorted(image_hashes_by_split[left] & image_hashes_by_split[right])
            if shared_works:
                work_overlap[key] = shared_works
            if shared_images:
                image_overlap[key] = shared_images
    if work_overlap or image_overlap:
        raise RuntimeError(
            "Adaptation train/evaluation leakage detected: "
            f"workOverlap={work_overlap}, imageHashOverlap={image_overlap}"
        )
    return {
        "workIdsBySplit": {
            split: sorted(work_ids) for split, work_ids in work_ids_by_split.items()
        },
        "workOverlap": work_overlap,
        "imageHashOverlap": image_overlap,
    }


def save_merged_checkpoint(
    *,
    model,
    checkpoint_state_keys: tuple[str, ...],
    metadata: dict,
    path: Path,
    steps: int,
) -> dict:
    from safetensors.torch import save_file

    merged_model = model.merge_and_unload(safe_merge=True)
    merged_state = merged_model.state_dict()
    missing = [key for key in checkpoint_state_keys if key not in merged_state]
    if missing:
        raise RuntimeError(f"Merged model is missing official checkpoint keys: {missing[:10]}")
    export_state = {
        key: merged_state[key].detach().cpu().contiguous()
        for key in checkpoint_state_keys
    }
    export_metadata = {str(key): str(value) for key, value in metadata.items()}
    export_metadata.update(
        {
            "format": "clarity-omr-stage-b",
            "dora_merged": "true",
            "western_strings_adaptation": "eval-only",
            "western_strings_adaptation_steps": str(steps),
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    save_file(export_state, str(path), metadata=export_metadata)
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "stateTensorCount": len(export_state),
    }


def evaluate_teacher_forced(
    *,
    model,
    rows: list[dict],
    train_root: Path,
    device,
    target_dtype,
    image_height: int,
    image_width: int,
    sequence_length: int,
) -> dict:
    import torch
    import torch.nn.functional as functional
    from src.train.train import _encode_batch

    model.eval()
    total_loss = 0.0
    total_tokens = 0
    correct_tokens = 0
    exact_sequences = 0
    with torch.inference_mode():
        for row in rows:
            images, decoder_inputs, labels, _, _, _ = _encode_batch(
                [row],
                max_sequence_length=sequence_length,
                project_root=train_root,
                image_height=image_height,
                image_width=image_width,
            )
            images = images.to(device=device, dtype=target_dtype)
            decoder_inputs = decoder_inputs.to(device)
            labels = labels.to(device)
            with torch.autocast(device_type="cuda", dtype=target_dtype):
                outputs = model(pixel_values=images, input_ids=decoder_inputs, return_aux=True)
                logits = outputs["logits"]
                loss_sum = functional.cross_entropy(
                    logits.transpose(1, 2),
                    labels,
                    ignore_index=-100,
                    reduction="sum",
                )
            valid = labels.ne(-100)
            predictions = logits.argmax(dim=-1)
            row_tokens = int(valid.sum().item())
            row_correct = int((predictions.eq(labels) & valid).sum().item())
            total_loss += float(loss_sum.detach().cpu())
            total_tokens += row_tokens
            correct_tokens += row_correct
            exact_sequences += int(row_tokens > 0 and row_correct == row_tokens)
    return {
        "sampleCount": len(rows),
        "tokenCount": total_tokens,
        "meanTokenLoss": round(total_loss / max(1, total_tokens), 6),
        "teacherForcedTokenAccuracy": round(correct_tokens / max(1, total_tokens), 6),
        "teacherForcedExactSequenceRate": round(exact_sequences / max(1, len(rows)), 6),
    }


def main() -> int:
    args = parse_args()
    train_root = args.clarity_train_root.resolve()
    weights_path = args.weights.resolve()
    report_path = args.report.resolve()
    train_rows = read_manifest(args.train_manifest.resolve(), "train")
    validation_rows = read_manifest(args.validation_manifest.resolve(), "validation")
    test_rows = read_manifest(args.test_manifest.resolve(), "synthetic-test")
    split_audit = validate_dataset_splits(
        {
            "train": train_rows,
            "validation": validation_rows,
            "synthetic-test": test_rows,
        }
    )
    if not math.isfinite(args.learning_rate) or args.learning_rate <= 0:
        raise ValueError("--learning-rate must be a positive finite number")
    validation_eval_rows = choose_eval_rows(validation_rows, args.eval_samples, args.seed + 1)
    test_eval_rows = choose_eval_rows(test_rows, args.eval_samples, args.seed + 2)
    report = {
        "schemaVersion": 1,
        "purpose": "M4 bounded Clarity supervised-adaptation pilot",
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "checkpointWritten": False,
        "strictFourMetricGateEvaluated": False,
        "blindHoldoutContaminated": False,
        "status": "not-run",
        "pilotSignalReady": False,
        "config": {
            "steps": max(1, args.steps),
            "evalSamples": max(1, args.eval_samples),
            "learningRate": args.learning_rate,
            "imageHeight": max(32, args.image_height),
            "imageWidth": max(256, args.image_width),
            "sequenceLength": max(16, args.sequence_length),
            "doraRank": max(1, args.dora_rank),
            "seed": args.seed,
            "augment": bool(args.augment),
        },
        "dataset": {
            "trainRows": len(train_rows),
            "validationRows": len(validation_rows),
            "testRows": len(test_rows),
            "validationWorkIds": sorted({str(row.get("work_id", "")) for row in validation_rows}),
            "testWorkIds": sorted({str(row.get("work_id", "")) for row in test_rows}),
            "splitAudit": split_audit,
        },
    }
    torch = None
    model = None
    optimizer = None
    try:
        os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
        os.environ.setdefault("OMR_DISABLE_BACKBONE_PRETRAINED", "1")
        import torch as torch_module
        import torch.nn.functional as functional

        torch = torch_module
        if not torch.cuda.is_available():
            report["status"] = "cuda-unavailable"
            write_report(report_path, report)
            return 2
        torch.manual_seed(args.seed)
        random.seed(args.seed)
        device = torch.device("cuda:0")
        model, _, metadata, load_report, model_report, checkpoint_state_keys = load_pretrained_dora_model(
            train_root=train_root,
            weights_path=weights_path,
            dora_rank=max(1, args.dora_rank),
        )
        from src.train.train import _apply_online_augmentations, _encode_batch

        report["checkpointMetadata"] = metadata
        report["pretrainedLoad"] = load_report
        report["model"] = model_report
        use_bf16 = bool(torch.cuda.is_bf16_supported())
        target_dtype = torch.bfloat16 if use_bf16 else torch.float16
        model = model.to(device=device, dtype=target_dtype)
        trainable_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
        optimizer = torch.optim.AdamW(
            trainable_parameters,
            lr=float(args.learning_rate),
            weight_decay=0.0,
        )
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

        baseline_validation = evaluate_teacher_forced(
            model=model,
            rows=validation_eval_rows,
            train_root=train_root,
            device=device,
            target_dtype=target_dtype,
            image_height=max(32, args.image_height),
            image_width=max(256, args.image_width),
            sequence_length=max(16, args.sequence_length),
        )
        baseline_test = evaluate_teacher_forced(
            model=model,
            rows=test_eval_rows,
            train_root=train_root,
            device=device,
            target_dtype=target_dtype,
            image_height=max(32, args.image_height),
            image_width=max(256, args.image_width),
            sequence_length=max(16, args.sequence_length),
        )

        rng = random.Random(args.seed)
        losses: list[float] = []
        finite_gradient_steps = 0
        model.train()
        for _ in range(max(1, args.steps)):
            row = train_rows[rng.randrange(len(train_rows))]
            images, decoder_inputs, labels, contour_targets, _, _ = _encode_batch(
                [row],
                max_sequence_length=max(16, args.sequence_length),
                project_root=train_root,
                image_height=max(32, args.image_height),
                image_width=max(256, args.image_width),
            )
            if args.augment:
                images = _apply_online_augmentations(images, rng)
            images = images.to(device=device, dtype=target_dtype)
            decoder_inputs = decoder_inputs.to(device)
            labels = labels.to(device)
            contour_targets = contour_targets.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type="cuda", dtype=target_dtype):
                outputs = model(pixel_values=images, input_ids=decoder_inputs, return_aux=True)
                token_loss = functional.cross_entropy(
                    outputs["logits"].transpose(1, 2), labels, ignore_index=-100
                )
                contour_loss = functional.cross_entropy(
                    outputs["contour_logits"], contour_targets
                )
                loss = token_loss + (0.01 * contour_loss)
            if not bool(torch.isfinite(loss).item()):
                raise RuntimeError("Non-finite loss in bounded adaptation pilot.")
            loss.backward()
            finite_gradients = all(
                parameter.grad is None or bool(torch.isfinite(parameter.grad).all().item())
                for parameter in trainable_parameters
            )
            if not finite_gradients:
                raise RuntimeError("Non-finite gradient in bounded adaptation pilot.")
            torch.nn.utils.clip_grad_norm_(trainable_parameters, max_norm=1.0)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
            finite_gradient_steps += 1

        adapted_validation = evaluate_teacher_forced(
            model=model,
            rows=validation_eval_rows,
            train_root=train_root,
            device=device,
            target_dtype=target_dtype,
            image_height=max(32, args.image_height),
            image_width=max(256, args.image_width),
            sequence_length=max(16, args.sequence_length),
        )
        adapted_test = evaluate_teacher_forced(
            model=model,
            rows=test_eval_rows,
            train_root=train_root,
            device=device,
            target_dtype=target_dtype,
            image_height=max(32, args.image_height),
            image_width=max(256, args.image_width),
            sequence_length=max(16, args.sequence_length),
        )
        validation_improved = bool(
            adapted_validation["meanTokenLoss"] < baseline_validation["meanTokenLoss"]
            and adapted_validation["teacherForcedTokenAccuracy"]
            >= baseline_validation["teacherForcedTokenAccuracy"]
        )
        test_not_regressed = bool(
            adapted_test["meanTokenLoss"] <= baseline_test["meanTokenLoss"] * 1.01
            and adapted_test["teacherForcedTokenAccuracy"] + 0.005
            >= baseline_test["teacherForcedTokenAccuracy"]
        )
        peak_allocated = int(torch.cuda.max_memory_allocated())
        peak_reserved = int(torch.cuda.max_memory_reserved())
        report.update(
            {
                "status": "passed",
                "device": torch.cuda.get_device_name(device),
                "bf16": use_bf16,
                "training": {
                    "executedSteps": len(losses),
                    "finiteGradientSteps": finite_gradient_steps,
                    "firstLoss": round(losses[0], 6),
                    "lastLoss": round(losses[-1], 6),
                    "meanLoss": round(sum(losses) / len(losses), 6),
                },
                "baseline": {
                    "validation": baseline_validation,
                    "syntheticTest": baseline_test,
                },
                "adapted": {
                    "validation": adapted_validation,
                    "syntheticTest": adapted_test,
                },
                "validationImproved": validation_improved,
                "syntheticTestNotRegressed": test_not_regressed,
                "pilotSignalReady": validation_improved and test_not_regressed,
                "peakAllocatedGiB": round(peak_allocated / (1024**3), 4),
                "peakReservedGiB": round(peak_reserved / (1024**3), 4),
            }
        )
        if report["pilotSignalReady"] and args.merged_checkpoint is not None:
            checkpoint_result = save_merged_checkpoint(
                model=model,
                checkpoint_state_keys=checkpoint_state_keys,
                metadata=metadata,
                path=args.merged_checkpoint.resolve(),
                steps=max(1, args.steps),
            )
            report["checkpointWritten"] = True
            report["candidateCheckpoint"] = checkpoint_result
        write_report(report_path, report)
        return 0
    except Exception as exc:
        is_oom = bool(torch is not None and isinstance(exc, torch.OutOfMemoryError))
        report.update(
            {
                "status": "cuda-oom" if is_oom else "failed",
                "pilotSignalReady": False,
                "errorType": type(exc).__name__,
                "error": str(exc),
                "tracebackTail": traceback.format_exc().splitlines()[-12:],
            }
        )
        write_report(report_path, report)
        return 2
    finally:
        optimizer = None
        model = None
        gc.collect()
        if torch is not None and torch.cuda.is_available():
            torch.cuda.empty_cache()


if __name__ == "__main__":
    raise SystemExit(main())
