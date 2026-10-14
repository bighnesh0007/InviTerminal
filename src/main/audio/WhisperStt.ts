import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SttStatus } from '../../shared/audio';

export interface SttPaths {
  /** Configured binary, or null to use `whisper-cli` on PATH. */
  binaryPath: string | null;
  /** Configured model, or null to use the default in the data dir. */
  modelPath: string | null;
  /** Default model location: <userData>/models/ggml-base.en.bin. */
  defaultModelPath: string;
}

export interface Transcript {
  text: string;
  ms: number;
}

/** Injectable so tests can run the real binary or a fake. */
export type RunWhisper = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const realRun: RunWhisper = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'whisper-cli not found' : stderr.trim() || err.message));
      else resolve(stdout);
    });
  });

/** whisper.cpp prints the transcript to stdout with -np -nt; this cleans it up. */
export function parseTranscript(stdout: string): string {
  return stdout
    .split('\n')
    .map((l) => l.replace(/^\s*\[[0-9:.,\s>-]+\]\s*/, '').trim()) // strip any [hh:mm:ss] prefix defensively
    .filter((l) => l.length > 0 && !/^load_backend:/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Local speech-to-text via the whisper.cpp CLI. No audio leaves the machine:
 * the wav is written to a temp file, transcribed by the local binary, and the
 * file is deleted by the caller. Spawned with an explicit argv — no shell.
 */
export class WhisperStt {
  constructor(
    private readonly paths: () => SttPaths,
    private readonly run: RunWhisper = realRun,
  ) {}

  private resolved(): { binary: string; model: string } {
    const p = this.paths();
    return { binary: p.binaryPath ?? 'whisper-cli', model: p.modelPath ?? p.defaultModelPath };
  }

  status(): SttStatus {
    const { binary, model } = this.resolved();
    // An absolute binary path must exist; a bare name is assumed on PATH.
    const binaryFound = isAbsolute(binary) ? existsSync(binary) : true;
    const modelFound = existsSync(model);
    const reason = !modelFound
      ? `Whisper model not found at ${model}. Download ggml-base.en.bin there, or set the model path in Settings.`
      : !binaryFound
        ? `whisper-cli not found at ${binary}.`
        : null;
    return { available: binaryFound && modelFound, binary, binaryFound, model, modelFound, reason };
  }

  async transcribe(wavPath: string, opts: { language?: string; threads?: number; timeoutMs?: number } = {}): Promise<Transcript> {
    const s = this.status();
    if (!s.available) throw new Error(s.reason ?? 'Speech-to-text is not available.');
    const args = ['-m', s.model, '-f', wavPath, '-nt', '-np', '-l', opts.language ?? 'en', '-t', String(opts.threads ?? 4)];
    const t0 = Date.now();
    const stdout = await this.run(s.binary, args, opts.timeoutMs ?? 120_000);
    return { text: parseTranscript(stdout), ms: Date.now() - t0 };
  }
}
