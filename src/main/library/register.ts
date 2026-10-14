import { type BrowserWindow, ipcMain } from 'electron';
import type { z } from 'zod';
import { IPC } from '../../shared/ipc';
import { isFromWindow } from '../ipc-guard';
import type { LibraryService } from './LibraryService';
import { IdRequest, SearchRequest, SnippetInputSchema, UpdateRequest } from './schemas';

/** Library IPC: every request is sender-checked and schema-parsed before it reaches the store. */
export function registerLibraryIpc(getWin: () => BrowserWindow | null, lib: LibraryService): void {
  function handle<S extends z.ZodType, R>(channel: string, schema: S | null, fn: (msg: z.infer<S>) => Promise<R> | R): void {
    ipcMain.handle(channel, (e, raw: unknown) => {
      if (!isFromWindow(e, getWin())) throw new Error('IPC from unexpected sender');
      return fn(schema ? schema.parse(raw ?? {}) : (undefined as z.infer<S>));
    });
  }

  handle(IPC.libStatus, null, () => lib.getStatus());
  handle(IPC.libRetry, null, () => lib.retry().then(() => lib.getStatus()));
  handle(IPC.libSearch, SearchRequest, (m) => {
    // exactOptionalPropertyTypes: pass only the keys that are present.
    const q: Parameters<ReturnType<LibraryService['require']>['search']>[0] = {};
    if (m.q !== undefined) q.q = m.q;
    if (m.folder !== undefined) q.folder = m.folder;
    if (m.tag !== undefined) q.tag = m.tag;
    if (m.deleted !== undefined) q.deleted = m.deleted;
    return lib.require().search(q);
  });
  handle(IPC.libCreate, SnippetInputSchema, (m) => lib.require().create(stripUndefined(m)));
  handle(IPC.libUpdate, UpdateRequest, (m) => lib.require().update(m.id, stripUndefined(m.patch)));
  handle(IPC.libTrash, IdRequest, (m) => lib.require().trash(m.id));
  handle(IPC.libRestore, IdRequest, (m) => lib.require().restore(m.id));
  handle(IPC.libUsed, IdRequest, (m) => lib.require().recordUse(m.id));
  handle(IPC.libFolders, null, () => lib.require().folders());
  handle(IPC.libTags, null, () => lib.require().tags());
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
