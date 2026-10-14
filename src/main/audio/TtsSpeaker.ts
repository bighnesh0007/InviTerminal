import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TtsStatus } from '../../shared/audio';

export interface TtsPaths {
  /** Configured binary, or null to use `espeak-ng` on PATH. */
  binaryPath: string | null;
  /** Voice/language passed with -v, or null for the engine default. */
  voice: string | null;
}

/** A running utterance: resolves when speech finishes, or can be stopped early. */
export interface Utterance {
  done: Promise<void>;
  stop(): void;
}

/** Injectable so tests drive a fake instead of spawning a real speech engine. */
export type RunTts = (bin: string, args: string[]) => Utterance;

const realRun: RunTts = (bin, args) => {
  const child = execFile(bin, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${bin} not found` : e.message)));
    child.on('close', () => resolve());
  });
  // Swallow a late rejection if nobody is awaiting (e.g. after stop()) so it never becomes unhandled.
  done.catch(() => undefined);
  return {
    done,
    stop: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
};

/** espeak(-ng) refuses pathologically long argv; interviewer turns are short, so cap defensively. */
const MAX_TEXT = 8000;

/**
 * Local text-to-speech via a CLI engine (espeak-ng by default). Nothing leaves
 * the machine: the text is spoken by the local binary straight to the default
 * audio sink. Spawned with an explicit argv — no shell. One utterance at a
 * time: a new speak() cancels the previous one.
 */
export class TtsSpeaker {
  private current: Utterance | null = null;

  constructor(
    private readonly paths: () => TtsPaths,
    private readonly run: RunTts = realRun,
  ) {}

  private resolved(): { binary: string; voice: string | null } {
    const p = this.paths();
    return { binary: p.binaryPath ?? 'espeak-ng', voice: p.voice };
  }

  status(): TtsStatus {
    const { binary, voice } = this.resolved();
    // An absolute binary path must exist; a bare name is assumed on PATH (like WhisperStt).
    const binaryFound = isAbsolute(binary) ? existsSync(binary) : true;
    const reason = binaryFound ? null : `Text-to-speech binary not found at ${binary}. Install espeak-ng, or set the path in Settings.`;
    return { available: binaryFound, binary, binaryFound, voice, reason };
  }

  /** The text is passed as a trailing argument (no shell, so punctuation is safe). */
  buildArgs(text: string, voice: string | null): string[] {
    return [...(voice ? ['-v', voice] : []), text.slice(0, MAX_TEXT)];
  }

  /** Speak `text`, resolving when it finishes. Cancels any utterance already playing. */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const s = this.status();
    if (!s.available) throw new Error(s.reason ?? 'Text-to-speech is not available.');
    this.stop();
    const utt = this.run(s.binary, this.buildArgs(trimmed, s.voice));
    this.current = utt;
    try {
      await utt.done;
    } finally {
      if (this.current === utt) this.current = null;
    }
  }

  /** Stop any utterance in progress. Safe to call when nothing is playing. */
  stop(): void {
    const utt = this.current;
    this.current = null;
    utt?.stop();
  }
}
