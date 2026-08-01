#!/usr/bin/env python3
"""Score one controlled submission with the frozen Round 6 Stage A model.

The model failed its Stage A clean-domain safety gate (81 false positives over
8,019 known-clean positions, about one per hundred notes), so it is not fit to
accuse a student and never becomes evidence. It is used here for one purpose
only: to surface extra candidates to a teacher who is already listening, and
whose confirmations feed the training ledger.

Three things follow from that and are enforced below:

  * studentFacing is always false and no gate, ready flag or recall figure is
    written. This output is a suggestion list, not a finding.
  * The model artifact is checked against the sha recorded by the Stage A run,
    so a swapped or retrained model fails closed instead of quietly scoring.
  * Features are computed by the same frozen pipeline that trained it. Feeding
    it approximations of its own inputs would produce confident noise that
    nobody could distinguish from signal.

    py -3.11 scripts/experiments/score_submission_with_stage_a_model.py \\
        --score <musicxml> --audio <audio> --out <report.json>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import joblib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_western_strings_duration_extra_quantization import analyze_take  # noqa: E402
from train_western_round5_segment_edit_path import (  # noqa: E402
    extract_segment_features,
    score_positions,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SAFETY_REPORT = REPO_ROOT / "data/experiments/western-strings-round6-stage-a-safety/report.json"
MODEL_PATH = REPO_ROOT / "data/experiments/western-strings-round6-stage-a-safety/model.joblib"
DECISION_POINT = 0.5


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_frozen_model() -> tuple[Any, list[str], dict[str, Any]]:
    report = json.loads(SAFETY_REPORT.read_text(encoding="utf-8"))
    recorded = report["modelArtifact"]
    observed = sha256(MODEL_PATH)
    if observed != recorded["sha256"]:
        raise SystemExit(
            "stage-a model artifact sha mismatch; refusing to score with an unverified model"
        )
    artifact = joblib.load(MODEL_PATH)
    # Feature order is taken from the artifact itself, not from the report: the
    # columns must line up with how the estimator was fitted, and only the
    # artifact is authoritative about that.
    feature_names = list(artifact["featureNames"])
    if list(report["featureNames"]) != feature_names:
        raise SystemExit("stage-a feature names disagree between report and artifact")
    return artifact["models"], feature_names, {
        "modelSha256": observed,
        "modelContract": artifact.get("contract"),
        "candidateContract": artifact.get("candidateContract"),
        "stageAPassed": bool(report.get("stageAPassed")),
        "safetyLimitViolations": list(report.get("safetyLimitViolations") or []),
        "featurePolicy": report.get("candidateFeaturePolicy"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--score", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    score_path = Path(args.score).resolve()
    audio_path = Path(args.audio).resolve()
    models, feature_names, provenance = load_frozen_model()

    take = analyze_take(score_path, audio_path)
    positions = score_positions(score_path)

    candidates: list[dict[str, Any]] = []
    for position in positions:
        note_index = int(position["noteIndex"])
        raw = extract_segment_features(take, note_index)
        vector = np.array([[float(raw.get(name, 0.0)) for name in feature_names]])
        for gate, model in models.items():
            probability = float(model.predict_proba(vector)[0][1])
            if probability < DECISION_POINT:
                continue
            candidates.append({
                "noteIndex": note_index,
                "measure": position.get("measure"),
                "beat": position.get("beat"),
                "scoreMidi": position.get("scoreMidi"),
                "gate": gate,
                "probability": round(probability, 6),
                # Wording matters: the teacher must read this as something to
                # listen to, never as a finding about the student.
                "role": "teacher_review_suggestion",
            })

    report = {
        "contract": "western-round6-stage-a-model-teacher-suggestions-v1",
        "score": str(score_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        "scoreSha256": sha256(score_path),
        "audioSha256": sha256(audio_path),
        "decisionPoint": DECISION_POINT,
        "provenance": provenance,
        "suggestionCount": len(candidates),
        "scorePositionCount": len(positions),
        "suggestions": candidates,
        # Hard-coded, not derived: this output can never promote anything.
        "studentFacing": False,
        "automaticAccusationAuthorized": False,
        "changesStrictConfirmedRecall": False,
        "isEvidence": False,
        "showOnlyAfterTeacherSignoff": True,
    }
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        shown_out = str(out_path.relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        shown_out = str(out_path)
    print(json.dumps({
        "ok": True,
        "out": shown_out,
        "suggestions": len(candidates),
        "positions": len(positions),
        "stageAPassed": provenance["stageAPassed"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
