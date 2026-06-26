import { useEffect, useMemo, useState } from "react";
import {
  applyTeacherValidationPack,
  fetchWesternAlignmentPreview,
  fetchTeacherValidationPack,
  fetchTeacherValidationPacks,
  saveTeacherValidationReview,
  saveWesternAlignmentPreviewReview,
} from "../researchApi";
import ScoreLocatorPanel from "./ScoreLocatorPanel.jsx";
import SegmentAudioPlayer from "./SegmentAudioPlayer.jsx";
import { FindingToggle, IssueChip, SummaryPill } from "./TeacherValidationAtoms.jsx";
import {
  PATH_OPTIONS,
  TEACHER_MATCH_STATUS_OPTIONS,
  TEACHER_TECHNIQUE_TAG_OPTIONS,
  findingText,
  formatDate,
  formatPercent,
  joinList,
  joinNumberList,
  makeDraft,
  measureLabelFromLocator,
  noteLabelFromLocator,
  notePosition,
  parseList,
  parseNumberList,
  pathLabel,
  severityLabel,
} from "./teacherValidationUtils.js";

const FILTER_LABELS = { pending: "待标注", complete: "已完成", excluded: "已排除", all: "全部" };
function filterLabel(value) {
  return FILTER_LABELS[value] || value;
}

function formatImportStatus(summary = {}) {
  const importedCount = Math.max(0, Math.round(Number(summary.acceptedReviewCount) || 0));
  const validationSummary = summary.validationSummary || {};
  const reviewCount = Math.max(0, Math.round(Number(validationSummary.reviewCount) || 0));
  const parts = [`已导入 ${importedCount} 条完成标注`];
  if (reviewCount > 0) {
    parts.push(`质量基线 ${reviewCount} 条`);
    parts.push(`音符 F1 ${formatPercent(validationSummary.averageNoteF1)}`);
    parts.push(`小节 F1 ${formatPercent(validationSummary.averageMeasureF1)}`);
    parts.push(`路径一致率 ${formatPercent(validationSummary.pathAgreementRate)}`);
  } else {
    parts.push("质量基线仍无教师标注");
  }
  return parts.join(" · ");
}

export default function TeacherValidationApp() {
  const [packs, setPacks] = useState([]);
  const [packId, setPackId] = useState("");
  const [pack, setPack] = useState(null);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [filter, setFilter] = useState("pending");
  const [raterId, setRaterId] = useState(() => localStorage.getItem("ai-erhu.teacher-rater") || "teacher-1");
  const [draft, setDraft] = useState(makeDraft(null, "teacher-1"));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [manualMeasureIndex, setManualMeasureIndex] = useState("");
  const [manualNoteMeasure, setManualNoteMeasure] = useState("");
  const [manualNoteOrdinal, setManualNoteOrdinal] = useState("");
  const [activeLocator, setActiveLocator] = useState({ type: "", measureIndex: 0, noteId: "" });
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [westernPreview, setWesternPreview] = useState(null);
  const [westernPreviewLoading, setWesternPreviewLoading] = useState(false);

  const items = pack?.items || [];
  const selectedItem = items.find((item) => item.caseId === selectedCaseId) || items[0] || null;
  const selectedIndex = items.findIndex((item) => item.caseId === selectedItem?.caseId);
  const noteIdSet = useMemo(() => new Set(parseList(draft.teacherIssueNoteIds)), [draft.teacherIssueNoteIds]);
  const measureIndexSet = useMemo(() => new Set(parseNumberList(draft.teacherIssueMeasureIndexes).map(String)), [draft.teacherIssueMeasureIndexes]);
  const noteFindings = selectedItem?.analysis?.noteFindings || [];
  const measureFindings = selectedItem?.analysis?.measureFindings || [];
  const selectedNoteIds = parseList(draft.teacherIssueNoteIds);
  const selectedMeasureIndexes = parseNumberList(draft.teacherIssueMeasureIndexes);
  const scoreLocator = selectedItem?.scoreLocator || null;
  const noteById = useMemo(
    () => new Map(noteFindings.map((finding, index) => [String(finding.noteId || ""), { finding, index }])),
    [noteFindings],
  );
  const locatorNoteById = useMemo(() => {
    const next = new Map();
    for (const note of scoreLocator?.notePositions || []) {
      if (note.noteId) next.set(String(note.noteId), note);
      if (note.sourceNoteId) next.set(String(note.sourceNoteId), note);
    }
    return next;
  }, [scoreLocator]);
  const locatorMeasureByIndex = useMemo(() => {
    const next = new Map();
    for (const measure of scoreLocator?.measurePositions || []) {
      if (measure.measureIndex) next.set(String(measure.measureIndex), measure);
      if (measure.globalMeasureIndex) next.set(String(measure.globalMeasureIndex), measure);
      if (measure.displayMeasureIndex) next.set(String(measure.displayMeasureIndex), measure);
    }
    return next;
  }, [scoreLocator]);
  const activeNoteId = activeLocator.type === "note" ? activeLocator.noteId : "";
  const activeMeasureIndex =
    activeLocator.type === "note"
      ? locatorNoteById.get(activeNoteId)?.measureIndex || notePosition(noteById.get(activeNoteId)?.finding || { noteId: activeNoteId }).measureIndex
      : Math.round(Number(activeLocator.measureIndex) || 0);
  const activeMeasureForTeacher =
    locatorMeasureByIndex.get(String(activeMeasureIndex))?.globalMeasureIndex ||
    locatorMeasureByIndex.get(String(activeMeasureIndex))?.displayMeasureIndex ||
    activeMeasureIndex;
  const measureRows = useMemo(() => {
    const rows = new Map();
    const ensure = (measureIndex) => {
      const numeric = Math.max(1, Math.round(Number(measureIndex) || 1));
      if (!rows.has(numeric)) rows.set(numeric, { measureIndex: numeric, notes: [], measureFindings: [] });
      return rows.get(numeric);
    };
    noteFindings.forEach((finding, index) => {
      const position = notePosition(finding, index + 1);
      ensure(position.measureIndex).notes.push({ finding, index, noteOrdinal: position.noteOrdinal });
    });
    measureFindings.forEach((finding) => {
      ensure(finding.measureIndex).measureFindings.push(finding);
    });
    selectedMeasureIndexes.forEach((measureIndex) => ensure(measureIndex));
    return Array.from(rows.values()).sort((left, right) => left.measureIndex - right.measureIndex);
  }, [noteFindings, measureFindings, selectedMeasureIndexes.join("|")]);

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((item) => {
      const status = item.review?.reviewStatus || "pending";
      const included = item.review?.includeInBaseline !== "no";
      if (filter === "complete") return status === "complete";
      if (filter === "excluded") return !included;
      return status !== "complete" && included;
    });
  }, [filter, items]);
  const reviewablePacks = useMemo(() => {
    const ready = packs.filter((item) => item.reviewReady !== false);
    return ready;
  }, [packs]);

  async function loadPacks() {
    setLoading(true);
    setErrorMessage("");
    try {
      const json = await fetchTeacherValidationPacks();
      const nextPacks = Array.isArray(json?.packs) ? json.packs : [];
      setPacks(nextPacks);
      const params = new URLSearchParams(window.location.search);
      const requestedPack = params.get("pack");
      const readyPacks = nextPacks.filter((item) => item.reviewReady !== false);
      const selectablePacks = readyPacks;
      const requestedPackReady = selectablePacks.some((item) => item.packId === requestedPack);
      const currentPackReady = selectablePacks.some((item) => item.packId === packId);
      const nextPackId =
        requestedPackReady ? requestedPack :
        currentPackReady ? packId :
        selectablePacks[0]?.packId || "";
      if (!selectablePacks.length) {
        setStatusMessage("当前没有可审教师包。需要先生成原 PDF 谱面、真实短音频，并带有已验证对齐证据的教师包。");
      }
      if (requestedPack && !requestedPackReady && selectablePacks[0]?.packId) {
        setStatusMessage("已切换到最新可审教师包，旧包缺少短音频或可信对齐证据。");
      }
      setPackId(nextPackId);
      if (nextPackId) {
        await loadPack(nextPackId);
      } else {
        setPack(null);
      }
    } catch (error) {
      setErrorMessage(error.message || "教师包加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadPack(nextPackId = packId) {
    if (!nextPackId) return;
    setErrorMessage("");
    const json = await fetchTeacherValidationPack(nextPackId);
    const nextPack = json?.pack || null;
    setPack(nextPack);
    const firstCase = nextPack?.items?.[0]?.caseId || "";
    setSelectedCaseId((current) => (nextPack?.items?.some((item) => item.caseId === current) ? current : firstCase));
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "teacher");
    url.searchParams.set("pack", nextPackId);
    window.history.replaceState({}, "", url);
  }

  useEffect(() => {
    loadPacks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("ai-erhu.teacher-rater", raterId);
  }, [raterId]);

  useEffect(() => {
    setDraft(makeDraft(selectedItem, raterId));
  }, [selectedItem?.caseId, raterId]);

  useEffect(() => {
    const firstFinding = selectedItem?.analysis?.noteFindings?.[0];
    if (firstFinding?.noteId) {
      const position = notePosition(firstFinding, 1);
      setActiveLocator({ type: "note", noteId: String(firstFinding.noteId), measureIndex: position.measureIndex });
      return;
    }
    const firstMeasure = selectedItem?.analysis?.measureFindings?.[0]?.measureIndex;
    if (firstMeasure) {
      setActiveLocator({ type: "measure", noteId: "", measureIndex: Math.round(Number(firstMeasure) || 1) });
      return;
    }
    setActiveLocator({ type: "", noteId: "", measureIndex: 0 });
  }, [selectedItem?.caseId]);

  async function handlePackChange(nextPackId) {
    setPackId(nextPackId);
    setLoading(true);
    try {
      await loadPack(nextPackId);
    } catch (error) {
      setErrorMessage(error.message || "教师包加载失败");
    } finally {
      setLoading(false);
    }
  }

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function toggleTechniqueTag(tag) {
    const set = new Set(parseList(draft.teacherTechniqueTags));
    const willHave = !set.has(tag);
    if (willHave) set.add(tag); else set.delete(tag);
    let tags = Array.from(set);
    // mirror the server: "none" (= no technique) is mutually exclusive
    if (willHave && tag === "none") tags = ["none"];
    else if (willHave && tag !== "none") tags = tags.filter((value) => value !== "none");
    updateDraft({ teacherTechniqueTags: tags.join("|") });
  }

  function activateMeasureIndex(measureIndex) {
    const numeric = Math.round(Number(measureIndex));
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    setActiveLocator({ type: "measure", noteId: "", measureIndex: numeric });
  }

  function activateNoteId(noteId, fallbackMeasureIndex = 0) {
    if (!noteId) return;
    const locatorNote = locatorNoteById.get(noteId);
    const known = noteById.get(noteId);
    const position = notePosition(known?.finding || { noteId }, known ? known.index + 1 : 1);
    setActiveLocator({
      type: "note",
      noteId,
      measureIndex: locatorNote?.measureIndex || fallbackMeasureIndex || position.measureIndex,
    });
  }

  function ensureMeasureIndex(measureIndex) {
    const numeric = Math.round(Number(measureIndex));
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const values = new Set(parseNumberList(draft.teacherIssueMeasureIndexes).map(String));
    values.add(String(numeric));
    updateDraft({ teacherIssueMeasureIndexes: Array.from(values).join("|") });
  }

  function ensureNoteId(noteId) {
    if (!noteId) return;
    const values = new Set(parseList(draft.teacherIssueNoteIds));
    values.add(noteId);
    updateDraft({ teacherIssueNoteIds: Array.from(values).join("|") });
  }

  function toggleNoteId(noteId) {
    if (!noteId) return;
    activateNoteId(noteId);
    const values = new Set(parseList(draft.teacherIssueNoteIds));
    if (values.has(noteId)) values.delete(noteId);
    else values.add(noteId);
    updateDraft({ teacherIssueNoteIds: Array.from(values).join("|") });
  }

  function toggleMeasureIndex(measureIndex) {
    const numeric = Math.round(Number(measureIndex));
    if (!Number.isFinite(numeric)) return;
    activateMeasureIndex(numeric);
    const key = String(numeric);
    const values = new Set(parseNumberList(draft.teacherIssueMeasureIndexes).map(String));
    if (values.has(key)) values.delete(key);
    else values.add(key);
    updateDraft({ teacherIssueMeasureIndexes: Array.from(values).join("|") });
  }

  function removeNoteId(noteId) {
    updateDraft({ teacherIssueNoteIds: parseList(draft.teacherIssueNoteIds).filter((item) => item !== noteId).join("|") });
  }

  function removeMeasureIndex(measureIndex) {
    const key = String(Math.round(Number(measureIndex)));
    updateDraft({
      teacherIssueMeasureIndexes: parseNumberList(draft.teacherIssueMeasureIndexes)
        .map(String)
        .filter((item) => item !== key)
        .join("|"),
    });
  }

  function addManualMeasure() {
    const numeric = Math.round(Number(manualMeasureIndex));
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    ensureMeasureIndex(numeric);
    activateMeasureIndex(numeric);
    setManualMeasureIndex("");
  }

  function addManualNote() {
    const measure = Math.round(Number(manualNoteMeasure));
    const ordinal = Math.round(Number(manualNoteOrdinal));
    if (!Number.isFinite(measure) || !Number.isFinite(ordinal) || measure <= 0 || ordinal <= 0) return;
    const noteId = `xml-m${measure}-n${ordinal}`;
    ensureNoteId(noteId);
    activateNoteId(noteId, measure);
    setManualNoteMeasure("");
    setManualNoteOrdinal("");
  }

  function useSystemFindings() {
    updateDraft({
      teacherPrimaryPath: selectedItem?.systemRecommendedPath || "review-first",
      teacherIssueNoteIds: joinList(selectedItem?.systemIssueNoteIds || selectedItem?.review?.systemIssueNoteIds || ""),
      teacherIssueMeasureIndexes: joinNumberList(selectedItem?.systemIssueMeasureIndexes || selectedItem?.review?.systemIssueMeasureIndexes || ""),
    });
  }

  function markAudioScoreMismatch() {
    const mismatchComment = "音频与谱面不匹配，无法判断，本样本不纳入质量基线。";
    const currentComment = String(draft.comments || "").trim();
    updateDraft({
      reviewStatus: "complete",
      includeInBaseline: "no",
      teacherMatchStatus: "mismatch",
      comments: currentComment.includes(mismatchComment) ? currentComment : [currentComment, mismatchComment].filter(Boolean).join("\n"),
    });
  }

  async function saveDraft({ complete = false, next = false } = {}) {
    if (!packId || !selectedItem) return;
    setSaving(true);
    setErrorMessage("");
    try {
      const payload = {
        ...draft,
        raterId: raterId || draft.raterId || "teacher-1",
        reviewStatus: complete ? "complete" : draft.reviewStatus,
        includeInBaseline: draft.includeInBaseline === "no" ? "no" : "yes",
        teacherIssueNoteIds: joinList(draft.teacherIssueNoteIds),
        teacherIssueMeasureIndexes: joinNumberList(draft.teacherIssueMeasureIndexes),
      };
      const json = await saveTeacherValidationReview(packId, selectedItem.caseId, payload);
      setPack(json?.pack || pack);
      setStatusMessage(complete ? "已保存完成标注" : "草稿已保存");
      if (next) {
        const latestItems = json?.pack?.items || items;
        const start = latestItems.findIndex((item) => item.caseId === selectedItem.caseId);
        const nextPending =
          latestItems.slice(start + 1).find((item) => item.review?.reviewStatus !== "complete" && item.review?.includeInBaseline !== "no") ||
          latestItems.find((item) => item.review?.reviewStatus !== "complete" && item.review?.includeInBaseline !== "no") ||
          latestItems[start + 1] ||
          latestItems[0];
        if (nextPending?.caseId) setSelectedCaseId(nextPending.caseId);
      }
    } catch (error) {
      setErrorMessage(error.message || "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function applyCompletedReviews() {
    if (!packId) return;
    if (!window.confirm("将本包 reviewStatus=complete 且 includeInBaseline=yes 的标注导入质量基线？")) return;
    setApplying(true);
    setErrorMessage("");
    try {
      const json = await applyTeacherValidationPack(packId);
      setStatusMessage(formatImportStatus(json?.summary));
      await loadPack(packId);
    } catch (error) {
      setErrorMessage(error.message || "导入失败");
    } finally {
      setApplying(false);
    }
  }

  async function loadWesternPreview() {
    setWesternPreviewLoading(true);
    setErrorMessage("");
    try {
      const preview = await fetchWesternAlignmentPreview({ limit: 8 });
      setWesternPreview(preview);
      setStatusMessage(`Western strings preview loaded: ${preview?.summary?.noteCount || 0} notes.`);
    } catch (error) {
      setErrorMessage(error.message || "Western strings preview failed.");
    } finally {
      setWesternPreviewLoading(false);
    }
  }

  async function reviewWesternDecision(decision, action) {
    const noteKey = decision?.noteKey || decision?.noteId || "";
    if (!noteKey) return;
    let correctedOnsetSeconds = "";
    if (action === "correct") {
      const entered = window.prompt("Correct onset seconds for this note:", String(decision.predictedOnsetSeconds ?? ""));
      if (entered == null) return;
      correctedOnsetSeconds = entered;
    }
    try {
      await saveWesternAlignmentPreviewReview({
        noteKey,
        action,
        raterId,
        predictedOnsetSeconds: decision.predictedOnsetSeconds,
        correctedOnsetSeconds,
      });
      setStatusMessage(`Western preview ${action} saved for ${noteKey}.`);
    } catch (error) {
      setErrorMessage(error.message || "Western preview review failed.");
    }
  }

  const summary = pack?.summary || {};
  const isTechniqueLabelingPack = pack?.manifest?.reviewMode === "technique-labeling";

  return (
    <main className="teacher-shell">
      <header className="teacher-header">
        <div>
          <span className="eyebrow">Teacher validation</span>
          <h1>教师标注后台</h1>
          <p>真实节目片段、谱面和系统发现集中在同一页，保存后可直接导入质量基线。</p>
        </div>
        <div className="teacher-header-actions">
          <a className="secondary-link" href="/" title="返回学生端">返回学生端</a>
          <button type="button" className="secondary-button" onClick={loadPacks} disabled={loading}>
            刷新
          </button>
        </div>
      </header>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
      {statusMessage ? <div className="status-banner">{statusMessage}</div> : null}

      <section className="teacher-toolbar panel-card">
        <label>
          <span>评审包</span>
          <select value={packId} onChange={(event) => handlePackChange(event.target.value)}>
            {reviewablePacks.map((item) => (
              <option key={item.packId} value={item.packId}>
                {item.packId} · {item.summary?.completedCount || 0}/{item.summary?.totalCount || item.selectedCount}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>教师 ID</span>
          <input value={raterId} onChange={(event) => setRaterId(event.target.value)} />
        </label>
        <label>
          <span>筛选</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="pending">待标注</option>
            <option value="complete">已完成</option>
            <option value="excluded">已排除</option>
            <option value="all">全部</option>
          </select>
        </label>
        <button type="button" className="primary-button" onClick={applyCompletedReviews} disabled={applying || isTechniqueLabelingPack || !summary.includedCompleteCount}>
          {isTechniqueLabelingPack ? "技巧标注只保存" : applying ? "导入中..." : "导入已完成标注"}
        </button>
      </section>

      <section className="ops-summary-grid">
        <SummaryPill label="候选片段" value={summary.totalCount ?? pack?.manifest?.selectedCount ?? 0} />
        <SummaryPill label="已完成" value={summary.completedCount ?? 0} />
        <SummaryPill label="可导入" value={summary.includedCompleteCount ?? 0} />
        <SummaryPill label="生成时间" value={formatDate(pack?.manifest?.generatedAt)} />
      </section>

      <section className="panel-card">
        <div className="section-title">
          <span className="section-step">M2</span>
          <div>
            <h2>Western strings offline alignment preview</h2>
            <p>Teacher-only evidence view. This does not publish feedback to students.</p>
          </div>
        </div>
        <div className="action-row">
          <button type="button" className="secondary-button" onClick={loadWesternPreview} disabled={westernPreviewLoading}>
            {westernPreviewLoading ? "Loading..." : "Load preview"}
          </button>
        </div>
        {westernPreview?.summary ? (
          <div className="upload-meta">
            <span>notes {westernPreview.summary.noteCount}</span>
            <span>auto {westernPreview.summary.autoPassCount}</span>
            <span>model {westernPreview.summary.confidenceModelVersion}</span>
          </div>
        ) : null}
        {westernPreview?.decisions?.length ? (
          <div className="teacher-finding-list">
            {westernPreview.decisions.slice(0, 8).map((decision) => (
              <div className="history-card" key={decision.noteId || decision.noteKey}>
                <strong>{decision.noteId || decision.noteKey}</strong>
                <p>
                  {decision.dataset} / {decision.piece} · predicted {Number(decision.predictedOnsetSeconds || 0).toFixed(3)}s ·
                  confidence {Number(decision.confidenceScore || 0).toFixed(2)}
                </p>
                <p>sources {(decision.candidateSources || []).map((item) => item.method).join(", ")}</p>
                <div className="action-row">
                  <button type="button" className="secondary-button" onClick={() => reviewWesternDecision(decision, "confirm")}>
                    Confirm
                  </button>
                  <button type="button" className="secondary-button" onClick={() => reviewWesternDecision(decision, "correct")}>
                    Correct
                  </button>
                  <button type="button" className="secondary-button" onClick={() => reviewWesternDecision(decision, "review_required")}>
                    Needs review
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="teacher-layout">
        <aside className="teacher-case-list panel-card">
          <div className="section-title">
            <span className="section-step">{filteredItems.length}</span>
            <div>
              <h2>片段列表</h2>
              <p>{loading ? "加载中" : `当前显示 ${filteredItems.length} 条`}</p>
            </div>
          </div>
          <div className="teacher-case-scroll">
            {(!loading && !filteredItems.length && items.length) ? (
              <button type="button" className="teacher-case-button" onClick={() => setFilter("all")}>
                <strong>当前筛选「{filterLabel(filter)}」无片段</strong>
                <span>共 {items.length} 段；点此查看「全部」即可切换/回填</span>
              </button>
            ) : null}
            {filteredItems.map((item) => (
              <button
                key={item.caseId}
                type="button"
                className={`teacher-case-button${item.caseId === selectedItem?.caseId ? " is-active" : ""}`}
                onClick={() => setSelectedCaseId(item.caseId)}
              >
                <strong>{item.title || item.analysis?.pieceTitle || "未命名曲目"}</strong>
                <span>{item.sectionTitle || item.sectionId}</span>
                <small>{item.review?.reviewStatus === "complete" ? "已完成" : item.review?.includeInBaseline === "no" ? "已排除" : "待标注"}</small>
              </button>
            ))}
          </div>
        </aside>

        <article className="teacher-editor panel-card">
          {selectedItem ? (
            <>
              <div className="teacher-editor-head">
                <div>
                  <span className="eyebrow">{selectedIndex + 1} / {items.length}</span>
                  <h2>{selectedItem.title || selectedItem.analysis?.pieceTitle || "未命名曲目"}</h2>
                  <p>{selectedItem.sectionTitle || selectedItem.sectionId}</p>
                </div>
                <div className="section-meta">
                  <span>{pathLabel(selectedItem.systemRecommendedPath)}</span>
                  <span>音符 {selectedItem.noteFindingCount ?? noteFindings.length}</span>
                  <span>小节 {selectedItem.measureFindingCount ?? measureFindings.length}</span>
                  <span>置信度 {formatPercent(selectedItem.confidence)}</span>
                </div>
              </div>

              {selectedItem.alignmentEvidence?.trusted === false ? (
                <div className="teacher-alignment-warning">
                  <strong>当前样本未通过真实音谱对齐</strong>
                  <span>
                    来源为 {selectedItem.alignmentEvidence.scanMode || "unknown"}：
                    {selectedItem.alignmentEvidence.reason || "缺少可用于教师标注的音频/PDF 对齐证据。"}
                    这类样本不能作为质量基线，听起来对不上时直接排除。
                  </span>
                </div>
              ) : null}

              <div className="teacher-media-grid">
                <div className="teacher-media-block">
                  <h3>音频片段</h3>
                  <SegmentAudioPlayer item={selectedItem} onMismatch={markAudioScoreMismatch} />
                </div>
                <ScoreLocatorPanel
                  item={selectedItem}
                  activeLocator={activeLocator}
                  activeMeasureIndex={activeMeasureIndex}
                  activeNoteId={activeNoteId}
                  noteIdSet={noteIdSet}
                  measureIndexSet={measureIndexSet}
                  onActivateMeasure={activateMeasureIndex}
                  onActivateNote={(note) => activateNoteId(note.sourceNoteId || note.noteId, note.measureIndex)}
                  onMarkActiveMeasure={() => ensureMeasureIndex(activeMeasureForTeacher)}
                  onMarkActiveNote={() => ensureNoteId(activeNoteId)}
                />
              </div>

              <div className="teacher-form-grid">
                <label>
                  <span>标注状态</span>
                  <select value={draft.reviewStatus} onChange={(event) => updateDraft({ reviewStatus: event.target.value })}>
                    <option value="pending">待标注</option>
                    <option value="complete">完成</option>
                  </select>
                </label>
                <label>
                  <span>纳入基线</span>
                  <select value={draft.includeInBaseline} onChange={(event) => updateDraft({ includeInBaseline: event.target.value })}>
                    <option value="yes">纳入</option>
                    <option value="no">排除</option>
                  </select>
                </label>
                <label>
                  <span>总体一致度</span>
                  <input
                    type="number"
                    min="0"
                    max="5"
                    step="1"
                    value={draft.overallAgreement}
                    onChange={(event) => updateDraft({ overallAgreement: event.target.value })}
                  />
                </label>
                <label>
                  <span>教师主判断</span>
                  <select value={draft.teacherPrimaryPath} onChange={(event) => updateDraft({ teacherPrimaryPath: event.target.value })}>
                    <option value="">未判断</option>
                    {PATH_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {isTechniqueLabelingPack && (
                <>
                  <div className="teacher-form-grid">
                    <label>
                      <span>是否匹配</span>
                      <select value={draft.teacherMatchStatus} onChange={(event) => updateDraft({ teacherMatchStatus: event.target.value })}>
                        {TEACHER_MATCH_STATUS_OPTIONS.map((item) => (
                          <option key={item.value} value={item.value}>{item.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>技巧置信度 (1-5)</span>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        step="1"
                        value={draft.teacherTechniqueConfidence}
                        onChange={(event) => updateDraft({ teacherTechniqueConfidence: event.target.value })}
                      />
                    </label>
                    <label className="teacher-inline-check">
                      <input
                        type="checkbox"
                        checked={draft.teacherTechniqueUncertain === "yes"}
                        onChange={(event) => updateDraft({ teacherTechniqueUncertain: event.target.checked ? "yes" : "" })}
                      />
                      <span>技巧不确定</span>
                    </label>
                  </div>

                  <section className="teacher-technique-tags">
                    <h3>技巧标签（多选）</h3>
                    <div className="teacher-tag-row">
                      {TEACHER_TECHNIQUE_TAG_OPTIONS.map((item) => {
                        const checked = parseList(draft.teacherTechniqueTags).includes(item.value);
                        return (
                          <label key={item.value} className={`teacher-tag-chip${checked ? " is-active" : ""}`}>
                            <input type="checkbox" checked={checked} onChange={() => toggleTechniqueTag(item.value)} />
                            <span>{item.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </section>
                </>
              )}

              <div className="action-row teacher-action-row">
                <button type="button" className="secondary-button" onClick={useSystemFindings}>
                  采用系统发现
                </button>
                <button type="button" className="secondary-button" onClick={() => updateDraft({ teacherIssueNoteIds: "", teacherIssueMeasureIndexes: "" })}>
                  清空问题
                </button>
              </div>

              <section className="teacher-finding-section">
                <h3>小节定位视图</h3>
                <div className="teacher-measure-map">
                  {measureRows.length ? measureRows.map((row) => (
                    <div key={row.measureIndex} className={`teacher-measure-card${measureIndexSet.has(String(row.measureIndex)) ? " is-active" : ""}`}>
                      <div className="teacher-measure-head">
                        <strong>{measureLabelFromLocator(locatorMeasureByIndex.get(String(row.measureIndex)), row.measureIndex)}</strong>
                        <button type="button" className="secondary-button" onClick={() => toggleMeasureIndex(row.measureIndex)}>
                          {measureIndexSet.has(String(row.measureIndex)) ? "取消问题小节" : "标记为问题小节"}
                        </button>
                      </div>
                      {row.measureFindings.length ? (
                        <div className="teacher-measure-reasons">
                          {row.measureFindings.map((finding, index) => (
                            <span key={`${row.measureIndex}-${finding.issueType || finding.issueLabel || index}`}>
                              {finding.issueLabel || finding.issueType || "小节问题"} · {severityLabel(finding.severity)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="teacher-note-chip-row">
                        {row.notes.length ? row.notes.map(({ finding, index, noteOrdinal }) => {
                          const noteId = String(finding.noteId || "");
                          return (
                            <button
                              key={noteId || `${row.measureIndex}-${noteOrdinal}`}
                              type="button"
                              className={`teacher-note-chip${noteIdSet.has(noteId) ? " is-active" : ""}`}
                              onClick={() => toggleNoteId(noteId)}
                            >
                              {`第 ${noteOrdinal} 音`}
                              <span>{finding.pitchLabel || finding.rhythmLabel || finding.rhythmTypeLabel || "系统问题"}</span>
                            </button>
                          );
                        }) : <span className="teacher-muted">本小节只有小节级问题，暂无具体音符定位。</span>}
                      </div>
                    </div>
                  )) : <p className="empty-card">本片段没有系统定位结果，可在下方手动添加问题小节或问题音。</p>}
                </div>
                <div className="teacher-manual-grid">
                  <label>
                    <span>补充问题小节</span>
                    <input type="number" min="1" value={manualMeasureIndex} onChange={(event) => setManualMeasureIndex(event.target.value)} />
                  </label>
                  <button type="button" className="secondary-button" onClick={addManualMeasure}>
                    添加问题小节
                  </button>
                  <label>
                    <span>补充问题音：小节</span>
                    <input type="number" min="1" value={manualNoteMeasure} onChange={(event) => setManualNoteMeasure(event.target.value)} />
                  </label>
                  <label>
                    <span>补充问题音：第几个音</span>
                    <input type="number" min="1" value={manualNoteOrdinal} onChange={(event) => setManualNoteOrdinal(event.target.value)} />
                  </label>
                  <button type="button" className="secondary-button" onClick={addManualNote}>
                    添加问题音
                  </button>
                </div>
              </section>

              <section className="teacher-finding-section">
                <h3>音符问题</h3>
                <div className="teacher-finding-list">
                  {noteFindings.length ? noteFindings.map((finding) => {
                    const noteId = String(finding.noteId || "");
                    const locatorNote = locatorNoteById.get(noteId);
                    return (
                      <FindingToggle key={noteId || `${finding.measureIndex}-${finding.noteIndex}`} checked={noteIdSet.has(noteId)} onToggle={() => toggleNoteId(noteId)}>
                        <strong>{noteLabelFromLocator(locatorNote, finding)}</strong>
                        <span>系统定位 · {severityLabel(finding.severity)}</span>
                        <small>{findingText(finding)}</small>
                      </FindingToggle>
                    );
                  }) : <p className="empty-card">本片段没有系统音符问题。</p>}
                </div>
                <div className="teacher-selected-row">
                  {selectedNoteIds.length ? selectedNoteIds.map((noteId) => {
                    const known = noteById.get(noteId);
                    const locatorNote = locatorNoteById.get(noteId);
                    return (
                      <IssueChip key={noteId} onRemove={() => removeNoteId(noteId)}>
                        {known ? noteLabelFromLocator(locatorNote, known.finding, known.index + 1) : noteLabelFromLocator(locatorNote, { noteId })}
                      </IssueChip>
                    );
                  }) : <span className="teacher-muted">尚未确认问题音。</span>}
                </div>
                <details className="teacher-raw-details">
                  <summary>查看/编辑内部音符 ID</summary>
                  <label className="notes-field">
                    <span>内部音符 ID（系统自动生成，通常不用手填）</span>
                    <textarea rows="2" value={draft.teacherIssueNoteIds} onChange={(event) => updateDraft({ teacherIssueNoteIds: event.target.value })} />
                  </label>
                </details>
              </section>

              <section className="teacher-finding-section">
                <h3>小节问题</h3>
                <div className="teacher-finding-list">
                  {measureFindings.length ? measureFindings.map((finding) => {
                    const measureIndex = Math.round(Number(finding.measureIndex));
                    const key = Number.isFinite(measureIndex) ? String(measureIndex) : "";
                    const locatorMeasure = locatorMeasureByIndex.get(key);
                    return (
                      <FindingToggle key={key || finding.issueId || finding.label} checked={measureIndexSet.has(key)} onToggle={() => toggleMeasureIndex(measureIndex)}>
                        <strong>{locatorMeasure ? locatorMeasure.label : `第 ${key || "-"} 小节`}</strong>
                        <span>{severityLabel(finding.severity)}</span>
                        <small>{findingText(finding)}</small>
                      </FindingToggle>
                    );
                  }) : <p className="empty-card">本片段没有系统小节问题。</p>}
                </div>
                <div className="teacher-selected-row">
                  {selectedMeasureIndexes.length ? selectedMeasureIndexes.map((measureIndex) => (
                    <IssueChip key={measureIndex} onRemove={() => removeMeasureIndex(measureIndex)}>
                      {measureLabelFromLocator(locatorMeasureByIndex.get(String(measureIndex)), measureIndex)}
                    </IssueChip>
                  )) : <span className="teacher-muted">尚未确认问题小节。</span>}
                </div>
                <details className="teacher-raw-details">
                  <summary>查看/编辑内部小节序号</summary>
                  <label className="notes-field">
                    <span>内部小节序号（系统自动生成，通常不用手填）</span>
                    <textarea rows="2" value={draft.teacherIssueMeasureIndexes} onChange={(event) => updateDraft({ teacherIssueMeasureIndexes: event.target.value })} />
                  </label>
                </details>
              </section>

              <label className="notes-field">
                <span>备注</span>
                <textarea rows="4" value={draft.comments} onChange={(event) => updateDraft({ comments: event.target.value })} />
              </label>

              <div className="action-row teacher-save-row">
                <button type="button" className="secondary-button" onClick={() => saveDraft()} disabled={saving}>
                  {saving ? "保存中..." : "保存草稿"}
                </button>
                <button type="button" className="primary-button" onClick={() => saveDraft({ complete: true, next: true })} disabled={saving}>
                  标为完成并下一条
                </button>
              </div>
            </>
          ) : (
            <div className="empty-card">没有可标注的教师评审包。</div>
          )}
        </article>
      </section>
    </main>
  );
}
