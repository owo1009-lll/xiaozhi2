#!/usr/bin/env python3
"""Freeze P1 clean-domain candidate semantics and inputs before evaluation.

This script is intentionally result-blind.  It inventories already-existing
audio/score pairs and candidate artifacts, binds their bytes, and writes the
candidate/threshold/elimination contract.  It never executes a candidate and
never reads a candidate decision or metric.
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
OUT_JSON = REPO / "docs/evidence/western-strings-p1-clean-domain-preregistration-20260724.json"
OUT_MD = REPO / "docs/western-strings-p1-clean-domain-preregistration.md"

ROUND2_MANIFEST = REPO / "data/private/western-strings-round2/manifest.csv"
ROUND2_FB_MANIFEST = REPO / "data/private/western-strings-round2-fresh-blind/manifest.csv"
ROUND3 = REPO / "data/private/western-strings-round3"
ROUND4_MANIFEST = REPO / "data/private/western-strings-round4/manifest.csv"
ROUND4_REPORT = REPO / "data/experiments/western-strings-round4/ordinary-fresh-blind/report.json"
ROUND5_MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
ROUND5_TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
ROUND2_FB_REPORT = REPO / "data/experiments/western-strings-m3/ordinary-fresh-blind/report.json"
ROUND3_ACCEPTANCE = (
    REPO
    / "data/experiments/western-strings-m3/ordinary-dynamic-shadow-r3-acceptance/report.json"
)
BACH_AUDIT = REPO / "data/experiments/western-strings-bach-violin-dataset-audit.json"
BACH_CACHE = REPO / "data/experiments/western-strings-bach-violin-basic-pitch-cache"

TEMPORAL_SOURCE = REPO / "scripts/experiments/eval_western_round5_temporal_operation_path.py"
PITCH_POLICY_SOURCE = REPO / "scripts/experiments/western_strings_m3plus_runtime_policy.py"

LOCAL_SELECTIONS = {
    "round2": {
        "round2-r2-01-20260715",
        "round2-r2-05-20260715",
        "round2-r2-06-20260715",
        "round2-r2-07-20260715",
        "round2-r2-08-20260715",
    },
    "round2-fresh-blind": {
        "r2fb-01-20260718",
        "r2fb-05-20260718",
        "r2fb-06-20260718",
        "r2fb-07-20260718",
        "r2fb-08-20260718",
    },
    "round3": {"r3-01", "r3-02", "r3-03"},
    "round4": {"round4-r4-01", "round4-r4-02", "round4-r4-03", "round4-r4-04"},
}

# Inventory-only selection made before candidate execution:
# - one structurally low-polyphony unseen-performer anchor for each available
#   performer/work combination needed to cover BWV1001/2/3/6;
# - development-reference anchors for the otherwise uncovered BWV1004/5;
# - a second independent BWV1006 performer.
PUBLIC_UNITS = {
    "emil-telmanyi_bwv1004_mov4",
    "emil-telmanyi_bwv1005_mov4",
    "john-garner_bwv1002_mov6",
    "karen-gomyo_bwv1006_mov7",
    "ko-donghwi_bwv1001_mov4",
    "minji-kim_bwv1003_mov4",
    "oliver-colbentson_bwv1006_mov7",
}

PITCH_LOCAL_IDS = {
    "r2fb-01-20260718",
    "r2fb-05-20260718",
    "r2fb-06-20260718",
    "r2fb-07-20260718",
    "r2fb-08-20260718",
    "r3-02",
    "r3-03",
    "round4-r4-01",
    "round4-r4-02",
    "round4-r4-03",
    "round4-r4-04",
}

FROZEN_TEMPORAL_PARAMS = {
    "merged_substitution": {
        "minConfidence": 0.45,
        "pitchWeight": 0.50,
        "deletePenalty": 0.80,
        "insertPenalty": 1.10,
        "mergePenalty": 0.20,
        "durationWeight": 0.30,
        "reattackRatio": 0.70,
        "dragDurationRatio": 1.30,
        "dragIoiRatio": 0.15,
    },
    "missing": {
        "minConfidence": 0.45,
        "pitchWeight": 0.50,
        "deletePenalty": 0.80,
        "insertPenalty": 0.80,
        "mergePenalty": 0.45,
        "durationWeight": 0.15,
        "reattackRatio": 0.70,
        "dragDurationRatio": 1.30,
        "dragIoiRatio": 0.15,
    },
    "extra": {
        "minConfidence": 0.55,
        "pitchWeight": 0.50,
        "deletePenalty": 0.80,
        "insertPenalty": 1.10,
        "mergePenalty": 0.20,
        "durationWeight": 0.30,
        "reattackRatio": 0.85,
        "dragDurationRatio": 1.30,
        "dragIoiRatio": 0.15,
    },
    "drag": {
        "minConfidence": 0.45,
        "pitchWeight": 0.50,
        "deletePenalty": 0.80,
        "insertPenalty": 0.80,
        "mergePenalty": 0.20,
        "durationWeight": 0.15,
        "reattackRatio": 0.70,
        "dragDurationRatio": 1.30,
        "dragIoiRatio": 0.15,
    },
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_sha256(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    if path.suffix.lower() in {".py", ".json", ".csv", ".md", ".xml", ".musicxml"}:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        return "lf-normalized-sha256", hashlib.sha256(data).hexdigest()
    return "raw-sha256", hashlib.sha256(data).hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(REPO).as_posix()


def local_inventory() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for row in read_csv(ROUND2_MANIFEST):
        if row["recordingId"] not in LOCAL_SELECTIONS["round2"]:
            continue
        if int(row["expectedIssueCount"]) != 0:
            raise RuntimeError(f"round2-clean-selection-not-zero:{row['recordingId']}")
        output.append(
            {
                "recordingId": row["recordingId"],
                "sourceRound": "round2",
                "performerCohort": "owner-original",
                "scenario": row["scenario"],
                "audioPath": row["audioPath"],
                "scorePath": row["scorePath"],
                "authoritativeZeroErrorIntent": True,
                "deviceId": None,
                "roomId": None,
            }
        )
    for row in read_csv(ROUND2_FB_MANIFEST):
        if row["recordingId"] not in LOCAL_SELECTIONS["round2-fresh-blind"]:
            continue
        if row["evidenceKind"] not in {"clean-full", "technique-full"}:
            raise RuntimeError(f"round2-fresh-clean-selection-invalid:{row['recordingId']}")
        output.append(
            {
                "recordingId": row["recordingId"],
                "sourceRound": "round2-fresh-blind",
                "performerCohort": "unseen-performer",
                "scenario": row["scenario"],
                "evidenceKind": row["evidenceKind"],
                "audioPath": row["audioPath"],
                "scorePath": row["scorePath"],
                "authoritativeZeroErrorIntent": True,
                "deviceId": None,
                "roomId": None,
            }
        )
    round3_specs = {
        "r3-01": ("r3-e-minor-etude", ROUND3 / "r3-01.musicxml", ROUND3 / "r3-01.m4a"),
        "r3-02": ("r3-a-major-waltz", ROUND3 / "r3-02.musicxml", ROUND3 / "r3-02.m4a"),
        "r3-03": ("r3-g-major-thirds", ROUND3 / "r3-03.musicxml", ROUND3 / "r3-03.m4a"),
    }
    for recording_id in sorted(LOCAL_SELECTIONS["round3"]):
        piece_id, score, audio = round3_specs[recording_id]
        output.append(
            {
                "recordingId": recording_id,
                "sourceRound": "round3",
                "performerCohort": "owner-reserve",
                "scenario": "correct",
                "pieceId": piece_id,
                "audioPath": relative(audio),
                "scorePath": relative(score),
                "authoritativeZeroErrorIntent": True,
                "deviceId": None,
                "roomId": None,
            }
        )
    for row in read_csv(ROUND4_MANIFEST):
        if row["recordingId"] not in LOCAL_SELECTIONS["round4"]:
            continue
        if int(row["expectedIssueCount"]) != 0:
            raise RuntimeError(f"round4-clean-selection-not-zero:{row['recordingId']}")
        output.append(
            {
                "recordingId": row["recordingId"],
                "sourceRound": "round4",
                "performerCohort": "round4-performer",
                "scenario": row["scenario"],
                "audioPath": row["audioPath"],
                "scorePath": row["scorePath"],
                "authoritativeZeroErrorIntent": True,
                "deviceId": None,
                "roomId": None,
            }
        )
    expected_count = sum(len(values) for values in LOCAL_SELECTIONS.values())
    if len(output) != expected_count:
        raise RuntimeError(f"local-clean-inventory-count:{len(output)}:{expected_count}")
    return sorted(output, key=lambda item: item["recordingId"])


def round5_inventory() -> list[dict[str, Any]]:
    output = []
    for row in read_csv(ROUND5_MANIFEST):
        output.append(
            {
                "recordingId": row["recordingId"],
                "split": row["split"],
                "performerId": row["performerId"],
                "deviceId": row["deviceId"],
                "roomId": row["roomId"],
                "audioPath": row["audioPath"],
                "scorePath": row["scorePath"],
                "completeErrorInventoryRequired": True,
            }
        )
    if len(output) != 12:
        raise RuntimeError(f"round5-inventory-count:{len(output)}")
    return output


def public_inventory() -> list[dict[str, Any]]:
    rows = {
        row["unit"]: row
        for row in read_json(BACH_AUDIT)["rows"]
        if row["unit"] in PUBLIC_UNITS
    }
    if set(rows) != PUBLIC_UNITS:
        raise RuntimeError(f"public-unit-missing:{sorted(PUBLIC_UNITS - set(rows))}")
    output = []
    for unit in sorted(PUBLIC_UNITS):
        row = rows[unit]
        if row.get("readyForEvalBenchmark") is not True:
            raise RuntimeError(f"public-unit-not-ready:{unit}")
        rate = row["referenceDoubleStopNoteCount"] / max(1, row["referenceNoteCount"])
        if rate > 0.05:
            raise RuntimeError(f"public-unit-polyphony-out-of-scope:{unit}:{rate}")
        audio = REPO / row["audioPath"]
        output.append(
            {
                "recordingId": unit,
                "violinist": row["violinist"],
                "work": row["work"],
                "movement": row["movement"],
                "source": row["source"],
                "benchmarkSplit": row["benchmarkSplit"],
                "audioPath": row["audioPath"],
                "scorePath": row["scorePath"],
                "basicPitchCachePath": relative(BACH_CACHE / f"{audio.stem}.basic-pitch.json"),
                "referenceNoteCount": row["referenceNoteCount"],
                "referenceDoubleStopNoteCount": row["referenceDoubleStopNoteCount"],
                "referenceDoubleStopRate": round(rate, 6),
                "humanErrorGoldAvailable": False,
            }
        )
    return output


def pitch_artifacts() -> list[dict[str, str]]:
    artifacts: dict[str, str] = {}
    for row in read_json(ROUND2_FB_REPORT)["recordings"]:
        if row["recordingId"] in PITCH_LOCAL_IDS:
            artifacts[row["recordingId"]] = row["candidateRowsPath"]
    for row in read_json(ROUND4_REPORT)["recordings"]:
        if row["recordingId"] in PITCH_LOCAL_IDS:
            artifacts[row["recordingId"]] = row["candidateRowsPath"]
    for row in read_json(ROUND3_ACCEPTANCE)["recordings"]:
        if row["recordingId"] in PITCH_LOCAL_IDS:
            artifacts[row["recordingId"]] = row["warmRun"]["candidateArtifactPath"]
    if set(artifacts) != PITCH_LOCAL_IDS:
        raise RuntimeError(
            f"pitch-artifact-coverage:{sorted(PITCH_LOCAL_IDS - set(artifacts))}"
        )
    return [
        {"recordingId": recording_id, "candidateRowsPath": artifacts[recording_id]}
        for recording_id in sorted(artifacts)
    ]


def candidates() -> list[dict[str, Any]]:
    common = {
        "positionFeaturesAllowed": False,
        "rawEnergyAllowed": False,
        "studentFacing": False,
        "automaticAdoptionReady": False,
    }
    return [
        {
            **common,
            "candidateId": "alignment-gap-refined-self-check-v1",
            "family": "alignment-gap",
            "outputSemantic": "review_hint",
            "applicableDatasets": [
                "authoritative-local-clean",
                "consumed-round5-known-negatives",
                "public-professional-burden",
            ],
            "rule": (
                "assignment gap AND (same-position temporal path substitution OR "
                "temporal-path deletion inside an adjacent assignment-gap run)"
            ),
            "thresholds": {"temporalParamsByGate": FROZEN_TEMPORAL_PARAMS},
        },
        {
            **common,
            "candidateId": "alignment-gap-strict-missing-v1",
            "family": "alignment-gap",
            "outputSemantic": "automatic_issue_candidate",
            "applicableDatasets": [
                "authoritative-local-clean",
                "consumed-round5-known-negatives",
                "public-professional-burden",
            ],
            "rule": (
                "alignment-gap-refined-self-check-v1 restricted to missing-note "
                "scope and suppressed unless the whole-take alignment health guard passes"
            ),
            "thresholds": {
                "maxAssignmentGapCount": 5,
                "maxAssignmentGapRate": 0.10,
                "temporalParamsByGate": FROZEN_TEMPORAL_PARAMS,
            },
        },
        {
            **common,
            "candidateId": "relative-ioi-duration-review-v1",
            "family": "relative-ioi-duration",
            "outputSemantic": "review_hint",
            "applicableDatasets": [
                "authoritative-local-clean",
                "consumed-round5-known-negatives",
                "public-professional-burden",
            ],
            "rule": (
                "temporal operation at same score position AND relative IOI deviation "
                "> 0.15 AND event duration ratio >= 1.20 AND event confidence >= 0.75"
            ),
            "thresholds": {
                "relativeIoiDeviationGreaterThan": 0.15,
                "eventDurationRatioAtLeast": 1.20,
                "eventConfidenceAtLeast": 0.75,
                "temporalParamsByGate": FROZEN_TEMPORAL_PARAMS,
            },
        },
        {
            **common,
            "candidateId": "relative-ioi-duration-strict-v1",
            "family": "relative-ioi-duration",
            "outputSemantic": "automatic_issue_candidate",
            "applicableDatasets": [
                "authoritative-local-clean",
                "consumed-round5-known-negatives",
                "public-professional-burden",
            ],
            "rule": (
                "temporal operation at same score position AND relative IOI deviation "
                "> 0.15 AND event duration ratio >= 1.30 AND event confidence >= 0.75"
            ),
            "thresholds": {
                "relativeIoiDeviationGreaterThan": 0.15,
                "eventDurationRatioAtLeast": 1.30,
                "eventConfidenceAtLeast": 0.75,
                "temporalParamsByGate": FROZEN_TEMPORAL_PARAMS,
            },
        },
        {
            **common,
            "candidateId": "pitch-trajectory-center-strict-v1",
            "family": "pitch-trajectory",
            "outputSemantic": "automatic_issue_candidate",
            "applicableDatasets": ["pitch-artifact-local-clean"],
            "rule": (
                "current M3+ pYIN stable-center policy; emit only decision=issue_detected; "
                "protected notation, polyphony, missing windows, low support, and high "
                "dispersion remain neutral/insufficient rather than accusations"
            ),
            "thresholds": {
                "pitchToleranceCents": 50.0,
                "maxSpreadCentsP95P05": 80.0,
                "maxIqrCents": 80.0,
                "minTotalFrameCount": 12,
                "minVoicedFrameCount": 12,
                "minVoicedFrameRatio": 0.70,
                "glissandoTargetTailFraction": 0.35,
            },
        },
        {
            **common,
            "candidateId": "onset-density-extra-strict-v1",
            "family": "onset-density",
            "outputSemantic": "automatic_issue_candidate",
            "applicableDatasets": [
                "authoritative-local-clean",
                "consumed-round5-known-negatives",
                "public-professional-burden",
            ],
            "rule": (
                "extra-gate temporal path exact-pitch match AND maximum normalized "
                "interior onset strength / whole-event maximum >= 0.85"
            ),
            "thresholds": {
                "interiorAttackRatioAtLeast": 0.85,
                "interiorStartMargin": "max(0.12 seconds, 20% event duration)",
                "interiorEndMargin": "max(0.06 seconds, 8% event duration)",
                "temporalParams": FROZEN_TEMPORAL_PARAMS["extra"],
            },
        },
        {
            **common,
            "candidateId": "temporal-operation-sequence-union-v1",
            "family": "sequence-model",
            "outputSemantic": "review_hint",
            "applicableDatasets": [
                "authoritative-local-clean",
                "consumed-round5-known-negatives",
                "public-professional-burden",
            ],
            "rule": (
                "union of fixed-parameter dynamic-programming match/insert/delete/"
                "merge/split gate outputs; no fit or threshold selection in P1"
            ),
            "thresholds": {"temporalParamsByGate": FROZEN_TEMPORAL_PARAMS},
        },
    ]


def source_bindings(
    local: list[dict[str, Any]],
    round5: list[dict[str, Any]],
    public: list[dict[str, Any]],
    pitch: list[dict[str, str]],
) -> dict[str, Any]:
    paths = {
        Path(__file__).resolve(),
        TEMPORAL_SOURCE,
        PITCH_POLICY_SOURCE,
        ROUND2_MANIFEST,
        ROUND2_FB_MANIFEST,
        ROUND4_MANIFEST,
        ROUND4_REPORT,
        ROUND5_MANIFEST,
        ROUND5_TRUTH,
        ROUND2_FB_REPORT,
        ROUND3_ACCEPTANCE,
        BACH_AUDIT,
    }
    for row in [*local, *round5, *public]:
        paths.add(REPO / row["audioPath"])
        paths.add(REPO / row["scorePath"])
        if row.get("basicPitchCachePath"):
            paths.add(REPO / row["basicPitchCachePath"])
    for row in pitch:
        paths.add(REPO / row["candidateRowsPath"])
    ledger = []
    for path in sorted(paths):
        if not path.exists():
            raise RuntimeError(f"preregistration-source-missing:{relative(path)}")
        mode, digest = normalized_sha256(path)
        ledger.append({"path": relative(path), "hashMode": mode, "sha256": digest})
    return {
        "fileCount": len(ledger),
        "aggregateSha256": hashlib.sha256(canonical_json(ledger).encode()).hexdigest(),
        "files": ledger,
    }


def build_protocol() -> dict[str, Any]:
    local = local_inventory()
    round5 = round5_inventory()
    public = public_inventory()
    pitch = pitch_artifacts()
    protocol: dict[str, Any] = {
        "schemaVersion": "western-p1-clean-domain-preregistration-v1",
        "protocolDate": "2026-07-24",
        "frozenBeforeEvaluation": True,
        "freshBlindResultReadForThisProtocol": False,
        "retuningAfterEvaluationAllowed": False,
        "purpose": (
            "Eliminate unsafe detector candidates on existing real clean performances "
            "before requesting any new recording."
        ),
        "authorization": {
            "promotionEvidenceEligible": False,
            "round4Round5ReuseAsAcceptance": False,
            "studentFacing": False,
            "automaticAccusationReady": False,
            "automaticAdoptionReady": False,
            "studentSwitchesMustRemainFalse": [
                "ordinaryUploadAutoFeedbackReady",
                "m3plusAutoFeedbackReady",
                "m4OmrAutoScoreReady",
            ],
        },
        "eliminationRules": {
            "automatic_issue_candidate": {
                "authoritativeLocalCleanFalsePositiveMax": 0,
                "consumedRound5KnownNegativeFalsePositiveMax": 0,
                "publicProfessionalBurdenPooledPer1000Max": 5.0,
                "publicProfessionalBurdenAnyRecordingPer1000Max": 10.0,
                "decision": "eliminate if any applicable maximum is exceeded",
            },
            "review_hint": {
                "authoritativeLocalCleanHintRateMax": 0.02,
                "authoritativeLocalCleanAnyRecordingHintRateMax": 0.05,
                "consumedRound5KnownNegativeHintRateMax": 0.02,
                "consumedRound5AnyRecordingHintRateMax": 0.05,
                "publicProfessionalBurdenPooledPer1000Max": 20.0,
                "publicProfessionalBurdenAnyRecordingPer1000Max": 50.0,
                "decision": "eliminate if any applicable maximum is exceeded",
            },
        },
        "candidates": candidates(),
        "excludedOrDeferred": [
            {
                "candidate": "raw-waveform-energy-absence",
                "status": "stop-line",
                "reason": "frozen real Round 5 recall 0/12; no further investment",
            },
            {
                "candidate": "target-pitch-frame-ratio-absence",
                "status": "rejected-before-P1",
                "reason": "frozen real Round 5 5/12 with 49 false positives",
            },
            {
                "candidate": "score-position-or-static-context-RF",
                "status": "prohibited",
                "reason": "Round 5 position confounding; position features are forbidden",
            },
            {
                "candidate": "fixed-acoustic-feature-stack",
                "status": "rejected-before-P1",
                "reason": "existing fixed stack underperformed structural candidate",
            },
            {
                "candidate": "performance-only-RF-v2",
                "status": "deferred-not-executable-in-P1",
                "reason": (
                    "requires a new counterbalanced calibration split; no valid fit is "
                    "available without recording, so P1 cannot manufacture one"
                ),
            },
            {
                "candidate": "M4-OMR",
                "status": "stop-line",
                "reason": "separate data/architecture blocker; outside audio P1",
            },
        ],
        "datasets": {
            "authoritative-local-clean": {
                "evidenceRole": "authoritative-clean-negative",
                "recordingCount": len(local),
                "recordings": local,
                "limitations": [
                    "round2-round4 manifests do not bind deviceId or roomId",
                    "these recordings are consumed historical evidence, never fresh acceptance",
                ],
            },
            "consumed-round5-known-negatives": {
                "evidenceRole": "consumed-complete-inventory-negative-diagnostic",
                "recordingCount": len(round5),
                "recordings": round5,
                "crossContextCoverage": {
                    "performerCount": len({row["performerId"] for row in round5}),
                    "deviceCount": len({row["deviceId"] for row in round5}),
                    "roomCount": len({row["roomId"] for row in round5}),
                },
                "limitations": [
                    "Round 5 is consumed and cannot be reused as acceptance",
                    "only non-error positions count as authoritative negatives",
                    "room is perfectly collinear with calibration/fresh split",
                ],
            },
            "public-professional-burden": {
                "evidenceRole": "unadjudicated-real-professional-burden",
                "recordingCount": len(public),
                "performerCount": len({row["violinist"] for row in public}),
                "workCount": len({row["work"] for row in public}),
                "sourceCount": len({row["source"] for row in public}),
                "recordings": public,
                "limitations": [
                    "no note-level human error gold; emitted flags are burden, not false positives",
                    "estimated score/audio alignment and possible edition/performance deviations",
                ],
            },
            "pitch-artifact-local-clean": {
                "evidenceRole": "authoritative-clean-negative-current-pitch-runtime",
                "recordingCount": len(pitch),
                "recordings": pitch,
                "limitations": [
                    "only recordings with already-frozen current M3+ candidate artifacts",
                    "not evaluated on public Bach because no equivalent frozen runtime artifact exists",
                ],
            },
        },
        "reportingContract": {
            "requiredPerCandidate": [
                "flagCount",
                "positionCount",
                "rate",
                "flagsPer1000Positions",
                "maximumPerRecordingRate",
                "applicability",
                "eliminated",
                "eliminationReasons",
            ],
            "publicTerminology": "burden-not-false-positive",
            "syntheticRecallMayRepresentRealRecall": False,
            "noRetuneAfterResults": True,
        },
    }
    protocol["sourceBindings"] = source_bindings(local, round5, public, pitch)
    protocol["protocolSemanticSha256"] = hashlib.sha256(
        canonical_json(protocol).encode()
    ).hexdigest()
    return protocol


def markdown(protocol: dict[str, Any]) -> str:
    lines = [
        "# P1 真实干净域候选预注册",
        "",
        f"- 合同：`{protocol['schemaVersion']}`",
        f"- 语义 SHA-256：`{protocol['protocolSemanticSha256']}`",
        f"- 来源聚合 SHA-256：`{protocol['sourceBindings']['aggregateSha256']}`",
        "- 冻结顺序：先提交并推送本协议与 runner，再允许运行真实干净域。",
        "- 盲后纪律：看到结果后不改候选、阈值、输入清单或淘汰门槛。",
        "- 发布边界：本轮只做淘汰，不产生学生端授权。",
        "",
        "## 候选与精确门槛",
        "",
        "| candidate | family | semantic | key thresholds |",
        "|---|---|---|---|",
    ]
    for candidate in protocol["candidates"]:
        threshold_text = json.dumps(
            candidate["thresholds"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        lines.append(
            f"| `{candidate['candidateId']}` | {candidate['family']} | "
            f"{candidate['outputSemantic']} | `{threshold_text}` |"
        )
    datasets = protocol["datasets"]
    lines.extend(
        [
            "",
            "## 冻结输入",
            "",
            f"- 本地完整干净录音：{datasets['authoritative-local-clean']['recordingCount']} 条。",
            (
                "- Round 5 已消费完整真值负位诊断："
                f"{datasets['consumed-round5-known-negatives']['recordingCount']} 条，"
                "只计算非错误位置，不能充当验收。"
            ),
            (
                "- 公开专业 Bach："
                f"{datasets['public-professional-burden']['recordingCount']} 条，"
                f"{datasets['public-professional-burden']['performerCount']} 名演奏者，"
                f"{datasets['public-professional-burden']['workCount']} 部作品，"
                "只上报负担，不把未人工裁决偏差写成 FP。"
            ),
            (
                "- 当前 M3+ 音高轨迹物理 artifact："
                f"{datasets['pitch-artifact-local-clean']['recordingCount']} 条。"
            ),
            "",
            "## 淘汰纪律",
            "",
            "- 自动指控候选：本地完整干净集和 Round 5 已知负位均要求 0 FP；公开专业域另受预注册负担上限约束。",
            "- 复核提示候选：完整干净域 pooled hint rate ≤2%，单条 ≤5%；公开专业域 pooled ≤20/1000、单条 ≤50/1000。",
            "- 任一适用门槛超限即淘汰；结果出现后不得放宽。",
            "- 三个学生开关保持 false，M4 OMR 与能量验漏音保持 stop-line。",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    protocol = build_protocol()
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps(protocol, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    OUT_MD.write_text(markdown(protocol), encoding="utf-8")
    print(
        json.dumps(
            {
                "schemaVersion": protocol["schemaVersion"],
                "candidateCount": len(protocol["candidates"]),
                "localCleanRecordings": protocol["datasets"]["authoritative-local-clean"][
                    "recordingCount"
                ],
                "publicProfessionalRecordings": protocol["datasets"][
                    "public-professional-burden"
                ]["recordingCount"],
                "pitchArtifactRecordings": protocol["datasets"]["pitch-artifact-local-clean"][
                    "recordingCount"
                ],
                "protocolSemanticSha256": protocol["protocolSemanticSha256"],
                "outJson": relative(OUT_JSON),
                "outMarkdown": relative(OUT_MD),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
