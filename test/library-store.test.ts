import { existsSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { buildSnippetSchema, LibraryStore } from '../src/main/library/LibraryStore';

// Needs a system mongod (dev machine). Skipped — visibly — where there is none, e.g. the Docker build image.
const HAS_MONGOD = existsSync('/usr/bin/mongod');

describe.skipIf(!HAS_MONGOD)('library store (system mongod)', () => {
  // A throwaway mongod (the system binary, random port, temp dbpath). Never the shared server on :27017.
  let server: MongoMemoryServer;
  let store: LibraryStore;
  let n = 0;

  beforeAll(async () => {
    server = await MongoMemoryServer.create({ binary: { systemBinary: '/usr/bin/mongod', version: '8.0.15' } });
  }, 60_000);

  afterAll(async () => {
    await store?.close();
    await server?.stop();
  });

  beforeEach(async () => {
    await store?.close();
    store = await LibraryStore.connect(`${server.getUri()}lib_${n++}`);
  });

  describe('LibraryStore (real mongod)', () => {
    it('creates with normalised fields and reads it back', async () => {
      const s = await store.create({ title: ' Restart nginx ', body: 'sudo systemctl restart nginx', tags: ['Ops', 'ops', 'Web Server'], folder: ' servers / web ' });
      expect(s).toMatchObject({ title: 'Restart nginx', tags: ['ops', 'web-server'], folder: 'servers/web', language: 'bash', useCount: 0, deletedAt: null });
      expect(await store.get(s.id)).toEqual(s);
    });

    it('rejects invalid documents at the database layer', async () => {
      await expect(store.create({ title: '', body: 'x' })).rejects.toThrow();
      await expect(store.create({ title: 't', body: 'x', language: 'perl' as never })).rejects.toThrow();
      await expect(store.create({ title: 'x'.repeat(201), body: 'x' })).rejects.toThrow();
    });

    it('never stores fields the caller smuggles in', async () => {
      const s = await store.create({ title: 't', body: 'b', useCount: 999, deletedAt: new Date(), isAdmin: true } as never);
      const raw = await store.get(s.id);
      expect(raw?.useCount).toBe(0);
      expect(raw?.deletedAt).toBeNull();
      expect(raw).not.toHaveProperty('isAdmin');
    });

    it('searches across fields, ranked, with literal (not regex) matching', async () => {
      await store.create({ title: 'docker prune', body: 'docker system prune -af', tags: ['docker'] });
      await store.create({ title: 'logs', body: 'journalctl -u docker -f' });
      await store.create({ title: 'regex trap', body: 'echo a.*b' });
      expect((await store.search({ q: 'docker' })).map((s) => s.title)).toEqual(['docker prune', 'logs']);
      expect((await store.search({ q: '.*' })).map((s) => s.title)).toEqual(['regex trap']);
      expect(await store.search({ q: 'nomatch' })).toEqual([]);
    });

    it('treats regex metacharacters literally at the database (an unescaped "(" is an invalid regex)', async () => {
      await store.create({ title: 'subshell', body: 'echo $(date)' });
      expect((await store.search({ q: '$(' })).map((s) => s.title)).toEqual(['subshell']);
      expect((await store.search({ q: '(' })).map((s) => s.title)).toEqual(['subshell']);
    });

    it('filters by folder (including subfolders) and tag', async () => {
      await store.create({ title: 'a', body: 'x', folder: 'deploy' });
      await store.create({ title: 'b', body: 'x', folder: 'deploy/k8s', tags: ['prod'] });
      await store.create({ title: 'c', body: 'x', folder: 'deployment' });
      expect((await store.search({ folder: 'deploy' })).map((s) => s.title).sort()).toEqual(['a', 'b']);
      expect((await store.search({ tag: 'PROD' })).map((s) => s.title)).toEqual(['b']);
      expect(await store.folders()).toEqual(['deploy', 'deploy/k8s', 'deployment']);
      expect(await store.tags()).toEqual(['prod']);
    });

    it('updates only the given fields and bumps updatedAt', async () => {
      const s = await store.create({ title: 't', body: 'old', tags: ['a'] });
      await new Promise((r) => setTimeout(r, 5));
      const u = await store.update(s.id, { body: 'new', tags: ['B'] });
      expect(u).toMatchObject({ title: 't', body: 'new', tags: ['b'] });
      expect(u.updatedAt > s.updatedAt).toBe(true);
      await expect(store.update(s.id, { title: '' })).rejects.toThrow();
    });

    it('trash hides from search, restore brings it back; nothing is hard-deleted', async () => {
      const s = await store.create({ title: 'temp', body: 'x' });
      await store.trash(s.id);
      expect(await store.search({})).toEqual([]);
      expect((await store.search({ deleted: true })).map((x) => x.id)).toEqual([s.id]);
      await expect(store.update(s.id, { body: 'y' })).rejects.toThrow(/not found/);
      await store.restore(s.id);
      expect((await store.search({})).map((x) => x.id)).toEqual([s.id]);
    });

    it('recordUse affects ranking but not updatedAt', async () => {
      const a = await store.create({ title: 'alpha', body: 'x' });
      await store.create({ title: 'beta', body: 'x' });
      await store.recordUse(a.id);
      await store.recordUse(a.id);
      const list = await store.search({});
      expect(list[0]?.title).toBe('alpha');
      expect(list[0]?.useCount).toBe(2);
      expect(list[0]?.updatedAt).toBe(a.updatedAt);
    });

    it('rejects malformed ids instead of querying', async () => {
      await expect(store.get('not-an-id')).rejects.toThrow(/Invalid snippet id/);
      await expect(store.trash('{"$ne":null}')).rejects.toThrow(/Invalid snippet id/);
    });

    it('creates its indexes explicitly', async () => {
      const s = await store.create({ title: 't', body: 'b' });
      expect(s.id).toMatch(/^[0-9a-f]{24}$/);
    });
  });

  describe('LibraryStore.connect failure', () => {
    it('fails fast when nothing is listening', async () => {
      const t0 = Date.now();
      await expect(LibraryStore.connect('mongodb://127.0.0.1:1/inviterminal', { serverSelectionTimeoutMS: 500 })).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(5000);
    });
  });

  describe('snippet schema (defence in depth behind LibraryStore)', () => {
    it('throws on unknown fields instead of storing or silently dropping them', async () => {
      const conn = await mongoose.createConnection(`${server.getUri()}schema_check`).asPromise();
      try {
        const M = conn.model('SchemaCheck', await buildSnippetSchema(), 'snippets');
        await expect(M.create({ title: 't', body: 'b', isAdmin: true } as never)).rejects.toThrow(/not in schema|strict/i);
      } finally {
        await conn.close();
      }
    });
  });
});
