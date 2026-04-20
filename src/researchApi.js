async function readJson(response) {
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.error || "请求失败");
  }
  return json;
}

export async function fetchPieces() {
  return readJson(await fetch("/api/erhu/pieces"));
}

export async function fetchParticipant(participantId) {
  return readJson(await fetch(`/api/erhu/study-records/${encodeURIComponent(participantId)}`));
}

export async function createAnalysis(payload) {
  return readJson(
    await fetch("/api/erhu/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveStudyRecord(payload) {
  return readJson(
    await fetch("/api/erhu/study-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveParticipantProfile(payload) {
  return readJson(
    await fetch("/api/erhu/participant-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchResearchOverview() {
  return readJson(await fetch("/api/erhu/research/overview"));
}

export async function fetchResearchParticipants() {
  return readJson(await fetch("/api/erhu/research/participants"));
}

export async function fetchDataQuality() {
  return readJson(await fetch("/api/erhu/research/data-quality"));
}

export async function fetchTasks() {
  return readJson(await fetch("/api/erhu/research/tasks"));
}

export async function fetchInterviews() {
  return readJson(await fetch("/api/erhu/research/interviews"));
}

export async function fetchQuestionnaires() {
  return readJson(await fetch("/api/erhu/research/questionnaires"));
}

export async function fetchExpertRatings() {
  return readJson(await fetch("/api/erhu/research/expert-ratings"));
}

export async function fetchValidationReviews() {
  return readJson(await fetch("/api/erhu/research/validation-reviews"));
}

export async function fetchValidationSummary() {
  return readJson(await fetch("/api/erhu/research/validation-summary"));
}

export async function fetchPendingRatings() {
  return readJson(await fetch("/api/erhu/research/pending-ratings"));
}

export async function fetchAnalyzerStatus() {
  return readJson(await fetch("/api/erhu/analyzer-status"));
}

export async function saveExpertRating(payload) {
  return readJson(
    await fetch("/api/erhu/expert-rating", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveValidationReview(payload) {
  return readJson(
    await fetch("/api/erhu/validation-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveTaskPlan(payload) {
  return readJson(
    await fetch("/api/erhu/task-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveInterviewNote(payload) {
  return readJson(
    await fetch("/api/erhu/interview-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function saveInterviewSampling(payload) {
  return readJson(
    await fetch("/api/erhu/interview-sampling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function batchCreateParticipants(payload) {
  return readJson(
    await fetch("/api/erhu/research/batch-participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}
