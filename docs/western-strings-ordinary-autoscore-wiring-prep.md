# Ordinary auto-score wiring — readiness prep (NOT executed)

Status: **prepared only**. No runtime switch has been flipped. Flipping any
switch in `WESTERN_STUDENT_RUNTIME_GATE` is a governed change that requires a
release review plus the project owner's署名 (guanxingzhi). This memo records
what is now proven, the single change that a flip would be, and the concrete
blockers that still stand in front of it.

## 1. The exact wiring point

`src/server/westernStudentGateService.js:13-18`

```js
export const WESTERN_STUDENT_RUNTIME_GATE = Object.freeze({
  ordinaryUploadAutoFeedbackReady: false,  // ordinary-upload auto feedback
  m3plusAutoFeedbackReady: false,          // M3+ pitch-safety auto accusation
  m4OmrAutoScoreReady: false,              // photo-score auto scoring (M4)
  policy: "fail-closed",
});
```

Everything the student page shows is derived from these three booleans by
`buildWesternStudentGateView()`. Note the compound rule:

```js
const autoFeedback = gate.ordinaryUploadAutoFeedbackReady === true
  && gate.m3plusAutoFeedbackReady === true;
```

So ordinary auto-feedback needs **both** the ordinary switch and the M3+
switch to be true. Turning on ordinary alone does nothing student-visible.

`status.runtimeStudentGate` (scripts/status-western-strings-project.mjs) mirrors
these values; the two must stay in lock-step, and the status test asserts it.

## 2. What round-4 now proves (evidence in hand)

Fresh-blind release-level batch (fresh performer/voice, never used to tune any
threshold): `data/experiments/western-strings-round4/ordinary-fresh-blind/report.json`

- **evidenceReady: true, liveAuditReady: true, blockingReasons: []**
- clean-full tier: 2/2 clean takes above the 0.2 coverage floor
  (r4-01 = 0.906, r4-02 = 0.763)
- technique-safety tier: 3 marked-zone rows, **0 accusations**
- planted-error localization reference (new, preGateOnly — position ground
  truth in `data/private/western-strings-round4/error-positions.json`):
  - overall detection recall **8/12 (66.7%)**
  - **wrong-pitch 3/3, missing 3/3** — pitch/presence errors localize perfectly
  - extra 1/3, drag 1/3 — count/timing errors only partially caught (loose
    duration-ratio heuristic; the pipeline has no reliable timing channel yet)
  - false-positive rate on clean notes of the same takes **11/73 (15.1%)**,
    driven by the duration heuristic and occasional `insufficient_evidence`,
    **not** by `issue_detected` firing on clean notes

Scope guard: this report is `implementation-evidence-preGateOnly`. It sets
`authorizationReady: false` and does **not** by itself grant the separate
`western-ordinary-dynamic-shadow-release-v1` authorization.

## 3. Blockers still standing in front of a flip

1. **M3+ is closed.** `autoFeedback` needs `m3plusAutoFeedbackReady` too, and
   the M3+ track is nowhere near ready (`m3plus-student-gate-closed`,
   `m3plus-review-only-runtime-not-wired`). Ordinary alone changes nothing.
2. **r3 acceptance live-artifact is stale.** `controlledCandidate` still carries
   `ordinary-dynamic-shadow-r3-live-artifact-audit-failed`
   (r3-02 / r3-03 score-store artifacts stale). The dynamic-shadow track cannot
   claim a clean live chain until that is re-frozen.
3. **Timing errors are not safely detectable.** extra/drag recall is 33% and the
   15% clean-note false-positive rate means an auto-*accusation* posture on this
   evidence would both miss real timing mistakes and wrongly flag clean notes.
   The evidence supports **review-assist**, not full auto-scoring.

## 4. Recommended posture (needs no flip, no irreversible action)

The value is already reachable without touching any switch: keep the
**review-assist** flow that is live today — the machine pre-highlights suspect
notes/measures via `score-diagnosis`, and a teacher confirms before anything
reaches the student. Round-4 shows this highlighting localizes wrong/missing
notes reliably, which is exactly the assist a reviewer wants.

A switch flip should only be proposed when: M3+ has its own passing gate, the r3
live-artifact chain is re-frozen green, and a posture decision (review-assist
vs. auto-accuse) is signed off. Until then this stays fail-closed by design.

## 5. If/when the owner approves (the actual change)

1. Owner records署名 approval in the release review
   (`scripts/run-western-strings-release-review.mjs`).
2. Flip only the approved switch(es) in `WESTERN_STUDENT_RUNTIME_GATE` and the
   mirrored `runtimeStudentGate` in the status script — same commit.
3. Run `scripts/test-western-student-gate.mjs` and
   `scripts/gate-western-strings-project.mjs`; both must stay green.
4. The student view unlocks the corresponding capability automatically; no other
   code change is required.
