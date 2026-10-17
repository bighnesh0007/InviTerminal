export const AUDIO_KINDS = ['practice', 'meeting', 'mic-test'] as const;
export type AudioKind = (typeof AUDIO_KINDS)[number];

export interface AudioStatus {
  active: boolean;
  kind: AudioKind | null;
  /** ISO time the session started, for the elapsed indicator. */
  since: string | null;
  /** True once consent for a meeting recording (which captures other people) has been given this session. */
  meetingConsented: boolean;
}

export const AUDIO_KIND_LABEL: Record<AudioKind, string> = {
  practice: 'Interview practice',
  meeting: 'Meeting recording',
  'mic-test': 'Microphone test',
};

export interface SttStatus {
  available: boolean;
  binary: string;
  binaryFound: boolean;
  model: string;
  modelFound: boolean;
  reason: string | null;
}

export interface TtsStatus {
  available: boolean;
  binary: string;
  binaryFound: boolean;
  /** Voice/language passed to the engine (e.g. "en"), or null for the engine default. */
  voice: string | null;
  reason: string | null;
}

/**
 * How speakers are told apart in the live transcript.
 * - off:      plain transcript of the call audio.
 * - turns:    whisper tinydiarize on the call audio (best-effort turn detection).
 * - you-them: your microphone on the left channel, the call audio on the right, then whisper's
 *             channel diarization (-di) labels "You" / "Them" — reliable, needs a microphone.
 * - stereo:   the source's own two channels via -di, for sources that put each speaker on a side.
 */
export const SPEAKER_MODES = ['off', 'turns', 'you-them', 'stereo'] as const;
export type SpeakerMode = (typeof SPEAKER_MODES)[number];
export const SPEAKER_MODE_LABELS: Record<SpeakerMode, string> = {
  off: 'Off',
  turns: 'Turns (best-effort)',
  'you-them': 'You / Them',
  stereo: 'Stereo channels',
};

export interface ModeAvailability {
  available: boolean;
  reason: string | null;
}

export interface LiveTranscriptStatus {
  /** A session exists (running or paused). */
  active: boolean;
  /** Session exists but capture is stopped — nothing is being recorded. */
  paused: boolean;
  /** The capture source being recorded (a PipeWire monitor), or null when idle. */
  source: string | null;
  /** ISO start time, for the elapsed indicator. */
  since: string | null;
  /** Lines emitted so far this session. */
  lines: number;
  /** Set when live transcription can't run (e.g. no whisper model). */
  reason: string | null;
  /** The speaker mode of the current session ('off' when idle). */
  speakerMode: SpeakerMode;
  /** Which speaker modes can run on this machine right now. */
  modes: Record<SpeakerMode, ModeAvailability>;
}

export interface LiveLine {
  text: string;
  at: string;
  /**
   * Speaker label when a speaker mode is on: "You"/"Them" (you-them), "Speaker 1"/"Speaker 2"
   * (turns — within-chunk turn detection, not identity), or "Left"/"Right" (stereo). Absent otherwise.
   */
  speaker?: string;
}

/**
 * whisper emits a few stock strings for a silent/near-silent chunk ("you",
 * "[BLANK_AUDIO]", etc.). Dropping them keeps the live transcript clean. Kept
 * conservative so real speech is never filtered.
 */
export function isSilenceTranscript(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,…]+$/g, '').trim();
  if (!t) return true;
  return ['you', 'thank you', 'thanks for watching', '[blank_audio]', '(silence)', 'bye'].includes(t);
}
