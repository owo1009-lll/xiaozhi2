import { useEffect, useRef, useState } from "react";
import {
  fetchWesternStudentAnalysis,
  fetchWesternStudentGate,
  fetchWesternStudentSubmissions,
} from "./researchApi.js";
import { REPERTOIRE } from "./data/repertoire.js";

const INSTRUMENTS = [
  { id: "violin", label: "小提琴" },
  { id: "viola", label: "中提琴" },
  { id: "cello", label: "大提琴" },
];

const STATUS_LABELS = {
  queued: "排队中",
  under_review: "老师复核中",
  feedback_released: "已反馈",
  unsupported: "暂不支持",
};

const STUDENT_REF_STORAGE_KEY = "western-strings-student-ref";
const TRAINING_CONSENT_DECISION_STORAGE_KEY = "western-strings-training-consent-decision";
const STUDENT_REF_PATTERN = /^stu-v2-[a-f0-9]{32}$/;

function createStudentCapability() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) return "";
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return `stu-v2-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function getOrCreateStudentRef() {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(STUDENT_REF_STORAGE_KEY);
    if (STUDENT_REF_PATTERN.test(existing || "")) return existing;
    const created = createStudentCapability();
    if (created) window.localStorage.setItem(STUDENT_REF_STORAGE_KEY, created);
    return created;
  } catch {
    return createStudentCapability();
  }
}

function getStoredTrainingConsentDecision() {
  if (typeof window === "undefined") return "";
  try {
    const decision = window.localStorage.getItem(TRAINING_CONSENT_DECISION_STORAGE_KEY) || "";
    return ["granted", "declined"].includes(decision) ? decision : "";
  } catch {
    return "";
  }
}

export default function WesternStudentApp() {
  const audioInputRef = useRef(null);
  const photoInputRef = useRef(null);
  const [studentRef] = useState(getOrCreateStudentRef);
  const [gateView, setGateView] = useState(null);
  const [piece, setPiece] = useState("");
  const [instrument, setInstrument] = useState("violin");
  const [audioFile, setAudioFile] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState("");
  const [trainingConsentDecision, setTrainingConsentDecision] = useState(getStoredTrainingConsentDecision);
  const [consentSubjectType, setConsentSubjectType] = useState("adult");
  const [guardianRef, setGuardianRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submissionList, setSubmissionList] = useState(null);
  const [listLoading, setListLoading] = useState(false);

  useEffect(() => {
    fetchWesternStudentGate()
      .then((view) => setGateView(view || null))
      .catch(() => setGateView(null));
  }, []);

  useEffect(() => {
    if (!photoFile || !photoFile.type?.startsWith("image/")) {
      setPhotoPreviewUrl("");
      return undefined;
    }
    const previewUrl = URL.createObjectURL(photoFile);
    setPhotoPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [photoFile]);

  async function loadSubmissions() {
    if (!studentRef) return;
    setListLoading(true);
    try {
      const result = await fetchWesternStudentSubmissions({ studentRef, limit: 20 });
      setSubmissionList(result);
    } catch {
      setSubmissionList(null);
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => {
    loadSubmissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentRef]);

  async function submitRecording() {
    if (!studentRef) {
      setError("当前浏览器无法创建安全的学生访问标识，请升级浏览器后重试。");
      return;
    }
    if (!piece.trim()) {
      setError("请先填写曲名。");
      return;
    }
    if (!audioFile) {
      setError("请选择你的演奏录音。");
      return;
    }
    if (!trainingConsentDecision) {
      setError("请明确选择是否同意录音用于模型训练；不同意不会影响提交和老师反馈。");
      return;
    }
    if (trainingConsentDecision === "granted" && consentSubjectType === "minor" && !guardianRef.trim()) {
      setError("未成年人同意用于训练时，需要由监护人填写监护人确认编号。");
      return;
    }
    setSubmitting(true);
    setError("");
    setMessage("");
    try {
      const result = await fetchWesternStudentAnalysis({
        studentRef,
        piece: piece.trim(),
        instrument,
        clientPlatform: "western-student-web",
        trainingConsent: {
          decision: trainingConsentDecision,
          subjectType: consentSubjectType,
          guardianRef: consentSubjectType === "minor" ? guardianRef.trim() : "",
        },
        audioFile,
        audioSubmission: {
          name: audioFile.name,
          mimeType: audioFile.type,
          size: audioFile.size,
        },
        scorePhotoFile: photoFile || undefined,
        scorePhotoSubmission: photoFile
          ? { name: photoFile.name, mimeType: photoFile.type, size: photoFile.size }
          : null,
      });
      if (result?.analysis?.submissionAccepted) {
        setMessage("提交成功!老师复核后,反馈会出现在下方列表里。");
        setAudioFile(null);
        setPhotoFile(null);
        setPiece("");
        await loadSubmissions();
      } else {
        setError("提交未被接收,请稍后重试。");
      }
    } catch (submitError) {
      setError(submitError?.message || "提交失败,请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const autoFeedbackEnabled = gateView?.capabilities?.autoFeedback === true;

  return (
    <div className="app-shell western-strings-app">
      <header className="hero-card">
        <div>
          <span className="eyebrow">弦乐练习反馈</span>
          <h1>上传练习录音</h1>
          <p>
            {gateView?.studentNotice
              || "录音提交后由老师复核,复核完成的反馈会显示在下方列表。"}
          </p>
        </div>
        <div className="hero-side">
          <strong>当前模式</strong>
          <span>{autoFeedbackEnabled ? "自动反馈" : "老师复核后反馈"}</span>
        </div>
      </header>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">第 1 步</span>
            <h2>这次练的是什么?</h2>
          </div>
          <select value={instrument} onChange={(event) => setInstrument(event.target.value)} aria-label="乐器">
            {INSTRUMENTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <input
          type="text"
          value={piece}
          placeholder="曲名,例如:开塞 Op.20 No.3"
          onChange={(event) => setPiece(event.target.value)}
          aria-label="曲名"
        />
        <select
          className="western-repertoire-select"
          value=""
          onChange={(event) => { if (event.target.value) setPiece(event.target.value); }}
          aria-label="从曲库选曲"
        >
          <option value="">从曲库选曲…</option>
          {REPERTOIRE.map((group) => (
            <optgroup key={group.level} label={group.level}>
              {group.items.map((item) => (
                <option key={item.title} value={item.title}>{item.title}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <p className="muted-copy">建议顺手拍一张这次练习用的谱子(可选),老师复核时能直接对着看。</p>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          hidden
          onChange={(event) => setPhotoFile(event.target.files?.[0] || null)}
        />
        <div className="western-strings-actions">
          <button type="button" className="secondary-button" onClick={() => photoInputRef.current?.click()}>
            {photoFile ? `已选谱子照片:${photoFile.name}` : "拍/选谱子照片(可选)"}
          </button>
        </div>
        {photoPreviewUrl ? (
          <div className="western-score-photo-selection">
            <img src={photoPreviewUrl} alt="已选择的谱子照片" />
          </div>
        ) : null}
      </section>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">第 2 步</span>
            <h2>上传演奏录音</h2>
          </div>
        </div>
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
          hidden
          onChange={(event) => setAudioFile(event.target.files?.[0] || null)}
        />
        <div className="western-strings-actions">
          <button type="button" className="secondary-button" onClick={() => audioInputRef.current?.click()}>
            {audioFile ? `已选录音:${audioFile.name}` : "选择录音文件"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={submitting || !audioFile || !piece.trim()}
            onClick={submitRecording}
          >
            {submitting ? "提交中..." : "提交"}
          </button>
        </div>
        <div className="western-training-consent">
          <select
            value={trainingConsentDecision}
            aria-label="是否同意用于模型训练"
            onChange={(event) => {
              const decision = event.target.value;
              setTrainingConsentDecision(decision);
              try {
                window.localStorage.setItem(TRAINING_CONSENT_DECISION_STORAGE_KEY, decision);
              } catch {
                // The server still records the explicit choice for this upload.
              }
            }}
          >
            <option value="">请选择是否同意用于模型训练（必选）</option>
            <option value="granted">同意本次及后续录音和老师标注用于改进模型</option>
            <option value="declined">不同意用于模型训练（仍可正常获得老师反馈）</option>
          </select>
          <p className="muted-copy">
            这与上传和获得老师反馈的隐私授权相互独立；不同意也可以正常提交并获得诊断。
          </p>
          {trainingConsentDecision === "granted" ? (
            <>
              <select
                value={consentSubjectType}
                onChange={(event) => setConsentSubjectType(event.target.value)}
                aria-label="训练授权主体"
              >
                <option value="adult">本人已成年，由本人同意</option>
                <option value="minor">未成年人，由监护人同意</option>
              </select>
              {consentSubjectType === "minor" ? (
                <input
                  type="text"
                  value={guardianRef}
                  placeholder="监护人确认编号（必填）"
                  onChange={(event) => setGuardianRef(event.target.value)}
                  aria-label="监护人确认编号"
                />
              ) : null}
            </>
          ) : null}
        </div>
        {message ? <div className="status-banner" aria-live="polite">{message}</div> : null}
        {error ? <div className="error-banner">{error}</div> : null}
      </section>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">我的练习记录</span>
            <h2>提交与反馈</h2>
          </div>
          <button type="button" className="secondary-button" disabled={listLoading} onClick={loadSubmissions}>
            {listLoading ? "刷新中..." : "刷新"}
          </button>
        </div>
        {submissionList?.submissions?.length ? (
          <div className="western-diagnosis-list">
            {submissionList.submissions.map((submission) => (
              <div key={submission.submissionId} className="western-diagnosis-row">
                <div>
                  <strong>{submission.piece || "未命名曲目"}</strong>
                  <span>
                    {submission.submittedAt ? submission.submittedAt.slice(0, 16).replace("T", " ") : ""}
                    {submission.instrument
                      ? ` · ${INSTRUMENTS.find((item) => item.id === submission.instrument)?.label || submission.instrument}`
                      : ""}
                  </span>
                  {submission.teacherFeedback ? (
                    <p className="western-student-feedback">{submission.teacherFeedback}</p>
                  ) : null}
                </div>
                <span className={submission.status === "feedback_released" ? "pill-ok" : "pill-review"}>
                  {STATUS_LABELS[submission.status] || submission.status}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted-copy">{listLoading ? "加载中..." : "还没有提交记录。上传第一条练习录音吧!"}</p>
        )}
      </section>
    </div>
  );
}
