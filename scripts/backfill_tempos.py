"""One-shot script: patch tempo=72 sections using enhanced OCR+text extraction."""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def extract_tempo(file_path: Path) -> int | None:
    is_image = file_path.suffix.lower() in {".png", ".jpg", ".jpeg"}
    try:
        import fitz  # type: ignore
        import cv2  # type: ignore
        import numpy as np
        import ddddocr  # type: ignore
        from PIL import Image

        # Strategy 1: text extraction (Western-font PDFs)
        if not is_image:
            try:
                doc = fitz.open(str(file_path))
                text = doc[0].get_text()
                doc.close()
                for m in re.finditer(r"[=(]\s*[A-Za-z]?\s*=\s*(\d{2,3})", text):
                    bpm = int(m.group(1))
                    if 40 <= bpm <= 300:
                        return bpm
            except Exception:
                pass

        # Strategy 2: image OCR
        ocr = ddddocr.DdddOcr(show_ad=False)
        SCALE = 3.0
        if is_image:
            arr = np.array(Image.open(str(file_path)).convert("RGB"))
        else:
            doc = fitz.open(str(file_path))
            page = doc[0]
            mat = fitz.Matrix(SCALE, SCALE)
            pix = page.get_pixmap(matrix=mat)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            if pix.n == 4:
                arr = arr[:, :, :3]
            doc.close()

        h, w = arr.shape[:2]
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        _, binary = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)
        search_h = int(h * 0.35)
        search_w = int(w * 0.65)
        binary_top = binary[:search_h, :]
        num_labels, _labels, stats, _ = cv2.connectedComponentsWithStats(binary_top)

        bars = []
        for i in range(1, num_labels):
            cx, cy, cw, ch, area = stats[i]
            if cx + cw > search_w:
                continue
            if 8 <= cw <= 60 and 2 <= ch <= 7 and cw >= ch * 2 and area >= 12:
                bars.append((cx, cy, cw, ch))

        used: set[int] = set()
        eq_signs = []
        for i, (x1, y1, w1, h1) in enumerate(bars):
            if i in used:
                continue
            for j, (x2, y2, w2, h2) in enumerate(bars):
                if j <= i or j in used:
                    continue
                if abs(x1 - x2) <= 8 and 4 <= abs(y1 - y2) <= 18:
                    eq_signs.append((min(x1, x2), (y1 + y2) // 2, max(w1, w2)))
                    used.add(i)
                    used.add(j)
                    break

        for eq_x, eq_y, eq_w in eq_signs:
            dx1 = eq_x + eq_w + 2
            dx2 = min(w, eq_x + eq_w + 90)
            dy1 = max(0, eq_y - 20)
            dy2 = min(search_h, eq_y + 22)
            full_x1 = max(0, eq_x - 5)
            full_crop = arr[dy1:dy2, full_x1:dx2]
            if full_crop.size == 0:
                continue
            pil = Image.fromarray(full_crop)
            pil = pil.resize((max(80, pil.width * 2), max(20, pil.height * 2)), Image.LANCZOS)
            buf = io.BytesIO()
            pil.save(buf, format="PNG")
            raw = ocr.classification(buf.getvalue())
            for m in re.finditer(r"(\d{2,3})", raw or ""):
                bpm = int(m.group(1))
                if 40 <= bpm <= 300:
                    return bpm
    except Exception:
        pass
    return None


def resolve_page_file(pagewise_dir: Path, page_num: int) -> Path | None:
    base = pagewise_dir / f"page-{page_num:03d}"
    for ext in (".pdf", ".png", ".jpg"):
        p = base.with_suffix(ext)
        if p.exists():
            return p
    return None


def main() -> None:
    store_path = ROOT / "data" / "erhu-score-imports.json"
    with store_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    target_ids = {"score-mo8vw5mc-y2ldjp", "score-moaxgd9v-gj6vsv", "score-mo9xju6b-ygpugm"}

    total_changed = 0
    for score in data["scores"]:
        if score.get("scoreId") not in target_ids:
            continue
        sections = score.get("sections", [])
        pdf_parts = score.get("sourcePdfPath", "").replace("\\", "/").split("/")
        pdf_parts = [p for p in pdf_parts if p]
        if len(pdf_parts) < 3:
            continue
        job_dir = pdf_parts[2]
        pagewise_dir = ROOT / "data" / "score-imports" / job_dir / "pagewise"

        # Group tempo=72 sections by page number
        page_to_indices: dict[int, list[int]] = {}
        for i, s in enumerate(sections):
            if s.get("tempo", 72) != 72:
                continue
            sid = s.get("sectionId", "")
            m = re.match(r"^page-(\d+)", sid)
            page_num = int(m.group(1)) if m else 0
            page_to_indices.setdefault(page_num, []).append(i)

        page_tempo_cache: dict[int, int | None] = {}
        for page_num in sorted(page_to_indices.keys()):
            if page_num == 0:
                continue
            file_path = resolve_page_file(pagewise_dir, page_num)
            if file_path is None:
                continue
            t = extract_tempo(file_path)
            page_tempo_cache[page_num] = t
            if t:
                print(f"  {score['title']} page-{page_num:03d} ({file_path.suffix}): {t}")

        for page_num, indices in page_to_indices.items():
            tempo = page_tempo_cache.get(page_num)
            if tempo and tempo != 72:
                for idx in indices:
                    sections[idx]["tempo"] = tempo
                total_changed += len(indices)

        detected = {k: v for k, v in page_tempo_cache.items() if v}
        non72 = sum(1 for s in sections if s.get("tempo", 72) != 72)
        print(f"{score['title']}: {non72}/{len(sections)} non-72 | patches={detected}")

    print(f"\nTotal sections patched: {total_changed}")
    if total_changed:
        with store_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("Written.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
