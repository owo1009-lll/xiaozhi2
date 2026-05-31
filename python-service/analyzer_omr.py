# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class OmrMixin:
    def _omr_render_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "omr-render-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir


    def _omr_page_result_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "omr-page-result-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir


    def _page_cache_key(self, fingerprint: str, kind: str) -> str:
        return self._json_hash(
            {
                "fingerprint": fingerprint,
                "kind": kind,
                "version": self.settings.omr_page_cache_version,
                "dpi": int(self.settings.omr_render_dpi),
                "minDpi": int(self.settings.omr_render_min_dpi),
                "maxPixels": int(self.settings.omr_page_max_pixels),
            }
        )


    def _page_render_cache_path(self, page_fingerprint: str) -> Path:
        return self._omr_render_cache_dir() / f"{self._page_cache_key(page_fingerprint, 'render')}.png"


    def _page_tile_cache_path(self, page_fingerprint: str, tile_index: int) -> Path:
        return self._omr_render_cache_dir() / f"{self._page_cache_key(page_fingerprint, f'tile-{tile_index:02d}')}.png"


    def _page_result_cache_path(self, page_fingerprint: str) -> Path:
        return self._omr_page_result_cache_dir() / f"{self._page_cache_key(page_fingerprint, 'musicxml')}.musicxml"


    def _ensure_page_preview_image(
        self,
        output_dir: Path,
        page_index: int,
        page_fingerprint: str,
        fitz_page: Any | None = None,
        pdf_path: Path | None = None,
    ) -> tuple[Path | None, str]:
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"page-{page_index:03d}.png"
        if output_path.exists():
            return output_path, "ready"

        render_cache_path = self._page_render_cache_path(page_fingerprint)
        if render_cache_path.exists():
            try:
                shutil.copy2(render_cache_path, output_path)
                return output_path, "cache-hit"
            except Exception:
                return render_cache_path, "cache-hit"

        rendered_path: Path | None = None
        if fitz_page is not None:
            rendered_path = self._render_page_image_from_page(fitz_page, page_index - 1, output_dir)
        elif pdf_path is not None:
            rendered_path = self._render_pdf_page_image(pdf_path, page_index - 1, output_dir)
        if rendered_path is None or not rendered_path.exists():
            return None, "missing"

        try:
            if not render_cache_path.exists():
                shutil.copy2(rendered_path, render_cache_path)
        except Exception:
            pass
        return rendered_path, "rendered"


    def _build_preview_pages(self, pdf_path: Path, job_id: str) -> list[dict[str, Any]]:
        preview_count = max(1, self.settings.omr_preview_pages)
        if PdfReader is not None:
            try:
                preview_count = min(preview_count, max(1, len(PdfReader(str(pdf_path)).pages)))
            except Exception:
                preview_count = max(1, self.settings.omr_preview_pages)

        return [
            {
                "pageNumber": index + 1,
                "type": "pdf",
                "url": f"/data/score-imports/{job_id}/{pdf_path.name}",
            }
            for index in range(preview_count)
        ]


    def _compact_import_warnings(self, warnings: list[str]) -> list[str]:
        compacted: list[str] = []
        seen: set[str] = set()
        for warning in warnings:
            text = str(warning or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            compacted.append(text)

        has_direct_pagewise = any(
            "按页识谱" in warning and ("缩短导入等待时间" in warning or "直接按页" in warning)
            for warning in compacted
        )
        if has_direct_pagewise:
            compacted = [warning for warning in compacted if "回退到按页识谱" not in warning]
        return compacted


    def _page_render_dpi(self, page: Any) -> int:
        target_dpi = max(72, int(self.settings.omr_render_dpi))
        max_pixels = max(1_000_000, int(self.settings.omr_page_max_pixels))
        min_dpi = max(96, int(self.settings.omr_render_min_dpi))
        try:
            width_points = float(page.rect.width)
            height_points = float(page.rect.height)
            if width_points <= 0 or height_points <= 0:
                return target_dpi
            max_dpi = math.sqrt((max_pixels * 72.0 * 72.0) / (width_points * height_points))
            bounded_dpi = min(float(target_dpi), float(max_dpi))
            if bounded_dpi < min_dpi:
                return min_dpi
            return max(min_dpi, int(math.floor(bounded_dpi)))
        except Exception:
            return target_dpi


    def _estimate_page_clip_rect(self, page: Any) -> Any | None:
        if fitz is None or np is None:
            return None
        try:
            preview_dpi = 96
            preview = page.get_pixmap(dpi=preview_dpi, alpha=False)
            channels = max(1, int(getattr(preview, "n", 3) or 3))
            pixels = np.frombuffer(preview.samples, dtype=np.uint8)
            if pixels.size != preview.width * preview.height * channels:
                return None
            image = pixels.reshape(preview.height, preview.width, channels)
            gray = image[:, :, : min(channels, 3)].mean(axis=2)
            occupied = gray < 245
            if not occupied.any():
                return None
            rows = np.where(occupied.any(axis=1))[0]
            cols = np.where(occupied.any(axis=0))[0]
            if rows.size == 0 or cols.size == 0:
                return None
            margin = max(10, int(min(preview.height, preview.width) * 0.02))
            top = max(0, int(rows[0]) - margin)
            bottom = min(preview.height - 1, int(rows[-1]) + margin)
            left = max(0, int(cols[0]) - margin)
            right = min(preview.width - 1, int(cols[-1]) + margin)
            if right <= left or bottom <= top:
                return None
            scale_x = float(page.rect.width) / max(1, preview.width)
            scale_y = float(page.rect.height) / max(1, preview.height)
            clip = fitz.Rect(
                float(page.rect.x0) + (left * scale_x),
                float(page.rect.y0) + (top * scale_y),
                float(page.rect.x0) + ((right + 1) * scale_x),
                float(page.rect.y0) + ((bottom + 1) * scale_y),
            )
            if clip.width <= 0 or clip.height <= 0:
                return None
            return clip
        except Exception:
            return None


    def _render_page_image_from_page(self, page: Any, page_index: int, output_dir: Path) -> Path | None:
        if fitz is None:
            return None
        try:
            clip_rect = self._estimate_page_clip_rect(page)
            dpi = self._page_render_dpi(page)
            pixmap = page.get_pixmap(dpi=dpi, alpha=False, clip=clip_rect)
            max_pixels = max(1_000_000, int(self.settings.omr_page_max_pixels))
            if (pixmap.width * pixmap.height) > max_pixels:
                adjusted_dpi = max(
                    int(self.settings.omr_render_min_dpi),
                    int(math.floor(dpi * math.sqrt(max_pixels / float(pixmap.width * pixmap.height)))),
                )
                if adjusted_dpi < dpi:
                    pixmap = page.get_pixmap(dpi=adjusted_dpi, alpha=False, clip=clip_rect)
            output_dir.mkdir(parents=True, exist_ok=True)
            image_path = output_dir / f"page-{page_index + 1:03d}.png"
            pixmap.save(str(image_path))
            return image_path
        except Exception:
            return None


    def _render_page_tile_images_from_page(self, page: Any, page_index: int, output_dir: Path, tile_count: int = 2) -> list[Path]:
        if fitz is None:
            return []
        try:
            base_clip = self._estimate_page_clip_rect(page) or page.rect
            if base_clip.height <= 0 or base_clip.width <= 0:
                return []
            target_dpi = max(220, int(self.settings.omr_render_dpi))
            overlap = max(8.0, float(base_clip.height) * 0.03)
            tile_height = float(base_clip.height) / max(1, int(tile_count))
            max_pixels = max(1_000_000, int(self.settings.omr_page_max_pixels))
            output_dir.mkdir(parents=True, exist_ok=True)
            tile_paths: list[Path] = []
            for tile_index in range(max(1, int(tile_count))):
                top = float(base_clip.y0) + (tile_index * tile_height)
                bottom = float(base_clip.y0) + ((tile_index + 1) * tile_height)
                if tile_index > 0:
                    top -= overlap * 0.5
                if tile_index < (tile_count - 1):
                    bottom += overlap * 0.5
                tile_clip = fitz.Rect(
                    float(base_clip.x0),
                    max(float(base_clip.y0), top),
                    float(base_clip.x1),
                    min(float(base_clip.y1), bottom),
                )
                if tile_clip.width <= 0 or tile_clip.height <= 0:
                    continue
                pixmap = page.get_pixmap(dpi=target_dpi, alpha=False, clip=tile_clip)
                if (pixmap.width * pixmap.height) > max_pixels:
                    adjusted_dpi = max(
                        int(self.settings.omr_render_min_dpi),
                        int(math.floor(target_dpi * math.sqrt(max_pixels / float(pixmap.width * pixmap.height)))),
                    )
                    if adjusted_dpi < target_dpi:
                        pixmap = page.get_pixmap(dpi=adjusted_dpi, alpha=False, clip=tile_clip)
                tile_path = output_dir / f"page-{page_index + 1:03d}-tile-{tile_index + 1:02d}.png"
                pixmap.save(str(tile_path))
                tile_paths.append(tile_path)
            return tile_paths
        except Exception:
            return []


    def _render_pdf_page_image(self, pdf_path: Path, page_index: int, output_dir: Path) -> Path | None:
        if fitz is None:
            return None
        try:
            document = fitz.open(str(pdf_path))
        except Exception:
            return None
        try:
            if page_index < 0 or page_index >= document.page_count:
                return None
            page = document.load_page(page_index)
            return self._render_page_image_from_page(page, page_index, output_dir)
        except Exception:
            return None
        finally:
            try:
                document.close()
            except Exception:
                pass


    def _render_pdf_page_tile_images(self, pdf_path: Path, page_index: int, output_dir: Path, tile_count: int = 2) -> list[Path]:
        if fitz is None:
            return []
        try:
            document = fitz.open(str(pdf_path))
        except Exception:
            return []
        try:
            if page_index < 0 or page_index >= document.page_count:
                return []
            page = document.load_page(page_index)
            return self._render_page_tile_images_from_page(page, page_index, output_dir, tile_count=tile_count)
        except Exception:
            return []
        finally:
            try:
                document.close()
            except Exception:
                pass


    def _run_audiveris_pagewise(self, pdf_path: Path, output_dir: Path) -> tuple[list[str], dict[str, Any]]:
        if PdfReader is None or PdfWriter is None:
            return [], {}
        try:
            reader = PdfReader(str(pdf_path))
        except Exception:
            return [], {}

        output_dir.mkdir(parents=True, exist_ok=True)
        fitz_document = None
        if fitz is not None:
            try:
                fitz_document = fitz.open(str(pdf_path))
            except Exception:
                fitz_document = None

        page_count = len(reader.pages)
        page_result_cache_hits = 0
        page_result_cache_misses = 0
        render_cache_hits = 0
        render_cache_misses = 0
        tile_render_cache_hits = 0
        tile_render_cache_misses = 0
        page_omr_runs = 0
        tile_omr_runs = 0
        deduped_page_tasks = 0

        try:
            page_tasks: list[dict[str, Any]] = []
            generated_sources_with_order: list[tuple[int, str]] = []
            pending_fingerprint_pages: dict[str, list[int]] = {}

            def append_generated_source(task: dict[str, Any], source_path: str) -> None:
                page_fingerprint = str(task.get("pageFingerprint") or "")
                page_indexes = pending_fingerprint_pages.pop(page_fingerprint, None) or [int(task["pageIndex"])]
                for source_page_index in page_indexes:
                    generated_sources_with_order.append((int(source_page_index), source_path))

            for page_index, page in enumerate(reader.pages, start=1):
                single_pdf_path = output_dir / f"page-{page_index:03d}.pdf"
                page_output_dir = output_dir / f"page-{page_index:03d}"
                page_bytes: bytes = b""
                page_fingerprint = ""
                try:
                    page_buffer = io.BytesIO()
                    writer = PdfWriter()
                    writer.add_page(page)
                    writer.write(page_buffer)
                    page_bytes = page_buffer.getvalue()
                    page_fingerprint = hashlib.sha1(page_bytes).hexdigest()
                except Exception:
                    page_bytes = b""
                    page_fingerprint = self._json_hash({"pdfPath": str(pdf_path), "pageIndex": page_index})

                page_result_cache_path = self._page_result_cache_path(page_fingerprint)
                if page_result_cache_path.exists():
                    page_result_cache_hits += 1
                    preview_status = "missing"
                    if fitz_document is not None:
                        try:
                            if 0 <= (page_index - 1) < fitz_document.page_count:
                                fitz_page = fitz_document.load_page(page_index - 1)
                                _, preview_status = self._ensure_page_preview_image(
                                    output_dir,
                                    page_index,
                                    page_fingerprint,
                                    fitz_page=fitz_page,
                                )
                        except Exception:
                            preview_status = "missing"
                    else:
                        _, preview_status = self._ensure_page_preview_image(
                            output_dir,
                            page_index,
                            page_fingerprint,
                            pdf_path=pdf_path,
                        )
                    if preview_status == "cache-hit":
                        render_cache_hits += 1
                    elif preview_status == "rendered":
                        render_cache_misses += 1
                    generated_sources_with_order.append((page_index, str(page_result_cache_path)))
                    continue
                page_result_cache_misses += 1

                if page_fingerprint in pending_fingerprint_pages:
                    deduped_page_tasks += 1
                    pending_fingerprint_pages[page_fingerprint].append(page_index)
                    preview_status = "missing"
                    if fitz_document is not None:
                        try:
                            if 0 <= (page_index - 1) < fitz_document.page_count:
                                fitz_page = fitz_document.load_page(page_index - 1)
                                _, preview_status = self._ensure_page_preview_image(
                                    output_dir,
                                    page_index,
                                    page_fingerprint,
                                    fitz_page=fitz_page,
                                )
                        except Exception:
                            preview_status = "missing"
                    else:
                        _, preview_status = self._ensure_page_preview_image(
                            output_dir,
                            page_index,
                            page_fingerprint,
                            pdf_path=pdf_path,
                        )
                    if preview_status == "cache-hit":
                        render_cache_hits += 1
                    elif preview_status == "rendered":
                        render_cache_misses += 1
                    continue
                pending_fingerprint_pages[page_fingerprint] = [page_index]

                audiveris_input_path: Path | None = None
                fitz_page = None
                if fitz_document is not None:
                    try:
                        if 0 <= (page_index - 1) < fitz_document.page_count:
                            fitz_page = fitz_document.load_page(page_index - 1)
                            render_cache_path = self._page_render_cache_path(page_fingerprint)
                            if render_cache_path.exists():
                                render_cache_hits += 1
                                audiveris_input_path = render_cache_path
                                try:
                                    preview_path = output_dir / f"page-{page_index:03d}.png"
                                    if not preview_path.exists():
                                        shutil.copy2(render_cache_path, preview_path)
                                except Exception:
                                    pass
                            else:
                                render_cache_misses += 1
                                rendered_page_path = self._render_page_image_from_page(fitz_page, page_index - 1, output_dir)
                                if rendered_page_path is not None:
                                    audiveris_input_path = rendered_page_path
                                    try:
                                        if not render_cache_path.exists():
                                            shutil.copy2(rendered_page_path, render_cache_path)
                                    except Exception:
                                        pass
                    except Exception:
                        fitz_page = None
                        audiveris_input_path = None
                try:
                    if audiveris_input_path is None:
                        if not page_bytes:
                            page_buffer = io.BytesIO()
                            writer = PdfWriter()
                            writer.add_page(page)
                            writer.write(page_buffer)
                            page_bytes = page_buffer.getvalue()
                        with single_pdf_path.open("wb") as handle:
                            handle.write(page_bytes)
                        audiveris_input_path = single_pdf_path
                except Exception:
                    continue

                page_tasks.append(
                    {
                        "pageIndex": page_index,
                        "pageOutputDir": page_output_dir,
                        "audiverisInputPath": audiveris_input_path,
                        "hasFitzPage": fitz_page is not None,
                        "pageFingerprint": page_fingerprint,
                    }
                )

            failed_tasks: list[dict[str, Any]] = []
            max_workers = max(1, min(int(self.settings.omr_pagewise_workers), len(page_tasks) or 1))
            if max_workers <= 1:
                for task in page_tasks:
                    page_omr_runs += 1
                    generated_musicxml = self._run_audiveris(task["audiverisInputPath"], task["pageOutputDir"])
                    if generated_musicxml:
                        cache_path = self._page_result_cache_path(str(task["pageFingerprint"]))
                        try:
                            xml_text = self._read_musicxml_source(Path(generated_musicxml))
                            if xml_text.strip() and not cache_path.exists():
                                cache_path.write_text(xml_text, encoding="utf-8")
                                generated_musicxml = str(cache_path)
                        except Exception:
                            pass
                        append_generated_source(task, generated_musicxml)
                    else:
                        failed_tasks.append(task)
            else:
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_map = {
                        executor.submit(self._run_audiveris, task["audiverisInputPath"], task["pageOutputDir"]): task
                        for task in page_tasks
                    }
                    page_omr_runs += len(future_map)
                    for future in as_completed(future_map):
                        task = future_map[future]
                        try:
                            generated_musicxml = future.result()
                        except Exception:
                            generated_musicxml = None
                        if generated_musicxml:
                            cache_path = self._page_result_cache_path(str(task["pageFingerprint"]))
                            try:
                                xml_text = self._read_musicxml_source(Path(generated_musicxml))
                                if xml_text.strip() and not cache_path.exists():
                                    cache_path.write_text(xml_text, encoding="utf-8")
                                    generated_musicxml = str(cache_path)
                            except Exception:
                                pass
                            append_generated_source(task, generated_musicxml)
                        else:
                            failed_tasks.append(task)

            for task in sorted(failed_tasks, key=lambda item: item["pageIndex"]):
                tile_inputs: list[Path] = []
                if fitz_document is not None and task.get("hasFitzPage"):
                    try:
                        fitz_page = fitz_document.load_page(int(task["pageIndex"]) - 1)
                        page_fingerprint = str(task.get("pageFingerprint") or "")
                        tile_inputs = []
                        missing_tile_indexes: list[int] = []
                        for tile_index in range(1, 3):
                            tile_cache_path = self._page_tile_cache_path(page_fingerprint, tile_index)
                            if tile_cache_path.exists():
                                tile_render_cache_hits += 1
                                tile_inputs.append(tile_cache_path)
                            else:
                                tile_render_cache_misses += 1
                                missing_tile_indexes.append(tile_index)
                        if missing_tile_indexes:
                            rendered_tiles = self._render_page_tile_images_from_page(
                                fitz_page,
                                int(task["pageIndex"]) - 1,
                                output_dir / f"page-{int(task['pageIndex']):03d}-tiles",
                                tile_count=2,
                            )
                            if rendered_tiles:
                                tile_inputs = []
                                for tile_index, tile_path in enumerate(rendered_tiles, start=1):
                                    tile_cache_path = self._page_tile_cache_path(page_fingerprint, tile_index)
                                    try:
                                        if not tile_cache_path.exists():
                                            shutil.copy2(tile_path, tile_cache_path)
                                            tile_inputs.append(tile_cache_path)
                                        else:
                                            tile_inputs.append(tile_cache_path)
                                    except Exception:
                                        tile_inputs.append(tile_path)
                    except Exception:
                        tile_inputs = []
                elif fitz_document is not None:
                    tile_inputs = self._render_pdf_page_tile_images(
                        pdf_path,
                        int(task["pageIndex"]) - 1,
                        output_dir / f"page-{int(task['pageIndex']):03d}-tiles",
                        tile_count=2,
                    )

                for tile_index, tile_input in enumerate(tile_inputs, start=1):
                    tile_output_dir = task["pageOutputDir"] / f"tile-{tile_index:02d}"
                    tile_omr_runs += 1
                    tile_musicxml = self._run_audiveris(tile_input, tile_output_dir)
                    if tile_musicxml:
                        cache_path = self._page_result_cache_path(str(task["pageFingerprint"]))
                        try:
                            xml_text = self._read_musicxml_source(Path(tile_musicxml))
                            if xml_text.strip() and not cache_path.exists():
                                cache_path.write_text(xml_text, encoding="utf-8")
                                tile_musicxml = str(cache_path)
                        except Exception:
                            pass
                        append_generated_source(task, tile_musicxml)
                        break
            generated_sources_with_order.sort(key=lambda item: item[0])
            pagewise_cache_hit_rate = round(page_result_cache_hits / page_count, 4) if page_count else 0.0
            render_cache_hit_rate = round(render_cache_hits / max(1, render_cache_hits + render_cache_misses), 4)
            tile_render_cache_hit_rate = round(tile_render_cache_hits / max(1, tile_render_cache_hits + tile_render_cache_misses), 4)
            stats = {
                "mode": "pagewise",
                "pageCount": page_count,
                "pageResultCacheHits": page_result_cache_hits,
                "pageResultCacheMisses": page_result_cache_misses,
                "pageResultCacheHitRate": pagewise_cache_hit_rate,
                "renderCacheHits": render_cache_hits,
                "renderCacheMisses": render_cache_misses,
                "renderCacheHitRate": render_cache_hit_rate,
                "tileRenderCacheHits": tile_render_cache_hits,
                "tileRenderCacheMisses": tile_render_cache_misses,
                "tileRenderCacheHitRate": tile_render_cache_hit_rate,
                "pageOmrRuns": page_omr_runs,
                "tileOmrRuns": tile_omr_runs,
                "dedupedPageTasks": deduped_page_tasks,
                "uniquePageOmrTasks": len(page_tasks),
                "reusedPageResults": page_result_cache_hits + deduped_page_tasks,
                "pageTaskReductionRate": round((page_result_cache_hits + deduped_page_tasks) / page_count, 4) if page_count else 0.0,
                "resultCount": len(generated_sources_with_order),
                "workers": max_workers,
            }
            return [source for _, source in generated_sources_with_order], stats
        finally:
            if fitz_document is not None:
                try:
                    fitz_document.close()
                except Exception:
                    pass


    def _estimate_pagewise_omr_confidence(self, pagewise_stats: dict[str, Any], source_count: int) -> float:
        page_count = max(1, int(safe_float(pagewise_stats.get("pageCount"), 0)))
        result_count = max(0, int(safe_float(pagewise_stats.get("resultCount"), source_count)))
        coverage = min(1.0, float(result_count) / float(page_count))
        tile_runs = max(0.0, safe_float(pagewise_stats.get("tileOmrRuns"), 0.0))
        tile_pressure = min(1.0, tile_runs / float(page_count))
        workers = max(1.0, safe_float(pagewise_stats.get("workers"), 1.0))

        # OMR confidence must reflect OMR quality only. Cache hit rates are a
        # re-import performance property, not quality; including them made the same
        # PDF score higher on a warm re-import than on the cold first import and
        # cross the low-confidence gate. Coverage, tile pressure, and worker bonus
        # are the genuine quality signals. Must match src/server/omrStats.js.
        confidence = (
            0.56
            + (coverage * 0.28)
            - (tile_pressure * 0.06)
        )
        if workers > 1 and coverage >= 0.9:
            confidence += 0.02
        return max(0.44, min(0.9, round(confidence, 3)))


    def _extract_tempo_from_pdf_image(self, pdf_path: Path, page_index: int = 0) -> int | None:
        """
        Extract tempo from a score page (PDF or PNG/image).

        Strategy:
        1. Text extraction (fast): parse '(D=NNN)' patterns from PDF text layer.
        2. Image OCR: find pairs of '=' bars via connected-component analysis, run ddddocr.
        PNG/image files are loaded directly; missing PDFs fall back to a sibling PNG.
        """
        try:
            import re as _re
            import fitz as _fitz

            actual_path = pdf_path
            is_image = actual_path.suffix.lower() in {".png", ".jpg", ".jpeg", ".bmp"}

            # Resolve: if PDF not found, try sibling PNG
            if not is_image and not actual_path.exists():
                png_sibling = actual_path.with_suffix(".png")
                if png_sibling.exists():
                    actual_path = png_sibling
                    is_image = True

            if not actual_path.exists():
                return None

            # Strategy 1: text extraction (Western-font PDFs)
            if not is_image:
                try:
                    doc = _fitz.open(str(actual_path))
                    text = doc[min(page_index, len(doc) - 1)].get_text()
                    doc.close()
                    # Match: (D=56), (q=138), =138 etc.
                    for m in _re.finditer(r"[=(]\s*[A-Za-z]?\s*=\s*(\d{2,3})", text):
                        bpm = int(m.group(1))
                        if 40 <= bpm <= 300:
                            return bpm
                except Exception:
                    pass

            # Strategy 2: image-based OCR
            import cv2 as _cv2
            import numpy as _np
            import io as _io
            import ddddocr as _ddddocr

            _ocr = _ddddocr.DdddOcr(show_ad=False)
            SCALE = 3.0

            if is_image:
                from PIL import Image as _PILImage
                raw_img = _PILImage.open(str(actual_path)).convert("RGB")
                arr = _np.array(raw_img)
            else:
                doc = _fitz.open(str(actual_path))
                try:
                    if page_index >= len(doc):
                        return None
                    page = doc[page_index]
                    mat = _fitz.Matrix(SCALE, SCALE)
                    pix = page.get_pixmap(matrix=mat)
                    arr = _np.frombuffer(pix.samples, dtype=_np.uint8).reshape(
                        pix.height, pix.width, pix.n
                    )
                    if pix.n == 4:
                        arr = arr[:, :, :3]
                finally:
                    doc.close()

            h, w = arr.shape[:2]
            gray = _cv2.cvtColor(arr, _cv2.COLOR_RGB2GRAY)
            _, binary = _cv2.threshold(gray, 200, 255, _cv2.THRESH_BINARY_INV)

            # Only look in the top 35% of the page (tempo marks never in lower portion)
            search_h = int(h * 0.35)
            binary_top = binary[:search_h, :]

            # Find connected components in top region
            num_labels, _labels, stats, _centroids = _cv2.connectedComponentsWithStats(binary_top)

            # Tempo marks appear in left 65% of page; ignore right side (barlines, repeat signs)
            search_w = int(w * 0.65)

            # Collect thin, short horizontal bars that could be '=' bars
            # '=' bar: width 8–60px at 3x, height 2–7px, width > height*2
            eq_bar_candidates: list[tuple[int, int, int, int]] = []  # (x, y, w, h)
            for i in range(1, num_labels):
                cx, cy, cw, ch, area = stats[i]
                if cx + cw > search_w:
                    continue  # skip bars in right portion of page
                if 8 <= cw <= 60 and 2 <= ch <= 7 and cw >= ch * 2 and area >= 12:
                    eq_bar_candidates.append((cx, cy, cw, ch))

            # Pair up bars that form '=': same x region, close vertically (4–18px apart)
            eq_signs: list[tuple[int, int, int]] = []  # (x_left, y_mid, bar_width)
            used = set()
            for i, (x1, y1, w1, h1) in enumerate(eq_bar_candidates):
                if i in used:
                    continue
                for j, (x2, y2, w2, h2) in enumerate(eq_bar_candidates):
                    if j <= i or j in used:
                        continue
                    if abs(x1 - x2) <= 8 and 4 <= abs(y1 - y2) <= 18:
                        x_left = min(x1, x2)
                        y_mid = (y1 + y2) // 2
                        bar_w = max(w1, w2)
                        eq_signs.append((x_left, y_mid, bar_w))
                        used.add(i)
                        used.add(j)
                        break

            for eq_x, eq_y, eq_w in eq_signs:
                # Digits are to the right of '=': extend ~80px for up to 3 digits
                dx1 = eq_x + eq_w + 2
                dx2 = min(w, eq_x + eq_w + 90)
                dy1 = max(0, eq_y - 20)
                dy2 = min(search_h, eq_y + 22)
                if dx2 <= dx1 or dy2 <= dy1:
                    continue
                crop = arr[dy1:dy2, dx1:dx2]
                if crop.size == 0:
                    continue
                # Include the '=' itself for context
                full_x1 = max(0, eq_x - 5)
                full_crop = arr[dy1:dy2, full_x1:dx2]
                from PIL import Image as _PILImage
                pil = _PILImage.fromarray(full_crop)
                # Upscale to aid OCR on small digits
                pil = pil.resize((max(80, pil.width * 2), max(20, pil.height * 2)), _PILImage.LANCZOS)
                buf = _io.BytesIO()
                pil.save(buf, format="PNG")
                raw = _ocr.classification(buf.getvalue())
                for m in _re.finditer(r"(\d{2,3})", raw or ""):
                    bpm = int(m.group(1))
                    if 40 <= bpm <= 300:
                        return bpm

        except Exception:
            pass
        return None


    def _run_audiveris(self, pdf_path: Path, output_dir: Path) -> str | None:
        audiveris_cli = self.settings.audiveris_cli.strip()
        if not audiveris_cli or not os.path.exists(audiveris_cli):
            return None
        page_count = 1
        if PdfReader is not None:
            try:
                page_count = max(1, len(PdfReader(str(pdf_path)).pages))
            except Exception:
                page_count = 1
        try:
            subprocess.run(
                [audiveris_cli, "-batch", "-transcribe", "-export", "-output", str(output_dir), str(pdf_path)],
                check=False,
                capture_output=True,
                timeout=self.settings.audiveris_timeout_seconds,
            )
        except Exception:
            return None

        candidates = self._collect_musicxml_candidates(output_dir)
        if not candidates:
            return None
        for candidate in candidates:
            xml_text = self._read_musicxml_source(candidate)
            if not xml_text.strip():
                continue
            if self._extract_musicxml_parts(xml_text):
                return None if page_count > 1 else str(candidate)
            if "<score-partwise" in xml_text or "<score-timewise" in xml_text:
                return None if page_count > 1 else str(candidate)
        return None
