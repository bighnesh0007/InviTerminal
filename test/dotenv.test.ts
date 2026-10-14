import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv, parseDotEnv } from '../src/main/dotenv';

describe('parseDotEnv', () => {
  it('parses KEY=VALUE, export, comments and blank lines', () => {
    const r = parseDotEnv('# a comment\n\nGROQ_API_KEY=gsk_abc123\nexport INVI_AI_MODEL=llama-3.1-8b-instant\n');
    expect(r).toEqual({ GROQ_API_KEY: 'gsk_abc123', INVI_AI_MODEL: 'llama-3.1-8b-instant' });
  });
  it('trims unquoted values and strips a trailing inline comment', () => {
    expect(parseDotEnv('K=  value  # trailing')).toEqual({ K: 'value' });
  });
  it('keeps quoted values verbatim, including spaces and #', () => {
    expect(parseDotEnv('K="a b # c"')).toEqual({ K: 'a b # c' });
    expect(parseDotEnv("K='x#y'")).toEqual({ K: 'x#y' });
  });
  it('ignores invalid names and lines without =', () => {
    expect(parseDotEnv('1BAD=x\n=noname\njusttext\nGOOD=y')).toEqual({ GOOD: 'y' });
  });
  it('allows = inside the value', () => {
    expect(parseDotEnv('URL=a=b=c')).toEqual({ URL: 'a=b=c' });
  });
});

describe('loadDotEnv', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const write = (body: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'invi-env-'));
    const p = join(dir, '.env');
    writeFileSync(p, body);
    return p;
  };

  it('sets only variables not already present (real env wins)', () => {
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'from-real-env' };
    const applied = loadDotEnv(write('GROQ_API_KEY=from-dotenv\nOTHER=set-me'), env);
    expect(env.GROQ_API_KEY).toBe('from-real-env'); // not overwritten
    expect(env.OTHER).toBe('set-me');
    expect(applied).toEqual(['OTHER']);
  });

  it('is a silent no-op when the file is missing', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadDotEnv(join(tmpdir(), 'does-not-exist-xyz', '.env'), env)).toEqual([]);
    expect(Object.keys(env)).toHaveLength(0);
  });
});
