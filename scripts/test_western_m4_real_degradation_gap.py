from __future__ import annotations

import json
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from audit_western_m4_real_degradation_gap import build_report  # noqa: E402


def main() -> int:
    report = build_report()
    findings = report["findings"]
    assert findings["chromaticScreenMoireGap"] is True
    assert findings["denseLayoutGap"] is True
    assert findings["blurGap"] is False
    assert findings["overexposureGap"] is False
    assert findings["illuminationGap"] is False
    assert findings["selectedNextPixelAugmentation"] == "chromatic-screen-moire"
    assert report["studentGateReady"] is False
    assert len(report["syntheticRows"]) == 12
    print(json.dumps({
        "ok": True,
        "checks": ["twelve-synthetic-baselines", "moire-selected", "dense-layout-separated", "student-boundary"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
