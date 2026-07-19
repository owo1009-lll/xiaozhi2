import { useEffect, useState } from "react";
import {
  fetchWesternScoreDiagnosis,
  fetchWesternScoreEditions,
  westernScoreRenderUrl,
} from "./researchApi.js";

function boxStyle(bbox) {
  return {
    left: `${(bbox[0] * 100).toFixed(2)}%`,
    top: `${(bbox[1] * 100).toFixed(2)}%`,
    width: `${((bbox[2] - bbox[0]) * 100).toFixed(2)}%`,
    height: `${((bbox[3] - bbox[1]) * 100).toFixed(2)}%`,
  };
}

export default function WesternScoreView() {
  const [editions, setEditions] = useState([]);
  const [current, setCurrent] = useState(null);
  const [diag, setDiag] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchWesternScoreEditions()
      .then((result) => {
        const list = result.editions || [];
        setEditions(list);
        if (list.length) selectEdition(list[0]);
      })
      .catch((err) => setError(err?.message || "无法加载内置谱面"));
  }, []);

  function selectEdition(edition) {
    setCurrent(edition);
    setDiag(null);
    fetchWesternScoreDiagnosis(edition.pieceId)
      .then(setDiag)
      .catch(() => setDiag(null));
  }

  const noteCount = diag?.noteIssues?.length || 0;

  return (
    <div className="app-shell western-strings-app">
      <header className="hero-card">
        <div>
          <span className="eyebrow">谱面定位 · web 测试</span>
          <h1>把诊断标到谱面上</h1>
          <p>用旧录音真实跑出的诊断结果,通过坐标定位到内置谱面。红框=问题小节,红圈=问题音符。web 与小程序用同一后端接口,这里能跑通即证明两端一致。</p>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="panel-card western-strings-panel">
        <div className="western-score-tabs">
          {editions.map((edition) => (
            <button
              key={edition.pieceId}
              type="button"
              className={`western-score-tab ${current?.pieceId === edition.pieceId ? "is-active" : ""}`}
              onClick={() => selectEdition(edition)}
            >
              {edition.title || edition.pieceId}
            </button>
          ))}
        </div>

        {diag?.hasData ? (
          <div className="western-score-summary">
            {noteCount === 0
              ? "本条录音:未发现明显问题音。"
              : `本条录音:标出 ${noteCount} 处问题音(音准 / 漏音),已定位到谱面。`}
          </div>
        ) : null}

        {current ? (
          <div className="western-score-stage">
            <img className="western-score-img" src={westernScoreRenderUrl(current.pieceId)} alt={current.title} />
            {(diag?.measureIssues || []).map((issue) => (
              <div key={`m${issue.measure}`} className="western-score-mbox" style={boxStyle(issue.bbox)}>
                <span className="western-score-mlabel">{(issue.labels || []).join(" · ")}</span>
              </div>
            ))}
            {(diag?.noteIssues || []).map((issue, index) => (
              <div key={`n${index}`} className="western-score-nbox" style={boxStyle(issue.bbox)} />
            ))}
          </div>
        ) : (
          <div className="muted-copy">加载内置谱面…</div>
        )}

        <p className="muted-copy">
          红框/红圈来自旧录音的真实诊断(研究级判定,非最终发布口径)。目前 3 首内置示例;学生实时录音的自动诊断待发布门槛通过后接入。
        </p>
      </section>
    </div>
  );
}
