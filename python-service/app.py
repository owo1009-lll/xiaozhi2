from __future__ import annotations

from fastapi import FastAPI, HTTPException

from analyzer import ErhuAnalyzer
from config import settings
from schemas import AnalyzeRequest

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
    if not payload.piecePack.notes:
        raise HTTPException(status_code=400, detail="piecePack.notes is required")
    result = analyzer.analyze(payload)
    return {"ok": True, "analysis": result.model_dump()}
