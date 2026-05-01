export function uniqueSortedNumbers(values = []) {
  return [...new Set(values.map((value) => Math.round(Number(value))).filter((value) => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
}

export function pageNumberFromText(value) {
  const match = String(value || "").match(/page[-\s]?0*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function sectionPage(section = {}) {
  return Math.max(
    1,
    Math.round(
      Number(section?.pageNumber)
      || pageNumberFromText(section?.sectionId)
      || pageNumberFromText(section?.sourceSectionId)
      || pageNumberFromText(section?.title)
      || 1,
    ),
  );
}

export function isImportedSection(section = {}) {
  return /page[-\s]?0*\d+/i.test(`${section?.sectionId || ""} ${section?.sourceSectionId || ""} ${section?.title || ""}`);
}

export function isErhuNote(note = {}, section = {}) {
  if (!isImportedSection(section)) return true;
  const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
  const confidence = Number(note?.notePosition?.scoreLineConfidence) || 0;
  if (role === "erhu" && confidence >= 0.66) return true;
  if (role) return false;
  return false;
}

export function isAccompanimentOnly(section = {}) {
  const stats = section?.scoreLineStats || {};
  const erhuCount = Number(stats.erhuNoteCount) || 0;
  const accompanimentCount = Number(stats.accompanimentNoteCount) || 0;
  if (erhuCount <= 0 && accompanimentCount > 0) return true;
  const notes = Array.isArray(section?.notes) ? section.notes : [];
  return notes.length > 0 && !notes.some((note) => isErhuNote(note, section));
}

export function parseXmlNoteId(noteId) {
  const match = String(noteId || "").trim().match(/^xml-m(\d+)-n(\d+)$/i);
  return match ? { measureIndex: Number(match[1]), noteIndex: Number(match[2]) } : null;
}

function issueMeasureIndex(issueOrMeasure = 0) {
  if (issueOrMeasure && typeof issueOrMeasure === "object") {
    return Number(issueOrMeasure.measureIndex) || parseXmlNoteId(issueOrMeasure.noteId)?.measureIndex || 1;
  }
  return Number(issueOrMeasure) || 1;
}

function noteMeasureMatchesIssue(note = {}, issueOrMeasure = 0) {
  const numericMeasure = issueMeasureIndex(issueOrMeasure);
  if (Number(note?.measureIndex) === numericMeasure) return true;
  const position = note?.notePosition || {};
  if (Number(position.localMeasureIndex) === numericMeasure) return true;
  const localNote = parseXmlNoteId(position.localNoteId);
  return Boolean(localNote && localNote.measureIndex === numericMeasure);
}

function noteIdMatchesIssue(note = {}, issue = {}) {
  const noteId = String(issue?.noteId || "").trim();
  if (!noteId) return true;
  if (String(note?.noteId || "") === noteId) return true;
  const position = note?.notePosition || {};
  return String(position.localNoteId || "") === noteId;
}

function noteMatchesIssue(note = {}, issue = {}) {
  return noteMeasureMatchesIssue(note, issue) && noteIdMatchesIssue(note, issue);
}

export function hasErhuMeasure(section = {}, issueOrMeasure = 0) {
  return (section?.notes || []).some((note) => noteMeasureMatchesIssue(note, issueOrMeasure) && isErhuNote(note, section));
}

export function resolveIssueSection(score = {}, issue = {}) {
  const sections = Array.isArray(score?.sections) ? score.sections : [];
  const requestedId = String(issue?.sectionId || "").trim();
  if (requestedId) {
    const matched = sections.find((section) => (
      String(section?.sectionId || "") === requestedId
      || String(section?.sourceSectionId || "") === requestedId
    ));
    if (matched && !isAccompanimentOnly(matched) && hasErhuMeasure(matched, issue)) return matched;
  }
  const page = Number(issue?.sourcePageNumber || issue?.pageNumber);
  if (Number.isFinite(page) && page > 0) {
    const pageSections = sections.filter((section) => sectionPage(section) === Math.round(page));
    const exact = pageSections.find((section) => (section.notes || []).some((note) => (
      noteMatchesIssue(note, issue)
      && isErhuNote(note, section)
    )));
    if (exact) return exact;
    const measure = pageSections.find((section) => hasErhuMeasure(section, issue));
    if (measure) return measure;
    return pageSections.find((section) => !isAccompanimentOnly(section)) || null;
  }
  return null;
}

export function auditScoreIssueProjection(score = {}, analysis = {}) {
  const sourcePages = [];
  const visiblePages = [];
  const reviewPages = [];
  const failures = [];
  let visibleNotes = 0;
  let reviewNotes = 0;
  let visibleMeasures = 0;
  let reviewMeasures = 0;

  for (const issue of analysis.noteFindings || []) {
    const section = resolveIssueSection(score, issue);
    const sourcePage = Number(issue?.sourcePageNumber || issue?.pageNumber) || (section ? sectionPage(section) : 0);
    if (sourcePage > 0) sourcePages.push(sourcePage);
    const note = (section?.notes || []).find((item) => (
      noteMatchesIssue(item, issue)
    ));
    if (!section || !note || !isErhuNote(note, section)) {
      reviewNotes += 1;
      if (sourcePage > 0) reviewPages.push(sourcePage);
      continue;
    }
    visibleNotes += 1;
    visiblePages.push(sectionPage(section));
    const role = String(note?.notePosition?.scoreLineRole || "").toLowerCase();
    if (role && role !== "erhu") {
      failures.push({
        type: "note-on-accompaniment",
        analysisId: analysis.analysisId,
        noteId: issue.noteId,
        sectionId: section.sectionId,
      });
    }
  }

  for (const issue of analysis.measureFindings || []) {
    const section = resolveIssueSection(score, issue);
    const sourcePage = Number(issue?.sourcePageNumber || issue?.pageNumber) || (section ? sectionPage(section) : 0);
    if (sourcePage > 0) sourcePages.push(sourcePage);
    if (!section || !hasErhuMeasure(section, issue)) {
      reviewMeasures += 1;
      if (sourcePage > 0) reviewPages.push(sourcePage);
      continue;
    }
    visibleMeasures += 1;
    visiblePages.push(sectionPage(section));
    if (isAccompanimentOnly(section)) {
      failures.push({
        type: "measure-on-accompaniment",
        analysisId: analysis.analysisId,
        measureIndex: issue.measureIndex,
        sectionId: section.sectionId,
      });
    }
  }

  const visibleIssues = visibleNotes + visibleMeasures;
  const reviewIssues = reviewNotes + reviewMeasures;
  const totalIssues = visibleIssues + reviewIssues;
  return {
    sourcePages: uniqueSortedNumbers(sourcePages),
    visiblePages: uniqueSortedNumbers(visiblePages),
    reviewPages: uniqueSortedNumbers(reviewPages),
    visibleNotes,
    hiddenNotes: reviewNotes,
    reviewNotes,
    visibleMeasures,
    hiddenMeasures: reviewMeasures,
    reviewMeasures,
    visibleIssues,
    reviewIssues,
    totalIssues,
    reviewRate: totalIssues ? Number((reviewIssues / totalIssues).toFixed(4)) : 0,
    failures,
  };
}
