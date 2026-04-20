from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class NoteEvent(BaseModel):
    noteId: str = ""
    measureIndex: int = 1
    beatStart: float = 0.0
    beatDuration: float = 1.0
    midiPitch: int = 60


class SymbolicScoreSource(BaseModel):
    format: str | None = None
    encoding: str | None = None
    data: str | None = None
    filename: str | None = None


class PiecePack(BaseModel):
    pieceId: str | None = None
    sectionId: str | None = None
    title: str | None = None
    meter: str | None = None
    tempo: int = 72
    demoAudio: str | None = None
    notes: list[NoteEvent] = Field(default_factory=list)
    scoreSource: SymbolicScoreSource | None = None


class AudioSubmission(BaseModel):
    name: str | None = None
    mimeType: str | None = None
    size: int | None = None
    duration: float | None = None


class AnalyzeRequest(BaseModel):
    participantId: str
    groupId: str = "experimental"
    sessionStage: str = "pretest"
    pieceId: str | None = None
    sectionId: str | None = None
    piecePack: PiecePack
    audioSubmission: AudioSubmission | None = None
    audioDataUrl: str | None = None


class MeasureFinding(BaseModel):
    measureIndex: int
    issueType: str
    issueLabel: str
    detail: str


class NoteFinding(BaseModel):
    noteId: str
    measureIndex: int
    expectedMidi: int
    centsError: int
    onsetErrorMs: int
    pitchLabel: str
    rhythmLabel: str
    pitchToleranceCents: int | None = None
    confidence: float | None = None
    isUncertain: bool = False
    evidenceLabel: str | None = None


class DemoSegment(BaseModel):
    measureIndex: int
    demoAudio: str | None = None
    label: str


class AnalyzeResult(BaseModel):
    overallPitchScore: int
    overallRhythmScore: int
    measureFindings: list[MeasureFinding]
    noteFindings: list[NoteFinding]
    demoSegments: list[DemoSegment]
    confidence: float
    analysisMode: str = "external"
    diagnostics: dict[str, Any] = Field(default_factory=dict)
