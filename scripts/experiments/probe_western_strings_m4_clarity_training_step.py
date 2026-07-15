#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run one Clarity Stage-B adaptation step and report memory/compatibility only."""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import sys
import traceback
from pathlib import Path

from western_strings_m4_clarity_adaptation_common import load_pretrained_dora_model


REPO = Path(__file__).resolve().parents[2]
DEFAULT_TRAIN_ROOT = REPO / "data" / "experiments" / "western-strings-m4" / "clarity-train-source-audit"
DEFAULT_WEIGHTS = REPO / "data" / "experiments" / "western-strings-m4" / "clarity-pretrained" / "model.safetensors"
DEFAULT_MANIFEST = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-adaptation-pilot"
    / "clarity-adaptation-token-manifest.jsonl"
)
DEFAULT_REPORT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-adaptation-training-step"
    / "clarity-adaptation-training-step.json"
)
BLIND_GOLD_ROOT = REPO / "data" / "experiments" / "western-strings-m4" / "independent-real-photo-gold"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clarity-train-root", type=Path, default=DEFAULT_TRAIN_ROOT)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--token-manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--image-height", type=int, default=128)
    parser.add_argument("--image-width", type=int, default=768)
    parser.add_argument("--sequence-length", type=int, default=128)
    parser.add_argument("--dora-rank", type=int, default=4)
    return parser.parse_args()


def read_first_row(path: Path) -> dict:
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            for field in ("image_path", "source_path"):
                value = str(row.get(field, "")).strip()
                if value and Path(value).resolve().is_relative_to(BLIND_GOLD_ROOT.resolve()):
                    raise RuntimeError("Blind real-photo gold must never enter the adaptation smoke test.")
            return row
    raise RuntimeError(f"No token rows found in {path}")


def write_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main() -> int:
    args = parse_args()
    train_root = args.clarity_train_root.resolve()
    weights_path = args.weights.resolve()
    manifest_path = args.token_manifest.resolve()
    report_path = args.report.resolve()
    if not weights_path.exists():
        raise FileNotFoundError(f"Clarity weights not found: {weights_path}")
    if not manifest_path.exists():
        raise FileNotFoundError(f"Adaptation token manifest not found: {manifest_path}")

    os.environ.setdefault("OMR_DISABLE_BACKBONE_PRETRAINED", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    sys.path.insert(0, str(train_root))
    report = {
        "schemaVersion": 1,
        "purpose": "M4 Clarity one-step supervised-adaptation hardware smoke",
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "checkpointWritten": False,
        "strictFourMetricGateEvaluated": False,
        "weights": str(weights_path),
        "tokenManifest": str(manifest_path),
        "blindHoldoutContaminated": False,
        "imageHeight": max(32, args.image_height),
        "imageWidth": max(256, args.image_width),
        "sequenceLength": max(16, args.sequence_length),
        "doraRank": max(1, args.dora_rank),
        "status": "not-run",
        "trainingStepReady": False,
    }
    torch = None
    model = None
    optimizer = None
    try:
        import torch as torch_module
        import torch.nn.functional as functional
        from src.train.train import _encode_batch

        torch = torch_module
        if not torch.cuda.is_available():
            report["status"] = "cuda-unavailable"
            write_report(report_path, report)
            return 2
        device = torch.device("cuda:0")
        row = read_first_row(manifest_path)
        model, vocab, metadata, pretrained_load, model_report, _ = load_pretrained_dora_model(
            train_root=train_root,
            weights_path=weights_path,
            dora_rank=max(1, args.dora_rank),
        )
        report["checkpointMetadata"] = metadata
        report["pretrainedLoad"] = pretrained_load
        trainable_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
        report["model"] = model_report

        images, decoder_inputs, labels, contour_targets, _, _ = _encode_batch(
            [row],
            max_sequence_length=max(16, args.sequence_length),
            project_root=train_root,
            image_height=max(32, args.image_height),
            image_width=max(256, args.image_width),
        )
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        use_bf16 = bool(torch.cuda.is_bf16_supported())
        target_dtype = torch.bfloat16 if use_bf16 else torch.float16
        model = model.to(device=device, dtype=target_dtype)
        images = images.to(device=device, dtype=target_dtype)
        decoder_inputs = decoder_inputs.to(device)
        labels = labels.to(device)
        contour_targets = contour_targets.to(device)
        optimizer = torch.optim.AdamW(trainable_parameters, lr=1e-4, weight_decay=0.0)
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type="cuda", dtype=target_dtype):
            outputs = model(pixel_values=images, input_ids=decoder_inputs, return_aux=True)
            token_loss = functional.cross_entropy(
                outputs["logits"].transpose(1, 2), labels, ignore_index=-100
            )
            contour_loss = functional.cross_entropy(outputs["contour_logits"], contour_targets)
            loss = token_loss + (0.01 * contour_loss)
        loss.backward()
        gradient_parameter_count = sum(
            parameter.grad is not None and bool(torch.isfinite(parameter.grad).all().item())
            for parameter in trainable_parameters
        )
        optimizer.step()
        torch.cuda.synchronize(device)
        loss_value = float(loss.detach().cpu())
        peak_allocated = int(torch.cuda.max_memory_allocated())
        peak_reserved = int(torch.cuda.max_memory_reserved())
        report.update(
            {
                "status": "passed",
                "trainingStepReady": math.isfinite(loss_value) and gradient_parameter_count > 0,
                "device": torch.cuda.get_device_name(device),
                "bf16": use_bf16,
                "loss": round(loss_value, 6),
                "tokenLoss": round(float(token_loss.detach().cpu()), 6),
                "contourLoss": round(float(contour_loss.detach().cpu()), 6),
                "finiteGradientParameterCount": gradient_parameter_count,
                "peakAllocatedBytes": peak_allocated,
                "peakReservedBytes": peak_reserved,
                "peakAllocatedGiB": round(peak_allocated / (1024**3), 4),
                "peakReservedGiB": round(peak_reserved / (1024**3), 4),
            }
        )
        write_report(report_path, report)
        return 0 if report["trainingStepReady"] else 1
    except Exception as exc:
        is_oom = bool(torch is not None and isinstance(exc, torch.OutOfMemoryError))
        report.update(
            {
                "status": "cuda-oom" if is_oom else "failed",
                "trainingStepReady": False,
                "errorType": type(exc).__name__,
                "error": str(exc),
                "tracebackTail": traceback.format_exc().splitlines()[-12:],
            }
        )
        if torch is not None and torch.cuda.is_available():
            report["peakAllocatedBytes"] = int(torch.cuda.max_memory_allocated())
            report["peakReservedBytes"] = int(torch.cuda.max_memory_reserved())
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
