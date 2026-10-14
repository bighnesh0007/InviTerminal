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
