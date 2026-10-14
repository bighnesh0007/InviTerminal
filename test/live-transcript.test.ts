import { describe, expect, it, vi } from 'vitest';
import { isSilenceTranscript, type LiveLine, type LiveTranscriptStatus, type SttStatus } from '../src/shared/audio';
import { isWav, wrapPcm16Wav } from '../src/shared/wav';
import { PcmChunker } from '../src/main/audio/PcmChunker';
import { type CaptureProcess, LiveTranscriptController, type StartCapture, type Transcriber } from '../src/main/audio/LiveTranscriptController';

describe('PcmChunker', () => {
  it('emits whole chunks and buffers the remainder', () => {
    const c = new PcmChunker(4);
    expect(c.push(new Uint8Array([1, 2]))).toEqual([]); // not enough yet
    const out = c.push(new Uint8Array([3, 4, 5]));
    expect(out).toHaveLength(1);
    expect([...out[0]!]).toEqual([1, 2, 3, 4]);
    expect([...(c.flush()[0] ?? [])]).toEqual([5]); // 1 byte buffered
  });
  it('emits multiple chunks from one large push', () => {
    const c = new PcmChunker(2);
    const out = c.push(new Uint8Array([1, 2, 3, 4, 5]));
    expect(out.map((x) => [...x])).toEqual([[1, 2], [3, 4]]);
    expect([...(c.flush()[0] ?? [])]).toEqual([5]);
  });
  it('flush is empty when nothing is buffered', () => {
    expect(new PcmChunker(2).flush()).toEqual([]);
  });
});

describe('wrapPcm16Wav', () => {
  it('wraps raw PCM into a valid WAV with correct sizes', () => {
    const pcm = new Uint8Array(3200); // 0.1s of 16k mono s16le
    const wav = wrapPcm16Wav(pcm);
    expect(isWav(wav)).toBe(true);
    expect(wav.length).toBe(44 + 3200);
    const v = new DataView(wav.buffer);
    expect(v.getUint32(40, true)).toBe(3200); // data chunk size
    expect(v.getUint32(24, true)).toBe(16000); // sample rate
  });
});

describe('isSilenceTranscript', () => {
  it('treats whisper silence artifacts and empties as silence', () => {
    for (const s of ['', '  ', 'you', 'You.', 'Thank you.', '[BLANK_AUDIO]', '(silence)']) expect(isSilenceTranscript(s)).toBe(true);
  });
  it('keeps real speech', () => {
    for (const s of ['Tell me about yourself.', 'you should refactor this', 'Thank you for explaining the design.']) expect(isSilenceTranscript(s)).toBe(false);
  });
});

// --- controller ----------------------------------------------------------------------------

const okStt = (): SttStatus => ({ available: true, binary: 'whisper-cli', binaryFound: true, model: 'm', modelFound: true, reason: null });

function fakeTranscriber(script: string[], turns?: string[][]): Transcriber {
  let i = 0;
  return {
    status: okStt,
    diarizeStatus: () => ({ available: turns !== undefined, model: 'tdrz', reason: turns ? null : 'no diarize model' }),
    transcribe: async (_w, o) => {
      const idx = i++;
      const text = script[idx % script.length]!;
      return o?.diarize && turns ? { text, ms: 1, turns: turns[idx % turns.length]! } : { text, ms: 1 };
    },
  };
}

/** A capture we can push bytes into from the test. */
function manualCapture(): { start: StartCapture; feed(bytes: Uint8Array): void; killed: () => boolean } {
  let dataCb: ((b: Uint8Array) => void) | null = null;
  let killed = false;
  const start: StartCapture = (): CaptureProcess => ({
    onData: (cb) => (dataCb = cb),
    onError: () => undefined,
    onClose: () => undefined,
    kill: () => (killed = true),
  });
  return { start, feed: (b) => dataCb?.(b), killed: () => killed };
}

const emitSpy = () => {
  const lines: LiveLine[] = [];
  const states: LiveTranscriptStatus[] = [];
  const errors: string[] = [];
  return { lines, states, errors, line: (l: LiveLine) => lines.push(l), state: (s: LiveTranscriptStatus) => states.push(s), error: (m: string) => errors.push(m) };
};

describe('LiveTranscriptController', () => {
  it('refuses to start without consent', async () => {
    const cap = manualCapture();
    const ctl = new LiveTranscriptController(fakeTranscriber(['hi']), cap.start, () => 'src.monitor', () => 1, emitSpy());
    await expect(ctl.start(false)).rejects.toThrow(/records everyone/i);
    expect(ctl.isActive).toBe(false);
  });

  it('refuses when speech-to-text is unavailable', async () => {
    const stt: Transcriber = { status: () => ({ available: false, binary: 'whisper-cli', binaryFound: false, model: 'm', modelFound: false, reason: 'model missing' }), diarizeStatus: () => ({ available: false, model: '', reason: 'no model' }), transcribe: async () => ({ text: '', ms: 0 }) };
    const ctl = new LiveTranscriptController(stt, manualCapture().start, () => 's', () => 1, emitSpy());
    await expect(ctl.start(true)).rejects.toThrow(/model missing/);
  });

  it('refuses when no capture source resolves', async () => {
    const ctl = new LiveTranscriptController(fakeTranscriber(['hi']), manualCapture().start, () => null, () => 1, emitSpy());
    await expect(ctl.start(true)).rejects.toThrow(/source/i);
  });

  it('transcribes chunks into lines, dropping silence, and updates state', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    // chunkSeconds is clamped to a 3s minimum → 3*16000*2 = 96000 bytes per chunk.
    // Script: a real line, then silence (dropped), then a real line.
    const CHUNK = 96_000;
    const ctl = new LiveTranscriptController(fakeTranscriber(['Tell me about yourself.', 'you', 'How do you debug?']), cap.start, () => 'src.monitor', () => 1, spy);
    await ctl.start(true);
    expect(ctl.isActive).toBe(true);

    cap.feed(new Uint8Array(CHUNK)); // chunk 1 → "Tell me about yourself."
    cap.feed(new Uint8Array(CHUNK)); // chunk 2 → "you" (silence, dropped)
    cap.feed(new Uint8Array(CHUNK)); // chunk 3 → "How do you debug?"
    await vi.waitFor(() => expect(spy.lines.length).toBe(2));

    expect(spy.lines.map((l) => l.text)).toEqual(['Tell me about yourself.', 'How do you debug?']);
    expect(ctl.status().lines).toBe(2);

    await ctl.stop();
    expect(ctl.isActive).toBe(false);
    expect(cap.killed()).toBe(true);
    expect(ctl.status().active).toBe(false);
  });

  it('labels speaker turns, alternating within a chunk, when diarizing', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    // One chunk diarizes into two turns → two labelled lines.
    const stt = fakeTranscriber(['Q and A'], [['What is your name?', 'My name is Sam.']]);
    const ctl = new LiveTranscriptController(stt, cap.start, () => 'src.monitor', () => 1, spy);
    expect(ctl.status().diarizeAvailable).toBe(true);
    await ctl.start(true, true);
    expect(ctl.status().diarizing).toBe(true);

    cap.feed(new Uint8Array(96_000));
    await vi.waitFor(() => expect(spy.lines.length).toBe(2));
    expect(spy.lines.map((l) => [l.speaker, l.text])).toEqual([
      ['Speaker 1', 'What is your name?'],
      ['Speaker 2', 'My name is Sam.'],
    ]);
  });

  it('does not diarize when the tdrz model is unavailable, even if requested', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    const stt = fakeTranscriber(['one speaker line']); // no turns → diarize unavailable
    const ctl = new LiveTranscriptController(stt, cap.start, () => 'src.monitor', () => 1, spy);
    expect(ctl.status().diarizeAvailable).toBe(false);
    await ctl.start(true, true); // request diarize, but it's unavailable
    expect(ctl.status().diarizing).toBe(false);
    cap.feed(new Uint8Array(96_000));
    await vi.waitFor(() => expect(spy.lines.length).toBe(1));
    expect(spy.lines[0]!.speaker).toBeUndefined();
  });
});
