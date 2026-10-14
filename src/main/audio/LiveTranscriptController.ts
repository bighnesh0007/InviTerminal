import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSilenceTranscript, type LiveLine, type LiveTranscriptStatus, type SttStatus } from '../../shared/audio';
import { WHISPER_SAMPLE_RATE, wrapPcm16Wav } from '../../shared/wav';
import { PcmChunker } from './PcmChunker';

/** The slice of WhisperStt the live controller needs (so tests use a fake transcriber). */
export interface Transcriber {
  status(): SttStatus;
  diarizeStatus(): { available: boolean; model: string; reason: string | null };
  transcribe(wavPath: string, opts?: { timeoutMs?: number; diarize?: boolean }): Promise<{ text: string; ms: number; turns?: string[] }>;
}

/** A running capture process. Injectable so tests drive a fake instead of parecord. */
export interface CaptureProcess {
  onData(cb: (bytes: Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
  kill(): void;
}
export type StartCapture = (source: string) => CaptureProcess;

/** Real capture: parecord streaming raw 16 kHz mono s16le PCM from a PipeWire monitor to stdout. */
export const parecordCapture: StartCapture = (source) => {
  const child = spawn('parecord', ['-d', source, '--rate=16000', '--channels=1', '--format=s16le', '--raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    onData: (cb) => child.stdout?.on('data', (d: Buffer) => cb(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))),
    onError: (cb) => child.on('error', (e) => cb(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'parecord not found (install pipewire-pulse / pulseaudio-utils)' : e.message))),
    onClose: (cb) => child.on('close', () => cb()),
    kill: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    },
  };
};

/** Default capture source: the current output sink's PipeWire monitor. Injectable `run` for tests. */
export function defaultMonitorSource(run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { timeout: 3000 }).toString()): string | null {
  try {
    const sink = run('pactl', ['get-default-sink']).trim();
    return sink ? `${sink}.monitor` : null;
  } catch {
    return null;
  }
}

export interface LiveEmit {
  line(l: LiveLine): void;
  state(s: LiveTranscriptStatus): void;
  error(msg: string): void;
}

/** How many chunks may queue before the oldest is dropped (keeps the transcript live, not lagging). */
const MAX_QUEUE = 3;

/**
 * Live meeting transcription (Phase 1): continuously captures the system audio
 * (a PipeWire monitor), splits it into fixed chunks, and transcribes each one
 * locally with whisper — emitting a running transcript. CONSENT-GATED: capturing
 * a call records everyone in it, so start() refuses without consent and the app
 * shows a recording indicator. Audio never leaves the machine.
 */
export class LiveTranscriptController {
  private proc: CaptureProcess | null = null;
  private chunker: PcmChunker | null = null;
  private queue: Uint8Array[] = [];
  private working = false;
  private source: string | null = null;
  private since: string | null = null;
  private lineCount = 0;
  private diarize = false;

  constructor(
    private readonly stt: Transcriber,
    private readonly startCapture: StartCapture,
    private readonly resolveSource: () => string | null,
    private readonly chunkSeconds: () => number,
    private readonly emit: LiveEmit,
  ) {}

  get isActive(): boolean {
    return this.proc !== null;
  }

  status(): LiveTranscriptStatus {
    const s = this.stt.status();
    return {
      active: this.proc !== null,
      source: this.source,
      since: this.since,
      lines: this.lineCount,
      reason: s.available ? null : s.reason,
      diarizeAvailable: this.stt.diarizeStatus().available,
      diarizing: this.diarize,
    };
  }

  private emitState(): void {
    this.emit.state(this.status());
  }

  /**
   * @param consent must be true — the user confirms everyone in the call is informed.
   * @param diarize label speaker turns (only takes effect if the tdrz model is present).
   */
  async start(consent: boolean, diarize = false): Promise<LiveTranscriptStatus> {
    if (this.proc) return this.status();
    if (!consent) throw new Error('Live transcription records everyone in the call. Confirm that they have been told, then start.');
    const stt = this.stt.status();
    if (!stt.available) throw new Error(stt.reason ?? 'Speech-to-text is not available.');
    const source = this.resolveSource();
    if (!source) throw new Error('No audio capture source found. Play the call through your speakers, or set a source in Settings.');

    this.diarize = diarize && this.stt.diarizeStatus().available;
    const seconds = Math.min(30, Math.max(3, Math.round(this.chunkSeconds())));
    this.chunker = new PcmChunker(seconds * WHISPER_SAMPLE_RATE * 2);
    this.source = source;
    this.since = new Date().toISOString();
    this.lineCount = 0;
    this.queue = [];

    const proc = this.startCapture(source);
    this.proc = proc;
    proc.onData((b) => this.onBytes(b));
    proc.onError((e) => this.emit.error(e.message));
    proc.onClose(() => {
      if (this.proc === proc) void this.stop();
    });
    this.emitState();
    return this.status();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
    this.chunker = null;
    this.queue = [];
    this.source = null;
    this.since = null;
    this.diarize = false;
    this.emitState();
  }

  private onBytes(bytes: Uint8Array): void {
    if (!this.chunker) return;
    for (const chunk of this.chunker.push(bytes)) {
      this.queue.push(chunk);
      if (this.queue.length > MAX_QUEUE) this.queue.shift(); // drop oldest; stay live
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.shift();
        if (chunk) await this.transcribeChunk(chunk);
      }
    } finally {
      this.working = false;
    }
  }

  private async transcribeChunk(chunk: Uint8Array): Promise<void> {
    const wav = wrapPcm16Wav(chunk);
    const dir = await mkdtemp(join(tmpdir(), 'invi-live-'));
    const file = join(dir, 'chunk.wav');
    try {
      await writeFile(file, wav, { mode: 0o600 });
      const r = await this.stt.transcribe(file, { timeoutMs: 60_000, diarize: this.diarize });
      if (!this.proc) return; // stopped while transcribing
      const at = new Date().toISOString();
      if (this.diarize && r.turns && r.turns.length > 0) {
        // [SPEAKER_TURN] marks a change, so segments alternate between two speakers. This is
        // turn detection within a chunk, not a persistent identity across chunks.
        let speaker = 0;
        let emitted = false;
        for (const seg of r.turns) {
          const t = seg.trim();
          if (!t || isSilenceTranscript(t)) continue;
          this.lineCount++;
          this.emit.line({ text: t, at, speaker: `Speaker ${speaker + 1}` });
          speaker = (speaker + 1) % 2;
          emitted = true;
        }
        if (emitted) this.emitState();
      } else {
        const text = r.text.trim();
        if (text && !isSilenceTranscript(text)) {
          this.lineCount++;
          this.emit.line({ text, at });
          this.emitState();
        }
      }
    } catch (e) {
      this.emit.error((e as Error).message);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
