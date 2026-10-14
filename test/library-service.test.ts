import { describe, expect, it } from 'vitest';
import { LibraryService } from '../src/main/library/LibraryService';
import type { LibraryStore } from '../src/main/library/LibraryStore';
import { IdRequest, SearchRequest, SnippetInputSchema, UpdateRequest } from '../src/main/library/schemas';
import type { LibraryStatus } from '../src/shared/snippet';

const fakeStore = { close: async () => {} } as unknown as LibraryStore;

describe('LibraryService', () => {
  it('reports ready after connecting, and shows host/db but never credentials', async () => {
    const seen: LibraryStatus[] = [];
    const svc = new LibraryService('mongodb://user:secret@127.0.0.1:27017/inviterminal', false, (s) => seen.push(s), async () => fakeStore);
    await svc.start();
    expect(svc.getStatus()).toEqual({ state: 'ready', target: '127.0.0.1/inviterminal' });
    expect(JSON.stringify(seen)).not.toContain('secret');
    expect(svc.require()).toBe(fakeStore);
  });

  it('turns a connection failure into an "unavailable" status, then recovers on retry', async () => {
    let fail = true;
    const svc = new LibraryService('mongodb://127.0.0.1:27017/inviterminal', false, () => {}, async () => {
      if (fail) throw new Error('connect ECONNREFUSED');
      return fakeStore;
    });
    await svc.start();
    expect(svc.getStatus()).toMatchObject({ state: 'unavailable' });
    expect(() => svc.require()).toThrow(/ECONNREFUSED/);
    fail = false;
    await svc.retry();
    expect(svc.getStatus().state).toBe('ready');
  });

  it('never connects to a refused URI (remote, or no database)', async () => {
    let connected = false;
    for (const uri of ['mongodb://db.example.com/inv', 'mongodb://127.0.0.1:27017']) {
      const svc = new LibraryService(uri, false, () => {}, async () => {
        connected = true;
        return fakeStore;
      });
      await svc.start();
      expect(svc.getStatus().state).toBe('unavailable');
    }
    expect(connected).toBe(false);
  });

  it('concurrent starts share one connection attempt', async () => {
    let attempts = 0;
    const svc = new LibraryService('mongodb://127.0.0.1/inv', false, () => {}, async () => {
      attempts++;
      await new Promise((r) => setTimeout(r, 10));
      return fakeStore;
    });
    await Promise.all([svc.start(), svc.start(), svc.retry()]);
    expect(attempts).toBe(1);
  });
});

describe('library IPC schemas', () => {
  const id = '65f1c0ffee0000000000abcd';

  it('accepts well-formed requests', () => {
    expect(SnippetInputSchema.parse({ title: 't', body: 'b', tags: ['x'], folder: 'a/b', language: 'bash' })).toBeTruthy();
    expect(UpdateRequest.parse({ id, patch: { body: 'x' } })).toBeTruthy();
    expect(SearchRequest.parse({ q: 'docker', deleted: false })).toBeTruthy();
  });

  it('refuses extra fields — no smuggling useCount, deletedAt or _id', () => {
    expect(SnippetInputSchema.safeParse({ title: 't', body: 'b', useCount: 5 }).success).toBe(false);
    expect(UpdateRequest.safeParse({ id, patch: { deletedAt: null } }).success).toBe(false);
    expect(UpdateRequest.safeParse({ id, patch: {}, _id: 'x' }).success).toBe(false);
  });

  it('refuses operator objects and malformed ids (NoSQL injection)', () => {
    expect(IdRequest.safeParse({ id: { $ne: null } }).success).toBe(false);
    expect(IdRequest.safeParse({ id: 'zz' }).success).toBe(false);
    expect(SearchRequest.safeParse({ q: { $regex: '.*' } }).success).toBe(false);
    expect(SearchRequest.safeParse({ tag: { $gt: '' } }).success).toBe(false);
  });

  it('bounds sizes', () => {
    expect(SnippetInputSchema.safeParse({ title: ' ', body: 'b' }).success).toBe(false);
    expect(SnippetInputSchema.safeParse({ title: 't', body: '' }).success).toBe(false);
    expect(SnippetInputSchema.safeParse({ title: 't', body: 'x'.repeat(262_145) }).success).toBe(false);
    expect(SearchRequest.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });
});
