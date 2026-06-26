import { useRef, useState } from "react";
import { importScoreMidi, importScoreMusicXml } from "./researchApi.js";

const INSTRUMENTS = [
  { id: "violin", label: "Violin" },
  { id: "viola", label: "Viola" },
  { id: "cello", label: "Cello" },
];

function fileTitle(file) {
  if (!file?.name) return "";
  return file.name.replace(/\.(musicxml|xml|mxl|mid|midi)$/i, "");
}

export default function WesternStringsApp({ onBackToStudent }) {
  const musicXmlInputRef = useRef(null);
  const midiInputRef = useRef(null);
  const [instrument, setInstrument] = useState("violin");
  const [scoreFile, setScoreFile] = useState(null);
  const [scoreKind, setScoreKind] = useState("");
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("Select a clean MusicXML or MIDI score.");
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);

  async function importSelectedScore() {
    if (!scoreFile || !scoreKind) {
      setError("Choose a MusicXML or MIDI file first.");
      return;
    }
    setImporting(true);
    setError("");
    setStatus("Importing clean score...");
    setJob(null);
    const metadata = {
      selectedPartHint: instrument,
      instrument,
      scoreSource: scoreKind,
      tempoKnown: scoreKind === "midi" ? "true" : "false",
      tempoSource: scoreKind === "midi" ? "midi" : "unknown",
    };
    try {
      const result =
        scoreKind === "midi"
          ? await importScoreMidi(scoreFile, fileTitle(scoreFile), metadata)
          : await importScoreMusicXml(scoreFile, fileTitle(scoreFile), metadata);
      setJob(result.job || null);
      setStatus(result.ok ? "Clean score imported." : "Clean score import failed.");
    } catch (importError) {
      setError(importError?.message || "Clean score import failed.");
      setStatus("Import failed.");
    } finally {
      setImporting(false);
    }
  }

  function pickFile(kind, file) {
    setScoreKind(kind);
    setScoreFile(file || null);
    setJob(null);
    setError("");
    setStatus(file ? `${kind === "midi" ? "MIDI" : "MusicXML"} selected: ${file.name}` : "Select a clean MusicXML or MIDI score.");
  }

  return (
    <div className="app-shell western-strings-app">
      <header className="hero-card">
        <div>
          <span className="eyebrow">Western strings V2 alpha</span>
          <h1>Clean-score practice diagnostics</h1>
          <p>MusicXML and MIDI only. Low-confidence analysis remains in review until the V2 gates pass.</p>
        </div>
        <div className="metric-card">
          <strong>Input policy</strong>
          <span>PDF OMR disabled</span>
        </div>
      </header>

      <div className="toolbar">
        <button type="button" className="secondary-button" onClick={onBackToStudent}>
          Back
        </button>
      </div>

      <section className="panel-card western-strings-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">M1 clean score</span>
            <h2>Import score</h2>
          </div>
          <select value={instrument} onChange={(event) => setInstrument(event.target.value)} aria-label="Instrument">
            {INSTRUMENTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <input
          ref={musicXmlInputRef}
          type="file"
          accept=".musicxml,.xml,.mxl,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml"
          hidden
          onChange={(event) => pickFile("musicxml", event.target.files?.[0] || null)}
        />
        <input
          ref={midiInputRef}
          type="file"
          accept=".mid,.midi,audio/midi"
          hidden
          onChange={(event) => pickFile("midi", event.target.files?.[0] || null)}
        />

        <div className="western-strings-actions">
          <button type="button" className="secondary-button" onClick={() => musicXmlInputRef.current?.click()}>
            Choose MusicXML
          </button>
          <button type="button" className="secondary-button" onClick={() => midiInputRef.current?.click()}>
            Choose MIDI
          </button>
          <button type="button" className="primary-button" disabled={importing || !scoreFile} onClick={importSelectedScore}>
            {importing ? "Importing..." : "Import"}
          </button>
        </div>

        <div className="status-banner" aria-live="polite">
          {status}
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        {job ? (
          <div className="western-strings-result">
            <div>
              <strong>Score ID</strong>
              <span>{job.scoreId || "pending"}</span>
            </div>
            <div>
              <strong>Source</strong>
              <span>{job.scoreSource || scoreKind}</span>
            </div>
            <div>
              <strong>Tempo</strong>
              <span>{job.tempoKnown ? job.tempoSource || "known" : "unknown"}</span>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
