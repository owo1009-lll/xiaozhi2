#!/usr/bin/env python3
"""Run the SHA-frozen P1 candidates on existing real clean evidence.

The preregistration and this runner must already be committed before main()
will execute.  No fitting, sweep, threshold selection, or result-dependent
branch changes candidate semantics.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import subprocess
import sys
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import numpy as np
from music21 import converter


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = REPO / "scripts/experiments"
sys.path.insert(0, str(EXPERIMENTS))

import eval_western_round5_temporal_operation_path as temporal  # noqa: E402
from eval_western_strings_injected_errors_dynamic_gate import CACHE as LOCAL_CACHE  # noqa: E402
from eval_western_strings_m0_bach10 import basic_pitch_events  # noqa: E402


PREREG_SCRIPT = EXPERIMENTS / "preregister_western_p1_clean_domain_candidates.py"
PREREG_JSON = (
    REPO / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
)
OUT_JSON = REPO / "data/experiments/western-strings-p1-clean-domain-candidates/report.json"
EVIDENCE_JSON = REPO / "docs/evidence/western-strings-p1-clean-domain-safety-20260724.json"
EVIDENCE_MD = REPO / "docs/western-strings-p1-clean-domain-safety.md"

ROUND5_TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
PITCH_POLICY = EXPERIMENTS / "western_strings_m3plus_runtime_policy.py"
TRACKED_FREEZE_FILES = [
    PREREG_SCRIPT,
    PREREG_JSON,
    REPO / "docs/western-strings-p1-clean-domain-preregistration.md",
    Path(__file__).resolve(),
    REPO / "scripts/test-western-p1-clean-domain-preregistration.py",
    REPO / "scripts/test-western-p1-clean-domain-candidates.py",
]

TEMPORAL_CANDIDATES = {
    "alignment-gap-refined-self-check-v1",
    "alignment-gap-strict-missing-v1",
    "relative-ioi-duration-review-v1",
    "relative-ioi-duration-strict-v1",
    "onset-density-extra-strict-v1",
    "temporal-operation-sequence-union-v1",
}
PITCH_CANDIDATE = "pitch-trajectory-center-strict-v1"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def load_preregistration_module():
    spec = importlib.util.spec_from_file_location("p1_preregistration", PREREG_SCRIPT)
    if not spec or not spec.loader:
        raise RuntimeError("p1-preregistration-module-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_preregistration() -> tuple[dict[str, Any], str, str]:
    module = load_preregistration_module()
    stored = read_json(PREREG_JSON)
    rebuilt = module.build_protocol()
    if stored != rebuilt:
        raise RuntimeError("p1-preregistration-or-source-binding-drift")
    semantic = dict(stored)
    expected_sha = semantic.pop("protocolSemanticSha256")
    actual_sha = hashlib.sha256(canonical_json(semantic).encode()).hexdigest()
    if actual_sha != expected_sha:
        raise RuntimeError("p1-preregistration-semantic-sha-mismatch")

    temporal_params = {
        gate: params.as_dict()
        for gate, params in temporal.FROZEN_PARAMS_BY_GATE.items()
    }
    candidate_map = {row["candidateId"]: row for row in stored["candidates"]}
    for candidate_id in TEMPORAL_CANDIDATES:
        thresholds = candidate_map[candidate_id]["thresholds"]
        if "temporalParamsByGate" in thresholds:
            if thresholds["temporalParamsByGate"] != temporal_params:
                raise RuntimeError(f"p1-temporal-params-drift:{candidate_id}")
        elif thresholds.get("temporalParams") != temporal_params["extra"]:
            raise RuntimeError(f"p1-extra-temporal-params-drift:{candidate_id}")

    execution_head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    freeze_commit = subprocess.run(
        ["git", "log", "-n", "1", "--format=%H", "--", relative(PREREG_JSON)],
        cwd=REPO,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", *[relative(path) for path in TRACKED_FREEZE_FILES]],
        cwd=REPO,
        text=True,
        capture_output=True,
    )
    if tracked.returncode != 0:
        raise RuntimeError("p1-freeze-files-not-committed")
    clean = subprocess.run(
        ["git", "diff", "--quiet", "HEAD", "--", *[relative(path) for path in TRACKED_FREEZE_FILES]],
        cwd=REPO,
    )
    if clean.returncode != 0:
        raise RuntimeError("p1-freeze-files-modified-after-commit")
    if not freeze_commit:
        raise RuntimeError("p1-preregistration-freeze-commit-missing")
    return stored, freeze_commit, execution_head


def empty_truth() -> dict[str, set[int]]:
    return {gate: set() for gate in temporal.GATES}


def prepare_local(row: dict[str, Any]) -> dict[str, Any]:
    score = REPO / row["scorePath"]
    audio = REPO / row["audioPath"]
    parsed = converter.parse(str(score))
    polyphonic = any(len(note.pitches) > 1 for note in parsed.flatten().notes)
    if polyphonic:
        notes = []
        durations = []
        for note in parsed.flatten().notes:
            midis = sorted(int(pitch.midi) for pitch in note.pitches)
            notes.append(
                {
                    "midi": midis[0],
                    "midis": midis,
                    "scoreUnit": float(note.offset),
                    "scoreOnsetUnit": float(note.offset),
                }
            )
            durations.append(max(0.125, float(note.quarterLength)))
        events = temporal.filter_events(
            basic_pitch_events(audio, LOCAL_CACHE),
            temporal.EVENT_FILTER["minConfidence"],
            temporal.EVENT_FILTER["minDurationSeconds"],
        )
        take_rows = temporal.build_rows(notes, events)
        for take_row in take_rows:
            take_row["selected"] = temporal.shadow_selected(take_row)
        assignments = temporal.assign_basic_pitch_events(notes, events)
        matched = {assignment["eventIndex"] for assignment in assignments if assignment}
        item = {
            "recordingId": row["recordingId"],
            "pieceId": row.get("pieceId", row["recordingId"]),
            "scorePath": score,
            "audioPath": audio,
            "take": {
                "notes": notes,
                "rows": take_rows,
                "events": events,
                "unassigned": [
                    event for index, event in enumerate(events) if index not in matched
                ],
            },
            "durations": durations,
            "onset": temporal.onset_context(audio),
            "polyphonicDeterministicProjection": "lowest-written-pitch-per-onset",
        }
    else:
        item = temporal.prepare_take(
            row["recordingId"],
            row.get("pieceId", row["recordingId"]),
            score,
            audio,
        )
    item["truth"] = empty_truth()
    item["metadata"] = row
    return item


def round5_truth_indices(recording_id: str, score_path: Path) -> dict[str, set[int]]:
    truth = read_json(ROUND5_TRUTH)
    record = truth["recordings"][recording_id]
    if record.get("completeErrorInventory") is not True:
        raise RuntimeError(f"round5-complete-inventory-missing:{recording_id}")
    positions = temporal.score_positions(score_path)
    output = empty_truth()
    for event in record["events"]:
        if event["label"] != "positive":
            continue
        output[event["gate"]].add(temporal.truth_note_index(positions, event))
    if sum(len(values) for values in output.values()) != 4:
        raise RuntimeError(f"round5-positive-count-not-four:{recording_id}")
    return output


def prepare_round5(row: dict[str, Any]) -> dict[str, Any]:
    score = REPO / row["scorePath"]
    audio = REPO / row["audioPath"]
    item = temporal.prepare_take(row["recordingId"], row["recordingId"], score, audio)
    item["truth"] = round5_truth_indices(row["recordingId"], score)
    item["metadata"] = row
    return item


def prepare_public(row: dict[str, Any]) -> dict[str, Any]:
    score_path = REPO / row["scorePath"]
    audio_path = REPO / row["audioPath"]
    cache_path = REPO / row["basicPitchCachePath"]
    expanded_score = converter.parse(str(score_path)).expandRepeats()
    notes = []
    durations = []
    for note in expanded_score.flatten().notes:
        midis = sorted(int(pitch.midi) for pitch in note.pitches)
        notes.append(
            {
                "midi": midis[0],
                "midis": midis,
                "scoreUnit": float(note.offset),
                "scoreOnsetUnit": float(note.offset),
            }
        )
        durations.append(max(0.125, float(note.quarterLength)))
    events = temporal.filter_events(
        temporal.load_events(cache_path.parent, audio_path),
        temporal.EVENT_FILTER["minConfidence"],
        temporal.EVENT_FILTER["minDurationSeconds"],
    )
    take_rows = temporal.build_rows(notes, events)
    for take_row in take_rows:
        take_row["selected"] = temporal.shadow_selected(take_row)
    assignments = temporal.assign_basic_pitch_events(notes, events)
    matched = {assignment["eventIndex"] for assignment in assignments if assignment}
    return {
        "recordingId": row["recordingId"],
        "pieceId": row["work"],
        "scorePath": score_path,
        "audioPath": audio_path,
        "cachePath": cache_path,
        "take": {
            "notes": notes,
            "rows": take_rows,
            "events": events,
            "unassigned": [
                event for index, event in enumerate(events) if index not in matched
            ],
        },
        "durations": durations,
        "onset": temporal.onset_context(audio_path),
        "truth": empty_truth(),
        "metadata": row,
    }


def prediction_sets(item: dict[str, Any]) -> dict[str, set[int]]:
    cache: dict[temporal.Params, dict[str, set[int]]] = {}
    predictions: dict[str, set[int]] = {}
    for gate in temporal.GATES:
        params = temporal.FROZEN_PARAMS_BY_GATE[gate]
        if params not in cache:
            cache[params] = temporal.predict_operations(item, params)
        predictions[gate] = cache[params][gate]
    return predictions


def onset_density_indices(item: dict[str, Any]) -> set[int]:
    params = temporal.FROZEN_PARAMS_BY_GATE["extra"]
    operations, events, _ = temporal.align_operation_path(
        item["take"], item["durations"], params
    )
    selected = set()
    for operation in operations:
        if operation["kind"] != "match" or operation["pitchDistance"] != 0:
            continue
        event = events[operation["events"][0]]
        ratio = temporal.interior_attack_ratio(
            item["onset"], event["start"], event["end"]
        )
        if ratio >= 0.85:
            selected.add(operation["score"][0])
    return selected


def temporal_candidate_flags(item: dict[str, Any]) -> dict[str, set[int]]:
    predictions = prediction_sets(item)
    _, gap_review = temporal.policy_c_gap_refinement_indices(
        item["take"], predictions, item.get("policyCGapIndices")
    )
    _, gap_strict, _ = temporal.gap_strict_issue_candidate_indices(
        item["take"], predictions, item.get("policyCGapIndices")
    )
    rhythm_review = temporal.rhythm_structural_refinement_indices(
        item["take"], predictions, temporal.RHYTHM_REFINEMENT
    )
    rhythm_strict = temporal.rhythm_structural_refinement_indices(
        item["take"], predictions, temporal.RHYTHM_STRICT_ISSUE_CANDIDATE
    )
    return {
        "alignment-gap-refined-self-check-v1": gap_review,
        "alignment-gap-strict-missing-v1": gap_strict,
        "relative-ioi-duration-review-v1": rhythm_review,
        "relative-ioi-duration-strict-v1": rhythm_strict,
        "onset-density-extra-strict-v1": onset_density_indices(item),
        "temporal-operation-sequence-union-v1": set().union(*predictions.values()),
    }


def rate(numerator: int, denominator: int) -> float:
    return round(numerator / max(1, denominator), 9)


def summarize_domain(
    *,
    role: str,
    records: list[dict[str, Any]],
    count_field: str,
    denominator_field: str,
    authoritative_false_positive: bool,
) -> dict[str, Any]:
    count = sum(int(row[count_field]) for row in records)
    denominator = sum(int(row[denominator_field]) for row in records)
    maximum = max((row["rate"] for row in records), default=0.0)
    return {
        "evidenceRole": role,
        "recordingCount": len(records),
        "flagCount": count,
        "positionCount": denominator,
        "rate": rate(count, denominator),
        "flagsPer1000Positions": round(1000.0 * count / max(1, denominator), 6),
        "maximumPerRecordingRate": round(maximum, 9),
        "falsePositiveCountAuthoritative": authoritative_false_positive,
        "recordings": records,
    }


def evaluate_temporal_dataset(
    *,
    dataset_id: str,
    rows: Iterable[dict[str, Any]],
    prepare: Callable[[dict[str, Any]], dict[str, Any]],
    public_burden: bool = False,
) -> dict[str, dict[str, Any]]:
    per_candidate = {candidate_id: [] for candidate_id in TEMPORAL_CANDIDATES}
    for source in rows:
        item = prepare(source)
        position_count = len(item["take"]["notes"])
        truth = set().union(*item["truth"].values())
        negative = set(range(position_count)) - truth
        flags = temporal_candidate_flags(item)
        for candidate_id, indices in flags.items():
            if not indices <= set(range(position_count)):
                raise RuntimeError(
                    f"candidate-index-out-of-range:{dataset_id}:{source['recordingId']}:{candidate_id}"
                )
            if public_burden:
                counted = indices
                denominator = position_count
            else:
                counted = indices & negative
                denominator = len(negative)
            per_candidate[candidate_id].append(
                {
                    "recordingId": source["recordingId"],
                    "flagCount": len(indices),
                    "countedNegativeOrBurdenFlags": len(counted),
                    "positionCount": position_count,
                    "countedPositionCount": denominator,
                    "excludedKnownPositiveFlagCount": len(indices & truth),
                    "rate": rate(len(counted), denominator),
                }
            )
        print(
            json.dumps(
                {
                    "event": "p1-clean-domain-recording-complete",
                    "dataset": dataset_id,
                    "recordingId": source["recordingId"],
                    "positionCount": position_count,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    output = {}
    for candidate_id, records in per_candidate.items():
        output[candidate_id] = summarize_domain(
            role=(
                "unadjudicated-real-professional-burden"
                if public_burden
                else (
                    "consumed-complete-inventory-negative-diagnostic"
                    if dataset_id == "consumed-round5-known-negatives"
                    else "authoritative-clean-negative"
                )
            ),
            records=records,
            count_field="countedNegativeOrBurdenFlags",
            denominator_field="countedPositionCount",
            authoritative_false_positive=not public_burden,
        )
    return output


def evaluate_pitch_dataset(rows: list[dict[str, str]]) -> dict[str, Any]:
    expected_policy = read_json(PREREG_JSON)["candidates"]
    expected_thresholds = next(
        row["thresholds"]
        for row in expected_policy
        if row["candidateId"] == PITCH_CANDIDATE
    )
    records = []
    for source in rows:
        artifact = read_json(REPO / source["candidateRowsPath"])
        candidate_rows = artifact["candidateRows"]
        flags = 0
        for row in candidate_rows:
            evidence = row.get("m3plusPitchSafetyEvidence")
            if not isinstance(evidence, dict):
                raise RuntimeError(
                    f"pitch-evidence-missing:{source['recordingId']}:{row.get('noteIndex')}"
                )
            if evidence.get("thresholds") != expected_thresholds:
                raise RuntimeError(
                    f"pitch-threshold-drift:{source['recordingId']}:{row.get('noteIndex')}"
                )
            if evidence.get("studentFacing") is not False:
                raise RuntimeError(
                    f"pitch-row-student-facing:{source['recordingId']}:{row.get('noteIndex')}"
                )
            flags += int(evidence.get("decision") == "issue_detected")
        records.append(
            {
                "recordingId": source["recordingId"],
                "flagCount": flags,
                "countedNegativeOrBurdenFlags": flags,
                "positionCount": len(candidate_rows),
                "countedPositionCount": len(candidate_rows),
                "excludedKnownPositiveFlagCount": 0,
                "rate": rate(flags, len(candidate_rows)),
                "candidateRowsPath": source["candidateRowsPath"],
            }
        )
        print(
            json.dumps(
                {
                    "event": "p1-pitch-artifact-complete",
                    "recordingId": source["recordingId"],
                    "positionCount": len(candidate_rows),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    return summarize_domain(
        role="authoritative-clean-negative-current-pitch-runtime",
        records=records,
        count_field="countedNegativeOrBurdenFlags",
        denominator_field="countedPositionCount",
        authoritative_false_positive=True,
    )


def elimination_decision(
    candidate: dict[str, Any], domains: dict[str, dict[str, Any]], rules: dict[str, Any]
) -> tuple[bool, list[str]]:
    semantic = candidate["outputSemantic"]
    rule_key = (
        "automatic_issue_candidate" if semantic == "automatic_issue_candidate" else "review_hint"
    )
    rule = rules[rule_key]
    reasons: list[str] = []
    local = domains.get("authoritative-local-clean") or domains.get(
        "pitch-artifact-local-clean"
    )
    round5 = domains.get("consumed-round5-known-negatives")
    public = domains.get("public-professional-burden")
    if rule_key == "automatic_issue_candidate":
        if (
            local
            and local["flagCount"] > rule["authoritativeLocalCleanFalsePositiveMax"]
        ):
            reasons.append("authoritative-local-clean-false-positive")
        if (
            round5
            and round5["flagCount"]
            > rule["consumedRound5KnownNegativeFalsePositiveMax"]
        ):
            reasons.append("consumed-round5-known-negative-false-positive")
        if (
            public
            and public["flagsPer1000Positions"]
            > rule["publicProfessionalBurdenPooledPer1000Max"]
        ):
            reasons.append("public-professional-pooled-burden")
        if (
            public
            and 1000.0 * public["maximumPerRecordingRate"]
            > rule["publicProfessionalBurdenAnyRecordingPer1000Max"]
        ):
            reasons.append("public-professional-recording-burden")
    else:
        if local and local["rate"] > rule["authoritativeLocalCleanHintRateMax"]:
            reasons.append("authoritative-local-clean-pooled-hint-rate")
        if (
            local
            and local["maximumPerRecordingRate"]
            > rule["authoritativeLocalCleanAnyRecordingHintRateMax"]
        ):
            reasons.append("authoritative-local-clean-recording-hint-rate")
        if (
            round5
            and round5["rate"] > rule["consumedRound5KnownNegativeHintRateMax"]
        ):
            reasons.append("consumed-round5-pooled-hint-rate")
        if (
            round5
            and round5["maximumPerRecordingRate"]
            > rule["consumedRound5AnyRecordingHintRateMax"]
        ):
            reasons.append("consumed-round5-recording-hint-rate")
        if (
            public
            and public["flagsPer1000Positions"]
            > rule["publicProfessionalBurdenPooledPer1000Max"]
        ):
            reasons.append("public-professional-pooled-burden")
        if (
            public
            and 1000.0 * public["maximumPerRecordingRate"]
            > rule["publicProfessionalBurdenAnyRecordingPer1000Max"]
        ):
            reasons.append("public-professional-recording-burden")
    return bool(reasons), reasons


def build_report(
    protocol: dict[str, Any],
    preregistration_commit: str,
    execution_commit: str,
) -> dict[str, Any]:
    datasets = protocol["datasets"]
    local_results = evaluate_temporal_dataset(
        dataset_id="authoritative-local-clean",
        rows=datasets["authoritative-local-clean"]["recordings"],
        prepare=prepare_local,
    )
    round5_results = evaluate_temporal_dataset(
        dataset_id="consumed-round5-known-negatives",
        rows=datasets["consumed-round5-known-negatives"]["recordings"],
        prepare=prepare_round5,
    )
    public_results = evaluate_temporal_dataset(
        dataset_id="public-professional-burden",
        rows=datasets["public-professional-burden"]["recordings"],
        prepare=prepare_public,
        public_burden=True,
    )
    pitch_result = evaluate_pitch_dataset(
        datasets["pitch-artifact-local-clean"]["recordings"]
    )

    candidate_results = []
    for candidate in protocol["candidates"]:
        candidate_id = candidate["candidateId"]
        if candidate_id == PITCH_CANDIDATE:
            domains = {"pitch-artifact-local-clean": pitch_result}
        else:
            domains = {
                "authoritative-local-clean": local_results[candidate_id],
                "consumed-round5-known-negatives": round5_results[candidate_id],
                "public-professional-burden": public_results[candidate_id],
            }
        eliminated, reasons = elimination_decision(
            candidate, domains, protocol["eliminationRules"]
        )
        candidate_results.append(
            {
                "candidateId": candidate_id,
                "family": candidate["family"],
                "outputSemantic": candidate["outputSemantic"],
                "applicableDatasets": candidate["applicableDatasets"],
                "domains": domains,
                "eliminated": eliminated,
                "eliminationReasons": reasons,
                "retainedForRecallAuditOnly": not eliminated,
                "promotionReady": False,
                "studentFacing": False,
                "automaticAdoptionReady": False,
            }
        )

    eliminated_ids = [
        row["candidateId"] for row in candidate_results if row["eliminated"]
    ]
    retained_ids = [
        row["candidateId"] for row in candidate_results if not row["eliminated"]
    ]
    report: dict[str, Any] = {
        "schemaVersion": "western-p1-clean-domain-safety-evaluation-v1",
        "preregistration": {
            "path": relative(PREREG_JSON),
            "artifactSha256": sha256(PREREG_JSON),
            "protocolSemanticSha256": protocol["protocolSemanticSha256"],
            "sourceBindingsAggregateSha256": protocol["sourceBindings"][
                "aggregateSha256"
            ],
            "gitCommitShaBeforeEvaluation": preregistration_commit,
            "executionRunnerCommitSha": execution_commit,
            "frozenBeforeEvaluation": True,
        },
        "executionDiscipline": {
            "candidateCount": len(protocol["candidates"]),
            "candidateRetuned": False,
            "thresholdChanged": False,
            "inputSelectionChanged": False,
            "blindResultUsedForSelection": False,
            "round4Round5ReusedAsAcceptance": False,
            "syntheticRecallReportedAsReal": False,
            "priorFailedAttempt": {
                "runnerCommitSha": preregistration_commit,
                "outcome": "no-report-deterministic-input-parser-crash",
                "reason": "r2-07 polyphonic MusicXML failed the inherited injection-index isomorphism assertion",
                "candidateCountsPrintedOrRead": False,
                "thresholdChangedAfterAttempt": False,
                "inputSelectionChangedAfterAttempt": False,
                "correction": "support the already-frozen polyphonic input with the same lowest-written-pitch projection used by the public-score path",
            },
        },
        "candidateResults": candidate_results,
        "conclusions": {
            "eliminatedCandidateIds": eliminated_ids,
            "retainedCandidateIds": retained_ids,
            "retainedCandidatesMayProceedToRecallAuditOnly": True,
            "retainedCandidatesPromotionReady": False,
            "studentFacing": False,
            "automaticAccusationReady": False,
            "automaticAdoptionReady": False,
            "publicFlagsAreBurdenNotAuthoritativeFalsePositives": True,
        },
        "stopLines": {
            "m4Omr": "no-further-investment",
            "waveformEnergyMissingNote": "no-further-investment",
        },
        "studentSwitches": {
            "ordinaryUploadAutoFeedbackReady": False,
            "m3plusAutoFeedbackReady": False,
            "m4OmrAutoScoreReady": False,
        },
    }
    report["evidenceSemanticSha256"] = hashlib.sha256(
        canonical_json(report).encode()
    ).hexdigest()
    return report


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# P1 真实干净域“不冤枉”评测",
        "",
        f"- 预注册语义 SHA：`{report['preregistration']['protocolSemanticSha256']}`",
        f"- 预注册 Git commit：`{report['preregistration']['gitCommitShaBeforeEvaluation']}`",
        "- 本轮未调参、未改阈值、未改变输入清单；只按冻结门槛淘汰。",
        "- 公开专业演奏没有逐音错误 gold，因此只报告标注负担，不冒充 FP。",
        "",
        "| candidate | local clean | Round 5 known negatives | public burden | decision |",
        "|---|---:|---:|---:|---|",
    ]
    for candidate in report["candidateResults"]:
        domains = candidate["domains"]
        local = domains.get("authoritative-local-clean") or domains.get(
            "pitch-artifact-local-clean"
        )
        round5 = domains.get("consumed-round5-known-negatives")
        public = domains.get("public-professional-burden")
        local_text = (
            f"{local['flagCount']}/{local['positionCount']} "
            f"({local['flagsPer1000Positions']:.2f}/1000)"
            if local
            else "N/A"
        )
        round5_text = (
            f"{round5['flagCount']}/{round5['positionCount']} "
            f"({round5['flagsPer1000Positions']:.2f}/1000)"
            if round5
            else "N/A"
        )
        public_text = (
            f"{public['flagCount']}/{public['positionCount']} "
            f"({public['flagsPer1000Positions']:.2f}/1000)"
            if public
            else "N/A"
        )
        decision = (
            "淘汰：" + ",".join(candidate["eliminationReasons"])
            if candidate["eliminated"]
            else "保留到召回审计（非晋升）"
        )
        lines.append(
            f"| `{candidate['candidateId']}` | {local_text} | {round5_text} | "
            f"{public_text} | {decision} |"
        )
    conclusions = report["conclusions"]
    lines.extend(
        [
            "",
            "## 结论",
            "",
            f"- 淘汰：{', '.join(conclusions['eliminatedCandidateIds']) or '无'}。",
            f"- 仅保留到召回审计：{', '.join(conclusions['retainedCandidateIds']) or '无'}。",
            "- “保留”不等于晋升；没有真实错误召回证据仍不得进入学生自动指控。",
            "- Round 4/5 仍是已消费材料，三开关继续 false；M4 OMR 与能量验漏音维持 stop-line。",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=OUT_JSON)
    parser.add_argument("--evidence-json", type=Path, default=EVIDENCE_JSON)
    parser.add_argument("--evidence-md", type=Path, default=EVIDENCE_MD)
    args = parser.parse_args()

    protocol, preregistration_commit, execution_commit = validate_preregistration()
    report = build_report(protocol, preregistration_commit, execution_commit)
    for path in (args.out, args.evidence_json):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    args.evidence_md.parent.mkdir(parents=True, exist_ok=True)
    args.evidence_md.write_text(markdown(report), encoding="utf-8")
    print(
        json.dumps(
            {
                "schemaVersion": report["schemaVersion"],
                "eliminatedCandidateIds": report["conclusions"][
                    "eliminatedCandidateIds"
                ],
                "retainedCandidateIds": report["conclusions"]["retainedCandidateIds"],
                "evidenceSemanticSha256": report["evidenceSemanticSha256"],
                "out": relative(args.out.resolve()),
                "evidenceJson": relative(args.evidence_json.resolve()),
                "evidenceMarkdown": relative(args.evidence_md.resolve()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
