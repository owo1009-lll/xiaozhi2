import {
  EXPERIENCE_QUESTIONS,
  RangeQuestion,
  ScoreBadge,
  SectionTitle,
  SESSION_STAGE_OPTIONS,
  clampScore,
  confidenceText,
  formatDateTime,
  measureIssueLabelText,
  pitchLabelText,
  plusNumber,
  practicePathLabel,
  preprocessModeLabel,
  rhythmLabelText,
  safeNumber,
  severityText,
} from "./ResearchAppSupport.jsx";

export default function ResearchWorkspaceTab({ ctx }) {
  const {
    adjudication,
    adjudicationSaving,
    analysis,
    analysisLoading,
    audioDuration,
    audioFile,
    audioPreviewUrl,
    currentAdjudicationRecord,
    currentValidationRecord,
    experienceNotes,
    experienceScales,
    fileInputRef,
    groupId,
    handleAdjudicationSubmit,
    handleAnalyze,
    handleAudioFile,
    handlePlayDemo,
    handleSaveInterviewNote,
    handleSaveProfile,
    handleSaveQuestionnaire,
    handleSaveSamplingMark,
    handleSaveTaskPlan,
    handleValidationReviewSubmit,
    interviewNote,
    interviewSaving,
    loadAdjudicationIntoForm,
    loadInterviewIntoEditor,
    loadTaskIntoEditor,
    loadValidationReviewIntoForm,
    participantInterviews,
    participantQuestionnaires,
    participantRecord,
    participantTaskPlans,
    participantId,
    pieces,
    preprocessMode,
    profile,
    profileSaving,
    questionnaireSaving,
    recentLogs,
    recording,
    samplingMark,
    samplingSaving,
    selectedAdjudicationAnalysis,
    selectedAdjudicationReviews,
    selectedPendingAdjudication,
    selectedPiece,
    selectedPieceId,
    selectedSection,
    selectedSectionId,
    selectedValidationAnalysis,
    selectedValidationReviews,
    sessionStage,
    setAdjudication,
    setAnalysis,
    setExperienceNotes,
    setExperienceScales,
    setGroupId,
    setInterviewNote,
    setParticipantId,
    setPreprocessMode,
    setProfile,
    setSamplingMark,
    setSelectedPieceId,
    setSelectedSectionId,
    setSessionStage,
    setTaskPlan,
    setValidationReview,
    startRecording,
    stopRecording,
    taskPlan,
    taskPlanSections,
    taskSaving,
    validationReview,
    validationSaving,
  } = ctx;

  return (
        <div className="grid-layout">
          <section className="panel-card">
            <SectionTitle step="01" title="受试编号与档案" description="保存受试分组、背景信息和知情同意状态，作为实验数据入口。" />
            <div className="field-grid">
              <label>
                <span>受试编号</span>
                <input value={participantId} onChange={(event) => setParticipantId(event.target.value)} placeholder="例如 EH-023" />
              </label>
              <label>
                <span>组别</span>
                <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                  <option value="experimental">实验组</option>
                  <option value="control">对照组</option>
                </select>
              </label>
              <label>
                <span>实验阶段</span>
                <select value={sessionStage} onChange={(event) => setSessionStage(event.target.value)}>
                  {SESSION_STAGE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="field-grid">
              <label>
                <span>匿名代号</span>
                <input value={profile.alias} onChange={(event) => setProfile((prev) => ({ ...prev, alias: event.target.value }))} placeholder="例如 P23" />
              </label>
              <label>
                <span>学校 / 机构</span>
                <input value={profile.institution} onChange={(event) => setProfile((prev) => ({ ...prev, institution: event.target.value }))} />
              </label>
              <label>
                <span>专业 / 方向</span>
                <input value={profile.major} onChange={(event) => setProfile((prev) => ({ ...prev, major: event.target.value }))} />
              </label>
              <label>
                <span>年级</span>
                <input value={profile.grade} onChange={(event) => setProfile((prev) => ({ ...prev, grade: event.target.value }))} />
              </label>
              <label>
                <span>学琴年限</span>
                <input
                  type="number"
                  min="0"
                  max="80"
                  value={profile.yearsOfTraining}
                  onChange={(event) => setProfile((prev) => ({ ...prev, yearsOfTraining: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>周练习时长（分钟）</span>
                <input
                  type="number"
                  min="0"
                  max="10080"
                  value={profile.weeklyPracticeMinutes}
                  onChange={(event) => setProfile((prev) => ({ ...prev, weeklyPracticeMinutes: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>设备型号</span>
                <input value={profile.deviceLabel} onChange={(event) => setProfile((prev) => ({ ...prev, deviceLabel: event.target.value }))} />
              </label>
              <div className="checkbox-field">
                <span>知情同意</span>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={profile.consentSigned}
                    onChange={(event) => setProfile((prev) => ({ ...prev, consentSigned: event.target.checked }))}
                  />
                  <span>已确认完成知情同意</span>
                </label>
              </div>
            </div>
            <label className="notes-field">
              <span>研究备注</span>
              <textarea rows="3" value={profile.notes} onChange={(event) => setProfile((prev) => ({ ...prev, notes: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveProfile} disabled={profileSaving}>
                {profileSaving ? "保存中..." : "保存受试档案"}
              </button>
            </div>
            <div className="mini-metrics">
              <div>
                <span>系统前测音准</span>
                <strong>{participantRecord?.pretest?.pitchScore == null ? "未记录" : `${clampScore(participantRecord.pretest.pitchScore)} 分`}</strong>
              </div>
              <div>
                <span>系统后测音准</span>
                <strong>{participantRecord?.posttest?.pitchScore == null ? "未记录" : `${clampScore(participantRecord.posttest.pitchScore)} 分`}</strong>
              </div>
              <div>
                <span>系统音准增益</span>
                <strong>{plusNumber(participantRecord?.pitchGain)}</strong>
              </div>
              <div>
                <span>系统节奏增益</span>
                <strong>{plusNumber(participantRecord?.rhythmGain)}</strong>
              </div>
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="01B" title="访谈抽样标记" description="标记优先访谈样本，记录抽样原因与优先级，便于正式实验阶段开展质性补充。" />
            <div className="field-grid">
              <label className="checkbox-field">
                <span>纳入访谈抽样</span>
                <div className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={samplingMark.selected}
                    onChange={(event) => setSamplingMark((prev) => ({ ...prev, selected: event.target.checked }))}
                  />
                  <span>将当前受试者纳入访谈候选队列</span>
                </div>
              </label>
              <label>
                <span>优先级</span>
                <select value={samplingMark.priority} onChange={(event) => setSamplingMark((prev) => ({ ...prev, priority: event.target.value }))}>
                  <option value="candidate">候选</option>
                  <option value="priority">优先</option>
                  <option value="reserve">备选</option>
                  <option value="completed">已访谈</option>
                </select>
              </label>
              <label>
                <span>标记人</span>
                <input value={samplingMark.markedBy} onChange={(event) => setSamplingMark((prev) => ({ ...prev, markedBy: event.target.value }))} />
              </label>
            </div>
            <label className="notes-field">
              <span>抽样原因</span>
              <textarea rows="3" value={samplingMark.reason} onChange={(event) => setSamplingMark((prev) => ({ ...prev, reason: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveSamplingMark} disabled={samplingSaving}>
                {samplingSaving ? "保存中..." : "保存抽样标记"}
              </button>
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="02" title="曲目与任务选择" description="统一调用结构化曲目包，供前端、Node 网关和 Python 分析服务复用。" />
            <div className="field-grid">
              <label>
                <span>研究曲目</span>
                <select
                  value={selectedPieceId}
                  onChange={(event) => {
                    const piece = pieces.find((item) => item.pieceId === event.target.value);
                    setSelectedPieceId(event.target.value);
                    setSelectedSectionId(piece?.sections?.[0]?.sectionId || "");
                  }}
                >
                  {pieces.map((piece) => (
                    <option key={piece.pieceId} value={piece.pieceId}>
                      {piece.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>练习段落</span>
                <select value={selectedSectionId} onChange={(event) => setSelectedSectionId(event.target.value)}>
                  {(selectedPiece?.sections || []).map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {selectedPiece ? (
              <div className="piece-summary">
                <h3>{selectedPiece.title}</h3>
                <p>难度：{selectedPiece.difficulty}</p>
                <p>目标技能：{(selectedPiece.targetSkills || []).join(" / ")}</p>
                {selectedSection ? (
                  <div className="section-meta">
                    <span>段落：{selectedSection.title}</span>
                    <span>速度：♩={selectedSection.tempo}</span>
                    <span>拍号：{selectedSection.meter}</span>
                    <span>音符数：{selectedSection.noteCount}</span>
                    <span>小节数：{selectedSection.measureCount}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="panel-card">
            <SectionTitle step="03" title="录音 / 上传" description="支持手机端录音与文件上传，所有反馈默认基于录制后分析。" />
            <div className="action-row">
              <button type="button" className="primary-button" onClick={recording ? stopRecording : startRecording}>
                {recording ? "结束录音" : "开始录音"}
              </button>
              <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                上传音频
              </button>
              <button type="button" className="secondary-button" onClick={handleAnalyze} disabled={analysisLoading}>
                {analysisLoading ? "分析中..." : "开始分析"}
              </button>
            </div>
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              accept="audio/*"
              onChange={(event) => handleAudioFile(event.target.files?.[0] || null)}
            />
            <div className="upload-meta">
              <span>文件：{audioFile?.name || "尚未选择音频"}</span>
              <span>时长：{audioDuration == null ? "待解析" : `${audioDuration.toFixed(1)} 秒`}</span>
              <span>大小：{audioFile ? `${(audioFile.size / 1024 / 1024).toFixed(2)} MB` : "0 MB"}</span>
            </div>
            <div className="field-grid">
              <label>
                <span>混合音频预处理</span>
                <select value={preprocessMode} onChange={(event) => setPreprocessMode(event.target.value)}>
                  <option value="off">关闭，适合纯二胡录音</option>
                  <option value="melody-focus">启用伴奏抑制 / 旋律增强，适合带伴奏或合奏音频</option>
                </select>
              </label>
            </div>
            {audioPreviewUrl ? (
              <audio controls className="audio-player" src={audioPreviewUrl}>
                当前浏览器不支持音频预览。
              </audio>
            ) : null}
          </section>

          <section className="panel-card">
            <SectionTitle step="04" title="分析结果" description="结果聚焦问题小节、问题音、偏差方向和示范回放，不追求商用级复杂评分。" />
            {analysis ? (
              <>
                <div className="result-grid">
                  <ScoreBadge label="总音准" value={analysis.overallPitchScore} accent="#0f766e" />
                  <ScoreBadge label="总节奏" value={analysis.overallRhythmScore} accent="#b45309" />
                  <ScoreBadge label="置信度" value={safeNumber((analysis.confidence || 0) * 100)} accent="#4338ca" suffix="%" />
                  <ScoreBadge label="分析模式" value={analysis.analysisMode === "external" ? 100 : 60} accent="#7c3aed" suffix="%" />
                </div>
                {(analysis.summaryText || analysis.teacherComment || (analysis.practiceTargets || []).length) ? (
                  <div className="summary-grid">
                    <div className="history-card">
                      <h3>整体判断</h3>
                      <p>{analysis.summaryText || "当前已生成结果，但整体说明尚未形成。"}</p>
                      {analysis.teacherComment ? <p className="supporting-copy">{analysis.teacherComment}</p> : null}
                      {analysis.recommendedPracticePath ? (
                        <p className="supporting-copy">{`推荐练习路径：${practicePathLabel(analysis.recommendedPracticePath)}`}</p>
                      ) : null}
                    </div>
                    <div className="history-card">
                      <h3>优先练习顺序</h3>
                      {(analysis.practiceTargets || []).length ? (
                        <ol className="compact-list practice-list">
                          {analysis.practiceTargets.map((target) => (
                            <li key={`${target.targetType}-${target.targetId || target.measureIndex || target.priority}`}>
                              <strong>{target.title}</strong>
                              <span className="practice-meta">{`${severityText(target.severity)} · ${practicePathLabel(target.practicePath)} · ${target.evidenceLabel || "系统建议"}`}</span>
                              <span>{target.why}</span>
                              {target.pathReason ? <span>{target.pathReason}</span> : null}
                              <span>{target.action}</span>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p>当前没有形成明确的优先练习顺序。</p>
                      )}
                    </div>
                  </div>
                ) : null}
                <div className="findings-grid">
                  <div className="finding-card">
                    <h3>问题小节</h3>
                    {(analysis.measureFindings || []).length ? (
                      <ul>
                        {analysis.measureFindings.map((item) => (
                          <li key={`${item.measureIndex}-${item.issueType}`}>
                            <strong>第 {item.measureIndex} 小节：</strong>
                            {measureIssueLabelText(item)}
                            {item.severity ? ` · ${severityText(item.severity)}` : ""}
                            {item.detail ? ` (${item.detail})` : ""}
                            {item.coachingTip ? <span className="finding-help">{`建议：${item.coachingTip}`}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>当前没有定位到显著的小节级问题。</p>
                    )}
                  </div>
                  <div className="finding-card">
                    <h3>问题音</h3>
                    {(analysis.noteFindings || []).length ? (
                      <ul>
                        {analysis.noteFindings.map((item) => (
                          <li key={item.noteId}>
                            <strong>{item.noteId}</strong>
                            {`，第 ${item.measureIndex} 小节，${pitchLabelText(item.pitchLabel)}，${rhythmLabelText(item)}`}
                            {item.severity ? ` · ${severityText(item.severity)}` : ""}
                            {item.evidenceLabel ? <span className="finding-help">{`证据：${item.evidenceLabel}`}</span> : null}
                            {item.confidence != null ? <span className="finding-help">{`置信度：${confidenceText(item.confidence)}`}</span> : null}
                            {item.durationErrorMs != null && Math.abs(safeNumber(item.durationErrorMs)) > 0 ? (
                              <span className="finding-help">{`时值偏差：${item.durationErrorMs > 0 ? "+" : ""}${item.durationErrorMs} ms`}</span>
                            ) : null}
                            {item.why ? <span className="finding-help">{`原因：${item.why}`}</span> : null}
                            {item.action ? <span className="finding-help">{`怎么练：${item.action}`}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>当前没有定位到问题音。</p>
                    )}
                  </div>
                </div>
                <div className="history-card">
                  <h3>教师标注验证</h3>
                  {selectedValidationReviews.length ? (
                    <div className="demo-note-list">
                      {selectedValidationReviews.map((item) => (
                        <button key={item.reviewId} type="button" className="secondary-button" onClick={() => loadValidationReviewIntoForm(item)}>
                          {`${item.raterId} · ${item.overallAgreement}/5 · ${item.pathAgreement ? "路径一致" : "路径不一致"}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="field-grid">
                    <label>
                      <span>分析记录</span>
                      <select value={validationReview.analysisId} onChange={(event) => setValidationReview((prev) => ({ ...prev, analysisId: event.target.value }))}>
                        <option value="">请选择分析记录</option>
                        {participantAnalyses.map((item) => (
                          <option key={item.analysisId} value={item.analysisId}>
                            {`${item.sessionStage} · ${item.pieceId}/${item.sectionId} · ${formatDateTime(item.createdAt)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>教师编号</span>
                      <input value={validationReview.raterId} onChange={(event) => setValidationReview((prev) => ({ ...prev, raterId: event.target.value }))} />
                    </label>
                    <label>
                      <span>整体一致性</span>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        value={validationReview.overallAgreement}
                        onChange={(event) => setValidationReview((prev) => ({ ...prev, overallAgreement: Number(event.target.value) }))}
                      />
                    </label>
                    <label>
                      <span>教师首要路径</span>
                      <select value={validationReview.teacherPrimaryPath} onChange={(event) => setValidationReview((prev) => ({ ...prev, teacherPrimaryPath: event.target.value }))}>
                        <option value="pitch-first">先修音准</option>
                        <option value="rhythm-first">先修节奏</option>
                        <option value="review-first">先复核</option>
                      </select>
                    </label>
                  </div>
                  {selectedValidationAnalysis ? (
                    <div className="demo-note-list">
                      <span>{`系统路径：${practicePathLabel(selectedValidationAnalysis.recommendedPracticePath || selectedValidationAnalysis.practiceTargets?.[0]?.practicePath)}`}</span>
                      <span>{`系统问题音：${(selectedValidationAnalysis.noteFindings || []).map((item) => item.noteId).join(" / ") || "无"}`}</span>
                      <span>{`系统问题小节：${(selectedValidationAnalysis.measureFindings || []).map((item) => `M${item.measureIndex}`).join(" / ") || "无"}`}</span>
                    </div>
                  ) : null}
                  <div className="field-grid">
                    <label>
                      <span>教师问题音</span>
                      <input
                        value={validationReview.teacherIssueNoteIds}
                        onChange={(event) => setValidationReview((prev) => ({ ...prev, teacherIssueNoteIds: event.target.value }))}
                        placeholder="例如 a-m1-n2, a-m2-n1"
                      />
                    </label>
                    <label>
                      <span>教师问题小节</span>
                      <input
                        value={validationReview.teacherIssueMeasureIndexes}
                        onChange={(event) => setValidationReview((prev) => ({ ...prev, teacherIssueMeasureIndexes: event.target.value }))}
                        placeholder="例如 1,2,4"
                      />
                    </label>
                  </div>
                  <label className="notes-field">
                    <span>教师验证备注</span>
                    <textarea rows="3" value={validationReview.comments} onChange={(event) => setValidationReview((prev) => ({ ...prev, comments: event.target.value }))} />
                  </label>
                  {currentValidationRecord ? (
                    <div className="demo-note-list">
                      <span>{`当前教师：${currentValidationRecord.raterId || "teacher"}`}</span>
                      <span>{`路径一致：${currentValidationRecord.pathAgreement ? "是" : "否"}`}</span>
                      <span>{`音符 Precision/Recall/F1：${currentValidationRecord.notePrecision == null ? "—" : currentValidationRecord.notePrecision.toFixed(3)} / ${currentValidationRecord.noteRecall == null ? "—" : currentValidationRecord.noteRecall.toFixed(3)} / ${currentValidationRecord.noteF1 == null ? "—" : currentValidationRecord.noteF1.toFixed(3)}`}</span>
                      <span>{`小节 Precision/Recall/F1：${currentValidationRecord.measurePrecision == null ? "—" : currentValidationRecord.measurePrecision.toFixed(3)} / ${currentValidationRecord.measureRecall == null ? "—" : currentValidationRecord.measureRecall.toFixed(3)} / ${currentValidationRecord.measureF1 == null ? "—" : currentValidationRecord.measureF1.toFixed(3)}`}</span>
                      <span>{`教师漏标：${(currentValidationRecord.missedTeacherNoteIds || []).join(" / ") || "无"}`}</span>
                      <span>{`系统多报：${(currentValidationRecord.extraSystemNoteIds || []).join(" / ") || "无"}`}</span>
                    </div>
                  ) : null}
                  <div className="action-row">
                    <button type="button" className="primary-button" onClick={handleValidationReviewSubmit} disabled={validationSaving}>
                      {validationSaving ? "保存中..." : "保存教师标注验证"}
                    </button>
                  </div>
                </div>
                <div className="history-card">
                  <h3>最终裁决</h3>
                  {participantAdjudications.length ? (
                    <div className="demo-note-list">
                      {participantAdjudications.map((item) => (
                        <button key={item.adjudicationId} type="button" className="secondary-button" onClick={() => loadAdjudicationIntoForm(item)}>
                          {`${item.analysisId} · ${practicePathLabel(item.finalPrimaryPath)} · ${item.pathAgreement ? "系统一致" : "系统不一致"}`}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="field-grid">
                    <label>
                      <span>裁决分析记录</span>
                      <select value={adjudication.analysisId} onChange={(event) => setAdjudication((prev) => ({ ...prev, analysisId: event.target.value }))}>
                        <option value="">请选择裁决记录</option>
                        {fullyValidatedAnalyses.map((item) => (
                          <option key={item.analysisId} value={item.analysisId}>
                            {`${item.sessionStage} · ${item.pieceId}/${item.sectionId} · ${formatDateTime(item.createdAt)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>裁决者编号</span>
                      <input value={adjudication.adjudicatorId} onChange={(event) => setAdjudication((prev) => ({ ...prev, adjudicatorId: event.target.value }))} />
                    </label>
                    <label>
                      <span>最终首要路径</span>
                      <select value={adjudication.finalPrimaryPath} onChange={(event) => setAdjudication((prev) => ({ ...prev, finalPrimaryPath: event.target.value }))}>
                        <option value="pitch-first">先修音准</option>
                        <option value="rhythm-first">先修节奏</option>
                        <option value="review-first">先复核</option>
                      </select>
                    </label>
                  </div>
                  {selectedAdjudicationAnalysis ? (
                    <div className="demo-note-list">
                      <span>{`系统路径：${practicePathLabel(selectedAdjudicationAnalysis.recommendedPracticePath || selectedAdjudicationAnalysis.practiceTargets?.[0]?.practicePath)}`}</span>
                      <span>{`教师 A：${selectedAdjudicationReviews[0]?.raterId || "—"} · ${practicePathLabel(selectedAdjudicationReviews[0]?.teacherPrimaryPath)}`}</span>
                      <span>{`教师 B：${selectedAdjudicationReviews[1]?.raterId || "—"} · ${practicePathLabel(selectedAdjudicationReviews[1]?.teacherPrimaryPath)}`}</span>
                      <span>{`裁决状态：${currentAdjudicationRecord ? "已裁决" : selectedPendingAdjudication ? "待裁决" : "可手动裁决"}`}</span>
                    </div>
                  ) : null}
                  {selectedPendingAdjudication ? (
                    <div className="demo-note-list">
                      <span>{`触发原因：${selectedPendingAdjudication.adjudicationReason || "manual-review"}`}</span>
                      <span>{`路径一致：${selectedPendingAdjudication.pathMatch ? "是" : "否"}`}</span>
                      <span>{`音符重叠 F1：${selectedPendingAdjudication.noteOverlapF1 == null ? "—" : selectedPendingAdjudication.noteOverlapF1.toFixed(3)}`}</span>
                      <span>{`小节重叠 F1：${selectedPendingAdjudication.measureOverlapF1 == null ? "—" : selectedPendingAdjudication.measureOverlapF1.toFixed(3)}`}</span>
                    </div>
                  ) : null}
                  <div className="field-grid">
                    <label>
                      <span>最终问题音</span>
                      <input
                        value={adjudication.finalIssueNoteIds}
                        onChange={(event) => setAdjudication((prev) => ({ ...prev, finalIssueNoteIds: event.target.value }))}
                        placeholder="例如 a-m1-n2, a-m2-n1"
                      />
                    </label>
                    <label>
                      <span>最终问题小节</span>
                      <input
                        value={adjudication.finalIssueMeasureIndexes}
                        onChange={(event) => setAdjudication((prev) => ({ ...prev, finalIssueMeasureIndexes: event.target.value }))}
                        placeholder="例如 1,2,4"
                      />
                    </label>
                  </div>
                  <label className="notes-field">
                    <span>裁决原因</span>
                    <textarea rows="2" value={adjudication.triggerReasons} onChange={(event) => setAdjudication((prev) => ({ ...prev, triggerReasons: event.target.value }))} />
                  </label>
                  <label className="notes-field">
                    <span>裁决备注</span>
                    <textarea rows="3" value={adjudication.comments} onChange={(event) => setAdjudication((prev) => ({ ...prev, comments: event.target.value }))} />
                  </label>
                  {currentAdjudicationRecord ? (
                    <div className="demo-note-list">
                      <span>{`当前裁决者：${currentAdjudicationRecord.adjudicatorId || "researcher"}`}</span>
                      <span>{`路径一致：${currentAdjudicationRecord.pathAgreement ? "是" : "否"}`}</span>
                      <span>{`音符 Precision/Recall/F1：${currentAdjudicationRecord.notePrecision == null ? "—" : currentAdjudicationRecord.notePrecision.toFixed(3)} / ${currentAdjudicationRecord.noteRecall == null ? "—" : currentAdjudicationRecord.noteRecall.toFixed(3)} / ${currentAdjudicationRecord.noteF1 == null ? "—" : currentAdjudicationRecord.noteF1.toFixed(3)}`}</span>
                      <span>{`小节 Precision/Recall/F1：${currentAdjudicationRecord.measurePrecision == null ? "—" : currentAdjudicationRecord.measurePrecision.toFixed(3)} / ${currentAdjudicationRecord.measureRecall == null ? "—" : currentAdjudicationRecord.measureRecall.toFixed(3)} / ${currentAdjudicationRecord.measureF1 == null ? "—" : currentAdjudicationRecord.measureF1.toFixed(3)}`}</span>
                    </div>
                  ) : null}
                  <div className="action-row">
                    <button type="button" className="primary-button" onClick={handleAdjudicationSubmit} disabled={adjudicationSaving}>
                      {adjudicationSaving ? "保存中..." : "保存最终裁决"}
                    </button>
                  </div>
                </div>
                {analysis.diagnostics ? (
                  <div className="history-card">
                    <h3>分析诊断</h3>
                    <div className="demo-note-list">
                      <span>依赖数：{Object.values(analysis.diagnostics.dependencyReport || {}).filter(Boolean).length}</span>
                      <span>音频字节：{analysis.diagnostics.decodedAudioBytes ?? 0}</span>
                      <span>对齐音符：{analysis.diagnostics.alignedNoteCount ?? 0}</span>
                      <span>{`预处理：${preprocessModeLabel(analysis.diagnostics.appliedPreprocessMode || analysis.diagnostics.requestedPreprocessMode)}`}</span>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="empty-card">尚未生成诊断结果。完成录音或上传后，点击“开始分析”。</div>
            )}
          </section>

          <section className="panel-card">
            <SectionTitle step="05" title="标准示范与重练" description="默认播放结构化标准音符序列，方便演奏者对照错误位置立即重练。" />
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handlePlayDemo} disabled={!selectedSection}>
                播放标准示范
              </button>
              <button type="button" className="secondary-button" onClick={() => setAnalysis(null)}>
                清空本轮结果
              </button>
            </div>
            <div className="demo-note-list">
              {(selectedSection?.notes || []).slice(0, 12).map((note) => (
                <span key={note.noteId}>
                  {note.noteId} · M{note.measureIndex} · MIDI {note.midiPitch}
                </span>
              ))}
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="06" title="周任务计划" description="为每位受试者分配周次任务、练习重点和截止时间，支撑 6-8 周任务化练习设计。" />
            <div className="field-grid">
              <label>
                <span>任务阶段</span>
                <select value={taskPlan.stage} onChange={(event) => setTaskPlan((prev) => ({ ...prev, stage: event.target.value }))}>
                  {SESSION_STAGE_OPTIONS.filter((item) => item.value.startsWith("week") || item.value === "pretest" || item.value === "posttest").map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>曲目</span>
                <select
                  value={taskPlan.pieceId || selectedPieceId}
                  onChange={(event) =>
                    setTaskPlan((prev) => ({
                      ...prev,
                      pieceId: event.target.value,
                      sectionId: pieces.find((piece) => piece.pieceId === event.target.value)?.sections?.[0]?.sectionId || "",
                    }))
                  }
                >
                  {pieces.map((piece) => (
                    <option key={piece.pieceId} value={piece.pieceId}>
                      {piece.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>段落</span>
                <select value={taskPlan.sectionId || selectedSectionId} onChange={(event) => setTaskPlan((prev) => ({ ...prev, sectionId: event.target.value }))}>
                  {taskPlanSections.map((section) => (
                    <option key={section.sectionId} value={section.sectionId}>
                      {section.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>目标分钟数</span>
                <input
                  type="number"
                  min="0"
                  max="600"
                  value={taskPlan.practiceTargetMinutes}
                  onChange={(event) => setTaskPlan((prev) => ({ ...prev, practiceTargetMinutes: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>截止日期</span>
                <input type="date" value={taskPlan.dueDate} onChange={(event) => setTaskPlan((prev) => ({ ...prev, dueDate: event.target.value }))} />
              </label>
              <label>
                <span>任务状态</span>
                <select value={taskPlan.status} onChange={(event) => setTaskPlan((prev) => ({ ...prev, status: event.target.value }))}>
                  <option value="assigned">已分配</option>
                  <option value="in-progress">进行中</option>
                  <option value="completed">已完成</option>
                </select>
              </label>
              <label>
                <span>指派人</span>
                <input value={taskPlan.assignedBy} onChange={(event) => setTaskPlan((prev) => ({ ...prev, assignedBy: event.target.value }))} />
              </label>
            </div>
            <label className="notes-field">
              <span>训练重点</span>
              <textarea rows="3" value={taskPlan.focus} onChange={(event) => setTaskPlan((prev) => ({ ...prev, focus: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>教师/研究者指令</span>
              <textarea rows="4" value={taskPlan.instructions} onChange={(event) => setTaskPlan((prev) => ({ ...prev, instructions: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveTaskPlan} disabled={taskSaving}>
                {taskSaving ? "保存中..." : "保存周任务"}
              </button>
            </div>
            <div className="queue-list">
              {participantTaskPlans.length ? (
                participantTaskPlans.map((item) => (
                  <div key={item.taskId || `${item.stage}-${item.updatedAt}`} className="queue-item">
                    <div>
                      <strong>{item.stage}</strong>
                      <p>
                        {item.pieceId}/{item.sectionId} · {item.status} · {item.practiceTargetMinutes} 分钟 · 截止 {item.dueDate || "未设置"}
                      </p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadTaskIntoEditor(item)}>
                      载入任务
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-card">当前还没有该受试者的周任务计划。</div>
              )}
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="07" title="访谈记录" description="记录半结构访谈摘要、学习障碍、策略变化和后续跟进建议，支撑体验与机制解释。" />
            <div className="field-grid">
              <label>
                <span>访谈阶段</span>
                <select value={interviewNote.stage} onChange={(event) => setInterviewNote((prev) => ({ ...prev, stage: event.target.value }))}>
                  {SESSION_STAGE_OPTIONS.filter((item) => item.value.startsWith("week") || item.value === "pretest" || item.value === "posttest").map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>访谈人</span>
                <input value={interviewNote.interviewerId} onChange={(event) => setInterviewNote((prev) => ({ ...prev, interviewerId: event.target.value }))} />
              </label>
              <label className="checkbox-field">
                <span>需要后续跟进</span>
                <div className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={interviewNote.followUpNeeded}
                    onChange={(event) => setInterviewNote((prev) => ({ ...prev, followUpNeeded: event.target.checked }))}
                  />
                  <span>标记为后续追访样本</span>
                </div>
              </label>
            </div>
            <label className="notes-field">
              <span>访谈摘要</span>
              <textarea rows="3" value={interviewNote.summary} onChange={(event) => setInterviewNote((prev) => ({ ...prev, summary: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>主要障碍</span>
              <textarea rows="3" value={interviewNote.barriers} onChange={(event) => setInterviewNote((prev) => ({ ...prev, barriers: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>练习策略变化</span>
              <textarea rows="3" value={interviewNote.strategyChanges} onChange={(event) => setInterviewNote((prev) => ({ ...prev, strategyChanges: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>代表性引语</span>
              <textarea rows="2" value={interviewNote.representativeQuote} onChange={(event) => setInterviewNote((prev) => ({ ...prev, representativeQuote: event.target.value }))} />
            </label>
            <label className="notes-field">
              <span>后续建议</span>
              <textarea rows="2" value={interviewNote.nextAction} onChange={(event) => setInterviewNote((prev) => ({ ...prev, nextAction: event.target.value }))} />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveInterviewNote} disabled={interviewSaving}>
                {interviewSaving ? "保存中..." : "保存访谈记录"}
              </button>
            </div>
            <div className="queue-list">
              {participantInterviews.length ? (
                participantInterviews.map((item) => (
                  <div key={item.interviewId || `${item.stage}-${item.submittedAt}`} className="queue-item">
                    <div>
                      <strong>{item.stage}</strong>
                      <p>
                        {item.interviewerId} · {item.followUpNeeded ? "需要跟进" : "常规记录"} · {formatDateTime(item.submittedAt)}
                      </p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadInterviewIntoEditor(item)}>
                      载入记录
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-card">当前还没有该受试者的访谈记录。</div>
              )}
            </div>
          </section>

          <section className="panel-card">
            <SectionTitle step="08" title="问卷与使用日志" description="按阶段保存学习体验问卷，并保留最近分析记录，服务于研究统计与访谈抽样。" />
            <div className="question-grid">
              {EXPERIENCE_QUESTIONS.map((item) => (
                <RangeQuestion
                  key={item.key}
                  label={item.label}
                  value={experienceScales[item.key]}
                  onChange={(value) => setExperienceScales((prev) => ({ ...prev, [item.key]: value }))}
                />
              ))}
            </div>
            <label className="notes-field">
              <span>开放性反馈</span>
              <textarea
                rows="4"
                value={experienceNotes}
                onChange={(event) => setExperienceNotes(event.target.value)}
                placeholder="记录本轮练习的困难、AI 反馈是否清晰，以及是否愿意继续使用。"
              />
            </label>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={handleSaveQuestionnaire} disabled={questionnaireSaving}>
                {questionnaireSaving ? "保存中..." : "保存学习体验"}
              </button>
            </div>
            <div className="history-columns">
              <div className="history-card">
                <h3>最近使用日志</h3>
                {recentLogs.length ? (
                  <ul className="compact-list">
                    {recentLogs.map((item) => (
                      <li key={item.analysisId || item.at}>
                        <strong>{item.sessionStage}</strong>
                        {` · ${item.pieceId}/${item.sectionId} · 音准 ${clampScore(item.overallPitchScore)} · 节奏 ${clampScore(item.overallRhythmScore)} · ${formatDateTime(item.at)}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>当前还没有使用日志。</p>
                )}
              </div>
              <div className="history-card">
                <h3>阶段问卷记录</h3>
                {participantQuestionnaires.length ? (
                  <ul className="compact-list">
                    {participantQuestionnaires.map((item) => (
                      <li key={item.questionnaireId || `${item.sessionStage}-${item.submittedAt}`}>
                        <strong>{item.sessionStage}</strong>
                        {` · 有用性 ${item.usefulness} · 持续使用 ${item.continuance} · ${formatDateTime(item.submittedAt)}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>当前还没有问卷记录。</p>
                )}
              </div>
            </div>
          </section>
        </div>
  );
}
