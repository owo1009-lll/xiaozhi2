#!/usr/bin/env python3
"""Shared, fail-closed Clarity Stage-B adaptation initialization."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path


CONTOUR_HEAD_KEYS = {
    "contour_head.0.weight",
    "contour_head.0.bias",
    "contour_head.2.weight",
    "contour_head.2.bias",
}
FFN_ALIAS_TO_CANONICAL = {
    "ffn_gate": "gate_proj",
    "ffn_up": "up_proj",
    "ffn_down": "down_proj",
}


def classify_missing_pretrained_keys(base_model, state_dict: dict, missing_keys: list[str]) -> dict:
    duplicate_aliases: list[str] = []
    random_auxiliary_head: list[str] = []
    disallowed: list[str] = []
    alias_pattern = re.compile(
        r"^decoder_blocks\.(?P<block>\d+)\.(?P<alias>ffn_gate|ffn_up|ffn_down)\.(?P<field>weight|bias)$"
    )
    for key in missing_keys:
        match = alias_pattern.fullmatch(key)
        if match:
            block_index = int(match.group("block"))
            alias_name = match.group("alias")
            canonical_name = FFN_ALIAS_TO_CANONICAL[alias_name]
            canonical_key = (
                f"decoder_blocks.{block_index}.{canonical_name}.{match.group('field')}"
            )
            block = base_model.decoder_blocks[block_index]
            aliases_same_module = getattr(block, alias_name) is getattr(block, canonical_name)
            if aliases_same_module and canonical_key in state_dict:
                duplicate_aliases.append(key)
                continue
        if key in CONTOUR_HEAD_KEYS:
            random_auxiliary_head.append(key)
            continue
        disallowed.append(key)
    return {
        "duplicateAliasKeys": duplicate_aliases,
        "randomInitializedAuxiliaryHeadKeys": random_auxiliary_head,
        "disallowedMissingKeys": disallowed,
    }


def load_pretrained_dora_model(
    *,
    train_root: Path,
    weights_path: Path,
    dora_rank: int,
):
    """Load official weights, verify known omissions, then attach trainable DoRA adapters."""

    train_root = train_root.resolve()
    weights_path = weights_path.resolve()
    if not weights_path.exists():
        raise FileNotFoundError(f"Clarity weights not found: {weights_path}")
    if not (train_root / "src" / "train" / "train.py").exists():
        raise FileNotFoundError(f"Clarity training source not found: {train_root}")

    os.environ.setdefault("OMR_DISABLE_BACKBONE_PRETRAINED", "1")
    train_root_text = str(train_root)
    if train_root_text not in sys.path:
        sys.path.insert(0, train_root_text)

    from safetensors import safe_open
    from safetensors.torch import load_file
    from src.tokenizer.vocab import build_default_vocabulary
    from src.train.model_factory import ModelFactoryConfig, build_stage_b_components
    from src.train.train import _prepare_model_for_dora

    vocab = build_default_vocabulary()
    with safe_open(str(weights_path), framework="pt", device="cpu") as handle:
        metadata = handle.metadata() or {}
    checkpoint_vocab = int(metadata.get("vocab_size", vocab.size))
    if checkpoint_vocab != vocab.size:
        raise RuntimeError(
            f"Checkpoint vocabulary mismatch: checkpoint={checkpoint_vocab}, code={vocab.size}"
        )

    factory = ModelFactoryConfig(
        stage_b_vocab_size=vocab.size,
        stage_b_max_decode_length=int(metadata.get("max_decode_length", 512)),
        stage_b_backbone=str(metadata.get("backbone", "davit_base.msft_in1k")),
        stage_b_decoder_dim=int(metadata.get("decoder_dim", 768)),
        stage_b_decoder_layers=int(metadata.get("decoder_layers", 8)),
        stage_b_decoder_heads=int(metadata.get("decoder_heads", 12)),
        stage_b_dora_rank=max(1, int(dora_rank)),
    )
    components = build_stage_b_components(factory)
    base_model = components["model"]
    state_dict = load_file(str(weights_path), device="cpu")
    load_result = base_model.load_state_dict(state_dict, strict=False)
    missing_classification = classify_missing_pretrained_keys(
        base_model,
        state_dict,
        list(load_result.missing_keys),
    )
    compatible = bool(
        not load_result.unexpected_keys
        and not missing_classification["disallowedMissingKeys"]
        and set(missing_classification["randomInitializedAuxiliaryHeadKeys"])
        == CONTOUR_HEAD_KEYS
    )
    checkpoint_state_keys = tuple(state_dict.keys())
    load_report = {
        "stateTensorCount": len(state_dict),
        "missingKeyCount": len(load_result.missing_keys),
        "unexpectedKeyCount": len(load_result.unexpected_keys),
        "missingKeysPreview": list(load_result.missing_keys[:10]),
        "unexpectedKeysPreview": list(load_result.unexpected_keys[:10]),
        "duplicateAliasMissingKeyCount": len(missing_classification["duplicateAliasKeys"]),
        "randomInitializedAuxiliaryHeadKeyCount": len(
            missing_classification["randomInitializedAuxiliaryHeadKeys"]
        ),
        "disallowedMissingKeys": missing_classification["disallowedMissingKeys"],
        "compatibleForAdaptation": compatible,
    }
    del state_dict
    if not compatible:
        raise RuntimeError(
            "Pretrained Stage-B checkpoint has missing or unexpected keys outside "
            "the verified alias/aux-head boundary."
        )

    model, dora_applied = _prepare_model_for_dora(base_model, components["dora_config"])
    trainable_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    total_parameter_count = sum(parameter.numel() for parameter in model.parameters())
    trainable_parameter_count = sum(parameter.numel() for parameter in trainable_parameters)
    model_report = {
        "doraApplied": bool(dora_applied),
        "totalParameterCount": total_parameter_count,
        "trainableParameterCount": trainable_parameter_count,
        "trainablePercent": round(
            100.0 * trainable_parameter_count / max(1, total_parameter_count), 4
        ),
    }
    if not dora_applied or not trainable_parameters:
        raise RuntimeError("DoRA adaptation was not applied or exposed no trainable parameters.")
    return model, vocab, metadata, load_report, model_report, checkpoint_state_keys
