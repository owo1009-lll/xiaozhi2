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

export async function fetchResearchOverview() {
  return readJson(await fetch("/api/erhu/research/overview"));
}

export async function fetchResearchParticipants() {
  return readJson(await fetch("/api/erhu/research/participants"));
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
