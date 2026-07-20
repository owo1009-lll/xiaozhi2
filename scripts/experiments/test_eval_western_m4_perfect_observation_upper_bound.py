from __future__ import annotations

from eval_western_m4_perfect_observation_upper_bound import (
    aggregate,
    perfect_staff_groups,
    semantic_mask_svg,
    target_size,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    width, height = target_size((1680, 2376))
    require(3_600_000 <= width * height <= 3_750_000, "Oemer target pixel scale")
    metrics = {
        "goldNotes": 10,
        "draftNotes": 10,
        "pitchExact": 10,
        "onsetExact": 10,
        "measureExact": 9,
        "onsetPassed": True,
        "measurePassed": False,
        "structurePassed": False,
    }
    summary = aggregate([{"status": "ok", "metrics": metrics}])
    require(summary["onsetPassedPieceRate"] == 1.0, "onset pass aggregation")
    require(summary["measurePassedPieceRate"] == 0.0, "measure fail aggregation")
    svg = b'''<svg xmlns="http://www.w3.org/2000/svg"><svg class="definition-scale"><g class="staff"><path id="line"/><g class="layer"><g class="notehead"><path id="head"/></g></g></g></svg></svg>'''
    staff = semantic_mask_svg(svg, "staff")
    notehead = semantic_mask_svg(svg, "notehead")
    require(b'id="line"' in staff and b'id="head"' not in staff, "staff direct children only")
    require(b'id="head"' in notehead and b'id="line"' not in notehead, "semantic notehead only")
    mask = __import__("numpy").zeros((80, 100), dtype="uint8")
    for y in (10, 14, 18, 22, 26, 50, 54, 58, 62, 66):
        mask[y, 5:95] = 1
    require(len(perfect_staff_groups(mask)) == 2, "perfect staff grouping")
    print('{"ok":true,"checks":["target-scale","strict-pass-aggregation","semantic-svg-pruning","perfect-staff-grouping"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
