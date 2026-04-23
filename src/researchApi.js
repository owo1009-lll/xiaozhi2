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
  if (payload?.audioFile instanceof File) {
    const formData = new FormData();
    formData.append("audio", payload.audioFile);
    const { audioFile, ...rest } = payload;
    formData.append("payload", JSON.stringify(rest));
    return readJson(
      await fetch("/api/erhu/analyze", {
        method: "POST",
        body: formData,
      }),
    );
  }
  return readJson(
    await fetch("/api/erhu/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function createAnalysisJob(payload) {
  if (payload?.audioFile instanceof File) {
    const formData = new FormData();
    formData.append("audio", payload.audioFile);
    const { audioFile, ...rest } = payload;
    formData.append("payload", JSON.stringify({ ...rest, async: true }));
    return readJson(
      await fetch("/api/erhu/analyze", {
        method: "POST",
        body: formData,
      }),
    );
  }
  return readJson(
    await fetch("/api/erhu/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, async: true }),
    }),
  );
}

export async function fetchAnalysisJob(jobId) {
  return readJson(await fetch(`/api/erhu/analyze-jobs/${encodeURIComponent(jobId)}`));
}

export async function importScorePdf(file, titleHint = "") {
  const formData = new FormData();
  formData.append("pdf", file);
  if (titleHint) {
    formData.append("titleHint", titleHint);
  }
  return readJson(
    await fetch("/api/erhu/scores/import-pdf", {
      method: "POST",
      body: formData,
    }),
  );
}

export async function fetchScoreImportJob(jobId) {
  return readJson(await fetch(`/api/erhu/scores/import-pdf/${encodeURIComponent(jobId)}`));
}

export async function fetchScore(scoreId) {
  return readJson(await fetch(`/api/erhu/scores/${encodeURIComponent(scoreId)}`));
}

export async function fetchLatestPiecePassSummary({ pieceId = "", title = "" } = {}) {
  const searchParams = new URLSearchParams();
  if (pieceId) searchParams.set("pieceId", pieceId);
  if (title) searchParams.set("title", title);
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : "";
  return readJson(await fetch(`/api/erhu/piece-pass/latest${suffix}`));
}

export async function createPiecePassJob(payload) {
  if (payload?.audioFile instanceof File) {
    const formData = new FormData();
    formData.append("audio", payload.audioFile);
    const { audioFile, ...rest } = payload;
    formData.append("payload", JSON.stringify(rest));
    return readJson(
      await fetch("/api/erhu/piece-pass-jobs", {
        method: "POST",
        body: formData,
      }),
    );
  }
  return readJson(
    await fetch("/api/erhu/piece-pass-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function fetchPiecePassJob(jobId) {
  return readJson(await fetch(`/api/erhu/piece-pass-jobs/${encodeURIComponent(jobId)}`));
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

export async function fetchAdjudications() {
  return readJson(await fetch("/api/erhu/research/adjudications"));
}

export async function fetchAdjudicationSummary() {
  return readJson(await fetch("/api/erhu/research/adjudication-summary"));
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

export async function saveAdjudication(payload) {
  return readJson(
    await fetch("/api/erhu/adjudication", {
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
