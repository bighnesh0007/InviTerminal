import { randomUUID } from 'node:crypto';
import { FlowControl } from './FlowControl';
import type { ShellProfile } from './shells';

/** The subset of node-pty's IPty we use, so tests can supply a fake. */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export type SpawnPty = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyLike;

export interface PtyEvents {
  data(sessionId: string, data: string): void;
  exit(sessionId: string, exitCode: number, signal: number | undefined): void;
}

export interface SessionInfo {
  sessionId: string;
  profileId: string;
  label: string;
  pid: number;
}

interface Session {
  info: SessionInfo;
  pty: PtyLike;
  flow: FlowControl;
  pending: string;
  timer: NodeJS.Timeout | null;
  size: { cols: number; rows: number } | null;
}

export const MAX_SESSIONS = 8;
/** Coalesce PTY output for this long before one IPC send; keeps `cat bigfile` from producing thousands of tiny messages. */
const BATCH_MS = 5;
const BATCH_MAX_CHARS = 65_536;

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  /** From settings; ignored if it names a profile that was not detected on this machine. */
  private preferredDefault: string | null = null;

  constructor(
    private readonly spawnPty: SpawnPty,
    private readonly profiles: { profiles: ShellProfile[]; defaultId: string },
    private readonly env: () => Record<string, string>,
    private readonly cwd: string,
    private readonly events: PtyEvents,
  ) {}

  setDefaultProfile(id: string | null): void {
    this.preferredDefault = id;
  }

  get defaultProfileId(): string {
    return this.preferredDefault && this.profiles.profiles.some((p) => p.id === this.preferredDefault) ? this.preferredDefault : this.profiles.defaultId;
  }

  listProfiles(): { id: string; label: string; isDefault: boolean }[] {
    return this.profiles.profiles.map((p) => ({ id: p.id, label: p.label, isDefault: p.id === this.defaultProfileId }));
  }

  /** The renderer chooses a profile id; the file and arguments come only from the detected table. */
  spawn(profileId?: string): SessionInfo {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} terminal sessions.`);
    const id = profileId ?? this.defaultProfileId;
    const profile = this.profiles.profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Unknown shell profile "${id}".`);

    const pty = this.spawnPty(profile.file, profile.args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: this.cwd, env: this.env() });
    const sessionId = randomUUID();
    const session: Session = {
      info: { sessionId, profileId: profile.id, label: profile.label, pid: pty.pid },
      pty,
      flow: new FlowControl(
        () => pty.pause(),
        () => pty.resume(),
      ),
      pending: '',
      timer: null,
      size: null,
    };
    this.sessions.set(sessionId, session);

    pty.onData((data) => this.buffer(session, data));
    pty.onExit(({ exitCode, signal }) => {
      this.flush(session);
      this.sessions.delete(sessionId);
      this.events.exit(sessionId, exitCode, signal);
    });
    return session.info;
  }

  private buffer(s: Session, data: string): void {
    s.pending += data;
    if (s.pending.length >= BATCH_MAX_CHARS) this.flush(s);
    else s.timer ??= setTimeout(() => this.flush(s), BATCH_MS);
  }

  private flush(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (!s.pending) return;
    const out = s.pending;
    s.pending = '';
    s.flow.sent(out.length);
    this.events.data(s.info.sessionId, out);
  }

  input(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.pty.resize(cols, rows);
    s.size = { cols, rows };
  }

  ack(sessionId: string, chars: number): void {
    this.sessions.get(sessionId)?.flow.acked(chars);
  }

  /** For diagnostics and the autotest. */
  stats(sessionId: string): { inFlight: number; paused: boolean; pauseCount: number; size: { cols: number; rows: number } | null } | null {
    const s = this.sessions.get(sessionId);
    return s ? { inFlight: s.flow.inFlight, paused: s.flow.isPaused, pauseCount: s.flow.pauseCount, size: s.size } : null;
  }

  kill(sessionId: string): void {
    this.sessions.get(sessionId)?.pty.kill();
  }

  /** Called on window close / quit so no shell outlives the app. */
  killAll(): void {
    for (const s of this.sessions.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.pty.kill();
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
