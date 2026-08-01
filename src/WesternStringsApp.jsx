import { useEffect, useRef, useState } from "react";
import {
  fetchWesternControlledSubmissionModelSuggestions,
  fetchWesternControlledSubmissionScoreNotes,
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

function ReviewAssistPanel({
  reviewAssist,
  rows = [],
  issueCategories = null,
  onIssueCategoryChange = null,
}) {
  if (!reviewAssist?.contract) return null;
  return (
    <div className="western-review-assist">
      <strong>
        复核辅助：机器确诊候选 {reviewAssist.confirmedIssueCandidateCount || 0} · 自查提示 {reviewAssist.selfCheckHintCount || 0}
      </strong>
      <span>仅供教师复核，不会自动发送给学生。</span>
      {rows.map((row) => (
        <span key={`${row.noteId}:${row.outputSemantic}`}>
          第 {row.measureIndex} 小节 · 拍位 {Number(row.beatStart || 0) + 1} · MIDI {row.midi ?? "?"} · {row.outputSemantic === "confirmed_issue" ? "机器确诊候选" : "建议自查"}
          {onIssueCategoryChange ? (
            <select
              aria-label={`第 ${row.measureIndex} 小节问题类型`}
              value={issueCategories?.[row.noteId] || ""}
              onChange={(event) => onIssueCategoryChange(row, event.target.value)}
            >
              <option value="">不发布定位</option>
              <option value="pitch">音准</option>
              <option value="rhythm">节奏</option>
              <option value="tone">音质</option>
              <option value="missing">漏音 / 错音</option>
            </select>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function getStudentIssueCandidateRows(submission) {
  const distributedRows = submission?.latestAnalysis?.studentIssueCandidates;
  if (Array.isArray(distributedRows) && distributedRows.length > 0) return distributedRows;
  return submission?.latestAnalysis?.reviewAssistPreview || [];
}

function ModelSuggestionPanel({ result, loading, onRefresh }) {
  if (!result) {
    return <button type="button" className="secondary-button" disabled={loading} onClick={onRefresh}>查看签署后的模型复核建议</button>;
  }
  if (result.withheld) {
    return <p className="muted-copy">模型建议暂不显示：请先独立完成并签署全谱逐音复核。</p>;
  }
  if (result.status !== "succeeded") {
    return (
      <div className="western-review-assist">
        <strong>模型复核建议 · {result.status || "unknown"}</strong>
        <span>{result.error || "后台推理尚未完成。可稍后刷新；这不会阻塞教师反馈。"}</span>
        <button type="button" className="secondary-button" disabled={loading} onClick={onRefresh}>刷新建议状态</button>
      </div>
    );
  }
  return (
    <div className="western-review-assist">
      <strong>失败的 Stage A 候选 · 仅供老师二次复听（{result.suggestions?.length || 0}）</strong>
      <span>它不是诊断证据，不会发给学生，也不授权自动指控。</span>
      {(result.suggestions || []).map((item, index) => (
        <span key={`${item.noteIndex}:${item.gate}:${index}`}>
          第 {item.measure ?? "?"} 小节 · 拍位 {item.beat ?? "?"} · MIDI {item.scoreMidi ?? "?"} · {item.gate} · {Math.round(Number(item.probability || 0) * 100)}%
        </span>
      ))}
      <button type="button" className="secondary-button" disabled={loading} onClick={onRefresh}>刷新建议</button>
    </div>
  );
}

// Training vocabulary from docs/western-strings-training-ledger-spec.md. It is
// deliberately different from the student-facing issue categories: this one
// feeds a future training corpus, the other one is what a student reads.
// `extra` is absent on purpose: an extra performed event has no score note, so
// it is recorded through the separate extra-event control below.
const TRAINING_LABEL_OPTIONS = [
  { value: "", label: "不标（默认正确）" },
  { value: "correct", label: "正确（否掉机器）" },
  { value: "wrong_pitch", label: "错音" },
  { value: "missing", label: "漏音" },
  { value: "drag", label: "拖拍" },
  { value: "uncertain", label: "拿不准" },
];

function describeScoreNote(note) {
  const measure = Number.isInteger(note?.measureIndex) ? `第 ${note.measureIndex} 小节` : "小节未知";
  const midi = Number.isInteger(note?.midi) ? ` · midi ${note.midi}` : "";
  return `${measure}${midi} · ${note?.noteId || ""}`;
}

function TrainingLabelPanel({
  submission,
  machineRows,
  scoreNotesMeta,
  scoreNotesLoading,
  draft,
  onDraftChange,
  onLabelChange,
  onAddExtraEvent,
  onExtraEventChange,
  onRemoveExtraEvent,
  onLoadScoreNotes,
}) {
  const labels = draft.labels || {};
  const scoreNotes = scoreNotesMeta?.notes || [];
  const extraEvents = draft.extraEvents || [];
  const machineNoteIds = new Set(machineRows.map((row) => row.noteId));
  const extraLabeled = Object.keys(labels).filter((noteId) => labels[noteId] && !machineNoteIds.has(noteId));
  const labeledCount = Object.values(labels).filter(Boolean).length;
  // Signing asserts every score note was swept, so it stays disabled until the
  // full score is actually loaded and a reviewer identifies themselves.
  const fullScoreLoaded = Boolean(scoreNotesMeta?.candidateRowsSha256) && scoreNotes.length > 0;
  const canSign = fullScoreLoaded && Boolean((draft.reviewerId || "").trim());
  const trainingEligible = submission?.trainingConsent?.eligible === true;

  return (
    <details className="western-training-ledger">
      <summary>逐音复核（{labeledCount} 条已标{draft.signed ? " · 已签署" : ""}）</summary>
      <p className="muted-copy">
        逐音结果先作为本次教师复核记录；只有学生本人或监护人已单独授权时才进入训练账本。
        它不改学生端、不翻任何开关、不参与冻结候选调参。未显式打标的谱音按「正确」计入，
        因此必须先载入全谱、逐音巡检完毕，再签署完整错误清单。
      </p>
      <div className={trainingEligible ? "status-banner" : "muted-copy"}>
        {trainingEligible
          ? `训练授权有效 · 主体 ${submission.trainingSubjectRef || "已绑定"} · ${submission.trainingConsent.subjectType === "minor" ? "监护人已确认" : "成年人本人授权"}`
          : `未取得独立训练授权（${submission?.trainingConsent?.reason || "no-consent-record"}）：仍可复核和反馈，但不会进入训练账本。`}
      </div>

      <div className={fullScoreLoaded ? "status-banner" : "muted-copy"}>
        {fullScoreLoaded
          ? `全谱已载入：共 ${scoreNotesMeta.noteCount} 个谱音，工件 ${String(scoreNotesMeta.candidateRowsSha256).slice(0, 12)}…`
          : "尚未载入全谱——未载入前无法签署完整错误清单。"}
      </div>

      {machineRows.length ? (
        <div className="western-training-rows">
          {machineRows.map((row) => (
            <label key={row.noteId}>
              <span>{describeScoreNote({ measureIndex: row.measureIndex, midi: row.midi, noteId: row.noteId })}</span>
              <select
                value={labels[row.noteId] || ""}
                onChange={(event) => onLabelChange(row.noteId, event.target.value)}
              >
                {TRAINING_LABEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : (
        <p className="muted-copy">本次分析没有机器候选行。</p>
      )}

      <div className="western-training-add">
        <button type="button" className="secondary-button" disabled={scoreNotesLoading} onClick={onLoadScoreNotes}>
          {scoreNotes.length ? `补机器漏掉的（${scoreNotes.length} 个谱音）` : "载入全谱音符"}
        </button>
        {scoreNotes.length ? (
          <select
            value=""
            onChange={(event) => {
              if (event.target.value) onLabelChange(event.target.value, "wrong_pitch");
            }}
          >
            <option value="">选择一个机器没标的谱音…</option>
            {scoreNotes
              .filter((note) => !machineNoteIds.has(note.noteId))
              .map((note) => (
                <option key={note.noteId} value={note.noteId}>{describeScoreNote(note)}</option>
              ))}
          </select>
        ) : null}
        <button type="button" className="secondary-button" disabled={!fullScoreLoaded} onClick={onAddExtraEvent}>
          补一个多余演奏事件
        </button>
      </div>

      {extraEvents.length ? (
        <div className="western-training-rows">
          {extraEvents.map((event, index) => (
            // Extra events carry their own identity (performed pitch + time),
            // and only optionally name the score note they followed.
            <div key={`extra-${index}`} className="western-training-extra">
              <select
                value={event.afterNoteId || ""}
                onChange={(e) => onExtraEventChange(index, { afterNoteId: e.target.value })}
              >
                <option value="">（不指定紧跟在哪个谱音后）</option>
                {scoreNotes.map((note) => (
                  <option key={note.noteId} value={note.noteId}>{describeScoreNote(note)}</option>
                ))}
              </select>
              <input
                type="number"
                value={event.performedMidi ?? ""}
                placeholder="实际音高 MIDI（可空）"
                onChange={(e) => onExtraEventChange(index, {
                  performedMidi: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
              <input
                type="number"
                step="0.01"
                value={event.startSeconds ?? ""}
                placeholder="起始秒"
                onChange={(e) => onExtraEventChange(index, {
                  startSeconds: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
              <input
                type="number"
                step="0.01"
                value={event.endSeconds ?? ""}
                placeholder="结束秒（可空）"
                onChange={(e) => onExtraEventChange(index, {
                  endSeconds: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
              <button type="button" className="secondary-button" onClick={() => onRemoveExtraEvent(index)}>删除</button>
            </div>
          ))}
        </div>
      ) : null}

      {extraLabeled.length ? (
        <div className="western-training-rows">
          {extraLabeled.map((noteId) => {
            const note = scoreNotes.find((item) => item.noteId === noteId);
            return (
              <label key={noteId}>
                <span>补标 · {note ? describeScoreNote(note) : noteId}</span>
                <select value={labels[noteId]} onChange={(event) => onLabelChange(noteId, event.target.value)}>
                  {TRAINING_LABEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}

      <div className="western-training-meta">
        <input
          type="text"
          value={draft.reviewerId || ""}
          placeholder="复核人编号（必填；同一录音换人再签即成为双人复核样本）"
          onChange={(event) => onDraftChange({ reviewerId: event.target.value })}
        />
        <input
          type="text"
          value={draft.deviceHint || ""}
          placeholder="录音设备（可空）"
          onChange={(event) => onDraftChange({ deviceHint: event.target.value })}
        />
        <input
          type="text"
          value={draft.levelHint || ""}
          placeholder="程度（可空）"
          onChange={(event) => onDraftChange({ levelHint: event.target.value })}
        />
        <label title={canSign ? "" : "需先载入全谱并填写复核人编号"}>
          <input
            type="checkbox"
            disabled={!canSign}
            checked={draft.signed === true && canSign}
            onChange={(event) => onDraftChange({ signed: event.target.checked })}
          />
          完整错误清单：全谱 {scoreNotesMeta?.noteCount || 0} 个音我已逐一巡检，未标记的即为正确
        </label>
      </div>
    </details>
  );
}

export default function WesternStringsApp({ onBackToStudent }) {
  const musicXmlInputRef = useRef(null);
  const midiInputRef = useRef(null);
  const scorePhotoInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const [instrument, setInstrument] = useState("violin");
  const [scoreFile, setScoreFile] = useState(null);
  const [scoreKind, setScoreKind] = useState("");
  const [scorePhotoFile, setScorePhotoFile] = useState(null);
  const [scorePhotoPreviewUrl, setScorePhotoPreviewUrl] = useState("");
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
  const [feedbackDrafts, setFeedbackDrafts] = useState({});
  const [issueDrafts, setIssueDrafts] = useState({});
  const [trainingDrafts, setTrainingDrafts] = useState({});
  const [scoreNotesBySubmission, setScoreNotesBySubmission] = useState({});
  const [scoreNotesLoadingId, setScoreNotesLoadingId] = useState("");
  const [modelSuggestionsBySubmission, setModelSuggestionsBySubmission] = useState({});
  const [modelSuggestionsLoadingId, setModelSuggestionsLoadingId] = useState("");

  const hasScoreInput = Boolean(job?.scoreId || scorePhotoFile);

  useEffect(() => {
    if (!scorePhotoFile || !scorePhotoFile.type?.startsWith("image/")) {
      setScorePhotoPreviewUrl("");
      return undefined;
    }
    const previewUrl = URL.createObjectURL(scorePhotoFile);
    setScorePhotoPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [scorePhotoFile]);

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
    setScorePhotoFile(null);
    setJob(null);
    setAudioFile(null);
    setError("");
    setStatus(file ? `${kind === "midi" ? "MIDI" : "MusicXML"} selected: ${file.name}` : "Select a clean MusicXML or MIDI score.");
  }

  function pickScorePhotoFile(file) {
    setScorePhotoFile(file || null);
    setScoreFile(null);
    setScoreKind("");
    setJob(null);
    setAudioFile(null);
    setError("");
    setReviewMessage("");
    setStatus(file ? `Score photo selected: ${file.name}` : "Select a clean score or score photo.");
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
    if (!hasScoreInput) {
      setError("Import a clean score or choose a score photo before submitting audio.");
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
        scoreId: job?.scoreId || "",
        scorePhotoFile,
        scorePhotoSubmission: scorePhotoFile ? {
          name: scorePhotoFile.name,
          mimeType: scorePhotoFile.type,
          size: scorePhotoFile.size,
        } : null,
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

  function updateTrainingDraft(submissionId, patch) {
    setTrainingDrafts((drafts) => ({
      ...drafts,
      [submissionId]: { ...(drafts[submissionId] || {}), ...patch },
    }));
  }

  function updateTrainingLabel(submissionId, noteId, label) {
    setTrainingDrafts((drafts) => {
      const current = drafts[submissionId] || {};
      return {
        ...drafts,
        [submissionId]: {
          ...current,
          labels: { ...(current.labels || {}), [noteId]: label },
        },
      };
    });
  }

  async function loadSubmissionScoreNotes(submission) {
    setScoreNotesLoadingId(submission.submissionId);
    try {
      const result = await fetchWesternControlledSubmissionScoreNotes(submission.submissionId);
      setScoreNotesBySubmission((notes) => ({
        ...notes,
        [submission.submissionId]: {
          notes: result.notes || [],
          candidateRowsSha256: result.candidateRowsSha256 || "",
          noteCount: result.noteCount || 0,
        },
      }));
    } catch (notesError) {
      setError(notesError?.message || "Score notes failed to load.");
    } finally {
      setScoreNotesLoadingId("");
    }
  }

  async function loadSubmissionModelSuggestions(submission) {
    setModelSuggestionsLoadingId(submission.submissionId);
    try {
      const result = await fetchWesternControlledSubmissionModelSuggestions(submission.submissionId);
      setModelSuggestionsBySubmission((current) => ({ ...current, [submission.submissionId]: result }));
    } catch (suggestionError) {
      setError(suggestionError?.message || "Model suggestions failed to load.");
    } finally {
      setModelSuggestionsLoadingId("");
    }
  }

  function addExtraEvent(submissionId) {
    setTrainingDrafts((drafts) => {
      const current = drafts[submissionId] || {};
      return {
        ...drafts,
        [submissionId]: {
          ...current,
          extraEvents: [
            ...(current.extraEvents || []),
            { afterNoteId: "", performedMidi: null, startSeconds: null, endSeconds: null, note: "" },
          ],
        },
      };
    });
  }

  function updateExtraEvent(submissionId, index, patch) {
    setTrainingDrafts((drafts) => {
      const current = drafts[submissionId] || {};
      const events = [...(current.extraEvents || [])];
      events[index] = { ...events[index], ...patch };
      return { ...drafts, [submissionId]: { ...current, extraEvents: events } };
    });
  }

  function removeExtraEvent(submissionId, index) {
    setTrainingDrafts((drafts) => {
      const current = drafts[submissionId] || {};
      const events = (current.extraEvents || []).filter((_, position) => position !== index);
      return { ...drafts, [submissionId]: { ...current, extraEvents: events } };
    });
  }

  // Only a signed complete error inventory becomes a training sample; an
  // ordinary review keeps sending exactly what it sent before.
  // Only a signed complete error inventory over a fully loaded score becomes a
  // training sample. The artifact sha and note count travel with the signature
  // so the server can refuse anything the reviewer did not actually see.
  function buildTrainingPayload(submission) {
    const draft = trainingDrafts[submission.submissionId];
    const meta = scoreNotesBySubmission[submission.submissionId];
    if (!draft?.signed || !meta?.candidateRowsSha256) return {};
    const labels = draft.labels || {};
    return {
      completeErrorInventory: true,
      fullScoreReviewed: true,
      candidateRowsSha256: meta.candidateRowsSha256,
      scoreNoteCount: meta.noteCount,
      reviewerId: (draft.reviewerId || "").trim(),
      deviceHint: draft.deviceHint || "",
      levelHint: draft.levelHint || "",
      noteLabels: Object.entries(labels)
        .filter(([, label]) => label)
        .map(([noteId, label]) => ({ noteId, label })),
      extraEvents: (draft.extraEvents || []).filter(
        (event) => event.afterNoteId || event.startSeconds !== null,
      ),
    };
  }

  function describeTrainingLedgerResult(result) {
    const ledger = result?.trainingLedger;
    if (!ledger) return "";
    if (ledger.recorded) return ` 训练账本已记录 ${ledger.noteLabelCount} 条标签（rev ${ledger.revision}）。`;
    if (ledger.reason === "complete-error-inventory-not-signed") return "";
    return ` 训练账本未记录：${ledger.reason}`;
  }

  async function saveSubmissionReview(submission, action) {
    setSubmissionReviewSavingId(submission.submissionId);
    setReviewMessage("");
    try {
      const result = await saveWesternControlledSubmissionReview({
        submissionId: submission.submissionId,
        action,
        ...buildTrainingPayload(submission),
      });
      setReviewMessage(`Controlled submission review saved.${describeTrainingLedgerResult(result)}`);
      await loadControlledSubmissionQueue();
      if (buildTrainingPayload(submission).completeErrorInventory) await loadSubmissionModelSuggestions(submission);
    } catch (queueError) {
      setError(queueError?.message || "Controlled submission review failed.");
    } finally {
      setSubmissionReviewSavingId("");
    }
  }

  async function releaseStudentFeedback(submission) {
    const studentMessage = (feedbackDrafts[submission.submissionId] || "").trim();
    if (!studentMessage) {
      setError("Write the student feedback text before releasing.");
      return;
    }
    setSubmissionReviewSavingId(submission.submissionId);
    setReviewMessage("");
    setError("");
    try {
      const categories = issueDrafts[submission.submissionId] || {};
      const studentIssues = getStudentIssueCandidateRows(submission)
        .filter((row) => categories[row.noteId])
        .map((row) => ({
          noteId: row.noteId,
          noteIndex: row.noteIndex,
          category: categories[row.noteId],
        }));
      const result = await saveWesternControlledSubmissionReview({
        submissionId: submission.submissionId,
        action: "feedback_released",
        studentMessage,
        releaseToStudent: true,
        studentIssues,
        ...buildTrainingPayload(submission),
      });
      setReviewMessage(`Feedback released to the student page.${describeTrainingLedgerResult(result)}`);
      setFeedbackDrafts((drafts) => ({ ...drafts, [submission.submissionId]: "" }));
      setIssueDrafts((drafts) => ({ ...drafts, [submission.submissionId]: {} }));
      await loadControlledSubmissionQueue();
      if (buildTrainingPayload(submission).completeErrorInventory) await loadSubmissionModelSuggestions(submission);
    } catch (releaseError) {
      setError(releaseError?.message || "Feedback release failed.");
    } finally {
      setSubmissionReviewSavingId("");
    }
  }

  async function runControlledBatch() {
    setSubmissionBatchLoading(true);
    setReviewMessage("");
    setError("");
    try {
      const result = await runWesternControlledSubmissionBatch({ limit: 5 });
      setSubmissionBatchResult(result.batch || null);
      setReviewMessage("Controlled batch audit finished. Photo-score results remain review-only.");
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
          <h1>Western strings practice diagnostics</h1>
          <p>Clean electronic scores and review-only photo scores. Low-confidence analysis remains in review until the V2 gates pass.</p>
        </div>
        <div className="hero-side">
          <strong>Input policy</strong>
          <span>Photo OMR review-only</span>
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
            <span className="eyebrow">M1 clean score / M4 photo score</span>
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
        <input
          ref={scorePhotoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          hidden
          onChange={(event) => pickScorePhotoFile(event.target.files?.[0] || null)}
        />

        <div className="western-strings-actions">
          <button type="button" className="secondary-button" onClick={() => musicXmlInputRef.current?.click()}>
            Choose MusicXML
          </button>
          <button type="button" className="secondary-button" onClick={() => midiInputRef.current?.click()}>
            Choose MIDI
          </button>
          <button type="button" className="secondary-button" onClick={() => scorePhotoInputRef.current?.click()}>
            Choose score photo
          </button>
          {scoreFile ? (
            <button type="button" className="primary-button" disabled={importing} onClick={importSelectedScore}>
              {importing ? "Importing..." : "Import"}
            </button>
          ) : null}
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
        {scorePhotoFile ? (
          <div className="western-score-photo-selection">
            {scorePhotoPreviewUrl ? <img src={scorePhotoPreviewUrl} alt="Selected score" /> : null}
            <div>
              <strong>{scorePhotoFile.name}</strong>
              <span>Score images enter the controlled OMR review queue.</span>
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
          Clean-score and score-image recordings wait here for manual review or offline batch analysis. Score-image results never create
          student-facing automatic feedback. Each batch run processes at most five accepted items to limit local resource use.
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
                      <div key={item.submissionId}>
                        <span>
                          {item.scoreId || item.scorePhotoSubmission?.name || "score"} · {item.analysisStatus} · candidates {item.candidateRowCount || 0} · decisions {item.decisionCount || 0} · auto {item.analysisSummary?.autoPassCount || 0}
                          {item.photoScoreDecision ? ` · photo ${item.photoScoreDecision}` : ""}
                          {item.candidateGate?.reason ? ` · gate ${item.candidateGate.reason}` : ""}
                        </span>
                        <ReviewAssistPanel
                          reviewAssist={item.candidateGate?.reviewAssist}
                          rows={item.reviewAssistPreview}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="western-diagnosis-list">
              {(submissionQueue.submissions || []).map((submission) => (
                <div key={submission.submissionId} className="western-diagnosis-row">
                  <div>
                    <strong>{submission.scoreId || submission.scorePhotoSubmission?.name || "missing score"}</strong>
                    <span>
                      {submission.kind || "clean-score"} · {submission.audioSubmission?.name || "audio"} · {submission.status}
                    </span>
                    {submission.scorePhotoUrl ? (
                      <a
                        className="western-score-photo-link"
                        href={submission.scorePhotoUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Open uploaded score image"
                      >
                        <img src={submission.scorePhotoUrl} alt={`Uploaded score ${submission.scorePhotoSubmission?.name || "image"}`} />
                      </a>
                    ) : null}
                    {submission.audioUrl ? <audio controls src={submission.audioUrl} /> : null}
                    <ReviewAssistPanel
                      reviewAssist={submission.latestAnalysis?.reviewAssist}
                      rows={getStudentIssueCandidateRows(submission)}
                      issueCategories={issueDrafts[submission.submissionId] || {}}
                      onIssueCategoryChange={(row, category) =>
                        setIssueDrafts((drafts) => ({
                          ...drafts,
                          [submission.submissionId]: {
                            ...(drafts[submission.submissionId] || {}),
                            [row.noteId]: category,
                          },
                        }))
                      }
                    />
                    <TrainingLabelPanel
                      submission={submission}
                      machineRows={getStudentIssueCandidateRows(submission)}
                      scoreNotesMeta={scoreNotesBySubmission[submission.submissionId] || null}
                      scoreNotesLoading={scoreNotesLoadingId === submission.submissionId}
                      draft={trainingDrafts[submission.submissionId] || {}}
                      onDraftChange={(patch) => updateTrainingDraft(submission.submissionId, patch)}
                      onLabelChange={(noteId, label) => updateTrainingLabel(submission.submissionId, noteId, label)}
                      onAddExtraEvent={() => addExtraEvent(submission.submissionId)}
                      onExtraEventChange={(index, patch) => updateExtraEvent(submission.submissionId, index, patch)}
                      onRemoveExtraEvent={(index) => removeExtraEvent(submission.submissionId, index)}
                      onLoadScoreNotes={() => loadSubmissionScoreNotes(submission)}
                    />
                    <ModelSuggestionPanel
                      result={modelSuggestionsBySubmission[submission.submissionId] || null}
                      loading={modelSuggestionsLoadingId === submission.submissionId}
                      onRefresh={() => loadSubmissionModelSuggestions(submission)}
                    />
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
                  <div className="western-feedback-release">
                    <input
                      type="text"
                      value={feedbackDrafts[submission.submissionId] || ""}
                      placeholder="Student feedback text (human-authored)"
                      onChange={(event) =>
                        setFeedbackDrafts((drafts) => ({
                          ...drafts,
                          [submission.submissionId]: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        submissionReviewSavingId === submission.submissionId
                        || !(feedbackDrafts[submission.submissionId] || "").trim()
                      }
                      onClick={() => releaseStudentFeedback(submission)}
                    >
                      Release
                    </button>
                  </div>
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
            disabled={!hasScoreInput}
            onClick={() => audioInputRef.current?.click()}
          >
            Choose audio
          </button>
        </div>

        <p className="muted-copy">
          This accepts a recording after a clean electronic score is imported or a score image is selected. The submission is stored for
          controlled offline review. Score-image analysis never produces student-facing automatic feedback.
        </p>

        <div className="western-strings-result">
          <div>
            <strong>Score</strong>
            <span>{job?.scoreId || scorePhotoFile?.name || "score required"}</span>
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
            disabled={analysisLoading || !hasScoreInput || !audioFile}
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
