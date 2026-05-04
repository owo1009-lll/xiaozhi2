import PdfScoreHelper from "../PdfScoreHelper";
import {
  ExportLink,
  GroupOverviewCard,
  ScoreBadge,
  SectionTitle,
  formatDateTime,
  plusNumber,
  practicePathLabel,
} from "./ResearchAppSupport.jsx";

export default function ResearchDashboardTab({
  dashboardLoading,
  researchOverview,
  analyzerStatus,
  groupSummaries,
  expertRating,
  setExpertRating,
  handleExpertRatingSubmit,
  expertSaving,
  loadDashboardData,
  batchImportText,
  setBatchImportText,
  handleBatchImport,
  batchImporting,
  pendingRatings,
  loadPendingRating,
  validationSummary,
  setParticipantId,
  setValidationReview,
  setActiveTab,
  setStatusMessage,
  selectedPiece,
  selectedSection,
  manualPiecePack,
  setManualPiecePack,
  adjudicationSummary,
  setAdjudication,
  dataQuality,
  loadParticipantWorkspace,
  researchParticipants,
  latestQuestionnaires,
  latestValidationReviews,
  latestAdjudications,
  latestRatings,
  latestTasks,
  latestInterviews,
}) {
  return (
    <div className="dashboard-layout">
      <section className="panel-card">
        <SectionTitle step="R1" title="研究总览" description="查看样本规模、问卷条目、教师评分待办和分析器连通状态。" />
        {dashboardLoading ? (
          <div className="empty-card">正在加载研究数据...</div>
        ) : researchOverview ? (
          <>
            <div className="result-grid">
              <ScoreBadge label="参与者" value={researchOverview.participantCount} accent="#1d4ed8" />
              <ScoreBadge label="分析记录" value={researchOverview.analysisCount} accent="#0f766e" />
              <ScoreBadge label="档案完成" value={researchOverview.profileCompletedCount} accent="#0f766e" />
              <ScoreBadge label="问卷参与者" value={researchOverview.questionnaireCount} accent="#b45309" />
            </div>
            <div className="result-grid">
              <ScoreBadge label="问卷条目" value={researchOverview.questionnaireEntryCount} accent="#7c3aed" />
              <ScoreBadge label="任务计划" value={researchOverview.taskPlanCount} accent="#1d4ed8" />
              <ScoreBadge label="已完成任务" value={researchOverview.completedTaskCount} accent="#0f766e" />
              <ScoreBadge label="访谈记录" value={researchOverview.interviewCount} accent="#7c3aed" />
            </div>
            <div className="result-grid">
              <ScoreBadge label="配对完成" value={researchOverview.completedPairCount} accent="#7c3aed" />
              <ScoreBadge label="平均音准增益" value={researchOverview.averagePitchGain} accent="#0f766e" />
              <ScoreBadge label="平均节奏增益" value={researchOverview.averageRhythmGain} accent="#b45309" />
            </div>
            <div className="result-grid">
              <ScoreBadge label="平均有用性" value={researchOverview.averageUsefulness * 20} accent="#7c3aed" suffix="%" />
              <ScoreBadge label="平均持续使用" value={researchOverview.averageContinuance * 20} accent="#1d4ed8" suffix="%" />
              <ScoreBadge label="教师后测评分" value={researchOverview.expertRatedCount} accent="#7c3aed" />
              <ScoreBadge label="分析器连通" value={analyzerStatus?.reachable ? 100 : 0} accent="#4338ca" suffix="%" />
            </div>
            <div className="result-grid">
              <ScoreBadge label="验证条目" value={researchOverview.validationReviewCount} accent="#1d4ed8" />
              <ScoreBadge label="平均一致性" value={(researchOverview.averageValidationAgreement || 0) * 20} accent="#0f766e" suffix="%" />
              <ScoreBadge label="音符 F1" value={(researchOverview.averageValidationNoteF1 || 0) * 100} accent="#b45309" suffix="%" />
              <ScoreBadge label="路径一致率" value={(researchOverview.validationPathAgreementRate || 0) * 100} accent="#7c3aed" suffix="%" />
            </div>
            <div className="result-grid">
              <ScoreBadge label="待裁决" value={researchOverview.adjudicationPendingCount} accent="#b45309" />
              <ScoreBadge label="已裁决" value={researchOverview.adjudicationResolvedCount} accent="#0f766e" />
              <ScoreBadge label="裁决后音符 F1" value={(researchOverview.averageAdjudicationNoteF1 || 0) * 100} accent="#1d4ed8" suffix="%" />
              <ScoreBadge label="裁决路径一致率" value={(researchOverview.adjudicationPathAgreementRate || 0) * 100} accent="#7c3aed" suffix="%" />
            </div>
            <div className="summary-grid">
              {groupSummaries.map((group) => (
                <GroupOverviewCard key={group.groupId} group={group} />
              ))}
            </div>
            <div className="history-card">
              <h3>分析器状态</h3>
              <div className="demo-note-list">
                <span>模式：{analyzerStatus?.mode || "fallback-only"}</span>
                <span>已配置：{analyzerStatus?.configured ? "是" : "否"}</span>
                <span>可访问：{analyzerStatus?.reachable ? "是" : "否"}</span>
                <span>服务地址：{analyzerStatus?.serviceUrl || "未配置"}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-card">研究总览尚未形成。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R2" title="教师评分与数据导出" description="支持前测/后测或阶段评分录入，并导出参与者、问卷、评分和分析记录。" />
        <div className="field-grid">
          <label>
            <span>受试编号</span>
            <input value={expertRating.participantId} onChange={(event) => setExpertRating((prev) => ({ ...prev, participantId: event.target.value }))} placeholder="例如 EH-023" />
          </label>
          <label>
            <span>评分阶段</span>
            <select value={expertRating.stage} onChange={(event) => setExpertRating((prev) => ({ ...prev, stage: event.target.value }))}>
              <option value="pretest">前测</option>
              <option value="week4">阶段测量</option>
              <option value="posttest">后测</option>
            </select>
          </label>
          <label>
            <span>评分教师</span>
            <input value={expertRating.raterId} onChange={(event) => setExpertRating((prev) => ({ ...prev, raterId: event.target.value }))} />
          </label>
          <label>
            <span>音准评分</span>
            <input type="number" min="0" max="100" value={expertRating.pitchScore} onChange={(event) => setExpertRating((prev) => ({ ...prev, pitchScore: Number(event.target.value) }))} />
          </label>
          <label>
            <span>节奏评分</span>
            <input type="number" min="0" max="100" value={expertRating.rhythmScore} onChange={(event) => setExpertRating((prev) => ({ ...prev, rhythmScore: Number(event.target.value) }))} />
          </label>
        </div>
        <label className="notes-field">
          <span>评分备注</span>
          <textarea rows="4" value={expertRating.comments} onChange={(event) => setExpertRating((prev) => ({ ...prev, comments: event.target.value }))} />
        </label>
        <div className="action-row">
          <button type="button" className="primary-button" onClick={handleExpertRatingSubmit} disabled={expertSaving}>
            {expertSaving ? "保存中..." : "保存教师评分"}
          </button>
          <button type="button" className="secondary-button" onClick={loadDashboardData}>
            刷新研究数据
          </button>
        </div>
        <div className="link-row">
          <ExportLink dataset="participants" format="csv">导出参与者 CSV</ExportLink>
          <ExportLink dataset="sampling" format="csv">导出抽样 CSV</ExportLink>
          <ExportLink dataset="tasks" format="csv">导出任务 CSV</ExportLink>
          <ExportLink dataset="interviews" format="csv">导出访谈 CSV</ExportLink>
          <ExportLink dataset="questionnaires" format="csv">导出问卷 CSV</ExportLink>
          <ExportLink dataset="expert-ratings" format="csv">导出评分 CSV</ExportLink>
          <ExportLink dataset="analyses" format="csv">导出分析 CSV</ExportLink>
          <ExportLink dataset="validation-reviews" format="csv">导出验证 CSV</ExportLink>
          <ExportLink dataset="adjudications" format="csv">导出裁决 CSV</ExportLink>
          <ExportLink dataset="participants" format="json">导出全量 JSON</ExportLink>
        </div>
        <div className="history-card">
          <h3>批量导入参与者</h3>
          <p>每行格式：participantId,groupId,alias,institution,grade</p>
          <label className="notes-field">
            <span>导入文本</span>
            <textarea
              rows="5"
              value={batchImportText}
              onChange={(event) => setBatchImportText(event.target.value)}
              placeholder={"EH-001,experimental,P01,Music University,Year 1\nEH-002,control,P02,Music University,Year 1"}
            />
          </label>
          <div className="action-row">
            <button type="button" className="primary-button" onClick={handleBatchImport} disabled={batchImporting}>
              {batchImporting ? "导入中..." : "批量导入参与者"}
            </button>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <SectionTitle step="R3" title="待评分队列" description="列出已完成前测或后测但尚未录入教师评分的受试者，可一键载入评分表。" />
        {pendingRatings.length ? (
          <div className="queue-list">
            {pendingRatings.map((item) => (
              <div key={`${item.participantId}-${item.pendingStages.join("-")}`} className="queue-item">
                <div>
                  <strong>{item.participantId}</strong>
                  <p>{item.groupId === "experimental" ? "实验组" : "对照组"} · 待评分阶段：{item.pendingStages.join(" / ")}</p>
                </div>
                <button type="button" className="secondary-button" onClick={() => loadPendingRating(item)}>
                  载入评分
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-card">当前没有待评分记录。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R3A" title="待验证分析" description="列出还未完成教师标注验证的分析记录，便于系统输出与教师判断对齐。" />
        {validationSummary?.pendingValidationCount ? (
          <div className="queue-list">
            {(researchOverview?.pendingValidationReviews || []).slice(0, 8).map((item) => (
              <div key={item.analysisId} className="queue-item">
                <div>
                  <strong>{item.participantId}</strong>
                  <p>{`${item.sessionStage} · ${item.pieceId}/${item.sectionId} · 系统路径 ${practicePathLabel(item.recommendedPracticePath)}`}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setParticipantId(item.participantId);
                    setValidationReview((prev) => ({
                      ...prev,
                      analysisId: item.analysisId,
                      teacherPrimaryPath: item.recommendedPracticePath || "review-first",
                    }));
                    setActiveTab("workspace");
                    setStatusMessage(`已载入 ${item.participantId} 的待验证分析。`);
                  }}
                >
                  打开验证
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-card">当前没有待验证分析。</div>
        )}
      </section>

      <PdfScoreHelper
        defaultPieceId={selectedPiece?.pieceId || "manual-pdf-piece"}
        defaultSectionId={selectedSection?.sectionId || "manual-section"}
        defaultTitle={selectedSection?.title || selectedPiece?.title || ""}
        defaultTempo={selectedSection?.tempo || 72}
        defaultMeter={selectedSection?.meter || "4/4"}
        templateNotes={selectedSection?.notes || []}
        activeManualPiecePack={manualPiecePack}
        onApplyManualPiecePack={(piecePack) => {
          setManualPiecePack(piecePack);
          setStatusMessage(`已启用人工录入乐谱：${piecePack.title}。后续分析会优先使用该乐谱。`);
        }}
        onClearManualPiecePack={() => {
          setManualPiecePack(null);
          setStatusMessage("已恢复使用内置曲目段落进行分析。");
        }}
      />

      <section className="panel-card">
        <SectionTitle step="R3B" title="待裁决分析" description="列出已完成双评且触发裁决规则的分析记录，可直接跳转到工作台完成最终裁决。" />
        {adjudicationSummary?.pendingAdjudicationCount ? (
          <div className="queue-list">
            {(researchOverview?.pendingAdjudications || adjudicationSummary?.pendingAdjudications || []).slice(0, 8).map((item) => (
              <div key={item.analysisId} className="queue-item">
                <div>
                  <strong>{item.participantId}</strong>
                  <p>{`${item.sessionStage} · ${item.pieceId}/${item.sectionId} · ${item.adjudicationReason || "manual-review"}`}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setParticipantId(item.participantId);
                    setAdjudication((prev) => ({
                      ...prev,
                      analysisId: item.analysisId,
                      triggerReasons: item.adjudicationReason || "",
                    }));
                    setActiveTab("workspace");
                    setStatusMessage(`已载入 ${item.participantId} 的待裁决分析。`);
                  }}
                >
                  打开裁决
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-card">当前没有待裁决分析。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R3C" title="缺测提醒与质控" description="汇总缺测、逾期任务和待访谈样本，帮助在正式实验阶段及时补录与跟进。" />
        {dataQuality ? (
          <>
            <div className="result-grid">
              <ScoreBadge label="提醒数" value={dataQuality.reminderCount} accent="#b45309" />
              <ScoreBadge label="缺少档案" value={dataQuality.missingProfileCount} accent="#7c3aed" />
              <ScoreBadge label="缺前测" value={dataQuality.missingPretestCount} accent="#1d4ed8" />
              <ScoreBadge label="缺后测" value={dataQuality.missingPosttestCount} accent="#4338ca" />
            </div>
            <div className="result-grid">
              <ScoreBadge label="逾期任务样本" value={dataQuality.overdueTaskParticipantCount} accent="#b45309" />
              <ScoreBadge label="抽样人数" value={dataQuality.samplingCount} accent="#0f766e" />
              <ScoreBadge label="待访谈样本" value={dataQuality.pendingInterviewCount} accent="#7c3aed" />
              <ScoreBadge label="已完成抽样访谈" value={dataQuality.samplingCompletedCount} accent="#1d4ed8" />
            </div>
            {dataQuality.reminders.length ? (
              <div className="queue-list">
                {dataQuality.reminders.slice(0, 8).map((item) => (
                  <div key={item.participantId} className="queue-item">
                    <div>
                      <strong>{item.participantId}</strong>
                      <p>
                        {item.groupId === "experimental" ? "实验组" : "对照组"} · 缺失项：{item.missingItems.join(" / ")}
                      </p>
                    </div>
                    <button type="button" className="secondary-button" onClick={() => loadParticipantWorkspace(item)}>
                      打开工作台
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-card">当前没有需要补录或跟进的样本。</div>
            )}
          </>
        ) : (
          <div className="empty-card">数据质量概览尚未生成。</div>
        )}
      </section>

      <section className="panel-card dashboard-span">
        <SectionTitle step="R3C" title="周任务完成率看板" description="按组别和周次查看任务完成率、进行中数量和逾期数量。" />
        {dataQuality?.taskBoard?.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>组别</th>
                  <th>已分配</th>
                  <th>已完成</th>
                  <th>进行中</th>
                  <th>逾期</th>
                  <th>完成率</th>
                </tr>
              </thead>
              <tbody>
                {dataQuality.taskBoard.map((item) => (
                  <tr key={`${item.stage}-${item.groupId}`}>
                    <td>{item.stage}</td>
                    <td>{item.groupId === "experimental" ? "实验组" : "对照组"}</td>
                    <td>{item.assignedCount}</td>
                    <td>{item.completedCount}</td>
                    <td>{item.inProgressCount}</td>
                    <td>{item.overdueCount}</td>
                    <td>{item.completionRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前没有可统计的任务计划。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R3D" title="访谈抽样队列" description="查看已标记的质性样本，追踪优先级、抽样原因和完成情况。" />
        {dataQuality?.samplingRows?.length ? (
          <div className="queue-list">
            {dataQuality.samplingRows.map((item) => (
              <div key={item.participantId} className="queue-item">
                <div>
                  <strong>{item.participantId}</strong>
                  <p>
                    {item.groupId === "experimental" ? "实验组" : "对照组"} · {item.priority} · 已访谈 {item.interviewCount} 次
                  </p>
                  <p>{item.reason || "未填写抽样原因"}</p>
                </div>
                <button type="button" className="secondary-button" onClick={() => loadParticipantWorkspace(item)}>
                  打开工作台
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-card">当前没有已标记的访谈抽样样本。</div>
        )}
      </section>

      <section className="panel-card dashboard-span">
        <SectionTitle step="R4" title="参与者列表" description="汇总每位受试的档案完成情况、系统增益、问卷数量和教师评分状态。" />
        {dashboardLoading ? (
          <div className="empty-card">正在加载参与者列表...</div>
        ) : researchParticipants.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>组别</th>
                  <th>档案</th>
                  <th>分析数</th>
                  <th>音准增益</th>
                  <th>节奏增益</th>
                  <th>问卷数</th>
                  <th>任务数</th>
                  <th>已完成任务</th>
                  <th>访谈数</th>
                  <th>验证数</th>
                  <th>平均验证一致性</th>
                  <th>裁决状态</th>
                  <th>裁决数</th>
                  <th>待裁决</th>
                  <th>抽样标记</th>
                  <th>抽样优先级</th>
                  <th>最新问卷阶段</th>
                  <th>最新访谈阶段</th>
                  <th>教师前测音准</th>
                  <th>教师后测音准</th>
                  <th>最新裁决</th>
                  <th>最近活跃</th>
                </tr>
              </thead>
              <tbody>
                {researchParticipants.map((participant) => (
                  <tr key={participant.participantId}>
                    <td>{participant.participantId}</td>
                    <td>{participant.groupId === "experimental" ? "实验组" : "对照组"}</td>
                    <td>{participant.profileCompleted ? "完成" : "未完成"}</td>
                    <td>{participant.analysisCount}</td>
                    <td>{plusNumber(participant.pitchGain)}</td>
                    <td>{plusNumber(participant.rhythmGain)}</td>
                    <td>{participant.questionnaireCount}</td>
                    <td>{participant.taskPlanCount}</td>
                    <td>{participant.completedTaskCount}</td>
                    <td>{participant.interviewCount}</td>
                    <td>{participant.validationReviewCount}</td>
                    <td>{participant.averageValidationAgreement ?? "—"}</td>
                    <td>{participant.adjudicationStatus || "—"}</td>
                    <td>{participant.adjudicationCount ?? 0}</td>
                    <td>{participant.pendingAdjudicationCount ?? 0}</td>
                    <td>{participant.interviewSamplingSelected ? "是" : "否"}</td>
                    <td>{participant.interviewSamplingPriority || "—"}</td>
                    <td>{participant.latestQuestionnaireStage || "—"}</td>
                    <td>{participant.latestInterviewStage || "—"}</td>
                    <td>{participant.expertPretestPitch ?? "—"}</td>
                    <td>{participant.expertPosttestPitch ?? "—"}</td>
                    <td>{participant.latestAdjudicationAt ? `${participant.latestAdjudicationPathAgreement ? "一致" : "偏离"} · ${formatDateTime(participant.latestAdjudicationAt)}` : "—"}</td>
                    <td>{formatDateTime(participant.lastActiveAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前还没有参与者数据。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R5" title="最新问卷" description="查看最近提交的问卷条目，验证导出前的数据完整性。" />
        {latestQuestionnaires.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>阶段</th>
                  <th>有用性</th>
                  <th>清晰度</th>
                  <th>持续使用</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                {latestQuestionnaires.map((item) => (
                  <tr key={`${item.participantId}-${item.sessionStage}-${item.submittedAt}`}>
                    <td>{item.participantId}</td>
                    <td>{item.sessionStage}</td>
                    <td>{item.usefulness}</td>
                    <td>{item.feedbackClarity}</td>
                    <td>{item.continuance}</td>
                    <td>{formatDateTime(item.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前没有问卷记录。</div>
        )}
      </section>

      <section className="panel-card dashboard-span">
        <SectionTitle step="R6" title="最新教师验证" description="查看系统输出与教师判断的一致性结果，包括问题定位和练习路径是否一致。" />
        {latestValidationReviews.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>分析记录</th>
                  <th>教师路径</th>
                  <th>系统路径</th>
                  <th>路径一致</th>
                  <th>整体一致性</th>
                  <th>音符 F1</th>
                  <th>小节 F1</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                {latestValidationReviews.map((item) => (
                  <tr key={item.reviewId}>
                    <td>{item.participantId}</td>
                    <td>{item.analysisId}</td>
                    <td>{practicePathLabel(item.teacherPrimaryPath)}</td>
                    <td>{practicePathLabel(item.systemRecommendedPath)}</td>
                    <td>{item.pathAgreement ? "是" : "否"}</td>
                    <td>{item.overallAgreement}</td>
                    <td>{item.noteF1 == null ? "—" : item.noteF1.toFixed(3)}</td>
                    <td>{item.measureF1 == null ? "—" : item.measureF1.toFixed(3)}</td>
                    <td>{formatDateTime(item.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前还没有教师标注验证记录。</div>
        )}
      </section>

      <section className="panel-card dashboard-span">
        <SectionTitle step="R6A" title="最新最终裁决" description="查看最近保存的最终裁决结果，确认双评后的最终标签已经写回系统。" />
        {latestAdjudications.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>分析记录</th>
                  <th>裁决者</th>
                  <th>最终路径</th>
                  <th>系统路径</th>
                  <th>路径一致</th>
                  <th>音符 F1</th>
                  <th>小节 F1</th>
                  <th>裁决时间</th>
                </tr>
              </thead>
              <tbody>
                {latestAdjudications.map((item) => (
                  <tr key={item.adjudicationId}>
                    <td>{item.participantId}</td>
                    <td>{item.analysisId}</td>
                    <td>{item.adjudicatorId}</td>
                    <td>{practicePathLabel(item.finalPrimaryPath)}</td>
                    <td>{practicePathLabel(item.systemRecommendedPath)}</td>
                    <td>{item.pathAgreement ? "是" : "否"}</td>
                    <td>{item.noteF1 == null ? "—" : Number(item.noteF1).toFixed(3)}</td>
                    <td>{item.measureF1 == null ? "—" : Number(item.measureF1).toFixed(3)}</td>
                    <td>{formatDateTime(item.resolvedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前还没有最终裁决记录。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R6" title="最新教师评分" description="查看最近保存的教师评分，确保评分流程写入成功。" />
        {latestRatings.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>阶段</th>
                  <th>教师</th>
                  <th>音准</th>
                  <th>节奏</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                {latestRatings.map((item) => (
                  <tr key={`${item.participantId}-${item.stage}-${item.submittedAt}`}>
                    <td>{item.participantId}</td>
                    <td>{item.stage}</td>
                    <td>{item.raterId}</td>
                    <td>{item.pitchScore}</td>
                    <td>{item.rhythmScore}</td>
                    <td>{formatDateTime(item.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前没有教师评分记录。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R7" title="最新任务计划" description="查看最近更新的周任务计划，确认实验组与对照组任务安排是否按周推进。" />
        {latestTasks.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>阶段</th>
                  <th>曲目/段落</th>
                  <th>状态</th>
                  <th>目标分钟数</th>
                  <th>截止日期</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {latestTasks.map((item) => (
                  <tr key={item.taskId}>
                    <td>{item.participantId}</td>
                    <td>{item.stage}</td>
                    <td>{`${item.pieceId}/${item.sectionId}`}</td>
                    <td>{item.status}</td>
                    <td>{item.practiceTargetMinutes}</td>
                    <td>{item.dueDate || "—"}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前没有任务计划记录。</div>
        )}
      </section>

      <section className="panel-card">
        <SectionTitle step="R8" title="最新访谈记录" description="查看最近保存的访谈条目，便于抽样分析 AI 反馈接受度与学习机制。" />
        {latestInterviews.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>受试编号</th>
                  <th>阶段</th>
                  <th>访谈人</th>
                  <th>需要跟进</th>
                  <th>摘要</th>
                  <th>提交时间</th>
                </tr>
              </thead>
              <tbody>
                {latestInterviews.map((item) => (
                  <tr key={item.interviewId}>
                    <td>{item.participantId}</td>
                    <td>{item.stage}</td>
                    <td>{item.interviewerId}</td>
                    <td>{item.followUpNeeded ? "是" : "否"}</td>
                    <td>{item.summary || "—"}</td>
                    <td>{formatDateTime(item.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card">当前没有访谈记录。</div>
        )}
      </section>
    </div>
  );
}
