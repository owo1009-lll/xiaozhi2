import { useEffect, useMemo, useState } from "react";
import {
  cancelOpsJob,
  fetchOpsHealth,
  fetchOpsJobs,
  resumeOpsJob,
  retryOpsJob,
} from "./researchApi";

function boolText(value) {
  return value ? "正常" : "异常";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString();
}

function statusClass(status) {
  if (status === "completed") return "is-ok";
  if (status === "failed") return "is-danger";
  if (status === "processing") return "is-active";
  return "";
}

function SummaryPill({ label, value, tone = "" }) {
  return (
    <span className={`ops-pill ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function HealthSection({ title, children }) {
  return (
    <section className="panel-card ops-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function JobActions({ job, busyKey, onAction }) {
  const isBusy = busyKey === `${job.type}:${job.jobId}`;
  return (
    <div className="action-row ops-action-row">
      <button type="button" className="secondary-button" disabled={!job.actions?.canCancel || isBusy} onClick={() => onAction("cancel", job)}>
        取消
      </button>
      <button type="button" className="secondary-button" disabled={!job.actions?.canRetry || isBusy} onClick={() => onAction("retry", job)}>
        重试
      </button>
      <button type="button" className="secondary-button" disabled={!job.actions?.canResume || isBusy} onClick={() => onAction("resume", job)}>
        续跑
      </button>
    </div>
  );
}

function JobsTable({ jobs, busyKey, onAction }) {
  if (!jobs.length) return <div className="empty-card">暂无任务。</div>;
  return (
    <div className="ops-table-wrap">
      <table className="data-table ops-table">
        <thead>
          <tr>
            <th>类型</th>
            <th>任务</th>
            <th>状态</th>
            <th>阶段</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={`${job.type}:${job.jobId}`}>
              <td>{job.type}</td>
              <td>
                <strong>{job.title || job.jobId}</strong>
                <p className="sidebar-meta">{job.jobId}{job.previousJobId ? ` · 来源 ${job.previousJobId}` : ""}</p>
                {job.error ? <p className="error-text">{job.error}</p> : null}
              </td>
              <td><span className={`ops-status ${statusClass(job.status)}`}>{job.status}</span></td>
              <td>{job.stage || "-"}</td>
              <td>{formatTime(job.updatedAt)}</td>
              <td><JobActions job={job} busyKey={busyKey} onAction={onAction} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HealthPage() {
  const [health, setHealth] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  async function refresh() {
    const [healthResult, jobsResult] = await Promise.all([fetchOpsHealth(), fetchOpsJobs()]);
    setHealth(healthResult);
    setJobs(Array.isArray(jobsResult.jobs) ? jobsResult.jobs : []);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [healthResult, jobsResult] = await Promise.all([fetchOpsHealth(), fetchOpsJobs()]);
        if (cancelled) return;
        setHealth(healthResult);
        setJobs(Array.isArray(jobsResult.jobs) ? jobsResult.jobs : []);
        setError("");
      } catch (err) {
        if (!cancelled) setError(err?.message || "健康检查失败");
      }
    }
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function handleAction(action, job) {
    const key = `${job.type}:${job.jobId}`;
    setBusyKey(key);
    setError("");
    try {
      if (action === "cancel") await cancelOpsJob(job.type, job.jobId);
      else if (action === "retry") await retryOpsJob(job.type, job.jobId);
      else await resumeOpsJob(job.type, job.jobId);
      await refresh();
    } catch (err) {
      setError(err?.message || "任务操作失败");
    } finally {
      setBusyKey("");
    }
  }

  const recentJobs = useMemo(() => jobs.slice(0, 20), [jobs]);
  const failedJobs = useMemo(() => jobs.filter((job) => job.status === "failed").slice(0, 10), [jobs]);

  return (
    <div className="app-shell ops-shell">
      <header className="panel-card ops-header">
        <div>
          <span className="eyebrow">AI ERHU OPS</span>
          <h1>运行健康</h1>
          <p className="supporting-copy">Node、Python、CPU-only、存储和任务状态。</p>
        </div>
        <button type="button" className="secondary-button" onClick={refresh}>刷新</button>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="ops-summary-grid">
        <SummaryPill label="Node" value={health?.node ? "运行中" : "检测中"} tone="is-ok" />
        <SummaryPill label="Python" value={boolText(health?.analyzer?.reachable)} tone={health?.analyzer?.reachable ? "is-ok" : "is-danger"} />
        <SummaryPill label="CPU-only" value={boolText(health?.cpuOnly?.expectedCpuOnly)} tone={health?.cpuOnly?.expectedCpuOnly ? "is-ok" : "is-danger"} />
        <SummaryPill label="Store" value={health?.store?.backend || "-"} tone={health?.store?.backend === "sqlite" ? "is-ok" : ""} />
        <SummaryPill label="失败任务" value={health?.tasks?.counts?.failed ?? 0} tone={health?.tasks?.counts?.failed ? "is-danger" : "is-ok"} />
      </div>

      <div className="ops-grid">
        <HealthSection title="服务">
          <div className="ops-kv">
            <span>Node PID</span><strong>{health?.node?.pid || "-"}</strong>
            <span>Node 版本</span><strong>{health?.node?.version || "-"}</strong>
            <span>Python</span><strong>{health?.analyzer?.reachable ? "可达" : "不可达"}</strong>
            <span>Python URL</span><strong>{health?.analyzer?.serviceUrl || "-"}</strong>
            <span>CUDA</span><strong>{health?.cpuOnly?.cudaVisibleDevices === "" ? "关闭" : health?.cpuOnly?.cudaVisibleDevices}</strong>
          </div>
        </HealthSection>

        <HealthSection title="存储">
          <div className="ops-kv">
            <span>后端</span><strong>{health?.store?.backend || "-"}</strong>
            <span>JSON</span><strong>{formatBytes(health?.store?.scoreJson?.sizeBytes)}</strong>
            <span>SQLite</span><strong>{formatBytes(health?.store?.scoreSqlite?.sizeBytes)}</strong>
            <span>活跃导入任务</span><strong>{health?.store?.sqliteSummary?.activeJobs ?? "-"}</strong>
            <span>Archive</span><strong>{health?.store?.recentArchives?.length ?? 0}</strong>
          </div>
        </HealthSection>
      </div>

      <HealthSection title="最近失败">
        <JobsTable jobs={failedJobs} busyKey={busyKey} onAction={handleAction} />
      </HealthSection>

      <HealthSection title="任务">
        <JobsTable jobs={recentJobs} busyKey={busyKey} onAction={handleAction} />
      </HealthSection>

      <HealthSection title="日志">
        <div className="ops-log-grid">
          {Object.entries(health?.logs?.production || {}).map(([key, value]) => (
            <code key={key}>{key}: {value}</code>
          ))}
          <code>perfTrace: {health?.logs?.perfTrace || ""}</code>
        </div>
      </HealthSection>
    </div>
  );
}
