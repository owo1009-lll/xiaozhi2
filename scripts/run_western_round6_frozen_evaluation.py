#!/usr/bin/env python3
"""Run the pre-registered Round-6 evaluation exactly once.

The wrapper verifies every frozen source binding before reading fresh audio.
It writes a consumed ledger before evaluation starts, so a crash cannot turn
the fresh-blind split into a reusable tuning set.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from collections import Counter
from pathlib import Path
from types import ModuleType
from typing import Any, Callable


REPO = Path(__file__).resolve().parents[1]
DEFAULT_PROTOCOL = REPO / "config/western-strings-round6-evaluation-protocol.json"
PROTOCOL_CONTRACT = "western-round6-frozen-evaluation-protocol-v1"
REPORT_CONTRACT = "western-round6-frozen-evaluation-v1"
EXPECTED_GATES = ("merged_substitution", "missing", "extra", "drag")


class CandidateEvidenceError(RuntimeError):
    def __init__(self, blocking_reasons: list[str]):
        self.blocking_reasons = sorted(set(blocking_reasons))
        super().__init__("round6-candidate-evidence-invalid")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_bytes(path: Path, mode: str) -> bytes:
    data = path.read_bytes()
    if mode == "raw-sha256":
        return data
    if mode == "lf-normalized-sha256":
        return data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    raise ValueError(f"unsupported hash mode: {mode}")


def sha256_path(path: Path, mode: str = "raw-sha256") -> str:
    return hashlib.sha256(normalized_bytes(path, mode)).hexdigest()


def resolve_inside(repo: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative.strip() or Path(relative).is_absolute():
        raise ValueError("workspace-relative path required")
    candidate = (repo / relative).resolve()
    candidate.relative_to(repo.resolve())
    return candidate


def write_json(path: Path, value: Any, *, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "x" if exclusive else "w"
    with path.open(mode, encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def summarize_blockers(reasons: list[Any]) -> list[str]:
    counts = Counter(str(reason).split(":", 1)[0] for reason in reasons)
    return [f"{reason}:{count}" for reason, count in sorted(counts.items())]


def source_audit(repo: Path, protocol: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    observed = []
    blockers = []
    bindings = protocol.get("sourceBindings")
    if not isinstance(bindings, list) or not bindings:
        return [], ["round6-evaluation-source-bindings-missing"]
    roles = set()
    for index, binding in enumerate(bindings):
        role = str(binding.get("role") or "")
        relative = str(binding.get("path") or "").replace("\\", "/")
        mode = str(binding.get("hashMode") or "")
        expected = str(binding.get("sha256") or "").lower()
        if not role or role in roles:
            blockers.append(f"round6-evaluation-source-role-invalid:{index}")
            continue
        roles.add(role)
        try:
            source = resolve_inside(repo, relative)
            actual = sha256_path(source, mode)
        except (OSError, UnicodeError, ValueError):
            blockers.append(f"round6-evaluation-source-unreadable:{role}")
            continue
        if len(expected) != 64 or actual != expected:
            blockers.append(f"round6-evaluation-source-sha-mismatch:{role}")
        observed.append({
            "role": role,
            "path": relative,
            "hashMode": mode,
            "sha256": actual,
        })
    required = {
        "execution-guard",
        "candidate-runner",
        "feature-extractor",
        "temporal-operation-policy",
        "intake-validator",
        "audio-feature-analyzer",
        "round6-contract",
    }
    for role in sorted(required - roles):
        blockers.append(f"round6-evaluation-source-role-missing:{role}")
    return observed, blockers


def validate_protocol(repo: Path, protocol_path: Path) -> dict[str, Any]:
    blockers = []
    try:
        protocol = read_json(protocol_path)
    except (OSError, json.JSONDecodeError):
        return {
            "ready": False,
            "protocol": None,
            "protocolSha256": "",
            "sources": [],
            "blockingReasons": ["round6-evaluation-protocol-unreadable"],
        }
    if protocol.get("contractVersion") != PROTOCOL_CONTRACT:
        blockers.append("round6-evaluation-protocol-contract-invalid")
    if protocol.get("status") != "pre-registered-before-audio":
        blockers.append("round6-evaluation-protocol-status-invalid")
    evaluation = protocol.get("evaluation") or {}
    if evaluation.get("calibrationSplit") != "calibration":
        blockers.append("round6-evaluation-calibration-split-invalid")
    if evaluation.get("freshBlindSplit") != "fresh-blind":
        blockers.append("round6-evaluation-fresh-split-invalid")
    if evaluation.get("freshBlindRunLimit") != 1:
        blockers.append("round6-evaluation-run-limit-invalid")
    if evaluation.get("freshUsedForSelection") is not False:
        blockers.append("round6-evaluation-fresh-selection-boundary-invalid")
    if evaluation.get("decisionThreshold") != 0.5:
        blockers.append("round6-evaluation-decision-threshold-invalid")
    if tuple(evaluation.get("gates") or ()) != EXPECTED_GATES:
        blockers.append("round6-evaluation-gates-invalid")
    if evaluation.get("promotionScope") != "independent-per-gate":
        blockers.append("round6-evaluation-promotion-scope-invalid")
    if evaluation.get("completeInventoryRequired") is not True:
        blockers.append("round6-evaluation-inventory-boundary-invalid")
    if evaluation.get("scorePositionCounterbalanceRequired") is not True:
        blockers.append("round6-evaluation-counterbalance-boundary-invalid")
    thresholds = evaluation.get("promotionThresholds") or {}
    if thresholds != {
        "minPrecision": 0.9,
        "minRecall": 0.5,
        "maxStrictFalseAccusations": 0,
    }:
        blockers.append("round6-evaluation-promotion-thresholds-invalid")
    if protocol.get("studentFacing") is not False:
        blockers.append("round6-evaluation-student-boundary-invalid")
    if protocol.get("automaticAuthorizationGranted") is not False:
        blockers.append("round6-evaluation-authorization-boundary-invalid")
    candidate = protocol.get("candidate") or {}
    if candidate.get("modelFamily") != (
        "full-score-performance-only-random-forest-binary-per-gate"
    ):
        blockers.append("round6-evaluation-model-family-invalid")
    if candidate.get("featurePolicy") != (
        "alignment-performance-only-no-fixed-acoustic-v1"
    ):
        blockers.append("round6-evaluation-feature-policy-invalid")
    if candidate.get("excludedScoreContextFeatures") != [
        "n_0OutOfRange",
        "n_m1OutOfRange",
        "n_m2OutOfRange",
        "n_p1OutOfRange",
        "n_p2OutOfRange",
        "scoreNextInterval",
        "scorePreviousInterval",
    ]:
        blockers.append("round6-evaluation-score-context-exclusions-invalid")
    if candidate.get("excludedFixedAcousticFeatures") != [
        "acousticAvailable",
        "targetInteriorAttackRatio",
        "targetMeanVoicedProbability",
        "targetNearPitchOccupancy",
        "targetOnsetMax",
        "targetOnsetMean",
        "targetOnsetPeakCount",
        "targetPeakDb",
        "targetPitchOccupancy",
        "targetRmsDb",
        "targetVoicedFrameRatio",
    ]:
        blockers.append("round6-evaluation-acoustic-exclusions-invalid")
    if candidate.get("requiredTemporalFeatures") != [
        "n_0AssignmentGap",
        "n_0DurationMissing",
        "n_0DurationRatio",
        "n_0IoiDeviation",
        "n_0IoiMissing",
        "segmentMaxIoiDeviation",
        "segmentMeanIoiDeviation",
        "targetWindowEventCount",
    ]:
        blockers.append("round6-evaluation-temporal-feature-requirements-invalid")
    if candidate.get("allowedCandidateFamilies") != [
        "full-score-performance-only-random-forest-binary-per-gate",
        "frozen-gap-refinement-self-check",
        "frozen-gap-strict-missing",
        "frozen-rhythm-structural-self-check",
        "frozen-rhythm-strict-extra-drag",
    ]:
        blockers.append("round6-evaluation-candidate-families-invalid")
    if candidate.get("postFreshRetuningAllowed") is not False:
        blockers.append("round6-evaluation-retuning-boundary-invalid")
    if candidate.get("strictFalseAccusationDenominator") != (
        "every fresh score position not signed positive for the evaluated gate"
    ):
        blockers.append("round6-evaluation-false-accusation-denominator-invalid")
    interpretation = protocol.get("interpretation") or {}
    for field in (
        "numericPassIsEvidenceNotReleaseAuthorization",
        "partialGatePassDoesNotAuthorizeOtherGates",
        "failedOrCrashedFreshRunMayNotBeRepeated",
        "newCandidateAfterFreshRequiresNewUntouchedPackage",
    ):
        if interpretation.get(field) is not True:
            blockers.append(f"round6-evaluation-interpretation-invalid:{field}")
    paths = protocol.get("paths")
    if not isinstance(paths, dict):
        blockers.append("round6-evaluation-paths-missing")
    else:
        for key in ("contract", "manifest", "truth", "report", "model", "consumedLedger"):
            value = paths.get(key)
            if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
                blockers.append(f"round6-evaluation-path-invalid:{key}")
    sources, source_blockers = source_audit(repo, protocol)
    blockers.extend(source_blockers)
    return {
        "ready": not blockers,
        "protocol": protocol,
        "protocolSha256": sha256_path(protocol_path, "lf-normalized-sha256"),
        "sources": sources,
        "blockingReasons": sorted(set(blockers)),
    }


def load_candidate_module(repo: Path, protocol: dict[str, Any]) -> ModuleType:
    binding = next(
        row for row in protocol["sourceBindings"] if row["role"] == "candidate-runner"
    )
    source = resolve_inside(repo, binding["path"])
    spec = importlib.util.spec_from_file_location("round6_frozen_candidate", source)
    if not spec or not spec.loader:
        raise RuntimeError("round6-evaluation-candidate-import-failed")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidate_semantics_blockers(module: ModuleType, protocol: dict[str, Any]) -> list[str]:
    candidate = protocol.get("candidate") or {}
    blockers = []
    if str(getattr(module, "CONTRACT", "")) != candidate.get("sourceContract"):
        blockers.append("round6-evaluation-candidate-contract-mismatch")
    if str(getattr(module, "MODEL_FAMILY", "")) != candidate.get("modelFamily"):
        blockers.append("round6-evaluation-model-family-mismatch")
    if str(getattr(module, "FEATURE_POLICY", "")) != candidate.get("featurePolicy"):
        blockers.append("round6-evaluation-feature-policy-mismatch")
    if list(getattr(module, "EXCLUDED_SCORE_CONTEXT_FEATURES", ())) != (
        candidate.get("excludedScoreContextFeatures")
    ):
        blockers.append("round6-evaluation-score-context-exclusions-mismatch")
    if list(getattr(module, "EXCLUDED_FIXED_ACOUSTIC_FEATURES", ())) != (
        candidate.get("excludedFixedAcousticFeatures")
    ):
        blockers.append("round6-evaluation-acoustic-exclusions-mismatch")
    if list(getattr(module, "REQUIRED_TEMPORAL_FEATURES", ())) != (
        candidate.get("requiredTemporalFeatures")
    ):
        blockers.append("round6-evaluation-temporal-feature-requirements-mismatch")
    if (
        str(getattr(module, "STRICT_FALSE_ACCUSATION_DENOMINATOR", ""))
        != candidate.get("strictFalseAccusationDenominator")
    ):
        blockers.append("round6-evaluation-false-accusation-denominator-mismatch")
    if tuple(getattr(module, "GATES", ())) != EXPECTED_GATES:
        blockers.append("round6-evaluation-candidate-gates-mismatch")
    if dict(getattr(module, "MODEL_PARAMS", {})) != candidate.get("modelParams"):
        blockers.append("round6-evaluation-model-params-mismatch")
    frozen = candidate.get("frozenRuleContracts") or {}
    for key, attribute in {
        "gapRefinement": "FROZEN_GAP_REFINEMENT_CONTRACT",
        "gapStrict": "FROZEN_GAP_STRICT_CONTRACT",
        "rhythmRefinement": "FROZEN_RHYTHM_REFINEMENT_CONTRACT",
        "rhythmStrict": "FROZEN_RHYTHM_STRICT_CONTRACT",
    }.items():
        if frozen.get(key) != getattr(module, attribute, None):
            blockers.append(f"round6-evaluation-frozen-rule-mismatch:{key}")
    return blockers


def candidate_evidence_blockers(
    evidence: dict[str, Any],
    protocol: dict[str, Any],
    intake_report: dict[str, Any],
) -> list[str]:
    blockers = []
    candidate = protocol.get("candidate") or {}
    if evidence.get("contract") != candidate.get("sourceContract"):
        blockers.append("round6-candidate-evidence-contract-mismatch")
    if evidence.get("modelFamily") != candidate.get("modelFamily"):
        blockers.append("round6-candidate-evidence-model-family-mismatch")
    if evidence.get("featurePolicy") != candidate.get("featurePolicy"):
        blockers.append("round6-candidate-evidence-feature-policy-mismatch")
    if evidence.get("excludedScoreContextFeatures") != (
        candidate.get("excludedScoreContextFeatures")
    ):
        blockers.append("round6-candidate-evidence-score-context-exclusions-mismatch")
    if evidence.get("excludedFixedAcousticFeatures") != (
        candidate.get("excludedFixedAcousticFeatures")
    ):
        blockers.append("round6-candidate-evidence-acoustic-exclusions-mismatch")
    if evidence.get("requiredTemporalFeatures") != (
        candidate.get("requiredTemporalFeatures")
    ):
        blockers.append("round6-candidate-evidence-temporal-features-mismatch")
    if (
        evidence.get("strictFalseAccusationDenominator")
        != candidate.get("strictFalseAccusationDenominator")
    ):
        blockers.append("round6-candidate-evidence-denominator-contract-mismatch")
    evaluation = evidence.get("evaluation")
    feature_names = (
        evaluation.get("featureNames")
        if isinstance(evaluation, dict)
        else None
    )
    if not isinstance(feature_names, list) or not all(
        isinstance(name, str) for name in feature_names
    ):
        blockers.append("round6-candidate-evidence-feature-names-missing")
    else:
        excluded = {
            *candidate.get("excludedScoreContextFeatures", []),
            *candidate.get("excludedFixedAcousticFeatures", []),
        }
        leaked = sorted(set(feature_names) & excluded)
        if leaked:
            blockers.append(
                "round6-candidate-evidence-excluded-feature-present:"
                + ",".join(leaked)
            )
        missing_temporal = sorted(
            set(candidate.get("requiredTemporalFeatures", []))
            - set(feature_names)
        )
        if missing_temporal:
            blockers.append(
                "round6-candidate-evidence-temporal-feature-missing:"
                + ",".join(missing_temporal)
            )

    counts = intake_report.get("counts")
    denominators = evidence.get("denominators")
    if not isinstance(counts, dict):
        blockers.append("round6-candidate-evidence-intake-counts-missing")
        return blockers
    if not isinstance(denominators, dict):
        blockers.append("round6-candidate-evidence-denominators-missing")
        return blockers

    count_fields = (
        "positiveByGate",
        "confusionNegativeByGate",
        "freshBlindPositiveByGate",
        "freshBlindConfusionNegativeByGate",
    )
    observed_counts: dict[str, dict[str, int]] = {}
    for field in count_fields:
        values = counts.get(field)
        if not isinstance(values, dict):
            blockers.append(f"round6-candidate-evidence-intake-counts-invalid:{field}")
            continue
        observed_counts[field] = {}
        for gate in EXPECTED_GATES:
            value = values.get(gate)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                blockers.append(
                    f"round6-candidate-evidence-intake-count-invalid:{field}:{gate}"
                )
            else:
                observed_counts[field][gate] = value
    if blockers:
        return blockers

    split_counts = {
        "calibration": {
            "positive": {
                gate: (
                    observed_counts["positiveByGate"][gate]
                    - observed_counts["freshBlindPositiveByGate"][gate]
                )
                for gate in EXPECTED_GATES
            },
            "confusion": {
                gate: (
                    observed_counts["confusionNegativeByGate"][gate]
                    - observed_counts["freshBlindConfusionNegativeByGate"][gate]
                )
                for gate in EXPECTED_GATES
            },
        },
        "fresh-blind": {
            "positive": observed_counts["freshBlindPositiveByGate"],
            "confusion": observed_counts["freshBlindConfusionNegativeByGate"],
        },
    }
    dataset_rows = 0
    denominator_fields = (
        "allScorePositions",
        "positivePositions",
        "strictNegativePositions",
        "ordinaryUnlistedPositions",
        "targetConfusionNegativePositions",
        "otherGateOrControlPositions",
    )
    for split, expected in split_counts.items():
        split_denominators = denominators.get(split)
        if not isinstance(split_denominators, dict):
            blockers.append(f"round6-candidate-evidence-denominator-split-missing:{split}")
            continue
        all_score_position_counts = set()
        total_signed_positions = sum(expected["positive"].values()) + sum(
            expected["confusion"].values()
        )
        for gate in EXPECTED_GATES:
            row = split_denominators.get(gate)
            if not isinstance(row, dict):
                blockers.append(
                    f"round6-candidate-evidence-denominator-gate-missing:{split}:{gate}"
                )
                continue
            if any(
                not isinstance(row.get(field), int)
                or isinstance(row.get(field), bool)
                or row[field] < 0
                for field in denominator_fields
            ):
                blockers.append(
                    f"round6-candidate-evidence-denominator-field-invalid:{split}:{gate}"
                )
                continue
            all_positions = row["allScorePositions"]
            all_score_position_counts.add(all_positions)
            dataset_rows += all_positions
            expected_positive = expected["positive"][gate]
            expected_confusion = expected["confusion"][gate]
            expected_other = (
                total_signed_positions - expected_positive - expected_confusion
            )
            expected_ordinary = all_positions - total_signed_positions
            if row["positivePositions"] != expected_positive:
                blockers.append(
                    f"round6-candidate-evidence-positive-count-mismatch:{split}:{gate}"
                )
            if row["targetConfusionNegativePositions"] != expected_confusion:
                blockers.append(
                    f"round6-candidate-evidence-confusion-count-mismatch:{split}:{gate}"
                )
            if row["otherGateOrControlPositions"] != expected_other:
                blockers.append(
                    f"round6-candidate-evidence-other-gate-count-mismatch:{split}:{gate}"
                )
            if expected_ordinary < 0 or row["ordinaryUnlistedPositions"] != expected_ordinary:
                blockers.append(
                    f"round6-candidate-evidence-ordinary-count-mismatch:{split}:{gate}"
                )
            if row["strictNegativePositions"] != all_positions - expected_positive:
                blockers.append(
                    f"round6-candidate-evidence-strict-negative-count-mismatch:{split}:{gate}"
                )
        if len(all_score_position_counts) != 1:
            blockers.append(
                f"round6-candidate-evidence-all-score-count-inconsistent:{split}"
            )
    if evidence.get("datasetRows") != dataset_rows:
        blockers.append("round6-candidate-evidence-dataset-row-count-mismatch")
    return sorted(set(blockers))


def run(
    *,
    repo_root: Path = REPO,
    protocol_path: Path = DEFAULT_PROTOCOL,
    module: ModuleType | None = None,
    intake_validator: Callable[[Path, Path, Path], dict[str, Any]] | None = None,
    evaluator: Callable[[Path, Path, Path, Path, Path], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    repo = repo_root.resolve()
    protocol_file = protocol_path if protocol_path.is_absolute() else repo / protocol_path
    audit = validate_protocol(repo, protocol_file)
    protocol = audit["protocol"] or {}
    paths = protocol.get("paths") or {}
    try:
        report_path = resolve_inside(repo, paths.get("report", ""))
    except (TypeError, ValueError):
        report_path = repo / "data/experiments/western-strings-round6-frozen-evaluation/report.json"
    try:
        ledger_path = resolve_inside(repo, paths.get("consumedLedger", ""))
    except (TypeError, ValueError):
        ledger_path = repo / "data/experiments/western-strings-round6-frozen-evaluation/invalid-ledger.json"
    try:
        model_path = resolve_inside(repo, paths.get("model", ""))
    except (TypeError, ValueError):
        model_path = repo / "data/experiments/western-strings-round6-frozen-evaluation/invalid-model.joblib"
    base = {
        "schemaVersion": 1,
        "contract": REPORT_CONTRACT,
        "protocol": PROTOCOL_CONTRACT,
        "protocolSha256": audit["protocolSha256"],
        "sourceBindings": audit["sources"],
        "runnerReady": audit["ready"],
        "intakeReady": False,
        "evaluationPerformed": False,
        "freshBlindConsumed": False,
        "promotionEvidenceEligible": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "blockingReasons": list(audit["blockingReasons"]),
    }
    if not audit["ready"]:
        write_json(report_path, base)
        return base

    candidate_module = module or load_candidate_module(repo, protocol)
    semantic_blockers = candidate_semantics_blockers(candidate_module, protocol)
    if semantic_blockers:
        result = {**base, "runnerReady": False, "blockingReasons": semantic_blockers}
        write_json(report_path, result)
        return result

    contract_path = resolve_inside(repo, paths["contract"])
    manifest_path = resolve_inside(repo, paths["manifest"])
    truth_path = resolve_inside(repo, paths["truth"])
    validate_intake = intake_validator or candidate_module.intake.validate
    candidate_module.intake.REPO = repo
    intake_report = validate_intake(contract_path, manifest_path, truth_path)
    if intake_report.get("ready") is not True:
        intake_reasons = intake_report.get("blockingReasons", [])
        result = {
            **base,
            "intakeReady": False,
            "sourceHashes": intake_report.get("hashes", {}),
            "intakeBlockingReasonCount": len(intake_reasons),
            "intakeBlockingReasonSummary": summarize_blockers(intake_reasons),
            "blockingReasons": [
                "round6-targeted-intake-not-ready",
            ],
        }
        write_json(report_path, result)
        return result

    if ledger_path.exists():
        try:
            ledger = read_json(ledger_path)
        except (OSError, json.JSONDecodeError):
            ledger = {}
        result = {
            **base,
            "intakeReady": True,
            "freshBlindConsumed": True,
            "consumedLedgerStatus": str(ledger.get("status") or "unreadable"),
            "blockingReasons": ["round6-fresh-blind-already-consumed"],
        }
        write_json(report_path, result)
        return result

    started_ledger = {
        "contract": "western-round6-fresh-blind-consumed-ledger-v1",
        "protocolSha256": audit["protocolSha256"],
        "freshBlindConsumed": True,
        "status": "evaluation-started",
        "sourceHashes": intake_report.get("hashes", {}),
    }
    write_json(ledger_path, started_ledger, exclusive=True)
    evaluate = evaluator or candidate_module.run
    scratch_report = report_path.with_suffix(".inner.tmp.json")
    try:
        inner = evaluate(
            contract_path,
            manifest_path,
            truth_path,
            scratch_report,
            model_path,
        )
        if inner.get("evaluationPerformed") is not True:
            raise RuntimeError("round6-candidate-returned-without-evaluation")
        evidence_blockers = candidate_evidence_blockers(inner, protocol, intake_report)
        if evidence_blockers:
            raise CandidateEvidenceError(evidence_blockers)
        result = {
            **base,
            "ok": True,
            "intakeReady": True,
            "evaluationPerformed": True,
            "freshBlindConsumed": True,
            "promotionEvidenceEligible": True,
            "sourceHashes": intake_report.get("hashes", {}),
            "candidateEvidence": inner,
            "blockingReasons": [],
        }
        write_json(report_path, result)
        completed_ledger = {
            **started_ledger,
            "status": "evaluation-completed",
            "reportSha256": sha256_path(report_path),
        }
        write_json(ledger_path, completed_ledger)
        return result
    except Exception as error:  # fresh has already been consumed; never retry automatically
        evidence_blockers = (
            error.blocking_reasons
            if isinstance(error, CandidateEvidenceError)
            else [f"round6-evaluation-error:{type(error).__name__}"]
        )
        result = {
            **base,
            "intakeReady": True,
            "freshBlindConsumed": True,
            "blockingReasons": [
                "round6-fresh-blind-evaluation-failed-after-consumption",
                *evidence_blockers,
            ],
        }
        write_json(report_path, result)
        write_json(ledger_path, {
            **started_ledger,
            "status": "evaluation-failed",
            "reportSha256": sha256_path(report_path),
        })
        return result
    finally:
        scratch_report.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-evaluated", action="store_true")
    args = parser.parse_args()
    report = run()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if args.require_evaluated and report.get("evaluationPerformed") is not True else 0


if __name__ == "__main__":
    raise SystemExit(main())
