#!/usr/bin/env python3
"""Unit tests for Oemer dewarp attribution metrics (no model inference)."""

from __future__ import annotations

import numpy as np

from experiments.audit_western_m4_oemer_dewarp import mapping_jacobian, staff_geometry


def synthetic_staff(curved: bool) -> np.ndarray:
    height, width = 240, 400
    mask = np.zeros((height, width), dtype=np.uint8)
    xs = np.arange(width)
    shift = 12.0 * np.sin(np.pi * xs / (width - 1)) if curved else np.zeros(width)
    for base in (70, 150):
        for line in range(5):
            ys = np.rint(base + line * 7 + shift).astype(int)
            mask[ys, xs] = 1
    return mask


def main() -> int:
    curved = staff_geometry(synthetic_staff(True), 2)
    flat = staff_geometry(synthetic_staff(False), 2)
    assert curved["fiveLineGroupRecoveryRate"] == 1.0
    assert flat["fiveLineGroupRecoveryRate"] == 1.0
    assert curved["staffLineStraightnessP90Pixels"] > flat["staffLineStraightnessP90Pixels"]
    identity = np.repeat(np.arange(20, dtype=np.float32)[:, None], 30, axis=1)
    healthy = mapping_jacobian(identity)
    assert healthy["foldCount"] == 0
    folded = identity[::-1].copy()
    unhealthy = mapping_jacobian(folded)
    assert unhealthy["foldRate"] == 1.0
    print("western m4 Oemer dewarp attribution metric tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
