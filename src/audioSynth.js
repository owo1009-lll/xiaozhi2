const AudioContextRef =
  typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;

let audioContextInstance = null;

function getAudioContext() {
  if (!AudioContextRef) return null;
  if (!audioContextInstance) {
    audioContextInstance = new AudioContextRef();
  }
  return audioContextInstance;
}

export async function unlockAudio() {
  const context = getAudioContext();
  if (!context) return null;
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return null;
    }
  }
  return context;
}

export function midiToFrequency(midiPitch) {
  return 440 * Math.pow(2, (Number(midiPitch) - 69) / 12);
}

export async function playReferenceNotes(notes = [], tempo = 72) {
  const context = await unlockAudio();
  if (!context || !Array.isArray(notes) || !notes.length) return () => {};

  const master = context.createGain();
  master.gain.value = 0.18;
  master.connect(context.destination);

  const startAt = context.currentTime + 0.04;
  const beatSeconds = 60 / Math.max(36, Number(tempo) || 72);
  const stopHandles = [];

  notes.forEach((note, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const duration = Math.max(0.18, Number(note.beatDuration || 1) * beatSeconds);
    const begin = startAt + notes.slice(0, index).reduce((sum, current) => sum + Math.max(0.18, Number(current.beatDuration || 1) * beatSeconds), 0);
    const frequency = midiToFrequency(note.midiPitch);

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, begin);
    gain.gain.setValueAtTime(0.0001, begin);
    gain.gain.linearRampToValueAtTime(0.18, begin + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + duration);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(begin);
    oscillator.stop(begin + duration + 0.06);
    stopHandles.push(() => {
      try {
        oscillator.stop();
      } catch {}
    });
  });

  return () => {
    stopHandles.forEach((stop) => stop());
    try {
      master.disconnect();
    } catch {}
  };
}
