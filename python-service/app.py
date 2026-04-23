from __future__ import annotations

from fastapi import FastAPI, HTTPException

from analyzer import ErhuAnalyzer
from config import settings
from schemas import AnalyzeRequest, RankSectionsRequest, ScoreImportRequest, SeparateErhuRequest

app = FastAPI(title="AI Erhu Analyzer", version="0.1.0")
analyzer = ErhuAnalyzer(settings)


@app.get("/health")
def health() -> dict[str, object]:
    dependencies = analyzer.dependency_report()
    ready = True if not settings.enable_torchcrepe else bool(dependencies["numpy"] and dependencies["torch"] and dependencies["torchcrepe"])
    return {
        "ok": True,
        "service": settings.service_name,
        "mode": "torchcrepe-ready" if settings.enable_torchcrepe else "skeleton",
        "ready": ready,
        "dependencies": dependencies,
        "settings": settings.public_dict(),
    }


@app.get("/config")
def config() -> dict[str, object]:
    return {
        "ok": True,
        "service": settings.service_name,
        "settings": settings.public_dict(),
        "dependencies": analyzer.dependency_report(),
    }


@app.post("/analyze")
def analyze(payload: AnalyzeRequest) -> dict[str, object]:
    if not payload.piecePack.notes and not (payload.piecePack.scoreSource and payload.piecePack.scoreSource.data):
        raise HTTPException(status_code=400, detail="piecePack.notes or piecePack.scoreSource is required")
    result = analyzer.analyze(payload)
    retry_applied = False
    retry_count = 0
    if analyzer.should_retry_analysis(payload, result):
        retry_applied = True
        best_result = result
        for _ in range(max(1, int(settings.analysis_stability_retry_max_retries))):
            retry_count += 1
            retry_result = analyzer.analyze(payload)
            best_result = analyzer.choose_preferred_analysis(payload, best_result, retry_result)
            if not analyzer.should_retry_analysis(payload, best_result):
                break
        result = best_result
    result.diagnostics["stabilityRetryApplied"] = retry_applied
    result.diagnostics["stabilityRetryCount"] = retry_count
    result.diagnostics["stabilityRetryReason"] = (
        "coarse-section-low-pitch-review" if retry_applied else ""
    )
    return {"ok": True, "analysis": result.model_dump()}


@app.post("/score/import-pdf")
def import_pdf_score(payload: ScoreImportRequest) -> dict[str, object]:
    result = analyzer.import_pdf_score(payload)
    return {"ok": True, "job": result.model_dump()}


@app.get("/score/import-pdf/{job_id}")
def get_score_import_pdf(job_id: str) -> dict[str, object]:
    raise HTTPException(status_code=404, detail=f"job lookup should be handled by the Node gateway: {job_id}")


@app.post("/audio/separate-erhu")
def separate_erhu(payload: SeparateErhuRequest) -> dict[str, object]:
    if not payload.piecePack.notes and not (payload.piecePack.scoreSource and payload.piecePack.scoreSource.data):
        raise HTTPException(status_code=400, detail="piecePack.notes or piecePack.scoreSource is required")
    result = analyzer.separate_erhu(payload)
    return {"ok": True, "separation": result.model_dump()}


@app.post("/detect-sections")
def detect_sections(payload: RankSectionsRequest) -> dict[str, object]:
    if not payload.piecePacks:
        raise HTTPException(status_code=400, detail="piecePacks is required")
    candidates = analyzer.rank_sections(payload)
    return {"ok": True, "candidates": [candidate.model_dump() for candidate in candidates]}
