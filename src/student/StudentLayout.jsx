import { clampScore } from "../analysisLabels.js";

export function MetricCard({ label, value, suffix = "" }) {
  const numeric = Number(value);
  const displayValue = Number.isFinite(numeric) ? `${clampScore(numeric)}${suffix}` : String(value || "--");
  return (
    <div className="score-badge">
      <span>{label}</span>
      <strong>{displayValue}</strong>
    </div>
  );
}

export function StepTitle({ step, title, description }) {
  return (
    <div className="section-title">
      <span className="section-step">{step}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

export function StudentHero({ analyzerStatus, showResearchEntry, onOpenResearch }) {
  return (
    <header className="hero-card">
      <div className="hero-copy">
        <span className="eyebrow">AI ERHU SELF-PRACTICE</span>
        <h1>二胡 AI 自主练习</h1>
        <p>导入 PDF 曲谱，选择段落，上传或录制演奏音频。系统会自动识谱、增强二胡主旋律，并把音准和节奏问题高亮到问题谱面页。</p>
        <div className="hero-badges">
          <span>PDF 自动识谱</span>
          <span>突出二胡旋律</span>
          <span>音准诊断</span>
          <span>节奏诊断</span>
        </div>
      </div>
      <div className="hero-side">
        <div className="score-badge">
          <span>诊断状态</span>
          <strong style={{ color: analyzerStatus?.reachable ? "var(--accent)" : "#b42318" }}>
            {analyzerStatus == null ? "检测中" : analyzerStatus.reachable ? "正常" : "离线"}
          </strong>
        </div>
        {showResearchEntry && onOpenResearch ? (
          <button type="button" className="secondary-button" onClick={onOpenResearch}>
            打开研究后台
          </button>
        ) : null}
      </div>
    </header>
  );
}
