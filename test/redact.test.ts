import { describe, expect, it } from 'vitest';
import { redactSecrets, summarizeRedactions } from '../src/shared/redact';

const r = (s: string) => redactSecrets(s).redacted;

describe('redactSecrets', () => {
  it('masks common credential shapes', () => {
    // [input, the exact secret VALUE that must disappear]
    const cases: [string, string][] = [
      ['export ANTHROPIC_API_KEY=sk-ant-abc123DEF456ghi789', 'sk-ant-abc123DEF456ghi789'],
      ['standalone gsk_abcdefghij0123456789ABCDEFGHIJ here', 'gsk_abcdefghij0123456789ABCDEFGHIJ'],
      ['standalone sk-ant-abc123DEF456ghi789 here', 'sk-ant-abc123DEF456ghi789'],
      ['AWS key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
      ['curl -H "Authorization: Bearer ey.longtokenvalue1234567890abc"', 'ey.longtokenvalue1234567890abc'],
      ['token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB done', 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'],
      ['key AIzaSyB0123456789abcdefghijklmnopqrstuv x', 'AIzaSyB0123456789abcdefghijklmnopqrstuv'],
      ['slack xoxb-123456789012-abcdefABCDEF end', 'xoxb-123456789012-abcdefABCDEF'],
    ];
    for (const [input, value] of cases) {
      const out = r(input);
      expect(out, input).not.toContain(value);
      expect(out).toContain('«redacted:');
    }
  });

  it('masks a JWT but keeps surrounding text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P';
    const out = r(`Authorization header had ${jwt} in it`);
    expect(out).toContain('Authorization header had');
    expect(out).toContain('in it');
    expect(out).not.toContain(jwt);
  });

  it('masks the value of a secret assignment but keeps the name', () => {
    expect(r('DATABASE_PASSWORD=hunter2secret')).toMatch(/DATABASE_PASSWORD=«redacted:value»/);
    expect(r('export MY_SECRET_TOKEN = "abc def ghi"')).toContain('MY_SECRET_TOKEN');
    expect(r('export MY_SECRET_TOKEN = "abc def ghi"')).not.toContain('abc def ghi');
    expect(r("api_key: 'swordfish123'")).not.toContain('swordfish123');
  });

  it('masks credentials embedded in a URL', () => {
    const out = r('mongodb://admin:s3cr3tP@ss@db.example.com/x');
    expect(out).not.toContain('s3cr3tP@ss');
    expect(out).toContain('db.example.com');
    expect(out).toContain('admin');
  });

  it('masks a private key block', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\nDEF456\n-----END RSA PRIVATE KEY-----';
    const out = r(`here is a key:\n${block}\nend`);
    expect(out).not.toContain('MIIabc123');
    expect(out).toContain('here is a key');
    expect(out).toContain('end');
  });

  it('leaves ordinary terminal output untouched', () => {
    const normal = '$ ls -la\ntotal 48\ndrwxr-xr-x  3 user user 4096 Oct 14 src/\nerror: cannot find module ./foo\n  at Object.<anonymous> (/app/index.js:4:11)';
    expect(r(normal)).toBe(normal);
    expect(redactSecrets(normal).redactions).toEqual([]);
  });

  it('does not mask a normal variable that merely contains a value', () => {
    expect(r('HOME=/home/user')).toBe('HOME=/home/user');
    expect(r('PORT=3000')).toBe('PORT=3000');
    expect(r('const name = "alice"')).toBe('const name = "alice"');
  });

  it('masks every secret when several appear', () => {
    const { redactions } = redactSecrets('sk-ant-aaaaaaaa and AKIAIOSFODNN7EXAMPLE and PASSWORD=x9y8z7w6');
    expect(redactions.length).toBeGreaterThanOrEqual(3);
  });

  it('summarizes for the preview', () => {
    expect(summarizeRedactions([])).toMatch(/No obvious secrets/);
    expect(summarizeRedactions([{ label: 'JWT' }, { label: 'JWT' }, { label: 'bearer token' }])).toBe('3 secrets masked (JWT, bearer token).');
  });
});
