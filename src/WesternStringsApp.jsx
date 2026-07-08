import { useRef, useState } from "react";
import {
  fetchWesternControlledSubmissions,
  fetchWesternStudentAnalysis,
  importScoreMidi,
  importScoreMusicXml,
  runWesternControlledSubmissionBatch,
  saveWesternControlledSubmissionReview,
  saveWesternStudentReview,
} from "./researchApi.js";

const INSTRUMENTS = [
  { id: "violin", label: "Violin" },
  { id: "viola", label: "Viola" },
  { id: "cello", label: "Cello" },
];

function fileTitle(file) {
  if (!file?.name) return "";
  return file.name.replace(/\.(musicxml|xml|mxl|mid|midi)$/i, "");
}

export default function WesternStringsApp({ onBackToStudent }) {
  const musicXmlInputRef = useRef(null);
  const midiInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const [instrument, setInstrument] = useState("violin");
  const [scoreFile, setScoreFile] = useState(null);
  const [scoreKind, setScoreKind] = useState("");
  const [audioFile, setAudioFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("Select a clean MusicXML or MIDI score.");
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [submissionQueue, setSubmissionQueue] = useState(null);
  const [submissionQueueLoading, setSubmissionQueueLoading] = useState(false);
  const [submissionReviewSavingId, setSubmissionReviewSavingId] = useState("");
  const [submissionBatchLoading, setSubmissionBatchLoading] = useState(false);
  const [submissionBatchResult, setSubmissionBatchResult] = useState(null);
  const [reviewSavingNoteId, setReviewSavingNoteId] = useState("");
  const [reviewMessage, setReviewMessage] = useState("");

  async function importSelectedScore() {
    if (!scoreFile || !scoreKind) {
      setError("Choose a MusicXML or MIDI file first.");
      return;
    }
    setImporting(true);
    setError("");
    setStatus("Importing clean score...");
    setJob(null);
    const metadata = {
      selectedPartHint: instrument,
      instrument,
      scoreSource: scoreKind,
      tempoKnown: scoreKind === "midi" ? "true" : "false",
      tempoSource: scoreKind === "midi" ? "midi" : "unknown",
    };
    try {
      const result =
        scoreKind === "midi"
          ? await importScoreMidi(scoreFile, fileTitle(scoreFile), metadata)
          : await importScoreMusicXml(scoreFile, fileTitle(scoreFile), metadata);
      setJob(result.job || null);
      setStatus(result.ok ? "Clean score imported." : "Clean score import failed.");
    } catch (importError) {
      setError(importError?.message || "Clean score import failed.");
      setStatus("Import failed.");
    } finally {
      setImporting(false);
    }
  }

  function pickFile(kind, file) {
    setScoreKind(kind);
    setScoreFile(file || null);
    setJob(null);
    setAudioFile(null);
    setError("");
    setStatus(file ? `${kind === "midi" ? "MIDI" : "MusicXML"} selected: ${file.name}` : "Select a clean MusicXML or MIDI score.");
  }

  function pickAudioFile(file) {
    setAudioFile(file || null);
    setError("");
    setReviewMessage("");
  }

  async function loadCoreDiagnosisPreview() {
    setAnalysisLoading(true);
    setError("");
    setReviewMessage("");
    try {
      const result = await fetchWesternStudentAnalysis({ dataset: "m0a-bach10", limit: 8 });
      setAnalysisResult(result.analysis || null);
    } catch (analysisError) {
      setError(analysisError?.message || "Western strings core diagnosis preview failed.");
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function submitControlledRecording() {
    if (!job?.scoreId) {
      setError("Import a clean score before submitting audio.");
      return;
    }
    if (!audioFile) {
      setError("Choose an audio recording first.");
      return;
    }
    setAnalysisLoading(true);
    setError("");
    setReviewMessage("");
    try {
      const result = await fetchWesternStudentAnalysis({
        scoreId: job.scoreId,
        instrument,
        audioFile,
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type,
          size: audioFile.size,
        },
      });
      setAnalysisResult(result.analysis || null);
      setReviewMessage(result.analysis?.submissionAccepted
        ? "Recording submitted for offline review. No automatic diagnosis was issued."
        : "Submission returned without review intake.");
      await loadControlledSubmissionQueue();
    } catch (analysisError) {
      setError(analysisError?.message || "Controlled recording submission failed.");
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function loadControlledSubmissionQueue() {
    setSubmissionQueueLoading(true);
    setError("");
    try {
      const result = await fetchWesternControlledSubmissions({ limit: 20 });
      setSubmissionQueue(result);
    } catch (queueError) {
      setError(queueError?.message || "Controlled submission queue failed to load.");
    } finally {
      setSubmissionQueueLoading(false);
    }
  }

  async function saveSubmissionReview(submission, action) {
    setSubmissionReviewSavingId(submission.submissionId);
    setReviewMessage("");
    try {
      await saveWesternControlledSubmissionReview({
        submissionId: submission.submissionId,
        action,
      });
      setReviewMessage("Controlled submission review saved.");
      await loadControlledSubmissionQueue();
    } catch (queueError) {
      setError(queueError?.message || "Controlled submission review failed.");
    } finally {
      setSubmissionReviewSavingId("");
    }
  }

  async function runControlledBatch() {
    setSubmissionBatchLoading(true);
    setReviewMessage("");
    setError("");
    try {
      const result = await runWesternControlledSubmissionBatch({ limit: 20 });
      setSubmissionBatchResult(result.batch || null);
      setReviewMessage("Controlled batch audit finished. No automatic diagnosis was issued.");
      await loadControlledSubmissionQueue();
    } catch (queueError) {
      setError(queueError?.message || "Controlled batch audit failed.");
    } finally {
      setSubmissionBatchLoading(false);
    }
  }

  async function saveReview(decision, action) {
    setReviewSavingNoteId(decision.noteId);
    setReviewMessage("");
    try {
      await saveWesternStudentReview({
        noteId: decision.noteId,
        action,
        category: "pitch",
        predictedOnsetSeconds: decision.predictedOnsetSeconds,
      });
      setReviewMessage(action === "confirm" ? "Review saved: confirmed." : "Review saved: sent to review.");
    } catch (reviewError) {
      setError(reviewError?.message || "Review save failed.");
    } finally {
      setReviewSavingNoteId("");
    }
  }

  return (
    <div className="app-shell western-strings-app">
      <header className="hero-card">
        <div>
          <span className="eyebrow">Western strings V2 alpha</span>
          <h1>Clean-score practice diagnostics</h1>
          <p>MusicXML and MIDI only. Low-confidence analysis remains in review until the V2 gates pass.</p>
        </div>
        <div className="metric-card">
          <strong>Input policy</strong>
          <span>PDF OMR disabled</span>
        </div>
      </header>

      {onBackToStudent ? (
        <div className="toolbar">
          <button type="button" className="secondary-button" onClick={onBackToStudent}>
            Back
          </button>
        </div>
      ) : null}

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">M1 clean score</span>
            <h2>Import score</h2>
          </div>
          <select value={instrument} onChange={(event) => setInstrument(event.target.value)} aria-label="Instrument">
            {INSTRUMENTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <input
          ref={musicXmlInputRef}
          type="file"
          accept=".musicxml,.xml,.mxl,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml"
          hidden
          onChange={(event) => pickFile("musicxml", event.target.files?.[0] || null)}
        />
        <input
          ref={midiInputRef}
          type="file"
          accept=".mid,.midi,audio/midi"
          hidden
          onChange={(event) => pickFile("midi", event.target.files?.[0] || null)}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
          hidden
          onChange={(event) => pickAudioFile(event.target.files?.[0] || null)}
        />

        <div className="western-strings-actions">
          <button type="button" className="secondary-button" onClick={() => musicXmlInputRef.current?.click()}>
            Choose MusicXML
          </button>
          <button type="button" className="secondary-button" onClick={() => midiInputRef.current?.click()}>
            Choose MIDI
          </button>
          <button type="button" className="primary-button" disabled={importing || !scoreFile} onClick={importSelectedScore}>
            {importing ? "Importing..." : "Import"}
          </button>
        </div>

        <div className="status-banner" aria-live="polite">
          {status}
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        {job ? (
          <div className="western-strings-result">
            <div>
              <strong>Score ID</strong>
              <span>{job.scoreId || "pending"}</span>
            </div>
            <div>
              <strong>Source</strong>
              <span>{job.scoreSource || scoreKind}</span>
            </div>
            <div>
              <strong>Tempo</strong>
              <span>{job.tempoKnown ? job.tempoSource || "known" : "unknown"}</span>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Offline review queue</span>
            <h2>Controlled submissions</h2>
          </div>
          <button type="button" className="secondary-button" disabled={submissionQueueLoading} onClick={loadControlledSubmissionQueue}>
            {submissionQueueLoading ? "Loading..." : "Refresh queue"}
          </button>
          <button type="button" className="secondary-button" disabled={submissionBatchLoading} onClick={runControlledBatch}>
            {submissionBatchLoading ? "Running..." : "Run batch audit"}
          </button>
        </div>

        <p className="muted-copy">
          These are uploaded clean-score recordings waiting for manual review or offline batch analysis. Queue actions never create
          student-facing automatic feedback.
        </p>

        {submissionQueue ? (
          <>
            <div className="western-strings-result">
              <div>
                <strong>Total</strong>
                <span>{submissionQueue.summary?.total ?? 0}</span>
              </div>
              <div>
                <strong>Review</strong>
                <span>{submissionQueue.summary?.reviewRequired ?? 0}</span>
              </div>
              <div>
                <strong>Batch</strong>
                <span>{submissionQueue.summary?.acceptedForBatch ?? 0}</span>
              </div>
              <div>
                <strong>Rejected</strong>
                <span>{submissionQueue.summary?.rejected ?? 0}</span>
              </div>
            </div>

            {submissionBatchResult ? (
              <div className="status-banner">
                Batch {submissionBatchResult.batchRunId}: {submissionBatchResult.itemCount} item(s), status {submissionBatchResult.status}.
                {(submissionBatchResult.items || []).length ? (
                  <div className="batch-result-list">
                    {(submissionBatchResult.items || []).slice(0, 5).map((item) => (
                      <span key={item.submissionId}>
                        {item.scoreId || "score"} · {item.analysisStatus} · candidates {item.candidateRowCount || 0} · decisions {item.decisionCount || 0} · auto {item.analysisSummary?.autoPassCount || 0}
                        {item.candidateGate?.reason ? ` · gate ${item.candidateGate.reason}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="western-diagnosis-list">
              {(submissionQueue.submissions || []).map((submission) => (
                <div key={submission.submissionId} className="western-diagnosis-row">
                  <div>
                    <strong>{submission.scoreId || "missing score"}</strong>
                    <span>
                      {submission.audioSubmission?.name || "audio"} · {submission.status}
                    </span>
                    {submission.audioUrl ? <audio controls src={submission.audioUrl} /> : null}
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={submissionReviewSavingId === submission.submissionId}
                    onClick={() => saveSubmissionReview(submission, "accepted_for_batch")}
                  >
                    Batch
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={submissionReviewSavingId === submission.submissionId}
                    onClick={() => saveSubmissionReview(submission, "review_required")}
                  >
                    Review
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={submissionReviewSavingId === submission.submissionId}
                    onClick={() => saveSubmissionReview(submission, "reject_unsupported")}
                  >
                    Reject
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Controlled intake</span>
            <h2>Submit recording for review</h2>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={!job?.scoreId}
            onClick={() => audioInputRef.current?.click()}
          >
            Choose audio
          </button>
        </div>

        <p className="muted-copy">
          This accepts a recording only after a clean score is imported. The submission is stored for offline review and does not produce
          student-facing automatic feedback.
        </p>

        <div className="western-strings-result">
          <div>
            <strong>Score</strong>
            <span>{job?.scoreId || "import required"}</span>
          </div>
          <div>
            <strong>Audio</strong>
            <span>{audioFile?.name || "not selected"}</span>
          </div>
        </div>

        <div className="western-strings-actions">
          <button
            type="button"
            className="primary-button"
            disabled={analysisLoading || !job?.scoreId || !audioFile}
            onClick={submitControlledRecording}
          >
            {analysisLoading ? "Submitting..." : "Submit for offline review"}
          </button>
        </div>
      </section>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">M3 core gate</span>
            <h2>Student-safe diagnosis preview</h2>
          </div>
          <button type="button" className="secondary-button" disabled={analysisLoading} onClick={loadCoreDiagnosisPreview}>
            {analysisLoading ? "Loading..." : "Load gated preview"}
          </button>
        </div>

        <p className="muted-copy">
          This panel uses validated M2/M3 evidence only. It is not a free-form upload analyzer. Current auto feedback is limited to
          pitch, onset, and missing-note candidates. Duration remains review-only because timing drift is not yet quantifiable.
          Extra-note can be judged during review, but this review batch had no confirmed extra-note samples, so it remains
          review-only until that evidence is added to the gate.
        </p>

        {analysisResult ? (
          <>
            <div className={analysisResult.studentReady ? "status-banner" : "error-banner"}>
              {analysisResult.studentReady
                ? "Core gate ready: pitch / onset / missing may be shown for high-confidence notes."
                : `Core gate not ready: ${(analysisResult.blockingReasons || []).join(", ") || "missing evidence"}`}
            </div>

            <div className="western-strings-result">
              <div>
                <strong>Auto notes</strong>
                <span>{analysisResult.summary?.autoPassCount ?? 0}</span>
              </div>
              <div>
                <strong>Review notes</strong>
                <span>{analysisResult.summary?.reviewRequiredCount ?? 0}</span>
              </div>
              <div>
                <strong>Allowed</strong>
                <span>{(analysisResult.summary?.allowedDiagnosticCategories || []).join(", ") || "none"}</span>
              </div>
              <div>
                <strong>Review only</strong>
                <span>{(analysisResult.summary?.reviewOnlyDiagnosticCategories || []).join(", ") || "none"}</span>
              </div>
            </div>

            {reviewMessage ? <div className="status-banner">{reviewMessage}</div> : null}

            <div className="western-diagnosis-list">
              {(analysisResult.decisions || []).slice(0, 8).map((decision) => (
                <div key={decision.noteId} className="western-diagnosis-row">
                  <div>
                    <strong>{decision.piece}</strong>
                    <span>
                      note {decision.noteIndex} · MIDI {decision.midi} · {Number(decision.predictedOnsetSeconds ?? 0).toFixed(2)}s
                    </span>
                  </div>
                  <span className={decision.autoDecision === "auto_pass" ? "pill-ok" : "pill-review"}>
                    {decision.autoDecision === "auto_pass" ? "auto" : "review"}
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={reviewSavingNoteId === decision.noteId}
                    onClick={() => saveReview(decision, "confirm")}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={reviewSavingNoteId === decision.noteId}
                    onClick={() => saveReview(decision, "review_required")}
                  >
                    Review
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
