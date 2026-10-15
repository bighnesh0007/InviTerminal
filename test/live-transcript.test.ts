import { describe, expect, it, vi } from 'vitest';
import { isSilenceTranscript, type LiveLine, type LiveTranscriptStatus, type SttStatus } from '../src/shared/audio';
import { isWav, wrapPcm16Wav } from '../src/shared/wav';
import { PcmChunker } from '../src/main/audio/PcmChunker';
import { type CaptureProcess, defaultMicSource, LiveTranscriptController, type StartCapture, type Transcriber } from '../src/main/audio/LiveTranscriptController';
import { StereoMixer } from '../src/main/audio/StereoMixer';

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

type Seg = { text: string; speaker: '0' | '1' | '?' };
/** Fake transcriber: scripted text; `turns` for tdrz, `channels` for stereo (-di). Records the options it got. */
function fakeTranscriber(script: string[], extra: { turns?: string[][]; channels?: Seg[][] } = {}) {
  let i = 0;
  const calls: { diarize?: boolean; stereo?: boolean }[] = [];
  const t: Transcriber = {
    status: okStt,
    diarizeStatus: () => ({ available: extra.turns !== undefined, model: 'tdrz', reason: extra.turns ? null : 'no diarize model' }),
    transcribe: async (_w, o) => {
      calls.push({ ...(o?.diarize !== undefined ? { diarize: o.diarize } : {}), ...(o?.stereo !== undefined ? { stereo: o.stereo } : {}) });
      const idx = i++;
      const text = script[idx % script.length]!;
      if (o?.stereo && extra.channels) return { text, ms: 1, channels: extra.channels[idx % extra.channels.length]! };
      if (o?.diarize && extra.turns) return { text, ms: 1, turns: extra.turns[idx % extra.turns.length]! };
      return { text, ms: 1 };
    },
  };
  return Object.assign(t, { calls });
}

/** Captures we can push bytes into; records every recorder started (source, channels, killed). */
function manualCapture() {
  const started: { source: string; channels: 1 | 2; feed(b: Uint8Array): void; killed: boolean; close(): void }[] = [];
  const start: StartCapture = (source, channels): CaptureProcess => {
    let dataCb: ((b: Uint8Array) => void) | null = null;
    let closeCb: (() => void) | null = null;
    const rec = { source, channels, killed: false, feed: (b: Uint8Array) => dataCb?.(b), close: () => closeCb?.() };
    started.push(rec);
    return {
      onData: (cb) => (dataCb = cb),
      onError: () => undefined,
      onClose: (cb) => (closeCb = cb),
      kill: () => (rec.killed = true),
    };
  };
  return { start, started, feed: (b: Uint8Array) => started[started.length - 1]!.feed(b), killed: () => started.every((r) => r.killed) };
}

const emitSpy = () => {
  const lines: LiveLine[] = [];
  const states: LiveTranscriptStatus[] = [];
  const errors: string[] = [];
  return { lines, states, errors, line: (l: LiveLine) => lines.push(l), state: (s: LiveTranscriptStatus) => states.push(s), error: (m: string) => errors.push(m) };
};

// chunkSeconds is clamped to a 3s minimum → 3*16000*2 bytes per mono chunk (×2 for stereo).
const MONO = 96_000;
const STEREO = 192_000;

describe('LiveTranscriptController', () => {
  it('refuses to start without consent', async () => {
    const ctl = new LiveTranscriptController(fakeTranscriber(['hi']), manualCapture().start, () => 'src.monitor', () => 1, emitSpy());
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
    const ctl = new LiveTranscriptController(fakeTranscriber(['Tell me about yourself.', 'you', 'How do you debug?']), cap.start, () => 'src.monitor', () => 1, spy);
    await ctl.start(true);
    expect(ctl.isActive).toBe(true);
    expect(cap.started).toMatchObject([{ source: 'src.monitor', channels: 1 }]);
    cap.feed(new Uint8Array(MONO));
    cap.feed(new Uint8Array(MONO)); // "you" → silence, dropped
    cap.feed(new Uint8Array(MONO));
    await vi.waitFor(() => expect(spy.lines.length).toBe(2));
    expect(spy.lines.map((l) => l.text)).toEqual(['Tell me about yourself.', 'How do you debug?']);
    expect(ctl.status().lines).toBe(2);
    await ctl.stop();
    expect(ctl.isActive).toBe(false);
    expect(cap.killed()).toBe(true);
  });

  it('pause kills the recorder (nothing captured) but keeps the session; resume starts a new one', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    const ctl = new LiveTranscriptController(fakeTranscriber(['one', 'two']), cap.start, () => 'src.monitor', () => 1, spy);
    await ctl.start(true);
    cap.feed(new Uint8Array(MONO));
    await vi.waitFor(() => expect(spy.lines.length).toBe(1));

    ctl.pause();
    expect(cap.started[0]!.killed).toBe(true);
    expect(ctl.status()).toMatchObject({ active: true, paused: true, lines: 1 });
    cap.started[0]!.feed(new Uint8Array(MONO)); // late bytes from the killed recorder are ignored
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.lines.length).toBe(1);

    ctl.resume();
    expect(cap.started).toHaveLength(2);
    expect(ctl.status().paused).toBe(false);
    // Bytes from the OLD (killed) recorder must still be ignored after resume, when a fresh chunker exists.
    cap.started[0]!.feed(new Uint8Array(MONO));
    await new Promise((r) => setTimeout(r, 30));
    expect(spy.lines.length).toBe(1);
    cap.feed(new Uint8Array(MONO));
    await vi.waitFor(() => expect(spy.lines.length).toBe(2));
    expect(ctl.status().lines).toBe(2); // the count carries across the pause
  });

  it('a recorder that exits on its own ends the session (but a pause does not)', async () => {
    const cap = manualCapture();
    const ctl = new LiveTranscriptController(fakeTranscriber(['x']), cap.start, () => 'src.monitor', () => 1, emitSpy());
    await ctl.start(true);
    ctl.pause();
    cap.started[0]!.close(); // the killed recorder's close event must not stop the paused session
    expect(ctl.isActive).toBe(true);
    ctl.resume();
    cap.started[1]!.close(); // a live recorder dying (e.g. device unplugged) ends it
    await vi.waitFor(() => expect(ctl.isActive).toBe(false));
  });

  it('turns mode labels speaker turns, alternating within a chunk', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    const stt = fakeTranscriber(['Q and A'], { turns: [['What is your name?', 'My name is Sam.']] });
    const ctl = new LiveTranscriptController(stt, cap.start, () => 'src.monitor', () => 1, spy);
    expect(ctl.status().modes.turns.available).toBe(true);
    await ctl.start(true, 'turns');
    expect(ctl.status().speakerMode).toBe('turns');
    cap.feed(new Uint8Array(MONO));
    await vi.waitFor(() => expect(spy.lines.length).toBe(2));
    expect(spy.lines.map((l) => [l.speaker, l.text])).toEqual([
      ['Speaker 1', 'What is your name?'],
      ['Speaker 2', 'My name is Sam.'],
    ]);
    expect(stt.calls[0]).toEqual({ diarize: true, stereo: false });
  });

  it('refuses a speaker mode that cannot run (turns without the tdrz model)', async () => {
    const ctl = new LiveTranscriptController(fakeTranscriber(['x']), manualCapture().start, () => 'src.monitor', () => 1, emitSpy());
    expect(ctl.status().modes.turns).toEqual({ available: false, reason: 'no diarize model' });
    await expect(ctl.start(true, 'turns')).rejects.toThrow(/diarize model/);
    expect(ctl.isActive).toBe(false);
  });

  it('you-them records the mic (left) and the call (right), mixes them, and labels You / Them', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    const stt = fakeTranscriber(['x'], { channels: [[{ text: 'Tell me about a hard bug.', speaker: '1' }, { text: 'Sure — a race in the cache.', speaker: '0' }, { text: 'mm', speaker: '?' }]] });
    const ctl = new LiveTranscriptController(stt, cap.start, () => 'call.monitor', () => 1, spy, () => 'usb-mic');
    expect(ctl.status().modes['you-them'].available).toBe(true);
    await ctl.start(true, 'you-them');
    expect(cap.started.map((r) => [r.source, r.channels])).toEqual([
      ['usb-mic', 1],
      ['call.monitor', 1],
    ]);
    // Like real recorders: both sides deliver small buffers in turn. 3s per side → one 3s stereo chunk.
    for (let i = 0; i < MONO / 8000; i++) {
      cap.started[0]!.feed(new Uint8Array(8000));
      cap.started[1]!.feed(new Uint8Array(8000));
    }
    await vi.waitFor(() => expect(spy.lines.length).toBe(3));
    expect(spy.lines.map((l) => [l.speaker, l.text])).toEqual([
      ['Them', 'Tell me about a hard bug.'],
      ['You', 'Sure — a race in the cache.'],
      [undefined, 'mm'],
    ]);
    expect(stt.calls[0]).toEqual({ diarize: false, stereo: true });
    await ctl.stop();
    expect(cap.started.every((r) => r.killed)).toBe(true);
  });

  it('you-them is unavailable without a microphone', async () => {
    const ctl = new LiveTranscriptController(fakeTranscriber(['x']), manualCapture().start, () => 'call.monitor', () => 1, emitSpy(), () => null);
    expect(ctl.status().modes['you-them'].available).toBe(false);
    await expect(ctl.start(true, 'you-them')).rejects.toThrow(/microphone/i);
  });

  it('stereo mode records 2 channels from the source and labels Left / Right', async () => {
    const cap = manualCapture();
    const spy = emitSpy();
    const stt = fakeTranscriber(['x'], { channels: [[{ text: 'left words', speaker: '0' }, { text: 'right words', speaker: '1' }]] });
    const ctl = new LiveTranscriptController(stt, cap.start, () => 'src.monitor', () => 1, spy);
    await ctl.start(true, 'stereo');
    expect(cap.started).toMatchObject([{ source: 'src.monitor', channels: 2 }]);
    cap.feed(new Uint8Array(STEREO));
    await vi.waitFor(() => expect(spy.lines.length).toBe(2));
    expect(spy.lines.map((l) => l.speaker)).toEqual(['Left', 'Right']);
  });
});

describe('StereoMixer', () => {
  const s16 = (...v: number[]) => new Uint8Array(new Int16Array(v).buffer);
  const vals = (b: Uint8Array) => [...new Int16Array(b.slice().buffer)];
  it('interleaves left and right samples once both sides have data', () => {
    const m = new StereoMixer({ now: () => 0 });
    expect(m.pushLeft(s16(1, 2)).length).toBe(0); // waiting for the right side
    expect(vals(m.pushRight(s16(10, 20)))).toEqual([1, 10, 2, 20]);
  });
  it('carries the surplus of the faster side to the next call', () => {
    const m = new StereoMixer({ now: () => 0 });
    m.pushLeft(s16(1, 2, 3));
    expect(vals(m.pushRight(s16(10)))).toEqual([1, 10]);
    expect(vals(m.pushRight(s16(20, 30)))).toEqual([2, 20, 3, 30]);
  });
  it('does NOT pad on ordinary delivery jitter, in either direction (that would shift a channel for good)', () => {
    let t = 0;
    const a = new StereoMixer({ now: () => t });
    t = 100; // the other side delivered 100ms ago — just jitter
    expect(a.pushLeft(s16(1, 2)).length).toBe(0);
    expect(vals(a.pushRight(s16(9, 8)))).toEqual([1, 9, 2, 8]);
    t = 0;
    const b = new StereoMixer({ now: () => t });
    t = 100;
    expect(b.pushRight(s16(9, 8)).length).toBe(0);
    expect(vals(b.pushLeft(s16(1, 2)))).toEqual([1, 9, 2, 8]);
  });
  it('pads a side that has gone quiet (a suspended sink sends nothing at all)', () => {
    let t = 0;
    const m = new StereoMixer({ now: () => t });
    t = 400; // right silent for 400ms ≥ 300ms
    expect(vals(m.pushLeft(s16(5, 6)))).toEqual([5, 0, 6, 0]);
  });
  it('pads once a side falls a full maxLag behind, even if it spoke recently', () => {
    const m = new StereoMixer({ now: () => 0, maxLagBytes: 4 });
    expect(vals(m.pushRight(s16(7, 8)))).toEqual([0, 7, 0, 8]);
  });
});

describe('defaultMicSource', () => {
  it('returns the default source, but never a monitor (that means there is no mic)', () => {
    expect(defaultMicSource(() => 'alsa_input.usb-mic\n')).toBe('alsa_input.usb-mic');
    expect(defaultMicSource(() => 'alsa_output.x.monitor')).toBeNull();
    expect(defaultMicSource(() => {
      throw new Error('no pactl');
    })).toBeNull();
  });
});
