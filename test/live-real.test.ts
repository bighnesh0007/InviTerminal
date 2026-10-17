import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveLine } from '../src/shared/audio';
import { defaultMicSource, defaultMonitorSource, LiveTranscriptController, parecordCapture } from '../src/main/audio/LiveTranscriptController';
import { WhisperStt } from '../src/main/audio/WhisperStt';

// Real hardware, real whisper. Opt-in: set INVI_REAL_LIVE=1 while speech is PLAYING through the
// default output (e.g. a video), with a microphone as the default input. Skipped otherwise.
const MODEL = join(homedir(), '.config/inviterminal/models/ggml-base.en.bin');
const REAL = process.env.INVI_REAL_LIVE === '1' && existsSync(MODEL);

describe.skipIf(!REAL)('live transcript on real hardware (INVI_REAL_LIVE=1)', () => {
  it('you-them: real mic (left) + real call audio (right) → whisper -di labels the playing speech "Them"', async () => {
    const stt = new WhisperStt(() => ({ binaryPath: null, modelPath: null, defaultModelPath: MODEL }));
    const lines: LiveLine[] = [];
    const errors: string[] = [];
    const ctl = new LiveTranscriptController(stt, parecordCapture, () => defaultMonitorSource(), () => 6, { line: (l) => lines.push(l), state: () => undefined, error: (m) => errors.push(m) }, () => defaultMicSource());
    expect(ctl.status().modes['you-them'].available).toBe(true);
    await ctl.start(true, 'you-them');
    await new Promise((r) => setTimeout(r, 16_000)); // ~2 chunks of 6s plus transcription time
    await ctl.stop();
    console.log(JSON.stringify({ lines, errors }, null, 2));
    expect(errors).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    // The video plays on the right (call) channel, so whisper must attribute it to "Them".
    expect(lines.filter((l) => l.speaker === 'Them').length).toBeGreaterThan(0);
  }, 40_000);
});
