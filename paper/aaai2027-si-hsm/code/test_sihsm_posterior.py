from sihsm_posterior import choose_pitch, midi_hz, timing_weight


def close(a: float, b: float, cents_tol: float = 8.0) -> bool:
    return abs(1200.0 * __import__("math").log2(a / b)) <= cents_tol


def test_high_confidence_uses_detector() -> None:
    result = choose_pitch(midi_hz(69), 0.95, midi_hz(70))
    assert close(result["f_eff"], midi_hz(69))


def test_low_confidence_uses_score() -> None:
    result = choose_pitch(midi_hz(69), 0.05, midi_hz(70))
    assert close(result["f_eff"], midi_hz(70))


def test_detector_octave_error_is_corrected_by_score() -> None:
    result = choose_pitch(midi_hz(57), 0.86, midi_hz(69))
    assert close(result["f_eff"], midi_hz(69))


def test_two_second_score_offset_has_stronger_prior_than_three_seconds() -> None:
    assert timing_weight(2.0) > timing_weight(3.0)


if __name__ == "__main__":
    test_high_confidence_uses_detector()
    test_low_confidence_uses_score()
    test_detector_octave_error_is_corrected_by_score()
    test_two_second_score_offset_has_stronger_prior_than_three_seconds()
    print("sihsm posterior tests ok")
