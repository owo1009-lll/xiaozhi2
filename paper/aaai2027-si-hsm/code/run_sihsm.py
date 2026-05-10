from __future__ import annotations

import argparse
import json

from sihsm_extract import Config, extract_file


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--mixture", required=True)
    p.add_argument("--score", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--instrument", default="erhu")
    p.add_argument("--mode", default="full", choices=["full", "score_only", "pitch_only", "hpss"])
    p.add_argument("--target-part")
    p.add_argument("--n-fft", type=int, default=2048)
    p.add_argument("--hop", type=int, default=512)
    p.add_argument("--harmonics", type=int, default=6)
    p.add_argument("--bandwidth-cents", type=float, default=38)
    p.add_argument("--residual", type=float, default=0.05)
    p.add_argument("--tolerance", type=float, default=2.0)
    p.add_argument("--score-weight", type=float, default=1.0)
    p.add_argument("--reliability-gating", action="store_true")
    p.add_argument("--reliability-alpha", type=float, default=1.0)
    p.add_argument("--score-branch-mode", choices=["always", "conditional", "none"], default="always")
    args = p.parse_args()
    cfg = Config(args.n_fft, args.hop, args.harmonics, args.bandwidth_cents, args.residual, args.tolerance, score_weight=args.score_weight, reliability_gating=args.reliability_gating, reliability_alpha=args.reliability_alpha, score_branch_mode=args.score_branch_mode)
    print(json.dumps(extract_file(args.mixture, args.score, args.out_dir, args.instrument, args.mode, args.target_part, cfg), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
