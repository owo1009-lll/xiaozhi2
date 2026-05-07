export function SummaryPill({ label, value }) {
  return (
    <div className="ops-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function FindingToggle({ checked, children, onToggle }) {
  return (
    <button type="button" className={`teacher-finding-toggle${checked ? " is-active" : ""}`} onClick={onToggle}>
      {children}
    </button>
  );
}

export function IssueChip({ children, onRemove }) {
  return (
    <span className="teacher-issue-chip">
      {children}
      <button type="button" onClick={onRemove} aria-label="移除">
        ×
      </button>
    </span>
  );
}
