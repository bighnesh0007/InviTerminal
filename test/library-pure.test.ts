import { describe, expect, it } from 'vitest';
import { checkMongoUri } from '../src/main/library/mongo-uri';
import { escapeRegex, normalizeFolder, normalizeTags } from '../src/main/library/normalize';
import { rankSnippets, textForInsert, type Snippet } from '../src/shared/snippet';

describe('normalizeTags', () => {
  it('lowercases, trims, dedupes and slugifies', () => {
    expect(normalizeTags([' Docker ', 'docker', 'K8s Prod', '', '--', 'a/b'])).toEqual(['docker', 'k8s-prod', 'a-b']);
  });
  it('caps the count', () => {
    expect(() => normalizeTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow();
  });
});

describe('normalizeFolder', () => {
  it('trims segments and drops empty ones', () => {
    expect(normalizeFolder(' deploy / k8s/ ')).toBe('deploy/k8s');
    expect(normalizeFolder('')).toBe('');
  });
  it('refuses traversal-looking segments and limits depth', () => {
    expect(() => normalizeFolder('a/../b')).toThrow();
    expect(() => normalizeFolder('./a')).toThrow();
    expect(() => normalizeFolder('a/b/c/d/e/f/g/h/i')).toThrow();
  });
});

describe('escapeRegex', () => {
  it('makes user text match literally', () => {
    const q = 'a.b*(c)|[d]$';
    expect(new RegExp(escapeRegex(q)).test('xa.b*(c)|[d]$y')).toBe(true);
    expect(new RegExp(escapeRegex('.*')).test('anything')).toBe(false);
  });
});

describe('checkMongoUri', () => {
  it('accepts the local default and extracts the database', () => {
    expect(checkMongoUri('mongodb://127.0.0.1:27017/inviterminal', false)).toEqual({ ok: true, dbName: 'inviterminal', host: '127.0.0.1', loopback: true });
    expect(checkMongoUri('mongodb://localhost/inviterminal?directConnection=true', false)).toMatchObject({ ok: true, dbName: 'inviterminal' });
    expect(checkMongoUri('mongodb://[::1]:27017/inv', false)).toMatchObject({ ok: true, loopback: true });
    expect(checkMongoUri('mongodb://user:p%40ss@127.0.0.1/inv', false)).toMatchObject({ ok: true, host: '127.0.0.1' });
  });

  it('refuses remote hosts unless explicitly allowed — snippets must not leave the machine silently', () => {
    for (const u of ['mongodb://db.example.com/inv', 'mongodb://127.0.0.1,db.example.com/inv', 'mongodb+srv://cluster0.x.mongodb.net/inv', 'mongodb://10.0.0.5/inv']) {
      expect(checkMongoUri(u, false).ok).toBe(false);
    }
    expect(checkMongoUri('mongodb://db.example.com/inv', true)).toMatchObject({ ok: true, loopback: false });
  });

  it('takes the host after the last "@" (an unencoded "@" in a password still parses)', () => {
    expect(checkMongoUri('mongodb://u:p@x@127.0.0.1/inv', false)).toMatchObject({ ok: true, host: '127.0.0.1' });
  });

  it('a credential containing "@127.0.0.1" does not make a remote host look local', () => {
    expect(checkMongoUri('mongodb://u:x@127.0.0.1@evil.example.com/inv', false).ok).toBe(false);
  });

  it('requires its own database, never admin/local/config', () => {
    for (const u of ['mongodb://127.0.0.1:27017', 'mongodb://127.0.0.1:27017/', 'mongodb://127.0.0.1/admin', 'mongodb://127.0.0.1/local', 'mongodb://127.0.0.1/config', 'mongodb://127.0.0.1/a.b']) {
      expect(checkMongoUri(u, false).ok).toBe(false);
    }
  });

  it('refuses other schemes', () => {
    expect(checkMongoUri('http://127.0.0.1/inv', false).ok).toBe(false);
  });
});

function snip(p: Partial<Snippet>): Snippet {
  return { id: p.title ?? 'x', title: '', body: '', description: '', language: 'bash', tags: [], folder: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null, useCount: 0, deletedAt: null, ...p };
}

describe('rankSnippets', () => {
  const items = [
    snip({ title: 'restart nginx', body: 'sudo systemctl restart nginx' }),
    snip({ title: 'docker prune', tags: ['docker'], body: 'docker system prune -af' }),
    snip({ title: 'logs', body: 'journalctl -u docker -f' }),
    snip({ title: 'dockerfile lint', body: 'hadolint Dockerfile' }),
  ];

  it('puts title prefix, then title substring, then tags, then body', () => {
    expect(rankSnippets(items, 'docker').map((s) => s.title)).toEqual(['docker prune', 'dockerfile lint', 'logs']);
    expect(rankSnippets(items, 'nginx').map((s) => s.title)).toEqual(['restart nginx']);
  });

  it('is case-insensitive and drops non-matches', () => {
    expect(rankSnippets(items, 'DOCKER PRUNE').map((s) => s.title)).toEqual(['docker prune']);
    expect(rankSnippets(items, 'zzz')).toEqual([]);
  });

  it('with no query, orders by use then recency', () => {
    const r = rankSnippets(
      [snip({ title: 'a', useCount: 1 }), snip({ title: 'b', useCount: 5 }), snip({ title: 'c', useCount: 1, updatedAt: '2026-10-09T00:00:00.000Z' })],
      undefined,
    );
    expect(r.map((s) => s.title)).toEqual(['b', 'c', 'a']);
  });
});

describe('textForInsert', () => {
  it('strips trailing newlines so inserting never executes', () => {
    expect(textForInsert('ls -la\n')).toEqual({ text: 'ls -la', multiline: false });
    expect(textForInsert('ls\r\n\r\n')).toEqual({ text: 'ls', multiline: false });
  });
  it('flags multi-line bodies for confirmation', () => {
    expect(textForInsert('a\nb\n')).toEqual({ text: 'a\nb', multiline: true });
    expect(textForInsert('a\r\nb')).toEqual({ text: 'a\nb', multiline: true });
  });
});
