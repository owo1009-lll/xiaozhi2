from __future__ import annotations

from eval_western_m4_clean_constraint_solver_poc import duration_candidates, solve_measure
from eval_western_strings_m4_rhythm_candidate_oracle import MeasureRhythm, RhythmToken


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    beamed = RhythmToken(1.0, True, notation_type="eighth", beam_count=1)
    require(24 in duration_candidates(beamed), "one beam supports eighth duration")
    dotted = RhythmToken(0.75, True, notation_type="eighth", dot_count=1)
    require(duration_candidates(dotted) == (36,), "dot is preserved")
    measure = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62, 64, 65),
        note_onset_ticks=(0, 48, 96, 144),
        tokens=tuple(RhythmToken(1.0, True, notation_type="quarter") for _ in range(4)),
        expected_ticks=192,
        has_backup=False,
    )
    solution = solve_measure(measure, 192)
    require(solution["solved"] and solution["meterSatisfied"], "exact meter DP")
    require(not solve_measure(measure, 10)["solved"], "unreachable meter fails closed")
    print('{"ok":true,"checks":["beam-duration","dot-preserved","exact-meter-dp","unreachable-fail-closed"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
