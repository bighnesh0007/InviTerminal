import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { RendererApi, TermSession } from '../shared/ipc';

/** Acks are batched so a fast producer does not cost one IPC message per chunk. */
const ACK_FLUSH_MS = 16;
/** Pastes larger than this are sent in pieces; main rejects input messages over 64 KiB. */
const INPUT_CHUNK = 32_768;

export interface TerminalOptions {
  fontSize: number;
  scrollback: number;
}

export interface TerminalView {
  focus(): void;
  /** Types text as a paste: bracketed when the shell enabled bracketed paste, so it is not run. */
  paste(text: string): void;
  /** Re-measure after the container changes size or becomes visible. */
  fit(): void;
  setOptions(o: TerminalOptions): void;
  /** The current selection, or '' if nothing is selected. */
  getSelectionText(): string;
  /** The visible viewport as text (fallback when there is no selection). */
  getViewportText(): string;
  /** Kills the shell and releases the terminal (tab closed). */
  dispose(): void;
  readonly session: TermSession | null;
}

export interface MountOptions extends TerminalOptions {
  /** Shell profile; undefined = the configured default. */
  profileId?: string;
  inputAllowed(): boolean;
  onBlockedInput(): void;
  /** Called with the session once the shell is running (again, after a restart). */
  onSession?(s: TermSession): void;
  onExit?(exitCode: number, signal: number | null): void;
  /** Passive read of each output chunk after it is shown (e.g. error detection). Never alters the shell. */
  onOutput?(data: string): void;
}

/**
 * One xterm.js terminal bound to one shell session. Keystrokes reach the
 * shell only while `inputAllowed()` is true, so nobody types blind into a
 * shell they cannot see while the protection gate is up.
 */
export function mountTerminal(container: HTMLElement, api: RendererApi, opts: MountOptions): TerminalView {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", monospace',
    fontSize: opts.fontSize,
    scrollback: opts.scrollback,
    cursorBlink: true,
    // Screen-reader mode mirrors terminal text into the accessibility tree, readable by any process.
    screenReaderMode: false,
    theme: { background: '#0b0d11', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: '#3a4252' },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  let session: TermSession | null = null;
  let exited = false;
  let disposed = false;
  let pendingAck = 0;
  let ackTimer: number | null = null;

  const flushAck = () => {
    ackTimer = null;
    if (session && pendingAck > 0) api.terminal.ack(session.sessionId, pendingAck);
    pendingAck = 0;
  };

  function send(data: string): void {
    if (!session || exited) return;
    if (!opts.inputAllowed()) {
      opts.onBlockedInput();
      return;
    }
    for (let i = 0; i < data.length; i += INPUT_CHUNK) api.terminal.input(session.sessionId, data.slice(i, i + INPUT_CHUNK));
  }

  function fit(): void {
    if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
    const before = `${term.cols}x${term.rows}`;
    fitAddon.fit();
    if (session && `${term.cols}x${term.rows}` !== before) api.terminal.resize(session.sessionId, term.cols, term.rows);
  }

  async function start(): Promise<void> {
    exited = false;
    const s = await api.terminal.spawn(opts.profileId);
    if (disposed) {
      api.terminal.kill(s.sessionId);
      return;
    }
    session = s;
    opts.onSession?.(s);
    if (container.clientWidth > 0) fitAddon.fit();
    api.terminal.resize(s.sessionId, term.cols, term.rows);
  }

  const offData = api.terminal.onData((id, data) => {
    if (id !== session?.sessionId) return;
    term.write(data, () => {
      pendingAck += data.length;
      ackTimer ??= window.setTimeout(flushAck, ACK_FLUSH_MS);
    });
    // Side observer only: a failure here must never affect rendering, acks or the shell.
    if (opts.onOutput) {
      try {
        opts.onOutput(data);
      } catch {
        /* ignore */
      }
    }
  });

  const offExit = api.terminal.onExit((id, exitCode, signal) => {
    if (id !== session?.sessionId) return;
    flushAck();
    exited = true;
    opts.onExit?.(exitCode, signal);
    const how = signal ? `signal ${signal}` : `code ${exitCode}`;
    term.write(`\r\n\x1b[2m[process exited with ${how}] Press Enter to start a new shell.\x1b[0m\r\n`);
  });

  term.onData((data) => {
    if (exited) {
      if (data === '\r') {
        term.reset();
        void start();
      }
      return;
    }
    send(data);
  });
  term.onBinary((data) => send(data));

  // Ctrl+Shift+C / Ctrl+Shift+V, as in Konsole and GNOME Terminal; plain Ctrl+C stays SIGINT.
  // App shortcuts never get here: a window-level capture listener takes them first.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) void api.clipboard.write(sel);
      return false;
    }
    if (e.code === 'KeyV') {
      // term.paste() applies bracketed-paste markers when the shell asked for them.
      void api.clipboard.read().then((t) => term.paste(t));
      return false;
    }
    return true;
  });

  let raf = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fit);
  });
  observer.observe(container);

  void start();
  return {
    focus: () => term.focus(),
    paste: (text) => term.paste(text),
    fit,
    setOptions(o) {
      term.options.fontSize = o.fontSize;
      term.options.scrollback = o.scrollback;
      fit();
    },
    getSelectionText: () => term.getSelection(),
    getViewportText: () => {
      const buf = term.buffer.active;
      const top = buf.viewportY;
      const lines: string[] = [];
      for (let y = top; y < top + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      return lines.join('\n').replace(/\n+$/, '');
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      offData();
      offExit();
      if (session && !exited) api.terminal.kill(session.sessionId);
      term.dispose();
    },
    get session() {
      return session;
    },
  };
}
