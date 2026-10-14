import type { AudioKind, AudioStatus } from '../../shared/audio';

/**
 * Tracks whether a microphone session is active. The permission handler only
 * allows getUserMedia({audio}) while this is active, so the mic is off by
 * default and on only during an explicit, user-started session. A meeting
 * recording (which captures other people) additionally requires a one-time
 * consent acknowledgement this session.
 */
export class AudioController {
  private active = false;
  private kind: AudioKind | null = null;
  private since: string | null = null;
  private meetingConsented = false;
  private readonly listeners: ((s: AudioStatus) => void)[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  get(): AudioStatus {
    return { active: this.active, kind: this.kind, since: this.since, meetingConsented: this.meetingConsented };
  }

  /** True only while a session is active — the mic permission gate reads this. */
  get micAllowed(): boolean {
    return this.active;
  }

  onChange(cb: (s: AudioStatus) => void): void {
    this.listeners.push(cb);
  }

  private emit(): void {
    const s = this.get();
    for (const l of this.listeners) l(s);
  }

  /** Records that the user consented to a meeting recording this session. */
  consentToMeeting(): void {
    if (this.meetingConsented) return;
    this.meetingConsented = true;
    this.emit();
  }

  /** Starts a session. A meeting recording requires prior consent. Throws otherwise. */
  start(kind: AudioKind): void {
    if (kind === 'meeting' && !this.meetingConsented) throw new Error('Meeting recording needs consent first (everyone present must agree).');
    this.active = true;
    this.kind = kind;
    this.since = this.now().toISOString();
    this.emit();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.kind = null;
    this.since = null;
    this.emit();
  }
}
