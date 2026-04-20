from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parent / ".env")


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
    target_sample_rate: int = int(os.getenv("ERHU_TARGET_SAMPLE_RATE", "16000"))
    pitch_hop_ms: int = int(os.getenv("ERHU_PITCH_HOP_MS", "10"))
    onset_hop_length: int = int(os.getenv("ERHU_ONSET_HOP_LENGTH", "256"))
    min_confidence: float = float(os.getenv("ERHU_MIN_CONFIDENCE", "0.6"))
    uncertain_confidence: float = float(os.getenv("ERHU_UNCERTAIN_CONFIDENCE", "0.63"))
    stable_region_start_ratio: float = float(os.getenv("ERHU_STABLE_REGION_START_RATIO", "0.2"))
    stable_region_end_ratio: float = float(os.getenv("ERHU_STABLE_REGION_END_RATIO", "0.82"))
    stable_note_min_frames: int = int(os.getenv("ERHU_STABLE_NOTE_MIN_FRAMES", "3"))
    base_pitch_tolerance_cents: float = float(os.getenv("ERHU_BASE_PITCH_TOLERANCE_CENTS", "15"))
    vibrato_spread_threshold_cents: float = float(os.getenv("ERHU_VIBRATO_SPREAD_THRESHOLD_CENTS", "26"))
    vibrato_tolerance_bonus_cents: float = float(os.getenv("ERHU_VIBRATO_TOLERANCE_BONUS_CENTS", "8"))
    glide_entry_threshold_cents: float = float(os.getenv("ERHU_GLIDE_ENTRY_THRESHOLD_CENTS", "24"))
    glide_tolerance_bonus_cents: float = float(os.getenv("ERHU_GLIDE_TOLERANCE_BONUS_CENTS", "12"))
    max_pitch_tolerance_cents: float = float(os.getenv("ERHU_MAX_PITCH_TOLERANCE_CENTS", "38"))
    base_rhythm_tolerance_ms: float = float(os.getenv("ERHU_BASE_RHYTHM_TOLERANCE_MS", "50"))
    enable_torchcrepe: bool = env_bool("ERHU_ENABLE_TORCHCREPE", False)
    enable_librosa_decode: bool = env_bool("ERHU_ENABLE_LIBROSA_DECODE", False)
    ffmpeg_path: str = os.getenv("ERHU_FFMPEG_PATH", "")
    fallback_issue_limit: int = int(os.getenv("ERHU_FALLBACK_ISSUE_LIMIT", "4"))

    def public_dict(self) -> dict[str, object]:
        return asdict(self)


settings = Settings()
