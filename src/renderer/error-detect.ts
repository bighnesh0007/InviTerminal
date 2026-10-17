/**
 * Heuristic detection of a failed command in terminal output. The PTY carries no command
 * boundaries (no shell integration), so this watches the output stream for signatures that almost
 * always mean something went wrong — "command not found", a stack trace, a non-trivial "Error:"
 * line — and reports once per burst. It is deliberately conservative to limit false positives,
 * and it is passive: it only reads output already shown, never writing to or blocking the shell.
 */

// Strip ANSI CSI/colour sequences and carriage returns so patterns match the visible text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(/\r/g, '');
}

/** Signatures that reliably indicate a failure. Kept specific on purpose. */
export const ERROR_SIGNATURES: RegExp[] = [
  /\bcommand not found\b/i,
  /\bNo such file or directory\b/,
  /\bPermission denied\b/,
  /\bsegmentation fault\b/i,
  /^Traceback \(most recent call last\):/m, // Python
  /^[A-Za-z_][\w.]*(Error|Exception): /m, // Foo.BarError: ... (Python/JS/Java)
  /^\s+at .+:\d+:\d+\)?\s*$/m, // JS/TS stack frame
  /^fatal: /m, // git
  /^npm ERR!/m,
  /^error\[E\d+\]:/m, // rust
  /^\s*panic:/m, // go
  /^(make|gcc|g\+\+|clang|ld):.*\berror\b/im,
  /^Error: /m,
];

/** True if `text` contains any failure signature. Pure; used for both detection and testing. */
export function looksLikeError(text: string): boolean {
  return ERROR_SIGNATURES.some((re) => re.test(text));
}

export interface ErrorWatcher {
  /** Feed a chunk of raw terminal output (ANSI allowed). */
  feed(data: string): void;
  /** Drop buffered state and any pending timer (e.g. on tab close). */
  reset(): void;
}

export interface WatcherOptions {
  /** Wait this long after a signature appears, so a full multi-line trace is captured in one shot. */
  debounceMs?: number;
  /** Suppress further detections for this long after firing, so one failure fires once. */
  cooldownMs?: number;
  /** How many recent lines of context to report. */
  bufferLines?: number;
  now?: () => number;
  /** Injectable timer (tests). Must return a handle cancellable by clearTimer. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * Builds a stateful watcher. On a detected failure it calls `onDetect(recent)` once, where
 * `recent` is the last N lines of cleaned output (the context to explain). Debounced so a
 * streaming traceback is one event; a cooldown stops a noisy failure from firing repeatedly.
 * `onDetect` returns false when it did not act on the detection, which leaves the cooldown unset.
 */
export function createErrorWatcher(onDetect: (recent: string) => boolean | void, opts: WatcherOptions = {}): ErrorWatcher {
  const debounceMs = opts.debounceMs ?? 500;
  const cooldownMs = opts.cooldownMs ?? 8000;
  const maxLines = opts.bufferLines ?? 60;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  let buffer = '';
  let lastFired = -Infinity;
  let pending: ReturnType<typeof setTimeout> | null = null;

  function trimBuffer(): void {
    const lines = buffer.split('\n');
    if (lines.length > maxLines) buffer = lines.slice(-maxLines).join('\n');
  }

  function fire(): void {
    pending = null;
    // The cooldown starts only if the detection was acted on. A detection nobody used (feature
    // off, a background tab, an explanation already running) must not suppress the next real one.
    const accepted = onDetect(buffer.trimEnd());
    if (accepted !== false) lastFired = now();
  }

  return {
    feed(data: string): void {
      const clean = stripAnsi(data);
      if (!clean) return;
      buffer += clean;
      trimBuffer();
      if (pending) return; // already waiting to fire for this burst
      if (now() - lastFired < cooldownMs) return; // still cooling down
      // Only inspect the fresh chunk, so we react to new failures, not old buffered text.
      if (looksLikeError(clean)) pending = setTimer(fire, debounceMs);
    },
    reset(): void {
      if (pending) clearTimer(pending);
      pending = null;
      buffer = '';
      lastFired = -Infinity;
    },
  };
}
