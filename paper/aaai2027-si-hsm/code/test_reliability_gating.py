from sihsm_extract import score_reliability
from sihsm_posterior import midi_hz


def main() -> int:
    score = midi_hz(69)
    assert score_reliability(score, score, 0.8, "erhu") > score_reliability(score, score * 1.3, 0.2, "erhu")
    assert score_reliability(0, score, 0.8, "erhu") == 0
    print("reliability gating tests ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
