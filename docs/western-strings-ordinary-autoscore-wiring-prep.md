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
- Policy C two-layer review-assist gate (preGateOnly, position truth in
  `data/private/western-strings-round4/error-positions.json`):
  - strict confirmed issues: **2/12**, with **0/253** false accusations
  - assignment-gap self-check hints add **4/12**, with **3/253** non-planted hints
  - combined review-assist recall **6/12 (50%)**; wrong 3/3, missing 3/3,
    extra 0/3, drag 0/3
  - `reviewAssistGateReady=true`, while `autoAccusationReady=false` and
    `energyRobustnessReady=false`

The self-check layer is an event-assignment-gap proxy, not a measured waveform
energy rule. It may ask for a self-check but may not accuse the learner.

Scope guard: this report is `implementation-evidence-preGateOnly`. It sets
`authorizationReady: false` and does **not** by itself grant the separate
`western-ordinary-dynamic-shadow-release-v1` authorization.

## 3. Blockers still standing in front of a flip

1. **M3+ student release is closed.** The review-only runtime and physical batch
   binding are current, but independent per-unit intonation gold is incomplete
   and `m3plusAutoFeedbackReady=false`. Ordinary alone changes nothing.
2. **Timing errors have no effective channel.** Policy C detects extra/drag at
   0/6. Relative-IOI is populated on 246/265 positions, but its 0.15 threshold
   catches 5/6 rhythm targets with 37 false positives; exhaustive threshold
   search reaches only 16.67% best precision at recall >= 50%. A segment-level
   onset-count/insertion-deletion model is required before timing claims.
3. **Automatic accusation is below its floor.** Treating self-check hints as
   accusations yields only 66.67% precision proxy, below the 90% floor; energy
   robustness is also unproven.

The r3 acceptance and live-artifact audit were re-frozen green on 2026-07-21.
The release review, decision and start-preflight machine bindings are current;
none of those facts opens the structurally separate student gate.

## 4. Recommended posture (needs no flip, no irreversible action)

The value is already reachable without touching any switch: keep the
**review-assist** flow that is live today — the machine pre-highlights suspect
notes/measures via `score-diagnosis`, and a teacher confirms before anything
reaches the student. Round-4 shows this highlighting localizes wrong/missing
notes reliably, which is exactly the assist a reviewer wants.

A switch flip should only be proposed when M3+ has complete independent gold,
the timing/energy gaps have their own fresh-blind evidence, and an automatic
output posture is explicitly approved. Until then this stays fail-closed by
design.

## 5. If/when the owner approves (the actual change)

1. Owner records署名 approval in the release review
   (`scripts/run-western-strings-release-review.mjs`).
2. Flip only the approved switch(es) in `WESTERN_STUDENT_RUNTIME_GATE` and the
   mirrored `runtimeStudentGate` in the status script — same commit.
3. Run `scripts/test-western-student-gate.mjs` and
   `scripts/gate-western-strings-project.mjs`; both must stay green.
4. The student view unlocks the corresponding capability automatically; no other
   code change is required.
