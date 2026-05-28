import { clamp, getArray, medianNumber, safeBoolean, safeNumber, safeString } from "./baseUtils.js";

export function buildScoreLineStatsFromNotes(notes = []) {
  const roleCounts = {};
  const sourceCounts = {};
  const noteList = getArray(notes);
  const measureKeys = new Set();
  const erhuMeasureKeys = new Set();
  const pageKeys = new Set();
  const erhuPageKeys = new Set();
  for (const note of noteList) {
    const position = note?.notePosition || {};
    const role = safeString(position.scoreLineRole, "missing") || "missing";
    const source = safeString(position.scoreLineSource, "missing") || "missing";
    const measureIndex = Math.max(1, Math.round(safeNumber(note?.measureIndex, 1)));
    const pageNumber = Math.max(1, Math.round(safeNumber(position.pageNumber, 1)));
    const measureKey = `${pageNumber}:${measureIndex}`;
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    measureKeys.add(measureKey);
    pageKeys.add(pageNumber);
    if (role === "erhu") {
      erhuMeasureKeys.add(measureKey);
      erhuPageKeys.add(pageNumber);
    }
  }
  const noteCount = noteList.length;
  const erhuNoteCount = Math.max(0, Math.round(safeNumber(roleCounts.erhu, 0)));
  const accompanimentNoteCount = Math.max(0, Math.round(safeNumber(roleCounts.accompaniment, 0)));
  const unknownNoteCount = Math.max(0, Math.round(safeNumber(roleCounts.unknown, 0) + safeNumber(roleCounts.missing, 0)));
  const measureCount = measureKeys.size;
  const pageCount = pageKeys.size;
  return {
    noteCount,
    erhuNoteCount,
    accompanimentNoteCount,
    unknownNoteCount,
    erhuRatio: noteCount ? Number((erhuNoteCount / noteCount).toFixed(3)) : 0,
    measureCount,
    erhuMeasureCount: erhuMeasureKeys.size,
    erhuMeasureCoverage: measureCount ? Number((erhuMeasureKeys.size / measureCount).toFixed(3)) : 0,
    pageCount,
    erhuPageCount: erhuPageKeys.size,
    erhuPageCoverage: pageCount ? Number((erhuPageKeys.size / pageCount).toFixed(3)) : 0,
    splitApplied: erhuNoteCount > 0 && accompanimentNoteCount > 0,
    roleCounts,
    sourceCounts,
  };
}

export function buildScoreLineStatsFromSections(sections = []) {
  const allNotes = getArray(sections).flatMap((section) => getArray(section?.notes));
  if (allNotes.length) return buildScoreLineStatsFromNotes(allNotes);

  const totals = {
    noteCount: 0,
    erhuNoteCount: 0,
    accompanimentNoteCount: 0,
    unknownNoteCount: 0,
    measureCount: 0,
    erhuMeasureCount: 0,
    pageCount: 0,
    erhuPageCount: 0,
    roleCounts: {},
    sourceCounts: {},
  };
  for (const section of getArray(sections)) {
    const stats =
      section?.scoreLineStats && typeof section.scoreLineStats === "object"
        ? section.scoreLineStats
        : buildScoreLineStatsFromNotes(section?.notes);
    totals.noteCount += Math.max(0, Math.round(safeNumber(stats.noteCount, 0)));
    totals.erhuNoteCount += Math.max(0, Math.round(safeNumber(stats.erhuNoteCount, 0)));
    totals.accompanimentNoteCount += Math.max(0, Math.round(safeNumber(stats.accompanimentNoteCount, 0)));
    totals.unknownNoteCount += Math.max(0, Math.round(safeNumber(stats.unknownNoteCount, 0)));
    totals.measureCount += Math.max(0, Math.round(safeNumber(stats.measureCount, 0)));
    totals.erhuMeasureCount += Math.max(0, Math.round(safeNumber(stats.erhuMeasureCount, 0)));
    totals.pageCount += Math.max(0, Math.round(safeNumber(stats.pageCount, 0)));
    totals.erhuPageCount += Math.max(0, Math.round(safeNumber(stats.erhuPageCount, 0)));
    for (const [role, count] of Object.entries(stats.roleCounts || {})) {
      totals.roleCounts[role] = (totals.roleCounts[role] || 0) + Math.max(0, Math.round(safeNumber(count, 0)));
    }
    for (const [source, count] of Object.entries(stats.sourceCounts || {})) {
      totals.sourceCounts[source] = (totals.sourceCounts[source] || 0) + Math.max(0, Math.round(safeNumber(count, 0)));
    }
  }
  return {
    ...totals,
    erhuRatio: totals.noteCount ? Number((totals.erhuNoteCount / totals.noteCount).toFixed(3)) : 0,
    erhuMeasureCoverage: totals.measureCount ? Number((totals.erhuMeasureCount / totals.measureCount).toFixed(3)) : 0,
    erhuPageCoverage: totals.pageCount ? Number((totals.erhuPageCount / totals.pageCount).toFixed(3)) : 0,
    splitApplied: totals.erhuNoteCount > 0 && totals.accompanimentNoteCount > 0,
  };
}

export function effectiveSelectedPartConfidence(rawConfidence, sections = []) {
  const confidence = clamp(safeNumber(rawConfidence, 0), 0, 1);
  const stats = buildScoreLineStatsFromSections(sections);
  const reliableErhuLine =
    stats.erhuNoteCount >= 12 &&
    (stats.splitApplied || safeNumber(stats.erhuRatio, 0) >= 0.75 || safeNumber(stats.erhuPageCoverage, 0) >= 0.7);
  if (reliableErhuLine) {
    return Math.max(confidence, 0.88);
  }
  return confidence;
}

export function annotateImportedSectionsScoreLineRoles(sections = [], score = {}) {
  const normalizedSections = getArray(sections);
  if (!normalizedSections.length) return normalizedSections;

  const cleanSolo = isCleanSoloSelectedPart(score);
  const candidate = getSelectedPartCandidate(score);
  const legacyImportedLayout =
    !candidate &&
    normalizedSections.some((section) => /page[-\s]?0*\d+/i.test(`${safeString(section?.sectionId)} ${safeString(section?.sourceSectionId)} ${safeString(section?.title)}`)) &&
    normalizedSections.some((section) => getArray(section?.notes).some((note) => Number.isFinite(safeNumber(note?.notePosition?.normalizedY, NaN))));
  const ambiguous =
    !cleanSolo &&
    (legacyImportedLayout ||
      hasAccompanimentPartCandidate(score) ||
      safeBoolean(candidate?.isLikelyPiano, false) ||
      safeNumber(candidate?.chordRatio, 0) >= 0.18 ||
      Math.max(1, safeNumber(candidate?.staffCount, 1)) >= 2);
  if (!cleanSolo && !ambiguous) return normalizedSections;
  const safePageMelodyProjection =
    ambiguous &&
    safeBoolean(candidate?.safeForErhuProjection, false) &&
    !safeBoolean(candidate?.isLikelyPiano, false) &&
    !safeBoolean(candidate?.isLikelyAccompanimentSplit, false) &&
    Math.max(1, safeNumber(candidate?.staffCount, 1)) <= 1 &&
    safeNumber(candidate?.chordRatio, 0) < 0.08 &&
    safeNumber(candidate?.erhuRangeRatio, 0) >= 0.75;
  const erhuRangeFallback =
    !cleanSolo &&
    ambiguous &&
    candidate &&
    !safeBoolean(candidate?.isLikelyPiano, false) &&
    Math.max(1, safeNumber(candidate?.staffCount, 1)) <= 1 &&
    safeNumber(candidate?.noteCount, 0) >= 8 &&
    safeNumber(candidate?.erhuRangeRatio, 0) >= 0.82 &&
    safeNumber(candidate?.chordRatio, 1) <= 0.14 &&
    (safeBoolean(candidate?.safeForErhuProjection, false) ||
      (safeNumber(candidate?.erhuRangeRatio, 0) >= 0.9 &&
        ((safeNumber(candidate?.chordRatio, 1) <= 0.04 &&
          Math.max(safeNumber(candidate?.score, 0), safeNumber(candidate?.selectedPartConfidence, 0)) >= 0.55) ||
          (safeNumber(candidate?.chordRatio, 1) <= 0.14 &&
            Math.max(safeNumber(candidate?.score, 0), safeNumber(candidate?.selectedPartConfidence, 0)) >= 0.75))));

  const lineGroups = new Map();
  const onsetCounts = new Map();
  for (const section of normalizedSections) {
    for (const note of getArray(section?.notes)) {
      const position = note?.notePosition || {};
      if (!Number.isFinite(safeNumber(position.normalizedY, NaN))) continue;
      const pageNumber = Math.max(1, Math.round(safeNumber(position.pageNumber, 1)));
      const systemIndex = Math.max(1, Math.round(safeNumber(position.systemIndex, 1)));
      const staffIndex = Math.max(1, Math.round(safeNumber(position.staffIndex, 1)));
      const key = `${pageNumber}:${systemIndex}:${staffIndex}`;
      if (!lineGroups.has(key)) {
        lineGroups.set(key, { key, pageNumber, systemIndex, staffIndex, notes: [] });
      }
      lineGroups.get(key).notes.push(note);
      const onsetKey = `${Math.max(1, Math.round(safeNumber(note?.measureIndex, 1)))}:${safeNumber(note?.beatStart, 0).toFixed(4)}`;
      onsetCounts.set(onsetKey, (onsetCounts.get(onsetKey) || 0) + 1);
    }
  }
  if (!lineGroups.size) return normalizedSections;

  const pageGroups = new Map();
  for (const group of lineGroups.values()) {
    if (!pageGroups.has(group.pageNumber)) pageGroups.set(group.pageNumber, []);
    pageGroups.get(group.pageNumber).push(group);
  }

  const roleByLineKey = new Map();
  const systemOrderByKey = new Map();
  for (const group of lineGroups.values()) {
    const systemKey = `${group.pageNumber}:${group.systemIndex}`;
    if (!systemOrderByKey.has(systemKey)) systemOrderByKey.set(systemKey, []);
    systemOrderByKey.get(systemKey).push({
      ...group,
      medianY: medianNumber(group.notes.map((note) => note?.notePosition?.normalizedY)),
    });
  }
  for (const [systemKey, groups] of systemOrderByKey.entries()) {
    systemOrderByKey.set(systemKey, groups.sort((left, right) => left.medianY - right.medianY));
  }
  const lineMetricCache = new Map();
  const lineMetrics = (group) => {
    if (lineMetricCache.has(group.key)) return lineMetricCache.get(group.key);
    const onsetCounts = new Map();
    const pitches = [];
    for (const note of group.notes) {
      const onsetKey = `${Math.max(1, Math.round(safeNumber(note?.measureIndex, 1)))}:${safeNumber(note?.beatStart, 0).toFixed(4)}`;
      onsetCounts.set(onsetKey, (onsetCounts.get(onsetKey) || 0) + 1);
      pitches.push(Math.round(safeNumber(note?.midiPitch, 69)));
    }
    const chordExcess = [...onsetCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const rangeHits = pitches.filter((pitch) => pitch >= 52 && pitch <= 96).length;
    const yValues = group.notes
      .map((note) => safeNumber(note?.notePosition?.normalizedY, NaN))
      .filter((value) => Number.isFinite(value));
    const metrics = {
      noteCount: group.notes.length,
      chordRatio: chordExcess / Math.max(1, group.notes.length),
      rangeRatio: rangeHits / Math.max(1, pitches.length),
      pitchSpan: pitches.length ? Math.max(...pitches) - Math.min(...pitches) : 0,
      medianY: medianNumber(yValues),
    };
    lineMetricCache.set(group.key, metrics);
    return metrics;
  };
  const looksLikeSingleLineMelody = (metrics) => (
    metrics.noteCount >= 6 &&
    metrics.chordRatio <= 0.08 &&
    metrics.rangeRatio >= 0.78 &&
    metrics.pitchSpan <= 36 &&
    metrics.medianY <= 0.52
  );
  const sparseSystemLeadNoise = new Set();
  const sparseSystemLeadMelody = new Set();
  if (ambiguous) {
    for (const groups of systemOrderByKey.values()) {
      if (groups.length < 2) continue;
      const firstGroup = groups[0];
      if (lineMetrics(firstGroup).noteCount > 2) continue;
      const melodyGroup = groups.slice(1).find((group) => {
        const metrics = lineMetrics(group);
        return metrics.noteCount >= 3 && metrics.chordRatio < 0.12 && metrics.rangeRatio >= 0.75 && metrics.pitchSpan <= 36;
      });
      if (melodyGroup) {
        sparseSystemLeadNoise.add(firstGroup.key);
        sparseSystemLeadMelody.add(melodyGroup.key);
      }
    }
  }
  const patternLineForGroup = (group, orderedPageGroups) => {
    const systemGroups = systemOrderByKey.get(`${group.pageNumber}:${group.systemIndex}`) || [];
    if (systemGroups.length >= 2) return systemGroups.findIndex((item) => item.key === group.key) === 0;
    if (safePageMelodyProjection && (orderedPageGroups.length >= 2 || lineMetrics(group).noteCount >= 4)) {
      return true;
    }
    const lineRank = orderedPageGroups.findIndex((item) => item.key === group.key);
    const lineCount = Math.max(1, orderedPageGroups.length);
    if (lineCount === 1) return true;
    if (lineCount === 2) return lineRank === 0;
    return lineRank >= 0 && lineRank % 3 === 0;
  };
  const pageHasDensePatternLine = new Map();
  for (const groups of pageGroups.values()) {
    const ordered = groups
      .map((group) => ({
        ...group,
        medianY: medianNumber(group.notes.map((note) => note?.notePosition?.normalizedY)),
      }))
      .sort((left, right) => left.medianY - right.medianY);
    pageHasDensePatternLine.set(
      ordered[0]?.pageNumber || 1,
      ordered.some((group) => patternLineForGroup(group, ordered) && group.notes.length >= 3),
    );
    const lineCount = Math.max(1, ordered.length);
    for (let lineRank = 0; lineRank < ordered.length; lineRank += 1) {
      const group = ordered[lineRank];
      if (cleanSolo) {
        roleByLineKey.set(group.key, { role: "erhu", confidence: 0.92, source: "clean-solo-part-js" });
        continue;
      }
      const metrics = lineMetrics(group);
      const chordRatio = metrics.chordRatio;
      const rangeRatio = metrics.rangeRatio;
      const pitchSpan = metrics.pitchSpan;
      let erhuPatternScore = 0.42;
      const systemGroups = systemOrderByKey.get(`${group.pageNumber}:${group.systemIndex}`) || [];
      const systemLineRank = systemGroups.findIndex((item) => item.key === group.key);
      const singleLineMelody =
        ambiguous &&
        lineCount === 1 &&
        systemGroups.length === 1 &&
        looksLikeSingleLineMelody(metrics);
      if (systemGroups.length >= 2) {
        erhuPatternScore = systemLineRank === 0 ? 0.76 : 0.14;
      } else if (singleLineMelody) {
        erhuPatternScore = 0.72;
      } else if (safePageMelodyProjection && (lineCount >= 2 || group.notes.length >= 4)) {
        erhuPatternScore = 0.74;
      } else if (lineCount === 2) {
        erhuPatternScore = lineRank === 0 ? 0.74 : 0.18;
      } else if (lineCount >= 3) {
        erhuPatternScore = lineRank % 3 === 0 ? 0.74 : 0.14;
      }
      if (sparseSystemLeadMelody.has(group.key)) {
        erhuPatternScore = Math.max(erhuPatternScore, 0.74);
      }
      let confidence = erhuPatternScore;
      confidence += Math.min(0.12, rangeRatio * 0.12);
      confidence += pitchSpan <= 36 ? 0.06 : -0.05;
      confidence -= Math.min(0.18, chordRatio * 0.75);
      if (chordRatio >= 0.18) {
        confidence = Math.min(confidence - 0.18, 0.58);
      }
      if (ambiguous && lineCount >= 4 && group.notes.length <= 2 && pageHasDensePatternLine.get(group.pageNumber)) {
        confidence = Math.min(confidence - 0.22, 0.58);
      }
      if (sparseSystemLeadNoise.has(group.key)) {
        confidence = Math.min(confidence - 0.22, 0.58);
      }
      confidence = clamp(Number(confidence.toFixed(3)), 0.05, 0.9);
      roleByLineKey.set(group.key, {
        role: confidence >= 0.66 ? "erhu" : "accompaniment",
        confidence,
        source: singleLineMelody ? "single-line-melody-js" : "omr-line-split-js",
      });
    }
  }

  return normalizedSections.map((section) => {
    const notes = getArray(section?.notes).map((note) => {
      const position = note?.notePosition || {};
      const pageNumber = Math.max(1, Math.round(safeNumber(position.pageNumber, 1)));
      const systemIndex = Math.max(1, Math.round(safeNumber(position.systemIndex, 1)));
      const staffIndex = Math.max(1, Math.round(safeNumber(position.staffIndex, 1)));
      const key = `${pageNumber}:${systemIndex}:${staffIndex}`;
      const originalLine = roleByLineKey.get(key);
      let line = originalLine;
      if (erhuRangeFallback && originalLine && originalLine.role !== "erhu") {
        const group = lineGroups.get(key);
        const metrics = group ? lineMetrics(group) : null;
        const orderedPageGroups = pageGroups.get(pageNumber) || [];
        const sparsePageNoise =
          ambiguous &&
          orderedPageGroups.length >= 4 &&
          (group?.notes?.length || 0) <= 2 &&
          pageHasDensePatternLine.get(pageNumber);
        const onsetKey = `${Math.max(1, Math.round(safeNumber(note?.measureIndex, 1)))}:${safeNumber(note?.beatStart, 0).toFixed(4)}`;
        const midiPitch = Math.round(safeNumber(note?.midiPitch, 0));
        if (
          metrics &&
          midiPitch >= 62 &&
          midiPitch <= 93 &&
          (onsetCounts.get(onsetKey) || 0) === 1 &&
          metrics.chordRatio <= 0.08 &&
          metrics.rangeRatio >= 0.75 &&
          !sparseSystemLeadNoise.has(key) &&
          !sparsePageNoise
        ) {
          line = {
            role: "erhu",
            confidence: Math.max(safeNumber(originalLine.confidence, 0), 0.68),
            source: "erhu-range-fallback-js",
          };
        }
      }
      if (!line || !note?.notePosition) return note;
      return {
        ...note,
        notePosition: {
          ...note.notePosition,
          scoreLineRole: line.role,
          scoreLineConfidence: line.confidence,
          scoreLineSource: line.source,
          scoreLineId: `p${pageNumber}-sys${systemIndex}-staff${staffIndex}`,
        },
      };
    });
    return {
      ...section,
      notes,
      scoreLineStats: buildScoreLineStatsFromNotes(notes),
    };
  });
}

export function getSelectedPartCandidate(score = {}) {
  const candidates = getArray(score?.partCandidates);
  if (!candidates.length) return null;
  const selected = safeString(score?.selectedPartId || score?.selectedPart).trim().toLowerCase();
  return candidates.find((candidate) => (
    [candidate?.id, candidate?.selectionKey, candidate?.qualifiedLabel, candidate?.name, candidate?.label]
      .map((item) => safeString(item).trim().toLowerCase())
      .includes(selected)
  )) || candidates[0] || null;
}

export function isExplicitErhuPartCandidate(candidate = {}) {
  const label = `${safeString(candidate?.id)} ${safeString(candidate?.name)} ${safeString(candidate?.label)}`;
  const normalizedLabel = label.replace(/\s+/g, "").toLowerCase();
  return /\berhu\b/i.test(label) || normalizedLabel.includes("二胡");
}

export function hasAccompanimentPartCandidate(score = {}) {
  return getArray(score?.partCandidates).some((candidate) => {
    const label = `${safeString(candidate?.id)} ${safeString(candidate?.name)} ${safeString(candidate?.label)}`;
    const normalizedLabel = label.replace(/\s+/g, "").toLowerCase();
    return /\b(piano|pno|pianoforte|accompaniment)\b|\bpn\./i.test(label)
      || normalizedLabel.includes("钢琴")
      || normalizedLabel.includes("鋼琴")
      || normalizedLabel.includes("伴奏")
      || safeBoolean(candidate?.isLikelyPiano, false)
      || Math.max(1, safeNumber(candidate?.staffCount, 1)) >= 2;
  });
}

export function isCleanSoloSelectedPart(score = {}) {
  const candidate = getSelectedPartCandidate(score);
  if (!candidate) return false;
  if (isExplicitErhuPartCandidate(candidate)) return true;
  if (hasAccompanimentPartCandidate(score)) return false;
  return !safeBoolean(candidate?.isLikelyPiano, false)
    && safeNumber(candidate?.chordRatio, 0) < 0.18
    && Math.max(1, safeNumber(candidate?.staffCount, 1)) <= 1;
}
