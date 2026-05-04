import { APP_TABS, ScoreBadge, TabButton, safeNumber } from "./ResearchAppSupport.jsx";

export default function ResearchChrome({
  activeTab,
  analysis,
  errorMessage,
  installPromptEvent,
  onBackToStudent,
  onInstallApp,
  onTabChange,
  statusMessage,
}) {
  return (
    <>
      <header className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">AI + 音乐教育 + 深度学习</span>
          <h1>AI 二胡教学干预研究原型</h1>
          <p>
            面向 SSCI 教育干预研究的 PWA 原型。当前版本覆盖受试档案录入、录音后分析、标准示范、学习体验问卷、教师评分和研究数据导出。
          </p>
          <div className="hero-badges">
            <span>教育干预研究</span>
            <span>PWA / 壳 App</span>
            <span>音准 + 节奏</span>
            <span>Python 外部分析服务</span>
          </div>
        </div>
        <div className="hero-side">
          <ScoreBadge label="最近音准" value={analysis?.overallPitchScore ?? 0} accent="#0f766e" />
          <ScoreBadge label="最近节奏" value={analysis?.overallRhythmScore ?? 0} accent="#b45309" />
          <ScoreBadge label="分析置信度" value={safeNumber((analysis?.confidence || 0) * 100)} accent="#4338ca" suffix="%" />
        </div>
      </header>

      <div className="toolbar">
        <div className="tab-row">
          {APP_TABS.map((tab) => (
            <TabButton key={tab.id} active={activeTab === tab.id} onClick={() => onTabChange(tab.id)}>
              {tab.label}
            </TabButton>
          ))}
        </div>
        {onBackToStudent ? (
          <button type="button" className="secondary-button" onClick={onBackToStudent}>
            返回学生主界面
          </button>
        ) : null}
        {installPromptEvent ? (
          <button type="button" className="secondary-button" onClick={onInstallApp}>
            安装到手机桌面
          </button>
        ) : null}
      </div>

      <div className="status-banner">
        <strong>状态：</strong>
        {statusMessage}
      </div>
      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
    </>
  );
}
