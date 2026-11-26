/**
 * The sound Aura plays when a session starts waiting for the user. The
 * built-in ones are synthesized with Web Audio, so nothing ships as a file;
 * "custom" plays a sound file the user picked (kept as a data: URL).
 */
import type { WaitingSound } from "../state/store";

type Note = { freq: number; at: number; length: number; type?: OscillatorType; gain?: number };

/** Each built-in sound as notes: frequency (Hz), start and length (seconds). */
const SOUNDS: Record<Exclude<WaitingSound, "custom" | "none">, Note[]> = {
  // Two rising notes, like a doorbell's friendly cousin.
  chime: [
    { freq: 880, at: 0, length: 0.35, type: "sine" },
    { freq: 1318.5, at: 0.12, length: 0.5, type: "sine" },
  ],
  // One bright strike with a soft overtone.
  bell: [
    { freq: 1046.5, at: 0, length: 0.9, type: "sine" },
    { freq: 2093, at: 0, length: 0.5, type: "sine", gain: 0.25 },
  ],
  // A short, round blip.
  pop: [{ freq: 520, at: 0, length: 0.12, type: "triangle" }],
  // Three low, quiet notes.
  soft: [
    { freq: 523.25, at: 0, length: 0.3, type: "sine", gain: 0.7 },
    { freq: 659.25, at: 0.14, length: 0.3, type: "sine", gain: 0.7 },
    { freq: 783.99, at: 0.28, length: 0.45, type: "sine", gain: 0.7 },
  ],
};

export const SOUND_CHOICES: { value: WaitingSound; label: string }[] = [
  { value: "chime", label: "Chime" },
  { value: "bell", label: "Bell" },
  { value: "pop", label: "Pop" },
  { value: "soft", label: "Soft" },
  { value: "custom", label: "Your own file…" },
  { value: "none", label: "No sound" },
];

/** Largest sound file accepted (it is kept in the app's settings). */
export const MAX_SOUND_FILE = 2 * 1024 * 1024;

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  // A context created before any user gesture starts suspended.
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

function playNotes(notes: Note[], volume: number) {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + 0.01;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.freq;
    const peak = Math.max(0.0001, volume * (n.gain ?? 1) * 0.35);
    // Quick attack, smooth exponential decay: no clicks.
    gain.gain.setValueAtTime(0.0001, start + n.at);
    gain.gain.exponentialRampToValueAtTime(peak, start + n.at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.at + n.length);
    osc.connect(gain).connect(ac.destination);
    osc.start(start + n.at);
    osc.stop(start + n.at + n.length + 0.05);
  }
}

/** Play `sound` at `volume` (0–1). A custom sound without a file plays nothing. */
export function playSound(sound: WaitingSound, volume: number, file: string | null = null) {
  const v = Math.min(1, Math.max(0, volume));
  if (sound === "none" || v === 0) return;
  try {
    if (sound === "custom") {
      if (!file) return;
      const el = new Audio(file);
      el.volume = v;
      void el.play().catch(() => {});
      return;
    }
    playNotes(SOUNDS[sound], v);
  } catch {
    /* no audio output */
  }
}
