import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { SttStatus } from '../../shared/audio';

export interface SttPaths {
  /** Configured binary, or null to use `whisper-cli` on PATH. */
  binaryPath: string | null;
  /** Configured model, or null to use the default in the data dir. */
  modelPath: string | null;
  /** Default model location: <userData>/models/ggml-base.en.bin. */
  defaultModelPath: string;
  /** Configured tinydiarize model, or null to use the default in the data dir. */
  tdrzModelPath?: string | null;
  /** Default tdrz model location: <userData>/models/ggml-small.en-tdrz.bin. */
  defaultTdrzModelPath?: string;
}

export interface Transcript {
  text: string;
  ms: number;
  /** Speaker-turn segments (only when diarize was requested and the tdrz model is present). */
  turns?: string[];
  /** Channel-diarized segments (stereo input with -di): speaker "0" = left, "1" = right, "?" = unclear. */
  channels?: ChannelSegment[];
}

export interface ChannelSegment {
  text: string;
  speaker: '0' | '1' | '?';
}

export interface DiarizeStatus {
  available: boolean;
  model: string;
  reason: string | null;
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

/** Joins whisper's stdout lines, stripping any timestamp prefix and backend log noise. */
function joinedText(stdout: string): string {
  return stdout
    .split('\n')
    .map((l) => l.replace(/^\s*\[[0-9:.,\s>-]+\]\s*/, '').trim()) // strip any [hh:mm:ss] prefix defensively
    .filter((l) => l.length > 0 && !/^load_backend:/.test(l))
    .join(' ');
}

/** whisper.cpp prints the transcript to stdout with -np -nt; this cleans it up. */
export function parseTranscript(stdout: string): string {
  return joinedText(stdout)
    .replace(/\[SPEAKER_TURN\]/g, ' ') // tinydiarize turn markers aren't speech
    .replace(/\s+/g, ' ')
    .trim();
}

/** A segment of whisper's JSON output; tinydiarize sets speaker_turn_next, -di sets speaker. */
export interface WhisperJsonSegment {
  text: string;
  speaker_turn_next?: boolean;
  speaker?: string;
}

/**
 * From whisper's -di JSON (stereo input), group consecutive segments by channel speaker.
 * whisper compares channel energy per segment: "0" = left louder, "1" = right, "?" = unclear.
 */
export function parseChannelSegments(segments: WhisperJsonSegment[]): ChannelSegment[] {
  const out: ChannelSegment[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const speaker: ChannelSegment['speaker'] = seg.speaker === '0' || seg.speaker === '1' ? seg.speaker : '?';
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) last.text = `${last.text} ${text}`;
    else out.push({ text, speaker });
  }
  return out;
}

/**
 * Builds speaker-turn segments from whisper's -tdrz JSON. A turn ends where a segment has
 * speaker_turn_next: consecutive segments are joined until then. Detection is best-effort
 * (tinydiarize misses some turns), so with no flags set this returns one combined turn.
 */
export function parseTurnsFromJson(segments: WhisperJsonSegment[]): string[] {
  const turns: string[] = [];
  let cur = '';
  for (const seg of segments) {
    cur += (cur ? ' ' : '') + (seg.text ?? '').trim();
    if (seg.speaker_turn_next) {
      const t = cur.replace(/\s+/g, ' ').trim();
      if (t) turns.push(t);
      cur = '';
    }
  }
  const last = cur.replace(/\s+/g, ' ').trim();
  if (last) turns.push(last);
  return turns;
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

  /** Whether tinydiarize (speaker-turn labels) can run: the whisper binary plus a tdrz model. */
  diarizeStatus(): DiarizeStatus {
    const p = this.paths();
    const binary = p.binaryPath ?? 'whisper-cli';
    const model = p.tdrzModelPath ?? p.defaultTdrzModelPath ?? '';
    const binaryFound = isAbsolute(binary) ? existsSync(binary) : true;
    const modelFound = model !== '' && existsSync(model);
    const reason = !binaryFound
      ? `whisper-cli not found at ${binary}.`
      : !modelFound
        ? `Speaker-turn model not found at ${model || '(unset)'}. Download ggml-small.en-tdrz.bin there to label speakers.`
        : null;
    return { available: binaryFound && modelFound, model, reason };
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

  async transcribe(wavPath: string, opts: { language?: string; threads?: number; timeoutMs?: number; diarize?: boolean; stereo?: boolean } = {}): Promise<Transcript> {
    const { binary } = this.resolved();
    if (opts.stereo === true) {
      // Stereo input: whisper's channel diarization labels each segment by the louder channel.
      const s = this.status();
      if (!s.available) throw new Error(s.reason ?? 'Speech-to-text is not available.');
      const base = wavPath.replace(/\.wav$/i, '');
      const jsonPath = `${base}.json`;
      const t0 = Date.now();
      await this.run(binary, ['-m', s.model, '-f', wavPath, '-np', '-l', opts.language ?? 'en', '-t', String(opts.threads ?? 4), '-di', '-oj', '-of', base], opts.timeoutMs ?? 120_000);
      try {
        const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as { transcription?: WhisperJsonSegment[] };
        const channels = parseChannelSegments(parsed.transcription ?? []);
        return { text: channels.map((c) => c.text).join(' '), ms: Date.now() - t0, channels };
      } finally {
        await rm(jsonPath, { force: true });
      }
    }
    // Diarize with the tdrz model when asked and available; otherwise fall back to normal STT.
    const tdrz = opts.diarize === true && this.diarizeStatus().available;
    let model: string;
    if (tdrz) {
      model = this.diarizeStatus().model;
    } else {
      const s = this.status();
      if (!s.available) throw new Error(s.reason ?? 'Speech-to-text is not available.');
      model = s.model;
    }
    const t0 = Date.now();
    if (tdrz) {
      // tinydiarize marks speaker turns only in the JSON (speaker_turn_next), so write JSON and read it back.
      const base = wavPath.replace(/\.wav$/i, '');
      const jsonPath = `${base}.json`;
      const args = ['-m', model, '-f', wavPath, '-np', '-l', opts.language ?? 'en', '-t', String(opts.threads ?? 4), '-tdrz', '-oj', '-of', base];
      await this.run(binary, args, opts.timeoutMs ?? 120_000);
      try {
        const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as { transcription?: WhisperJsonSegment[] };
        const turns = parseTurnsFromJson(parsed.transcription ?? []);
        return { text: turns.join(' '), ms: Date.now() - t0, turns };
      } finally {
        await rm(jsonPath, { force: true });
      }
    }
    const args = ['-m', model, '-f', wavPath, '-nt', '-np', '-l', opts.language ?? 'en', '-t', String(opts.threads ?? 4)];
    const stdout = await this.run(binary, args, opts.timeoutMs ?? 120_000);
    return { text: parseTranscript(stdout), ms: Date.now() - t0 };
  }
}
