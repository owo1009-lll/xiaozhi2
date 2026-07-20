from __future__ import annotations

from audit_western_m4_clean_structure_failures import (
    MeasureInfo,
    classify_onset_offsets,
    concentration,
    summarize_measure_structure,
)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def measure(index: int, duration: float = 4.0, expected: float = 4.0) -> MeasureInfo:
    return MeasureInfo(index, duration, expected, "4/4", 0)


def main() -> int:
    check(classify_onset_offsets([1.0] * 12)["mode"] == "constant-offset", "constant")
    check(
        classify_onset_offsets([0.0] * 10 + [1.0] * 10)["mode"]
        == "piecewise-constant-steps",
        "piecewise",
    )
    check(
        classify_onset_offsets([float(index) for index in range(12)])["mode"]
        == "monotonic-drift-after-edit",
        "monotonic",
    )
    check(
        classify_onset_offsets([0.0, 2.0, -1.0, 3.0, -2.0, 1.0])["mode"] == "random",
        "random",
    )
    same = summarize_measure_structure([measure(1), measure(2)], [measure(1), measure(2, 3.0)])
    check(same["mode"] == "same-count-duration-reconstruction", "duration reconstruction")
    mismatch = summarize_measure_structure([measure(1), measure(2)], [measure(1)])
    check(mismatch["mode"] == "measure-count-mismatch-other", "count mismatch")
    concentration_result = concentration(
        [
            {"failed": True, "onset": {"mode": "random"}},
            {"failed": True, "onset": {"mode": "random"}},
            {"failed": True, "onset": {"mode": "piecewise-constant-steps"}},
        ],
        "onset",
        "failed",
        {"piecewise-constant-steps"},
    )
    check(
        concentration_result["moreThanHalfConcentratedInOneMode"]
        and not concentration_result["moreThanHalfExplainedByKnownSystematicModes"],
        "random dominance is not a systematic explanation",
    )
    print('{"ok":true,"checks":["onset-modes","measure-count","meter-balance"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
