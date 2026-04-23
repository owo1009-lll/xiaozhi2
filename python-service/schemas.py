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
    sequenceIndex: int | None = None
    sourceSectionId: str | None = None
    researchWindowHints: list[float] = Field(default_factory=list)
    measureRange: list[int] = Field(default_factory=list)
    calibrationProfile: dict[str, Any] | None = None
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
    scoreId: str | None = None
    pieceId: str | None = None
    sectionId: str | None = None
    preprocessMode: str | None = "off"
    separationMode: str | None = "auto"
    piecePack: PiecePack
    audioSubmission: AudioSubmission | None = None
    audioPath: str | None = None
    audioDataUrl: str | None = None
    windowStartSeconds: float | None = None
    windowEndSeconds: float | None = None


class MeasureFinding(BaseModel):
    measureIndex: int
    issueType: str
    issueLabel: str
    detail: str
    rhythmType: str | None = None
    severity: str | None = None
    coachingTip: str | None = None


class NoteFinding(BaseModel):
    noteId: str
    measureIndex: int
    expectedMidi: int
    centsError: int
    rawCentsError: int | None = None
    octaveFlexSemitones: int | None = None
    onsetErrorMs: int
    pitchLabel: str
    rhythmLabel: str
    rhythmType: str | None = None
    rhythmTypeLabel: str | None = None
    expectedDurationMs: int | None = None
    observedDurationMs: int | None = None
    durationErrorMs: int | None = None
    pitchToleranceCents: int | None = None
    confidence: float | None = None
    isUncertain: bool = False
    evidenceLabel: str | None = None
    severity: str | None = None
    why: str | None = None
    action: str | None = None


class PracticeTarget(BaseModel):
    priority: int
    targetType: str
    targetId: str | None = None
    measureIndex: int | None = None
    title: str
    why: str
    action: str
    severity: str | None = None
    evidenceLabel: str | None = None
    practicePath: str | None = None
    pathReason: str | None = None


class DemoSegment(BaseModel):
    measureIndex: int
    demoAudio: str | None = None
    label: str


class AnalyzeResult(BaseModel):
    overallPitchScore: int
    overallRhythmScore: int
    studentPitchScore: int | None = None
    studentRhythmScore: int | None = None
    studentCombinedScore: int | None = None
    separationApplied: bool | None = None
    separationMode: str | None = None
    separationConfidence: float | None = None
    rawAudioPath: str | None = None
    erhuEnhancedAudioPath: str | None = None
    accompanimentResidualPath: str | None = None
    measureFindings: list[MeasureFinding]
    noteFindings: list[NoteFinding]
    demoSegments: list[DemoSegment]
    confidence: float
    summaryText: str | None = None
    teacherComment: str | None = None
    recommendedPracticePath: str | None = None
    practiceTargets: list[PracticeTarget] = Field(default_factory=list)
    analysisMode: str = "external"
    diagnostics: dict[str, Any] = Field(default_factory=dict)


class ScoreImportRequest(BaseModel):
    jobId: str
    pdfPath: str
    originalFilename: str | None = None
    titleHint: str | None = None
    selectedPartHint: str | None = None
    fallbackPieceId: str | None = None
    fallbackPieceTitle: str | None = None
    fallbackPiecePack: dict[str, Any] | None = None
    outputDir: str | None = None


class ScoreImportJobResult(BaseModel):
    jobId: str
    omrStatus: str
    omrConfidence: float = 0.0
    scoreId: str | None = None
    title: str | None = None
    sourcePdfPath: str | None = None
    musicxmlPath: str | None = None
    previewPages: list[dict[str, Any]] = Field(default_factory=list)
    detectedParts: list[str] = Field(default_factory=list)
    selectedPart: str | None = None
    selectedPartCandidates: list[str] = Field(default_factory=list)
    piecePack: dict[str, Any] | None = None
    omrStats: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


class SeparateErhuRequest(BaseModel):
    pieceId: str | None = None
    sectionId: str | None = None
    separationMode: str | None = "erhu-focus"
    piecePack: PiecePack
    audioSubmission: AudioSubmission | None = None
    audioPath: str | None = None
    audioDataUrl: str | None = None
    outputDir: str | None = None


class SeparateErhuResult(BaseModel):
    separationApplied: bool
    separationMode: str
    separationConfidence: float = 0.0
    inputAudioPath: str | None = None
    erhuEnhancedAudioPath: str | None = None
    accompanimentResidualPath: str | None = None
    warnings: list[str] = Field(default_factory=list)


class RankSectionsRequest(BaseModel):
    participantId: str = "section-rank"
    groupId: str = "experimental"
    sessionStage: str = "section-rank"
    scoreId: str | None = None
    pieceId: str | None = None
    preprocessMode: str | None = "off"
    separationMode: str | None = "auto"
    piecePacks: list[PiecePack] = Field(default_factory=list)
    audioSubmission: AudioSubmission | None = None
    audioPath: str | None = None
    audioDataUrl: str | None = None


class RankedSectionCandidate(BaseModel):
    pieceId: str | None = None
    sectionId: str
    sourceSectionId: str | None = None
    sectionTitle: str = ""
    sequenceIndex: int = 0
    score: float = 0.0
    overallPitchScore: int = 0
    overallRhythmScore: int = 0
    confidence: float = 0.0
    recommendedPracticePath: str | None = None
    measureFindingCount: int = 0
    noteFindingCount: int = 0
    summaryText: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)
