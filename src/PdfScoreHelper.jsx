import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

function createRowId() {
  return `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function createBlankNote(index = 1) {
  return {
    rowId: createRowId(),
    noteId: `manual-m1-n${index}`,
    measureIndex: 1,
    beatStart: 0,
    beatDuration: 1,
    midiPitch: 69,
  };
}

function normalizeManualNotes(rows = []) {
  return rows
    .map((row, index) => ({
      noteId: String(row.noteId || "").trim() || `manual-m${safeNumber(row.measureIndex, 1)}-n${index + 1}`,
      measureIndex: Math.max(1, Math.round(safeNumber(row.measureIndex, 1))),
      beatStart: Math.max(0, safeNumber(row.beatStart, 0)),
      beatDuration: Math.max(0.125, safeNumber(row.beatDuration, 1)),
      midiPitch: Math.min(108, Math.max(21, Math.round(safeNumber(row.midiPitch, 69)))),
    }))
    .filter((row) => row.noteId);
}

function rowsFromNotes(notes = []) {
  if (!Array.isArray(notes) || !notes.length) {
    return [createBlankNote(1)];
  }
  return notes.map((note, index) => ({
    rowId: createRowId(),
    noteId: note.noteId || `manual-note-${index + 1}`,
    measureIndex: safeNumber(note.measureIndex, 1),
    beatStart: safeNumber(note.beatStart, 0),
    beatDuration: safeNumber(note.beatDuration, 1),
    midiPitch: safeNumber(note.midiPitch, 69),
  }));
}

function summarizePack(piecePack) {
  const notes = Array.isArray(piecePack?.notes) ? piecePack.notes : [];
  const measureCount = notes.length ? Math.max(...notes.map((item) => safeNumber(item.measureIndex, 1))) : 0;
  return {
    noteCount: notes.length,
    measureCount,
  };
}

export default function PdfScoreHelper({
  defaultPieceId,
  defaultSectionId,
  defaultTitle,
  defaultTempo,
  defaultMeter,
  templateNotes = [],
  activeManualPiecePack,
  onApplyManualPiecePack,
  onClearManualPiecePack,
}) {
  const [title, setTitle] = useState(defaultTitle ? `${defaultTitle} - 手工录入` : "PDF 手工录入片段");
  const [sectionTitle, setSectionTitle] = useState(defaultSectionId ? `${defaultSectionId}-manual` : "manual-section");
  const [tempo, setTempo] = useState(defaultTempo || 72);
  const [meter, setMeter] = useState(defaultMeter || "4/4");
  const [noteRows, setNoteRows] = useState([createBlankNote()]);
  const [pdfFileName, setPdfFileName] = useState("");
  const [pdfDocument, setPdfDocument] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [previewError, setPreviewError] = useState("");
  const [helperMessage, setHelperMessage] = useState("可先选择 PDF 页面，再手工录入音符事件。");
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return undefined;
    let cancelled = false;

    async function renderPage() {
      try {
        const page = await pdfDocument.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        if (renderTaskRef.current?.cancel) {
          try {
            renderTaskRef.current.cancel();
          } catch {
            // ignore cancelled task
          }
        }
        const task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (error) {
        if (!cancelled && error?.name !== "RenderingCancelledException") {
          setPreviewError(error?.message || "PDF 页面渲染失败。");
        }
      }
    }

    renderPage();
    return () => {
      cancelled = true;
      if (renderTaskRef.current?.cancel) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // ignore cancelled task
        }
      }
    };
  }, [pageNumber, pdfDocument]);

  useEffect(() => {
    setTitle(defaultTitle ? `${defaultTitle} - 手工录入` : "PDF 手工录入片段");
    setSectionTitle(defaultSectionId ? `${defaultSectionId}-manual` : "manual-section");
    setTempo(defaultTempo || 72);
    setMeter(defaultMeter || "4/4");
  }, [defaultMeter, defaultSectionId, defaultTempo, defaultTitle]);

  const piecePackPreview = useMemo(() => {
    const normalizedNotes = normalizeManualNotes(noteRows);
    return {
      pieceId: defaultPieceId || "manual-pdf-piece",
      sectionId: String(sectionTitle || "manual-section").trim() || "manual-section",
      title: String(title || defaultTitle || "PDF 手工录入片段").trim() || "PDF 手工录入片段",
      meter: String(meter || "4/4").trim() || "4/4",
      tempo: Math.max(30, Math.round(safeNumber(tempo, 72))),
      demoAudio: "",
      notes: normalizedNotes,
    };
  }, [defaultPieceId, defaultTitle, meter, noteRows, sectionTitle, tempo, title]);

  const summary = useMemo(() => summarizePack(piecePackPreview), [piecePackPreview]);

  async function handlePdfFile(file) {
    if (!file) return;
    setPreviewError("");
    setPdfFileName(file.name);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loadingTask = getDocument({ data: bytes });
      const documentProxy = await loadingTask.promise;
      setPdfDocument(documentProxy);
      setPageCount(documentProxy.numPages || 0);
      setPageNumber(1);
      setHelperMessage(`已加载 PDF：${file.name}，共 ${documentProxy.numPages || 0} 页。`);
    } catch (error) {
      setPreviewError(error?.message || "PDF 加载失败。");
      setPdfDocument(null);
      setPageCount(0);
      setPageNumber(1);
    }
  }

  function updateNoteRow(rowId, key, value) {
    setNoteRows((prev) => prev.map((row) => (row.rowId === rowId ? { ...row, [key]: value } : row)));
  }

  function addBlankRow() {
    setNoteRows((prev) => [...prev, createBlankNote(prev.length + 1)]);
  }

  function duplicateLastRow() {
    setNoteRows((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return [createBlankNote(1)];
      return [
        ...prev,
        {
          ...last,
          rowId: createRowId(),
          noteId: `${last.noteId || "manual-note"}-copy`,
        },
      ];
    });
  }

  function removeRow(rowId) {
    setNoteRows((prev) => (prev.length === 1 ? prev : prev.filter((row) => row.rowId !== rowId)));
  }

  function loadSectionTemplate() {
    if (!templateNotes.length) {
      setHelperMessage("当前选中段落没有可复制的内置音符模板。");
      return;
    }
    setNoteRows(rowsFromNotes(templateNotes));
    setHelperMessage("已将当前段落复制为人工录入模板，可继续按 PDF 调整。");
  }

  function loadActiveManualPiecePack() {
    if (!activeManualPiecePack?.notes?.length) {
      setHelperMessage("当前还没有已应用的人工乐谱。");
      return;
    }
    setTitle(activeManualPiecePack.title || defaultTitle || "PDF 手工录入片段");
    setSectionTitle(activeManualPiecePack.sectionId || defaultSectionId || "manual-section");
    setTempo(activeManualPiecePack.tempo || defaultTempo || 72);
    setMeter(activeManualPiecePack.meter || defaultMeter || "4/4");
    setNoteRows(rowsFromNotes(activeManualPiecePack.notes));
    setHelperMessage("已把当前启用的人工乐谱回填到编辑器。");
  }

  function applyManualPiecePack() {
    if (!piecePackPreview.notes.length) {
      setPreviewError("请至少录入一个音符后再应用到分析。");
      return;
    }
    setPreviewError("");
    onApplyManualPiecePack?.(piecePackPreview);
    setHelperMessage(`已应用人工录入乐谱：${piecePackPreview.title}（${piecePackPreview.notes.length} 个音符）。`);
  }

  return (
    <section className="panel-card pdf-helper-card">
      <div className="section-title">
        <span className="section-step">02B</span>
        <div>
          <h2>PDF 乐谱人工录入辅助</h2>
          <p>选本地 PDF 进行页面预览，再手工录入音符事件，生成结构化 notes 并直接用于当前音频分析。</p>
        </div>
      </div>

      <div className="field-grid">
        <label>
          <span>PDF 文件</span>
          <input type="file" accept="application/pdf" onChange={(event) => handlePdfFile(event.target.files?.[0] || null)} />
        </label>
        <label>
          <span>片段标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>片段标识</span>
          <input value={sectionTitle} onChange={(event) => setSectionTitle(event.target.value)} />
        </label>
        <label>
          <span>速度</span>
          <input type="number" min="30" max="220" value={tempo} onChange={(event) => setTempo(event.target.value)} />
        </label>
        <label>
          <span>拍号</span>
          <input value={meter} onChange={(event) => setMeter(event.target.value)} />
        </label>
        <label>
          <span>PDF 页码</span>
          <input
            type="number"
            min="1"
            max={pageCount || 1}
            value={pageNumber}
            onChange={(event) => setPageNumber(Math.max(1, Math.min(pageCount || 1, safeNumber(event.target.value, 1))))}
            disabled={!pageCount}
          />
        </label>
      </div>

      <div className="upload-meta">
        <span>{`PDF：${pdfFileName || "尚未选择 PDF"}`}</span>
        <span>{`总页数：${pageCount || 0}`}</span>
        <span>{`当前页：${pageCount ? `${pageNumber} / ${pageCount}` : "—"}`}</span>
        <span>{`乐谱摘要：${summary.noteCount} 个音符 / ${summary.measureCount} 小节`}</span>
      </div>

      {previewError ? <div className="error-banner">{previewError}</div> : null}
      <div className="status-banner">{helperMessage}</div>

      <div className="pdf-helper-grid">
        <div className="pdf-preview-panel">
          <div className="toolbar">
            <h3>PDF 页面预览</h3>
            <div className="tab-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPageNumber((prev) => Math.max(1, prev - 1))}
                disabled={!pageCount || pageNumber <= 1}
              >
                上一页
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPageNumber((prev) => Math.min(pageCount || 1, prev + 1))}
                disabled={!pageCount || pageNumber >= pageCount}
              >
                下一页
              </button>
            </div>
          </div>
          {pageCount ? <canvas ref={canvasRef} className="pdf-preview-canvas" /> : <p>选择 PDF 后将在这里显示页面。</p>}
        </div>

        <div className="pdf-note-editor">
          <div className="toolbar">
            <div className="tab-row">
              <button type="button" className="secondary-button" onClick={addBlankRow}>
                新增音符
              </button>
              <button type="button" className="secondary-button" onClick={duplicateLastRow}>
                复制最后一行
              </button>
              <button type="button" className="secondary-button" onClick={loadSectionTemplate}>
                从当前段落复制模板
              </button>
              <button type="button" className="secondary-button" onClick={loadActiveManualPiecePack}>
                回填当前人工乐谱
              </button>
            </div>
            <div className="tab-row">
              <button type="button" className="primary-button" onClick={applyManualPiecePack}>
                应用到当前分析
              </button>
              {activeManualPiecePack ? (
                <button type="button" className="secondary-button" onClick={onClearManualPiecePack}>
                  取消人工乐谱
                </button>
              ) : null}
            </div>
          </div>

          {activeManualPiecePack ? (
            <div className="history-card active-manual-pack">
              <h3>当前已启用的人工乐谱</h3>
              <p>{`${activeManualPiecePack.title} / ${activeManualPiecePack.sectionId} / ${activeManualPiecePack.notes?.length || 0} 个音符`}</p>
            </div>
          ) : null}

          <div className="pdf-note-table-wrap">
            <table className="pdf-note-table">
              <thead>
                <tr>
                  <th>noteId</th>
                  <th>小节</th>
                  <th>拍点</th>
                  <th>时值</th>
                  <th>MIDI</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {noteRows.map((row) => (
                  <tr key={row.rowId}>
                    <td>
                      <input value={row.noteId} onChange={(event) => updateNoteRow(row.rowId, "noteId", event.target.value)} />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        value={row.measureIndex}
                        onChange={(event) => updateNoteRow(row.rowId, "measureIndex", event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.125"
                        min="0"
                        value={row.beatStart}
                        onChange={(event) => updateNoteRow(row.rowId, "beatStart", event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.125"
                        min="0.125"
                        value={row.beatDuration}
                        onChange={(event) => updateNoteRow(row.rowId, "beatDuration", event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="21"
                        max="108"
                        value={row.midiPitch}
                        onChange={(event) => updateNoteRow(row.rowId, "midiPitch", event.target.value)}
                      />
                    </td>
                    <td>
                      <button type="button" className="text-button" onClick={() => removeRow(row.rowId)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="notes-field">
            <span>结构化乐谱预览</span>
            <textarea rows={10} readOnly value={JSON.stringify(piecePackPreview, null, 2)} />
          </label>
        </div>
      </div>
    </section>
  );
}
