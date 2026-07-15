#!/usr/bin/env python3
import importlib.util
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).resolve().parent / "experiments" / "eval_western_strings_m4_omr_confidence_probe.py"
SPEC = importlib.util.spec_from_file_location("m4_confidence_probe", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def main():
    probabilities = np.asarray([0.95, 0.9, 0.8, 0.7, 0.6])
    labels = np.asarray([1, 1, 0, 0, 0])
    _, safe, observed = MODULE.threshold_sweep(
        probabilities,
        labels,
        min_precision=0.9,
        min_coverage=0.4,
        min_selected=2,
    )
    assert safe is not None
    assert safe["selected"] == 2
    assert safe["precision"] == 1.0
    assert observed["precision"] == 1.0

    _, blocked, _ = MODULE.threshold_sweep(
        np.asarray([0.95, 0.9, 0.8, 0.7]),
        np.asarray([0, 1, 1, 0]),
        min_precision=0.9,
        min_coverage=0.5,
        min_selected=2,
    )
    assert blocked is None
    print({"ok": True, "checks": ["safe-threshold-found", "unsafe-threshold-rejected"]})


if __name__ == "__main__":
    main()
