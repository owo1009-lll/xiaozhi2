export const ERHU_STUDY_PIECES = [
  {
    pieceId: "d-major-scale-fragment",
    title: "D调一把位音阶片段",
    composer: "研究任务曲目 A",
    targetSkills: ["音准稳定", "换弦控制", "均匀拍感"],
    difficulty: "高校二胡专业基础段",
    sections: [
      {
        sectionId: "section-a",
        title: "上行音阶与长音保持",
        tempo: 72,
        meter: "4/4",
        demoAudio: "",
        notes: [
          { noteId: "a-m1-n1", measureIndex: 1, beatStart: 0, beatDuration: 1, midiPitch: 62 },
          { noteId: "a-m1-n2", measureIndex: 1, beatStart: 1, beatDuration: 1, midiPitch: 64 },
          { noteId: "a-m1-n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 66 },
          { noteId: "a-m1-n4", measureIndex: 1, beatStart: 3, beatDuration: 1, midiPitch: 67 },
          { noteId: "a-m2-n1", measureIndex: 2, beatStart: 0, beatDuration: 1, midiPitch: 69 },
          { noteId: "a-m2-n2", measureIndex: 2, beatStart: 1, beatDuration: 1, midiPitch: 71 },
          { noteId: "a-m2-n3", measureIndex: 2, beatStart: 2, beatDuration: 2, midiPitch: 74 },
          { noteId: "a-m3-n1", measureIndex: 3, beatStart: 0, beatDuration: 2, midiPitch: 74 },
          { noteId: "a-m3-n2", measureIndex: 3, beatStart: 2, beatDuration: 1, midiPitch: 71 },
          { noteId: "a-m3-n3", measureIndex: 3, beatStart: 3, beatDuration: 1, midiPitch: 69 },
          { noteId: "a-m4-n1", measureIndex: 4, beatStart: 0, beatDuration: 1, midiPitch: 67 },
          { noteId: "a-m4-n2", measureIndex: 4, beatStart: 1, beatDuration: 1, midiPitch: 66 },
          { noteId: "a-m4-n3", measureIndex: 4, beatStart: 2, beatDuration: 1, midiPitch: 64 },
          { noteId: "a-m4-n4", measureIndex: 4, beatStart: 3, beatDuration: 1, midiPitch: 62 },
        ],
      },
      {
        sectionId: "section-b",
        title: "附点与切分节奏片段",
        tempo: 80,
        meter: "4/4",
        demoAudio: "",
        notes: [
          { noteId: "b-m1-n1", measureIndex: 1, beatStart: 0, beatDuration: 1.5, midiPitch: 69 },
          { noteId: "b-m1-n2", measureIndex: 1, beatStart: 1.5, beatDuration: 0.5, midiPitch: 71 },
          { noteId: "b-m1-n3", measureIndex: 1, beatStart: 2, beatDuration: 1, midiPitch: 72 },
          { noteId: "b-m1-n4", measureIndex: 1, beatStart: 3, beatDuration: 1, midiPitch: 74 },
          { noteId: "b-m2-n1", measureIndex: 2, beatStart: 0, beatDuration: 0.5, midiPitch: 74 },
          { noteId: "b-m2-n2", measureIndex: 2, beatStart: 0.5, beatDuration: 1.5, midiPitch: 72 },
          { noteId: "b-m2-n3", measureIndex: 2, beatStart: 2, beatDuration: 1, midiPitch: 71 },
          { noteId: "b-m2-n4", measureIndex: 2, beatStart: 3, beatDuration: 1, midiPitch: 69 },
          { noteId: "b-m3-n1", measureIndex: 3, beatStart: 0, beatDuration: 1, midiPitch: 67 },
          { noteId: "b-m3-n2", measureIndex: 3, beatStart: 1, beatDuration: 1, midiPitch: 69 },
          { noteId: "b-m3-n3", measureIndex: 3, beatStart: 2, beatDuration: 2, midiPitch: 71 },
        ],
      },
    ],
  },
  {
    pieceId: "pentatonic-lyrical-study",
    title: "五声音阶旋律练习",
    composer: "研究任务曲目 B",
    targetSkills: ["连贯句法", "慢速节奏控制", "音高稳定区"],
    difficulty: "高校二胡专业中级段",
    sections: [
      {
        sectionId: "section-a",
        title: "歌唱性慢板句",
        tempo: 60,
        meter: "4/4",
        demoAudio: "",
        notes: [
          { noteId: "c-m1-n1", measureIndex: 1, beatStart: 0, beatDuration: 2, midiPitch: 67 },
          { noteId: "c-m1-n2", measureIndex: 1, beatStart: 2, beatDuration: 2, midiPitch: 69 },
          { noteId: "c-m2-n1", measureIndex: 2, beatStart: 0, beatDuration: 1, midiPitch: 71 },
          { noteId: "c-m2-n2", measureIndex: 2, beatStart: 1, beatDuration: 1, midiPitch: 74 },
          { noteId: "c-m2-n3", measureIndex: 2, beatStart: 2, beatDuration: 2, midiPitch: 76 },
          { noteId: "c-m3-n1", measureIndex: 3, beatStart: 0, beatDuration: 1, midiPitch: 74 },
          { noteId: "c-m3-n2", measureIndex: 3, beatStart: 1, beatDuration: 1, midiPitch: 71 },
          { noteId: "c-m3-n3", measureIndex: 3, beatStart: 2, beatDuration: 2, midiPitch: 69 },
          { noteId: "c-m4-n1", measureIndex: 4, beatStart: 0, beatDuration: 4, midiPitch: 67 },
        ],
      },
    ],
  },
  {
    pieceId: "bowing-rhythm-cell",
    title: "均分节奏与重音控制",
    composer: "研究任务曲目 C",
    targetSkills: ["节奏稳定", "重音清晰", "快速定位错误音"],
    difficulty: "高校二胡专业节奏控制段",
    sections: [
      {
        sectionId: "section-a",
        title: "八分音符均分练习",
        tempo: 96,
        meter: "2/4",
        demoAudio: "",
        notes: [
          { noteId: "d-m1-n1", measureIndex: 1, beatStart: 0, beatDuration: 0.5, midiPitch: 62 },
          { noteId: "d-m1-n2", measureIndex: 1, beatStart: 0.5, beatDuration: 0.5, midiPitch: 64 },
          { noteId: "d-m1-n3", measureIndex: 1, beatStart: 1, beatDuration: 0.5, midiPitch: 66 },
          { noteId: "d-m1-n4", measureIndex: 1, beatStart: 1.5, beatDuration: 0.5, midiPitch: 67 },
          { noteId: "d-m2-n1", measureIndex: 2, beatStart: 0, beatDuration: 0.5, midiPitch: 69 },
          { noteId: "d-m2-n2", measureIndex: 2, beatStart: 0.5, beatDuration: 0.5, midiPitch: 67 },
          { noteId: "d-m2-n3", measureIndex: 2, beatStart: 1, beatDuration: 0.5, midiPitch: 66 },
          { noteId: "d-m2-n4", measureIndex: 2, beatStart: 1.5, beatDuration: 0.5, midiPitch: 64 },
          { noteId: "d-m3-n1", measureIndex: 3, beatStart: 0, beatDuration: 0.5, midiPitch: 62 },
          { noteId: "d-m3-n2", measureIndex: 3, beatStart: 0.5, beatDuration: 0.5, midiPitch: 64 },
          { noteId: "d-m3-n3", measureIndex: 3, beatStart: 1, beatDuration: 0.5, midiPitch: 66 },
          { noteId: "d-m3-n4", measureIndex: 3, beatStart: 1.5, beatDuration: 0.5, midiPitch: 69 },
        ],
      },
    ],
  },
];

function summarizeSection(section) {
  const totalBeats = section.notes.reduce((sum, note) => sum + Number(note.beatDuration || 0), 0);
  return {
    sectionId: section.sectionId,
    title: section.title,
    tempo: section.tempo,
    meter: section.meter,
    demoAudio: section.demoAudio,
    noteCount: section.notes.length,
    measureCount: Math.max(...section.notes.map((note) => Number(note.measureIndex || 1))),
    totalBeats,
  };
}

export function getErhuPieceSummaries() {
  return ERHU_STUDY_PIECES.map((piece) => ({
    pieceId: piece.pieceId,
    title: piece.title,
    composer: piece.composer,
    targetSkills: piece.targetSkills,
    difficulty: piece.difficulty,
    sections: piece.sections.map((section) => summarizeSection(section)),
  }));
}

export function getErhuPiece(pieceId) {
  return ERHU_STUDY_PIECES.find((piece) => piece.pieceId === pieceId) || null;
}

export function getErhuSection(pieceId, sectionId) {
  const piece = getErhuPiece(pieceId);
  if (!piece) return null;
  const section = piece.sections.find((item) => item.sectionId === sectionId) || null;
  if (!section) return null;
  return {
    pieceId: piece.pieceId,
    title: piece.title,
    composer: piece.composer,
    targetSkills: piece.targetSkills,
    difficulty: piece.difficulty,
    ...section,
  };
}
