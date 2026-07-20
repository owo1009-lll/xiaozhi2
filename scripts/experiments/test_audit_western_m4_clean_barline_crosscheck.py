from __future__ import annotations

from audit_western_m4_clean_barline_crosscheck import (
    apply,
    match_positions,
    multiply,
    parse_transform,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    transform = multiply(parse_transform("translate(10,20)"), parse_transform("scale(2)"))
    require(apply(transform, 3, 4) == (16, 28), "SVG affine composition")
    require(
        match_positions([(10, 10), (30, 30)], [(11, 9), (31, 32)], 3.0) == 2,
        "one-to-one position match",
    )
    require(
        match_positions([(10, 10), (12, 10)], [(11, 10)], 3.0) == 1,
        "prediction cannot match twice",
    )
    print('{"ok":true,"checks":["svg-affine","one-to-one-position-match"]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
