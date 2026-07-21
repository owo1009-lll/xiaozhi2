export const contractVersion = "western-round5-targeted-diagnosis-intake-v1";
export const gates = ["merged_substitution", "missing", "extra", "drag"];

const positiveInstructions = {
  merged_substitution: "把目标谱音稳定演奏成相邻半音或全音，时值不变。",
  missing: "完全跳过目标谱音，不用邻音或滑音填补。",
  extra: "把目标谱音清楚地重复起弓两次，谱面仍只有一个音。",
  drag: "把目标谱音明显拖长，并压缩或推迟后继音。",
};

const negativeKinds = {
  merged_substitution: ["adjacent-semitone-clean", "adjacent-wholetone-clean"],
  missing: ["wrong-pitch-control", "neighbor-extension-control", "slide-control", "alignment-gap-control"],
  extra: ["normal-bow-change", "vibrato-peak", "notated-repeated-note"],
  drag: ["natural-rubato", "written-fermata-or-tie", "normal-long-bow"],
};

function confusionInstruction(gate, kind) {
  return `正常演奏一个 ${kind} 混淆位置；它是 ${gate} 的负例，不得故意制造该错误。`;
}

function eventSlots(taskIndex) {
  return gates.flatMap((gate) => {
    const kinds = negativeKinds[gate];
    const selected = [
      kinds[(taskIndex * 2) % kinds.length],
      kinds[(taskIndex * 2 + 1) % kinds.length],
    ];
    return [
      {
        eventId: `${gate}-positive`,
        gate,
        label: "positive",
        plannedPerformance: positiveInstructions[gate],
      },
      ...selected.map((kind, index) => ({
        eventId: `${gate}-negative-${index + 1}`,
        gate,
        label: "confusion_negative",
        confusionKind: kind,
        plannedPerformance: confusionInstruction(gate, kind),
      })),
    ];
  });
}

export const tasks = Array.from({ length: 12 }, (_, index) => {
  const freshBlind = index >= 6;
  const localIndex = index % 6;
  const split = freshBlind ? "fresh-blind" : "calibration";
  const splitSlug = freshBlind ? "fresh" : "cal";
  return {
    recordingId: `r5-${splitSlug}-${String(localIndex + 1).padStart(2, "0")}`,
    pieceId: `replace-${splitSlug}-piece-${String(localIndex + 1).padStart(2, "0")}`,
    performerId: `performer-${(localIndex % 2) + 1}`,
    deviceId: `device-${Math.floor(localIndex / 2) + 1}`,
    roomId: freshBlind ? "room-2" : "room-1",
    split,
    audioPath: `data/private/western-strings-round5/r5-${splitSlug}-${String(localIndex + 1).padStart(2, "0")}.wav`,
    scorePath: `data/private/western-strings-round5/r5-${splitSlug}-${String(localIndex + 1).padStart(2, "0")}.musicxml`,
    consent: "yes",
    licenseStatus: "local-only",
    eventSlots: eventSlots(index),
  };
});

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function manifestTemplateCsv() {
  const fields = [
    "recordingId", "pieceId", "performerId", "deviceId", "roomId", "split",
    "audioPath", "scorePath", "consent", "licenseStatus",
  ];
  return `${fields.join(",")}\n${tasks.map((task) => (
    fields.map((field) => csvCell(task[field])).join(",")
  )).join("\n")}\n`;
}

export function truthTemplate() {
  return {
    contractVersion,
    recordingRequirements: {
      completeErrorInventory: true,
      meaning: "Every performed error in this recording has been position-labelled; unlisted score positions are ordinary-correct.",
    },
    recordings: Object.fromEntries(tasks.map((task) => [task.recordingId, {
      completeErrorInventory: false,
      events: task.eventSlots.map((slot) => ({
        eventId: slot.eventId,
        gate: slot.gate,
        label: slot.label,
        measure: "",
        beat: "",
        scoreMidi: "",
        asPerformed: "",
        ...(slot.confusionKind ? { confusionKind: slot.confusionKind } : {}),
        plannedPerformance: slot.plannedPerformance,
      })),
    }])),
  };
}
