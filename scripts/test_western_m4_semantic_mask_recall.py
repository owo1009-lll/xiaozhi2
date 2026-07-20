from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_m4_semantic_mask_recall import recall  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    empty = recall(np.zeros((8, 8), dtype=np.uint8), np.ones((8, 8), dtype=np.uint8))
    require(not empty["evaluable"] and empty["exactRecall"] is None, "empty gold")
    gold = np.zeros((8, 8), dtype=np.uint8)
    prediction = np.zeros((8, 8), dtype=np.uint8)
    gold[4, 4] = 1
    prediction[4, 6] = 1
    shifted = recall(gold, prediction)
    require(shifted["exactRecall"] == 0.0 and shifted["tolerantRecall"] == 1.0, "tolerance")

    report_path = REPO / "data/experiments/western-strings-m4/semantic-mask-recall/report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    require(report["studentGateReady"] is False, "student boundary")
    for domain in ["clean-render", "synthetic-test"]:
        classes = report["aggregate"][domain]["classes"]
        require(classes["stem"]["evaluable"], f"{domain} stem")
        require(classes["notehead"]["evaluable"], f"{domain} notehead")
        require(classes["barline"]["evaluable"], f"{domain} barline")
        require(not classes["beam"]["evaluable"], f"{domain} beam empty")
    print(json.dumps({
        "ok": True,
        "checks": ["empty-gold-not-evaluable", "two-pixel-tolerance", "domain-boundary", "student-boundary"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
