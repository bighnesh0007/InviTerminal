import { describe, expect, it } from 'vitest';
import { type RunTts, TtsSpeaker, type TtsPaths, type Utterance } from '../src/main/audio/TtsSpeaker';

const paths = (over: Partial<TtsPaths> = {}): (() => TtsPaths) => () => ({ binaryPath: null, voice: null, ...over });

/** A fake engine that records what it was asked to say and lets the test resolve/cancel it. */
function fakeEngine() {
  const calls: { bin: string; args: string[] }[] = [];
  let resolveCurrent: (() => void) | null = null;
  let stopped = 0;
  const run: RunTts = (bin, args) => {
    calls.push({ bin, args });
    const done = new Promise<void>((resolve) => (resolveCurrent = resolve));
    const utt: Utterance = { done, stop: () => { stopped++; resolveCurrent?.(); } };
    return utt;
  };
  return {
    run,
    calls,
    finish: () => resolveCurrent?.(),
    get stopped() {
      return stopped;
    },
    get spoken() {
      return calls.map((c) => c.args[c.args.length - 1]);
    },
  };
}

describe('TtsSpeaker.status', () => {
  it('defaults the binary to espeak-ng and is available (a bare name is assumed on PATH)', () => {
    const s = new TtsSpeaker(paths()).status();
    expect(s.binary).toBe('espeak-ng');
    expect(s.available).toBe(true);
    expect(s.reason).toBeNull();
  });
  it('reports unavailable with a reason when an absolute binary path is missing', () => {
    const s = new TtsSpeaker(paths({ binaryPath: '/no/such/espeak' })).status();
    expect(s.available).toBe(false);
    expect(s.binaryFound).toBe(false);
    expect(s.reason).toMatch(/not found/);
  });
  it('carries the configured voice through', () => {
    expect(new TtsSpeaker(paths({ voice: 'en-us' })).status().voice).toBe('en-us');
  });
});

describe('TtsSpeaker.buildArgs', () => {
  it('passes the text as the trailing argument, with no voice flag by default', () => {
    expect(new TtsSpeaker(paths()).buildArgs('hello world', null)).toEqual(['hello world']);
  });
  it('prepends -v when a voice is set', () => {
    expect(new TtsSpeaker(paths()).buildArgs('hi', 'en')).toEqual(['-v', 'en', 'hi']);
  });
  it('clamps pathologically long text', () => {
    const long = 'a'.repeat(20_000);
    const args = new TtsSpeaker(paths()).buildArgs(long, null);
    expect((args[args.length - 1] as string).length).toBe(8000);
  });
});

describe('TtsSpeaker.speak with a fake engine', () => {
  it('builds the argv (voice + text) and resolves when the utterance finishes', async () => {
    const eng = fakeEngine();
    const speaker = new TtsSpeaker(paths({ voice: 'en' }), eng.run);
    const p = speaker.speak('Question 1: tell me about yourself.');
    expect(eng.calls[0]!.args).toEqual(['-v', 'en', 'Question 1: tell me about yourself.']);
    eng.finish();
    await expect(p).resolves.toBeUndefined();
  });

  it('does nothing for empty/whitespace text (no engine call)', async () => {
    const eng = fakeEngine();
    await new TtsSpeaker(paths(), eng.run).speak('   ');
    expect(eng.calls).toHaveLength(0);
  });

  it('refuses to run when unavailable', async () => {
    const eng = fakeEngine();
    const speaker = new TtsSpeaker(paths({ binaryPath: '/no/such/espeak' }), eng.run);
    await expect(speaker.speak('hi')).rejects.toThrow(/not found/);
    expect(eng.calls).toHaveLength(0);
  });

  it('a new speak() cancels the one already playing (one utterance at a time)', async () => {
    const eng = fakeEngine();
    const speaker = new TtsSpeaker(paths(), eng.run);
    const first = speaker.speak('first');
    const second = speaker.speak('second'); // should stop the first
    expect(eng.stopped).toBe(1);
    eng.finish(); // finishes the second
    await Promise.all([first, second]);
    expect(eng.spoken).toEqual(['first', 'second']);
  });

  it('stop() cancels the current utterance', async () => {
    const eng = fakeEngine();
    const speaker = new TtsSpeaker(paths(), eng.run);
    const p = speaker.speak('long answer');
    speaker.stop();
    expect(eng.stopped).toBe(1);
    await expect(p).resolves.toBeUndefined();
  });

  it('stop() is safe when nothing is playing', () => {
    expect(() => new TtsSpeaker(paths(), fakeEngine().run).stop()).not.toThrow();
  });
});
