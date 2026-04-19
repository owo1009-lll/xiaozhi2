from __future__ import annotations

import os
from dataclasses import asdict, dataclass


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class Settings:
    service_name: str = os.getenv("ERHU_SERVICE_NAME", "ai-erhu-analyzer")
    host: str = os.getenv("ERHU_HOST", "0.0.0.0")
    port: int = int(os.getenv("ERHU_PORT", "8000"))
    pitch_hop_ms: int = int(os.getenv("ERHU_PITCH_HOP_MS", "10"))
    min_confidence: float = float(os.getenv("ERHU_MIN_CONFIDENCE", "0.6"))
    enable_torchcrepe: bool = env_bool("ERHU_ENABLE_TORCHCREPE", False)
    enable_librosa_decode: bool = env_bool("ERHU_ENABLE_LIBROSA_DECODE", False)
    fallback_issue_limit: int = int(os.getenv("ERHU_FALLBACK_ISSUE_LIMIT", "4"))

    def public_dict(self) -> dict[str, object]:
        return asdict(self)


settings = Settings()
