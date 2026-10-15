import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSilenceTranscript, type LiveLine, type LiveTranscriptStatus, type ModeAvailability, type SpeakerMode, type SttStatus } from '../../shared/audio';
import { WHISPER_SAMPLE_RATE, wrapPcm16Wav } from '../../shared/wav';
import { PcmChunker } from './PcmChunker';
import { StereoMixer } from './StereoMixer';

/** The slice of WhisperStt the live controller needs (so tests use a fake transcriber). */
export interface Transcriber {
  status(): SttStatus;
  diarizeStatus(): { available: boolean; model: string; reason: string | null };
  transcribe(
    wavPath: string,
    opts?: { timeoutMs?: number; diarize?: boolean; stereo?: boolean },
  ): Promise<{ text: string; ms: number; turns?: string[]; channels?: { text: string; speaker: '0' | '1' | '?' }[] }>;
}

/** A running capture process. Injectable so tests drive a fake instead of parecord. */
export interface CaptureProcess {
  onData(cb: (bytes: Uint8Array) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
  kill(): void;
}
export type StartCapture = (source: string, channels: 1 | 2) => CaptureProcess;

/** Real capture: parecord streaming raw 16 kHz s16le PCM (mono or stereo) from a PipeWire source to stdout. */
export const parecordCapture: StartCapture = (source, channels) => {
  const child = spawn('parecord', ['-d', source, '--rate=16000', `--channels=${channels}`, '--format=s16le', '--raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
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

type Run = (cmd: string, args: string[]) => string;
const realRun: Run = (c, a) => execFileSync(c, a, { timeout: 3000 }).toString();

/** Default capture source: the current output sink's PipeWire monitor (what's playing). */
export function defaultMonitorSource(run: Run = realRun): string | null {
  try {
    const sink = run('pactl', ['get-default-sink']).trim();
    return sink ? `${sink}.monitor` : null;
  } catch {
    return null;
  }
}

/** Default microphone: the default PipeWire source, unless that is itself a monitor (no mic). */
export function defaultMicSource(run: Run = realRun): string | null {
  try {
    const src = run('pactl', ['get-default-source']).trim();
    return src && !src.endsWith('.monitor') ? src : null;
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

/** Channel labels per stereo mode: whisper's -di reports "0" (left louder) / "1" (right louder). */
const CHANNEL_LABELS: Record<'you-them' | 'stereo', Record<'0' | '1', string>> = {
  'you-them': { '0': 'You', '1': 'Them' },
  stereo: { '0': 'Left', '1': 'Right' },
};

interface Session {
  source: string;
  mic: string | null;
  mode: SpeakerMode;
  since: string;
}

/**
 * Live meeting transcription: captures the call audio playing on this machine (a PipeWire
 * monitor) — plus, in "You / Them" mode, the microphone on a second channel — splits it into
 * fixed chunks, and transcribes each one locally with whisper. CONSENT-GATED: capturing a call
 * records everyone in it, so start() refuses without consent and the app shows an indicator.
 * Pause stops the recorder entirely (nothing is captured while paused); the session's lines are
 * kept. Audio never leaves the machine.
 */
export class LiveTranscriptController {
  private session: Session | null = null;
  private procs: CaptureProcess[] = [];
  /** Bumped on every (re)start/pause/stop so late callbacks from a killed recorder are ignored. */
  private gen = 0;
  private chunker: PcmChunker | null = null;
  private queue: Uint8Array[] = [];
  private working = false;
  private lineCount = 0;

  constructor(
    private readonly stt: Transcriber,
    private readonly startCapture: StartCapture,
    private readonly resolveSource: () => string | null,
    private readonly chunkSeconds: () => number,
    private readonly emit: LiveEmit,
    private readonly resolveMic: () => string | null = () => null,
  ) {}

  get isActive(): boolean {
    return this.session !== null;
  }

  private get channels(): 1 | 2 {
    return this.session && (this.session.mode === 'you-them' || this.session.mode === 'stereo') ? 2 : 1;
  }

  /** What each speaker mode needs, so the UI can disable the ones that can't run. */
  modes(): Record<SpeakerMode, ModeAvailability> {
    const s = this.stt.status();
    const base: ModeAvailability = s.available ? { available: true, reason: null } : { available: false, reason: s.reason };
    const d = this.stt.diarizeStatus();
    const turns: ModeAvailability = !base.available ? base : d.available ? base : { available: false, reason: d.reason };
    const youThem: ModeAvailability = !base.available ? base : this.resolveMic() ? base : { available: false, reason: 'No microphone found (set a default input device).' };
    return { off: base, turns, 'you-them': youThem, stereo: base };
  }

  status(): LiveTranscriptStatus {
    const s = this.stt.status();
    return {
      active: this.session !== null,
      paused: this.session !== null && this.procs.length === 0,
      source: this.session?.source ?? null,
      since: this.session?.since ?? null,
      lines: this.lineCount,
      reason: s.available ? null : s.reason,
      speakerMode: this.session?.mode ?? 'off',
      modes: this.modes(),
    };
  }

  private emitState(): void {
    this.emit.state(this.status());
  }

  /**
   * @param consent must be true — the user confirms everyone in the call is informed.
   * @param mode how to tell speakers apart (see SpeakerMode); falls back to 'off' only if asked
   *             for a mode that can't run — the caller is told via the error.
   */
  async start(consent: boolean, mode: SpeakerMode = 'off'): Promise<LiveTranscriptStatus> {
    if (this.session) return this.status();
    if (!consent) throw new Error('Live transcription records everyone in the call. Confirm that they have been told, then start.');
    const stt = this.stt.status();
    if (!stt.available) throw new Error(stt.reason ?? 'Speech-to-text is not available.');
    const avail = this.modes()[mode];
    if (!avail.available) throw new Error(avail.reason ?? `Speaker mode "${mode}" is not available.`);
    const source = this.resolveSource();
    if (!source) throw new Error('No audio capture source found. Play the call through your speakers, or set a source in Settings.');
    const mic = mode === 'you-them' ? this.resolveMic() : null;

    this.session = { source, mic, mode, since: new Date().toISOString() };
    this.lineCount = 0;
    this.startRecorders();
    this.emitState();
    return this.status();
  }

  /** Stop recording but keep the session (and its lines); resume() continues it. */
  pause(): void {
    if (!this.session || this.procs.length === 0) return;
    this.killRecorders();
    this.emitState();
  }

  resume(): void {
    if (!this.session || this.procs.length > 0) return;
    this.startRecorders();
    this.emitState();
  }

  async stop(): Promise<void> {
    this.killRecorders();
    this.session = null;
    this.emitState();
  }

  private killRecorders(): void {
    this.gen++;
    const procs = this.procs;
    this.procs = [];
    for (const p of procs) p.kill();
    this.chunker = null; // a partial chunk from before a pause is dropped, never stitched to later audio
    this.queue = [];
  }

  private startRecorders(): void {
    const session = this.session!;
    const gen = ++this.gen;
    const seconds = Math.min(30, Math.max(3, Math.round(this.chunkSeconds())));
    this.chunker = new PcmChunker(seconds * WHISPER_SAMPLE_RATE * 2 * this.channels);
    const live = () => gen === this.gen;
    const watch = (p: CaptureProcess) => {
      p.onError((e) => live() && this.emit.error(e.message));
      // A recorder that exits on its own (device unplugged, parecord died) ends the session.
      p.onClose(() => {
        if (live()) void this.stop();
      });
    };

    if (session.mode === 'you-them' && session.mic) {
      const mixer = new StereoMixer();
      const mic = this.startCapture(session.mic, 1);
      const call = this.startCapture(session.source, 1);
      this.procs = [mic, call];
      mic.onData((b) => live() && this.onBytes(mixer.pushLeft(b)));
      call.onData((b) => live() && this.onBytes(mixer.pushRight(b)));
      watch(mic);
      watch(call);
    } else {
      const p = this.startCapture(session.source, this.channels);
      this.procs = [p];
      p.onData((b) => live() && this.onBytes(b));
      watch(p);
    }
  }

  private onBytes(bytes: Uint8Array): void {
    if (!this.chunker || bytes.length === 0) return;
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

  private emitLine(text: string, at: string, speaker?: string): boolean {
    const t = text.trim();
    if (!t || isSilenceTranscript(t)) return false;
    this.lineCount++;
    this.emit.line(speaker ? { text: t, at, speaker } : { text: t, at });
    return true;
  }

  private async transcribeChunk(chunk: Uint8Array): Promise<void> {
    const session = this.session;
    if (!session) return;
    const channels = this.channels;
    const wav = wrapPcm16Wav(chunk, WHISPER_SAMPLE_RATE, channels);
    const dir = await mkdtemp(join(tmpdir(), 'invi-live-'));
    const file = join(dir, 'chunk.wav');
    try {
      await writeFile(file, wav, { mode: 0o600 });
      const r = await this.stt.transcribe(file, { timeoutMs: 60_000, diarize: session.mode === 'turns', stereo: channels === 2 });
      if (this.session !== session) return; // stopped while transcribing
      const at = new Date().toISOString();
      let emitted = false;
      if ((session.mode === 'you-them' || session.mode === 'stereo') && r.channels) {
        const labels = CHANNEL_LABELS[session.mode];
        for (const seg of r.channels) emitted = this.emitLine(seg.text, at, seg.speaker === '?' ? undefined : labels[seg.speaker]) || emitted;
      } else if (session.mode === 'turns' && r.turns && r.turns.length > 0) {
        // A turn flag marks a change, so segments alternate between two speakers. Turn detection
        // within a chunk, not a persistent identity across chunks.
        r.turns.forEach((seg, i) => {
          emitted = this.emitLine(seg, at, `Speaker ${(i % 2) + 1}`) || emitted;
        });
      } else {
        emitted = this.emitLine(r.text, at);
      }
      if (emitted) this.emitState();
    } catch (e) {
      this.emit.error((e as Error).message);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
