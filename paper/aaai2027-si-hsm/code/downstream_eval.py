from __future__ import annotations

import argparse
import csv
import json


def _key(row):
    return (row.get("itemId", ""), row.get("noteId") or row.get("measureId", ""))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--labels", required=True)
    p.add_argument("--predictions", required=True)
    p.add_argument("--threshold", type=float, default=0.5)
    args = p.parse_args()
    labels = {_key(r): int(float(r.get("label", 0))) for r in csv.DictReader(open(args.labels, encoding="utf-8"))}
    preds = {_key(r): float(r.get("score", r.get("prediction", 0))) >= args.threshold for r in csv.DictReader(open(args.predictions, encoding="utf-8"))}
    tp = sum(preds.get(k, False) and v for k, v in labels.items())
    fp = sum(preds.get(k, False) and not v for k, v in labels.items())
    fn = sum((not preds.get(k, False)) and v for k, v in labels.items())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    print(json.dumps({"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
