import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseBoolReply,
  parseInt32Reply,
  parseMatchUuids,
  parseWindowInfo,
} from '../src/main/capture/kwin/gvariant';
import { buildExclusionScript } from '../src/main/capture/kwin/script';

// Recorded from `gdbus call` against KWin 6.7.5 on 2026-10-14.
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('KWin gdbus reply parsing (recorded fixtures)', () => {
  it('extracts the window uuid from a WindowsRunner.Match reply', () => {
    expect(parseMatchUuids(fixture('kwin-match-one.txt'))).toEqual(['{60d5dd0b-01cd-409e-a6a5-ba57a3bd26af}']);
  });

  it('returns no uuids for an empty Match reply', () => {
    expect(parseMatchUuids(fixture('kwin-match-none.txt'))).toEqual([]);
  });

  it('parses getWindowInfo', () => {
    expect(parseWindowInfo(fixture('kwin-getwindowinfo.txt'))).toEqual({
      uuid: '{60d5dd0b-01cd-409e-a6a5-ba57a3bd26af}',
      pid: 23185,
      caption: 'fixture-6f3a91',
      resourceClass: 'inviterminal',
      excludeFromCapture: false,
    });
  });

  it('reads excludeFromCapture=true', () => {
    const text = fixture('kwin-getwindowinfo.txt').replace("'excludeFromCapture': <false>", "'excludeFromCapture': <true>");
    expect(parseWindowInfo(text)?.excludeFromCapture).toBe(true);
  });

  it('reports undefined (not false) when KWin predates the property', () => {
    const text = fixture('kwin-getwindowinfo.txt').replace("'excludeFromCapture': <false>, ", '');
    expect(parseWindowInfo(text)?.excludeFromCapture).toBeUndefined();
  });

  it('treats the empty map KWin returns for an unknown uuid as no window', () => {
    expect(parseWindowInfo(fixture('kwin-getwindowinfo-missing.txt'))).toBeNull();
  });

  it('handles escaped quotes in captions', () => {
    const text = fixture('kwin-getwindowinfo.txt').replace("'caption': <'fixture-6f3a91'>", "'caption': <'it\\'s > here'>");
    expect(parseWindowInfo(text)?.caption).toBe("it's > here");
  });

  it('parses scalar replies', () => {
    expect(parseInt32Reply('(0,)\n')).toBe(0);
    expect(parseInt32Reply('(-1,)')).toBe(-1);
    expect(parseInt32Reply('garbage')).toBeNull();
    expect(parseBoolReply('(true,)\n')).toBe(true);
    expect(parseBoolReply('(false,)')).toBe(false);
  });
});

describe('buildExclusionScript', () => {
  const uuid = '{60d5dd0b-01cd-409e-a6a5-ba57a3bd26af}';

  it('targets the uuid and pid given', () => {
    const s = buildExclusionScript({ uuid, pid: 4242, exclude: true });
    expect(s).toContain(`var target = "${uuid}";`);
    expect(s).toContain('var pid = 4242;');
    expect(s).toContain('var exclude = true;');
  });

  it('refuses anything that is not a KWin uuid, so nothing can be injected into the script', () => {
    expect(() => buildExclusionScript({ uuid: '"; workspace.foo(); "', pid: 1, exclude: true })).toThrow();
    expect(() => buildExclusionScript({ uuid, pid: 0, exclude: true })).toThrow();
    expect(() => buildExclusionScript({ uuid, pid: 1.5, exclude: true })).toThrow();
  });
});
