import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTranscript, WhisperStt, type SttPaths } from '../src/main/audio/WhisperStt';
import { encodeWav } from '../src/shared/wav';

const MODEL = process.env.INVI_WHISPER_MODEL ?? join(homedir(), '.config/inviterminal/models/ggml-base.en.bin');
const JFK = join('/tmp/claude-1000/-home-bighnesh-Desktop-Projects-invierminal-InviTerminal/b283fc0a-f41a-4ad0-97d9-a0939ad254ca/scratchpad', 'jfk.wav');

const paths = (over: Partial<SttPaths> = {}): (() => SttPaths) => () => ({ binaryPath: null, modelPath: MODEL, defaultModelPath: '/nonexistent/model.bin', ...over });

describe('parseTranscript', () => {
  it('joins lines, strips the backend log and any timestamp prefix', () => {
    expect(parseTranscript('load_backend: loaded CPU backend\n [00:00:00.000 --> 00:00:05.000]  Hello there \n world\n')).toBe('Hello there world');
  });
  it('is empty for empty output', () => {
    expect(parseTranscript('\n  \n')).toBe('');
  });
});

describe('WhisperStt.status', () => {
  it('reports unavailable with a reason when the model is missing', () => {
    const s = new WhisperStt(paths({ modelPath: '/nope/ggml.bin' })).status();
    expect(s.available).toBe(false);
    expect(s.reason).toMatch(/model not found/);
  });
  it('uses the default model path when none is configured', () => {
    const s = new WhisperStt(() => ({ binaryPath: null, modelPath: null, defaultModelPath: '/d/m.bin' })).status();
    expect(s.model).toBe('/d/m.bin');
  });
});

describe('WhisperStt.transcribe with a fake runner', () => {
  it('builds the whisper-cli argv and parses stdout', async () => {
    let captured: string[] = [];
    const stt = new WhisperStt(paths(), (_bin, args) => {
      captured = args;
      return Promise.resolve('load_backend: x\n And so my fellow Americans.\n');
    });
    const r = await stt.transcribe('/tmp/a.wav', { threads: 2 });
    expect(r.text).toBe('And so my fellow Americans.');
    expect(captured).toEqual(['-m', MODEL, '-f', '/tmp/a.wav', '-nt', '-np', '-l', 'en', '-t', '2']);
  });

  it('refuses to run when unavailable', async () => {
    const stt = new WhisperStt(paths({ modelPath: '/nope.bin' }), () => Promise.resolve('x'));
    await expect(stt.transcribe('/tmp/a.wav')).rejects.toThrow(/model not found/);
  });
});

// Real binary + model on the dev machine; skipped automatically if either is missing.
const canRunReal = existsSync(MODEL) && existsSync(JFK);
describe.skipIf(!canRunReal)('WhisperStt.transcribe (real whisper-cli + base.en on jfk.wav)', () => {
  it('transcribes the sample correctly', async () => {
    const stt = new WhisperStt(paths());
    const r = await stt.transcribe(JFK, { timeoutMs: 60_000 });
    expect(r.text.toLowerCase()).toContain('ask not what your country');
  }, 70_000);
});

// Decodes a 16-bit PCM mono WAV to Float32, walking chunks (jfk.wav has a LIST chunk).
function decodeWav(bytes: Uint8Array): { samples: Float32Array; rate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate = 16000;
  let dataOff = -1;
  let dataLen = 0;
  let i = 12;
  while (i + 8 <= v.byteLength) {
    const id = String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
    const sz = v.getUint32(i + 4, true);
    if (id === 'fmt ') rate = v.getUint32(i + 8 + 4, true);
    else if (id === 'data') { dataOff = i + 8; dataLen = sz; break; }
    i += 8 + sz + (sz & 1);
  }
  const n = Math.floor(dataLen / 2);
  const samples = new Float32Array(n);
  for (let j = 0; j < n; j++) samples[j] = v.getInt16(dataOff + j * 2, true) / 0x8000;
  return { samples, rate };
}

describe.skipIf(!canRunReal)('encodeWav output is whisper-readable (encoder → whisper chain)', () => {
  it('re-encodes the sample through encodeWav and still transcribes it', async () => {
    const { samples, rate } = decodeWav(readFileSync(JFK));
    const wav = encodeWav(samples, rate); // 16k → 16k, exercises the real encoder path
    const dir = mkdtempSync(join(tmpdir(), 'invi-stt-enc-'));
    const file = join(dir, 'a.wav');
    try {
      writeFileSync(file, wav);
      const r = await new WhisperStt(paths()).transcribe(file, { timeoutMs: 60_000 });
      expect(r.text.toLowerCase()).toContain('country');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});
