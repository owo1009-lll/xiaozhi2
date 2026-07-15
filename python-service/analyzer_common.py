# -*- coding: utf-8 -*-
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import wave
import zipfile
import collections
import collections.abc
import gc
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from statistics import median
import time
from typing import Any
from xml.etree import ElementTree as ET

if not hasattr(collections, "MutableSequence"):
    collections.MutableSequence = collections.abc.MutableSequence

from config import Settings
from schemas import (
    AnalyzeRequest,
    AnalyzeResult,
    DemoSegment,
    MeasureFinding,
    NoteEvent,
    NoteFinding,
    PiecePack,
    PracticeTarget,
    RankedSectionCandidate,
    RankSectionsRequest,
    MusicXmlImportRequest,
    ScoreImportJobResult,
    ScoreImportRequest,
    SeparateErhuRequest,
    SeparateErhuResult,
)
from analyzer_audio import (
    AudioArtifact,
    DecodedAudioCacheItem,
    audio_file_cache_identity,
    decoded_cache_item,
    is_sha1_hex,
    mono_float32,
)
from analyzer_feature_reuse import estimate_window_feature_from_full_audio

try:
    import numpy as np
except ImportError:  # pragma: no cover - optional dependency
    np = None

if np is not None:
    if not hasattr(np, "float"):
        np.float = float  # type: ignore[attr-defined]
    if not hasattr(np, "int"):
        np.int = int  # type: ignore[attr-defined]
    if not hasattr(np, "complex"):
        np.complex = np.complex128  # type: ignore[attr-defined]

try:
    import librosa
except ImportError:  # pragma: no cover - optional dependency
    librosa = None

try:
    import soundfile as sf
except ImportError:  # pragma: no cover - optional dependency
    sf = None

try:
    import torch
    import torchcrepe
except ImportError:  # pragma: no cover - optional dependency
    torch = None
    torchcrepe = None

try:
    import imageio_ffmpeg
except ImportError:  # pragma: no cover - optional dependency
    imageio_ffmpeg = None

try:
    import pretty_midi
except ImportError:  # pragma: no cover - optional dependency
    pretty_midi = None

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:  # pragma: no cover - optional dependency
    PdfReader = None
    PdfWriter = None

try:
    import fitz
except ImportError:  # pragma: no cover - optional dependency
    fitz = None

try:
    from madmom.features.beats import DBNBeatTrackingProcessor, RNNBeatProcessor
    from madmom.features.onsets import OnsetPeakPickingProcessor, RNNOnsetProcessor
except ImportError:  # pragma: no cover - optional dependency
    DBNBeatTrackingProcessor = None
    RNNBeatProcessor = None
    OnsetPeakPickingProcessor = None
    RNNOnsetProcessor = None

from analyzer_utils import (
    analysis_separation_result_fields,
    beats_per_measure,
    cents_between,
    cents_error,
    count_sign_changes,
    frequency_to_midi,
    lowpass_series,
    midi_to_frequency,
    musicxml_clef_reference,
    musicxml_pitch_to_midi,
    musicxml_step_to_diatonic,
    normalize_part_label,
    optional_count,
    optional_float,
    optional_ratio,
    normalize_musicxml_measure_indices,
    parse_musicxml_measure_index,
    percentile,
    safe_float,
    severity_label,
    trimmed_median,
)
from analyzer_models import ObservedNote, SymbolicNote
from analyzer_musicxml import (
    extract_dynamic_label,
    extract_musicxml_markings,
    extract_musicxml_part_candidates,
    resolve_selected_part_from_candidates,
    refine_selected_part_candidate_with_layout,
    xml_child,
    xml_children,
    xml_local_tag,
)
from analyzer_score_roles import (
    apply_page_erhu_fallback,
    collapse_erhu_melody_events,
    is_ambiguous_part_candidate,
    is_clean_solo_part_candidate,
    is_explicit_erhu_part_candidate,
    should_apply_erhu_range_fallback,
)
