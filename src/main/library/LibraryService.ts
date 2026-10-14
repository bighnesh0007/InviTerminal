import type { LibraryStatus } from '../../shared/snippet';
import { LibraryStore } from './LibraryStore';
import { checkMongoUri } from './mongo-uri';

/**
 * Owns the connection lifecycle. The terminal must keep working when MongoDB
 * is down, so failures become an "unavailable" status the UI shows, never a
 * crash; retry() tries again.
 */
export class LibraryService {
  private store: LibraryStore | null = null;
  private status: LibraryStatus;
  private connecting: Promise<void> | null = null;
  private target: string;

  constructor(
    private uri: string,
    private allowRemote: boolean,
    private readonly onStatus: (s: LibraryStatus) => void,
    private readonly connect: (uri: string) => Promise<LibraryStore> = (u) => LibraryStore.connect(u),
  ) {
    const check = checkMongoUri(uri, allowRemote);
    // Shown in the UI: host and database only, never credentials.
    this.target = check.ok ? `${check.host}/${check.dbName}` : 'invalid URI';
    this.status = check.ok ? { state: 'connecting', target: this.target } : { state: 'unavailable', target: this.target, reason: check.reason };
  }

  getStatus(): LibraryStatus {
    return this.status;
  }

  private set(s: LibraryStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  start(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  retry(): Promise<void> {
    return this.store ? Promise.resolve() : this.start();
  }

  private async doConnect(): Promise<void> {
    const check = checkMongoUri(this.uri, this.allowRemote);
    if (!check.ok) {
      this.set({ state: 'unavailable', target: this.target, reason: check.reason });
      return;
    }
    this.set({ state: 'connecting', target: this.target });
    try {
      this.store = await this.connect(this.uri);
      this.set({ state: 'ready', target: this.target });
    } catch (e) {
      this.set({ state: 'unavailable', target: this.target, reason: `Cannot reach MongoDB at ${this.target}: ${(e as Error).message}` });
    }
  }

  /** Throws a readable error instead of a driver stack when the library is not connected. */
  require(): LibraryStore {
    if (!this.store) throw new Error(this.status.state === 'unavailable' ? this.status.reason : 'Library is still connecting.');
    return this.store;
  }

  /** Switches to another URI (settings change): closes the old connection, then connects anew. */
  async reconfigure(uri: string, allowRemote: boolean): Promise<void> {
    if (uri === this.uri && allowRemote === this.allowRemote) return;
    await this.connecting?.catch(() => undefined);
    await this.close();
    this.uri = uri;
    this.allowRemote = allowRemote;
    const check = checkMongoUri(uri, allowRemote);
    this.target = check.ok ? `${check.host}/${check.dbName}` : 'invalid URI';
    await this.start();
  }

  async close(): Promise<void> {
    await this.store?.close();
    this.store = null;
  }
}
