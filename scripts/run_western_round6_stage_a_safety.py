"""Fit the frozen Round-6 calibration model, then consume clean safety once."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier


REPO = Path(__file__).resolve().parents[1]
EXPERIMENTS = REPO / "scripts" / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

import eval_western_p1_clean_domain_candidates as p1  # noqa: E402
import train_western_round6_full_score_candidate as candidate  # noqa: E402


CONTRACT = "western-round6-stage-a-clean-safety-v1"
P3_CONTRACT = "western-p3-staged-minimal-recording-protocol-v1"
LINEAGE_CONTRACT = "western-round6-stage-a-signoff-lineage-v1"
P3_PROTOCOL = (
    REPO
    / "docs/evidence/western-strings-p3-minimal-recording-preregistration-20260724.json"
)
ROUND6_CONTRACT = REPO / "config/western-strings-round6-counterbalanced-contract.json"
ROUND6_MANIFEST = (
    REPO / "data/private/western-strings-round6-counterbalanced/manifest.csv"
)
ROUND6_TRUTH = (
    REPO / "data/private/western-strings-round6-counterbalanced/position-truth.json"
)
POSITION_BALANCE = (
    REPO
    / "data/experiments/western-strings-round6-counterbalanced-position-balance/report.json"
)
SIGNOFF_LINEAGE = (
    REPO / "data/experiments/western-strings-round6-stage-a-signoff/ledger.json"
)
CONSUMED_LEDGER = (
    REPO / "data/experiments/western-strings-round6-stage-a-safety/consumed-ledger.json"
)
OUT_REPORT = (
    REPO / "data/experiments/western-strings-round6-stage-a-safety/report.json"
)
OUT_MODEL = (
    REPO / "data/experiments/western-strings-round6-stage-a-safety/model.joblib"
)
GATES = ("merged_substitution", "missing", "extra", "drag")


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def read_csv(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    except FileNotFoundError:
        return []


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except FileNotFoundError:
        return ""
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def relative(repo: Path, path: Path) -> str:
    return path.resolve().relative_to(repo.resolve()).as_posix()


def same_strings(left: list[str], right: list[str]) -> bool:
    return sorted(left) == sorted(right)


def protocol_semantic_sha(protocol: dict[str, Any]) -> str:
    core = {
        key: value
        for key, value in protocol.items()
        if key not in {
            "schemaVersion",
            "sourceBindings",
            "protocolSemanticSha256",
        }
    }
    return hashlib.sha256(canonical_json(core).encode("utf-8")).hexdigest()


def event_profile(
    rows: list[dict[str, str]],
    truth: dict[str, Any],
) -> tuple[dict[str, dict[str, int]], int, int, int]:
    counts = {
        gate: {"positive": 0, "confusionNegative": 0}
        for gate in GATES
    }
    event_count = 0
    signed_count = 0
    complete_count = 0
    recordings = truth.get("recordings") or {}
    for row in rows:
        recording = recordings.get(row["recordingId"]) or {}
        if recording.get("completeErrorInventory") is True:
            complete_count += 1
        for event in recording.get("events") or []:
            event_count += 1
            if str(event.get("asPerformed") or "").strip():
                signed_count += 1
            gate = str(event.get("gate") or "")
            label = str(event.get("label") or "")
            if gate not in counts:
                continue
            if label == "positive":
                counts[gate]["positive"] += 1
            elif label == "confusion_negative":
                counts[gate]["confusionNegative"] += 1
    return counts, event_count, signed_count, complete_count


def validate_stage_a_inputs(
    *,
    repo: Path,
    protocol_path: Path,
    contract_path: Path,
    manifest_path: Path,
    truth_path: Path,
    position_balance_path: Path,
    lineage_path: Path,
) -> dict[str, Any]:
    protocol = read_json(protocol_path)
    contract = read_json(contract_path)
    truth = read_json(truth_path)
    manifest = read_csv(manifest_path)
    position = read_json(position_balance_path)
    lineage = read_json(lineage_path)
    blockers: list[str] = []
    if protocol is None:
        blockers.append("round6-stage-a-protocol-missing")
        protocol = {}
    if protocol.get("contract") != P3_CONTRACT:
        blockers.append("round6-stage-a-protocol-contract-invalid")
    observed_semantic_sha = protocol_semantic_sha(protocol)
    expected_semantic_sha = str(protocol.get("protocolSemanticSha256") or "")
    if not expected_semantic_sha or observed_semantic_sha != expected_semantic_sha:
        blockers.append("round6-stage-a-protocol-semantic-sha-mismatch")

    binding_by_path = {
        str(row.get("path") or ""): str(row.get("sha256") or "")
        for row in protocol.get("sourceBindings") or []
    }
    mutable_paths = {
        relative(repo, manifest_path),
        relative(repo, truth_path),
    }
    source_hashes = {}
    for source_path, expected in binding_by_path.items():
        observed = sha256(repo / source_path)
        source_hashes[source_path] = observed
        if source_path in mutable_paths:
            if observed == expected:
                continue
            ledger_source = lineage.get("sourceHashes") if lineage else {}
            ledger_applied = lineage.get("appliedHashes") if lineage else {}
            ledger_key = (
                "manifestSha256"
                if source_path == relative(repo, manifest_path)
                else "truthSha256"
            )
            if (
                lineage is None
                or ledger_source.get(ledger_key) != expected
                or ledger_applied.get(ledger_key) != observed
            ):
                blockers.append(
                    f"round6-stage-a-source-lineage-invalid:{source_path}"
                )
        elif not expected or observed != expected:
            blockers.append(f"round6-stage-a-source-binding-stale:{source_path}")

    if contract is None or contract.get("contractVersion") != (
        "western-round6-counterbalanced-diagnosis-v1"
    ):
        blockers.append("round6-stage-a-round6-contract-invalid")
    if truth is None or truth.get("contractVersion") != (
        "western-round6-counterbalanced-diagnosis-v1"
    ):
        blockers.append("round6-stage-a-truth-contract-invalid")
        truth = {"recordings": {}}
    manifest_ids = [str(row.get("recordingId") or "") for row in manifest]
    truth_ids = list((truth.get("recordings") or {}).keys())
    if (
        len(manifest_ids) != 12
        or len(set(manifest_ids)) != 12
        or not same_strings(manifest_ids, truth_ids)
    ):
        blockers.append("round6-stage-a-manifest-truth-identity-invalid")

    stage_a_ids = [
        str(value)
        for value in protocol.get("stageA", {}).get("recordingIds", [])
    ]
    stage_b_ids = [
        str(value)
        for value in protocol.get("stageB", {}).get("recordingIds", [])
    ]
    calibration = [
        row for row in manifest if row.get("split") == "calibration"
    ]
    fresh = [
        row for row in manifest if row.get("split") == "fresh-blind"
    ]
    if (
        len(stage_a_ids) != 6
        or not same_strings(
            stage_a_ids,
            [str(row.get("recordingId") or "") for row in calibration],
        )
    ):
        blockers.append("round6-stage-a-calibration-scope-invalid")
    if (
        len(stage_b_ids) != 6
        or not same_strings(
            stage_b_ids,
            [str(row.get("recordingId") or "") for row in fresh],
        )
    ):
        blockers.append("round6-stage-a-fresh-scope-invalid")

    lineage_audio = (
        lineage.get("audioSha256ByRecording") if lineage else {}
    ) or {}
    if lineage is None or lineage.get("contract") != LINEAGE_CONTRACT:
        blockers.append("round6-stage-a-signoff-lineage-missing")
    else:
        if lineage.get("stagedProtocol", {}).get(
            "protocolSemanticSha256"
        ) != expected_semantic_sha:
            blockers.append("round6-stage-a-lineage-protocol-mismatch")
        if not same_strings(
            list(lineage.get("scope", {}).get("recordingIds") or []),
            stage_a_ids,
        ):
            blockers.append("round6-stage-a-lineage-recording-set-mismatch")

    required_consent = str(contract.get("privacy", {}).get("requiredConsent") or "")
    required_license = str(
        contract.get("privacy", {}).get("requiredLicenseStatus") or ""
    )
    for row in calibration:
        recording_id = row["recordingId"]
        audio_path = repo / row["audioPath"]
        if not audio_path.is_file():
            blockers.append(f"round6-stage-a-audio-missing:{recording_id}")
        elif sha256(audio_path) != lineage_audio.get(recording_id):
            blockers.append(f"round6-stage-a-audio-sha-mismatch:{recording_id}")
        for field in ("performerId", "deviceId", "roomId"):
            if not str(row.get(field) or "").strip():
                blockers.append(
                    f"round6-stage-a-recording-metadata-missing:{recording_id}:{field}"
                )
        if str(row.get("consent") or "").lower() != required_consent.lower():
            blockers.append(f"round6-stage-a-consent-invalid:{recording_id}")
        if str(row.get("licenseStatus") or "") != required_license:
            blockers.append(f"round6-stage-a-license-invalid:{recording_id}")
    for row in fresh:
        recording_id = row["recordingId"]
        if (repo / row["audioPath"]).exists():
            blockers.append(f"round6-stage-a-fresh-audio-present:{recording_id}")
        recording = truth.get("recordings", {}).get(recording_id) or {}
        if recording.get("completeErrorInventory") is True:
            blockers.append(
                f"round6-stage-a-fresh-inventory-already-signed:{recording_id}"
            )
        if any(
            str(event.get("asPerformed") or "").strip()
            for event in recording.get("events") or []
        ):
            blockers.append(
                f"round6-stage-a-fresh-truth-already-exposed:{recording_id}"
            )

    profile, event_count, signed_count, complete_count = event_profile(
        calibration,
        truth,
    )
    if event_count != 72:
        blockers.append(f"round6-stage-a-event-count-invalid:{event_count}/72")
    if signed_count != event_count:
        blockers.append(
            f"round6-stage-a-signed-event-count-invalid:{signed_count}/{event_count}"
        )
    if complete_count != 6:
        blockers.append(
            f"round6-stage-a-complete-inventory-count-invalid:{complete_count}/6"
        )
    for gate in GATES:
        if profile[gate] != {"positive": 6, "confusionNegative": 12}:
            blockers.append(f"round6-stage-a-gate-profile-invalid:{gate}")
    for field, expected_count in (
        ("performerId", 3),
        ("deviceId", 3),
        ("roomId", 2),
    ):
        observed = len({
            str(row.get(field) or "").strip()
            for row in calibration
            if str(row.get(field) or "").strip()
        })
        if observed < expected_count:
            blockers.append(
                f"round6-stage-a-{field}-coverage-invalid:{observed}/{expected_count}"
            )

    position_hashes = (position or {}).get("sourceHashes") or {}
    if (
        position is None
        or position.get("contract")
        != "western-round5-position-balance-preflight-v2"
        or position.get("readyForRecording") is not True
        or position.get("audioRead") is not False
        or position_hashes.get("manifestSha256") != sha256(manifest_path)
        or position_hashes.get("truthSha256") != sha256(truth_path)
        or position.get("confoundedSplitGates") != []
        or position.get("rhythmReviewHint", {}).get("confoundedSplits") != []
    ):
        blockers.append("round6-stage-a-position-balance-not-current")

    unique_blockers = sorted(set(blockers))
    return {
        "ready": not unique_blockers,
        "protocol": protocol,
        "contract": contract,
        "manifest": manifest,
        "truth": truth,
        "stageAIds": stage_a_ids,
        "stageBIds": stage_b_ids,
        "profile": profile,
        "counts": {
            "recordings": len(calibration),
            "events": event_count,
            "signedEvents": signed_count,
            "completeInventories": complete_count,
        },
        "sourceHashes": {
            "protocolSha256": sha256(protocol_path),
            "protocolSemanticSha256": expected_semantic_sha,
            "contractSha256": sha256(contract_path),
            "manifestSha256": sha256(manifest_path),
            "truthSha256": sha256(truth_path),
            "positionBalanceSha256": sha256(position_balance_path),
            "signoffLineageSha256": sha256(lineage_path),
        },
        "freshAudioRead": False,
        "blockingReasons": unique_blockers,
    }


def fit_models(
    dataset: list[dict[str, Any]],
) -> tuple[dict[str, RandomForestClassifier], list[str]]:
    feature_names = sorted({
        feature
        for row in dataset
        for feature in row.get("features", {})
    })
    missing = [
        feature
        for feature in candidate.REQUIRED_TEMPORAL_FEATURES
        if feature not in feature_names
    ]
    if missing:
        raise RuntimeError(
            "round6-stage-a-required-temporal-feature-missing:"
            + ",".join(missing)
        )
    models: dict[str, RandomForestClassifier] = {}
    for gate in GATES:
        rows = [row for row in dataset if row["gate"] == gate]
        labels = np.asarray([
            int(row["label"] == "positive")
            for row in rows
        ])
        if not rows or set(labels.tolist()) != {0, 1}:
            raise RuntimeError(f"round6-stage-a-class-support-missing:{gate}")
        matrix = np.asarray([
            [float(row["features"].get(name, 0.0)) for name in feature_names]
            for row in rows
        ])
        model = RandomForestClassifier(**candidate.MODEL_PARAMS)
        model.fit(matrix, labels)
        models[gate] = model
    return models, feature_names


def model_flags(
    item: dict[str, Any],
    models: dict[str, Any],
    feature_names: list[str],
) -> dict[str, set[int]]:
    position_count = len(item["take"]["notes"])
    features = [
        candidate.candidate_features(
            candidate.base.extract_segment_features(item["take"], note_index)
        )
        for note_index in range(position_count)
    ]
    matrix = np.asarray([
        [float(row.get(name, 0.0)) for name in feature_names]
        for row in features
    ])
    output: dict[str, set[int]] = {}
    for gate in GATES:
        model = models[gate]
        classes = list(model.classes_)
        if 1 not in classes:
            raise RuntimeError(f"round6-stage-a-positive-class-missing:{gate}")
        positive_column = classes.index(1)
        probabilities = model.predict_proba(matrix)[:, positive_column]
        output[gate] = {
            index
            for index, probability in enumerate(probabilities)
            if float(probability) >= 0.5
        }
    return output


def summarize_domain(
    *,
    domain_id: str,
    items: list[dict[str, Any]],
    models: dict[str, Any],
    feature_names: list[str],
    public_burden: bool,
) -> dict[str, Any]:
    recordings = []
    for item in items:
        flags_by_gate = model_flags(item, models, feature_names)
        union_flags = set().union(*flags_by_gate.values())
        truth = set().union(*item["truth"].values())
        position_count = len(item["take"]["notes"])
        counted = union_flags if public_burden else union_flags - truth
        denominator = position_count if public_burden else position_count - len(truth)
        recordings.append({
            "recordingId": item["recordingId"],
            "flagCount": len(union_flags),
            "countedNegativeOrBurdenFlags": len(counted),
            "positionCount": position_count,
            "countedPositionCount": denominator,
            "excludedKnownPositiveFlagCount": len(union_flags & truth),
            "flagsByGate": {
                gate: len(flags_by_gate[gate])
                for gate in GATES
            },
            "rate": round(len(counted) / max(1, denominator), 9),
        })
    flag_count = sum(
        row["countedNegativeOrBurdenFlags"] for row in recordings
    )
    denominator = sum(row["countedPositionCount"] for row in recordings)
    maximum_rate = max((row["rate"] for row in recordings), default=0.0)
    return {
        "domainId": domain_id,
        "evidenceRole": (
            "unadjudicated-real-professional-burden"
            if public_burden
            else (
                "consumed-complete-inventory-negative-diagnostic"
                if domain_id == "consumed-round5-known-negatives"
                else "authoritative-clean-negative"
            )
        ),
        "recordingCount": len(recordings),
        "flagCount": flag_count,
        "positionCount": denominator,
        "flagsPer1000Positions": round(
            1000.0 * flag_count / max(1, denominator),
            6,
        ),
        "maximumPerRecordingRate": round(maximum_rate, 9),
        "recordings": recordings,
    }


def prepare_clean_domains(
    *,
    repo: Path,
    protocol: dict[str, Any],
) -> dict[str, list[dict[str, Any]]]:
    p1.REPO = repo
    p1.ROUND5_TRUTH = repo / "data/private/western-strings-round5/position-truth.json"
    p1.temporal.REPO = repo
    datasets = protocol["datasets"]
    return {
        "authoritative-local-clean": [
            p1.prepare_local(row)
            for row in datasets["authoritative-local-clean"]["recordings"]
        ],
        "consumed-round5-known-negatives": [
            p1.prepare_round5(row)
            for row in datasets[
                "consumed-round5-known-negatives"
            ]["recordings"]
        ],
        "public-professional-burden": [
            p1.prepare_public(row)
            for row in datasets["public-professional-burden"]["recordings"]
        ],
    }


def safety_result(
    domains: dict[str, dict[str, Any]],
    limits: dict[str, Any],
) -> tuple[bool, list[str]]:
    local = domains["authoritative-local-clean"]
    round5 = domains["consumed-round5-known-negatives"]
    public = domains["public-professional-burden"]
    violations = []
    if local["flagCount"] > int(
        limits["authoritativeLocalCleanFalsePositiveMax"]
    ):
        violations.append("authoritative-local-clean-false-positive")
    if round5["flagCount"] > int(
        limits["consumedRound5KnownNegativeFalsePositiveMax"]
    ):
        violations.append("consumed-round5-known-negative-false-positive")
    if public["flagsPer1000Positions"] > float(
        limits["publicProfessionalBurdenPooledPer1000Max"]
    ):
        violations.append("public-professional-pooled-burden")
    if 1000.0 * public["maximumPerRecordingRate"] > float(
        limits["publicProfessionalBurdenAnyRecordingPer1000Max"]
    ):
        violations.append("public-professional-recording-burden")
    return not violations, violations


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run(
    *,
    repo: Path = REPO,
    protocol_path: Path = P3_PROTOCOL,
    contract_path: Path = ROUND6_CONTRACT,
    manifest_path: Path = ROUND6_MANIFEST,
    truth_path: Path = ROUND6_TRUTH,
    position_balance_path: Path = POSITION_BALANCE,
    lineage_path: Path = SIGNOFF_LINEAGE,
    consumed_ledger_path: Path = CONSUMED_LEDGER,
    report_path: Path = OUT_REPORT,
    model_path: Path = OUT_MODEL,
    execute: bool = False,
    build_dataset: Callable[..., list[dict[str, Any]]] | None = None,
    prepare_domains: Callable[..., dict[str, list[dict[str, Any]]]] | None = None,
) -> dict[str, Any]:
    preflight = validate_stage_a_inputs(
        repo=repo,
        protocol_path=protocol_path,
        contract_path=contract_path,
        manifest_path=manifest_path,
        truth_path=truth_path,
        position_balance_path=position_balance_path,
        lineage_path=lineage_path,
    )
    protocol = preflight["protocol"]
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "p3ProtocolSemanticSha256": protocol.get(
            "protocolSemanticSha256"
        ),
        "sourceHashes": preflight["sourceHashes"],
        "preflightReady": preflight["ready"],
        "executionRequested": execute,
        "trainingPerformed": False,
        "cleanSafetyEvaluationPerformed": False,
        "stageAPassed": False,
        "stageBFreshRecordingAuthorized": False,
        "freshAudioRead": False,
        "strictConfirmedRecall": "2/12",
        "studentFacing": False,
        "automaticAuthorizationGranted": False,
        "blockingReasons": list(preflight["blockingReasons"]),
    }
    if not execute or not preflight["ready"]:
        write_json(report_path, report)
        return report
    if consumed_ledger_path.exists():
        report["blockingReasons"] = ["round6-stage-a-clean-safety-already-consumed"]
        write_json(report_path, report)
        return report

    dataset_builder = build_dataset or candidate.build_dataset
    domain_preparer = prepare_domains or prepare_clean_domains
    candidate.REPO = repo
    candidate.base.REPO = repo
    try:
        dataset = dataset_builder(
            manifest_path,
            truth_path,
            include_splits={"calibration"},
        )
        models, feature_names = fit_models(dataset)
        model_path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({
            "contract": CONTRACT,
            "candidateContract": candidate.CONTRACT,
            "featureNames": feature_names,
            "modelParams": candidate.MODEL_PARAMS,
            "models": models,
            "sourceHashes": preflight["sourceHashes"],
        }, model_path)
        model_sha256 = sha256(model_path)
        write_json(consumed_ledger_path, {
            "schemaVersion": 1,
            "contract": "western-round6-stage-a-clean-safety-consumed-v1",
            "p3ProtocolSemanticSha256": protocol.get(
                "protocolSemanticSha256"
            ),
            "sourceHashes": preflight["sourceHashes"],
            "modelSha256": model_sha256,
            "cleanSafetyConsumed": True,
            "freshAudioRead": False,
            "studentFacing": False,
            "automaticAuthorizationGranted": False,
        })
        report.update({
            "trainingPerformed": True,
            "datasetRows": len(dataset),
            "featureNames": feature_names,
            "modelArtifact": {
                "path": relative(repo, model_path),
                "sha256": model_sha256,
            },
        })

        p1_protocol = read_json(
            repo
            / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
        )
        if p1_protocol is None:
            raise RuntimeError("round6-stage-a-p1-protocol-missing")
        prepared = domain_preparer(repo=repo, protocol=p1_protocol)
        domains = {
            domain_id: summarize_domain(
                domain_id=domain_id,
                items=items,
                models=models,
                feature_names=feature_names,
                public_burden=domain_id == "public-professional-burden",
            )
            for domain_id, items in prepared.items()
        }
        limits = protocol["stageA"]["cleanSafetyLimits"]
        passed, violations = safety_result(domains, limits)
        report.update({
            "cleanSafetyEvaluationPerformed": True,
            "domains": domains,
            "cleanSafetyLimits": limits,
            "safetyLimitViolations": violations,
            "stageAPassed": passed,
            "stageBFreshRecordingAuthorized": passed,
            "blockingReasons": (
                []
                if passed
                else [
                    "round6-stage-a-clean-safety-failed",
                    *violations,
                ]
            ),
        })
    except Exception as error:  # fail-closed after the consumed ledger boundary
        report.update({
            "cleanSafetyEvaluationPerformed": False,
            "stageAPassed": False,
            "stageBFreshRecordingAuthorized": False,
            "blockingReasons": [
                f"round6-stage-a-evaluation-error:{type(error).__name__}",
            ],
        })
    write_json(report_path, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--protocol", type=Path, default=P3_PROTOCOL)
    parser.add_argument("--contract", type=Path, default=ROUND6_CONTRACT)
    parser.add_argument("--manifest", type=Path, default=ROUND6_MANIFEST)
    parser.add_argument("--truth", type=Path, default=ROUND6_TRUTH)
    parser.add_argument(
        "--position-balance",
        type=Path,
        default=POSITION_BALANCE,
    )
    parser.add_argument("--lineage", type=Path, default=SIGNOFF_LINEAGE)
    parser.add_argument("--consumed-ledger", type=Path, default=CONSUMED_LEDGER)
    parser.add_argument("--report", type=Path, default=OUT_REPORT)
    parser.add_argument("--model", type=Path, default=OUT_MODEL)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    report = run(
        protocol_path=args.protocol,
        contract_path=args.contract,
        manifest_path=args.manifest,
        truth_path=args.truth,
        position_balance_path=args.position_balance,
        lineage_path=args.lineage,
        consumed_ledger_path=args.consumed_ledger,
        report_path=args.report,
        model_path=args.model,
        execute=args.execute,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.require_ready:
        expected = (
            report["cleanSafetyEvaluationPerformed"]
            if args.execute
            else report["preflightReady"]
        )
        return 0 if expected else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
