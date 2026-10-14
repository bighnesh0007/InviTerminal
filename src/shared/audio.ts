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

export interface LiveTranscriptStatus {
  active: boolean;
  /** The capture source being recorded (a PipeWire monitor), or null when idle. */
  source: string | null;
  /** ISO start time, for the elapsed indicator. */
  since: string | null;
  /** Lines emitted so far this session. */
  lines: number;
  /** Set when live transcription can't run (e.g. no whisper model). */
  reason: string | null;
  /** Whether speaker-turn labelling (tinydiarize) is available (the tdrz model is present). */
  diarizeAvailable: boolean;
  /** Whether this session is labelling speaker turns. */
  diarizing: boolean;
}

export interface LiveLine {
  text: string;
  at: string;
  /** Speaker-turn label (e.g. "Speaker 1") when diarizing; absent otherwise. Turn detection within a chunk, not a persistent identity. */
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
