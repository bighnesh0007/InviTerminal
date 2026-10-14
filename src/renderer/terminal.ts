import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { RendererApi } from '../shared/ipc';

/** Acks are batched so a fast producer does not cost one IPC message per chunk. */
const ACK_FLUSH_MS = 16;
/** Pastes larger than this are sent in pieces; main rejects input messages over 64 KiB. */
const INPUT_CHUNK = 32_768;

export interface TerminalView {
  focus(): void;
  /** Re-measure after the container changes size. */
  fit(): void;
}

/**
 * One xterm.js terminal bound to one shell session. Keystrokes reach the
 * shell only while `inputAllowed()` is true, so nobody types blind into a
 * shell they cannot see while the protection gate is up.
 */
export function mountTerminal(container: HTMLElement, api: RendererApi, inputAllowed: () => boolean, onBlockedInput: () => void): TerminalView {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", monospace',
    fontSize: 13,
    scrollback: 5000,
    cursorBlink: true,
    // Screen-reader mode mirrors terminal text into the accessibility tree, readable by any process.
    screenReaderMode: false,
    theme: { background: '#0b0d11', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: '#3a4252' },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  let sessionId: string | null = null;
  let exited = false;
  let pendingAck = 0;
  let ackTimer: number | null = null;

  const flushAck = () => {
    ackTimer = null;
    if (sessionId && pendingAck > 0) api.terminal.ack(sessionId, pendingAck);
    pendingAck = 0;
  };

  function send(data: string): void {
    if (!sessionId || exited) return;
    if (!inputAllowed()) {
      onBlockedInput();
      return;
    }
    for (let i = 0; i < data.length; i += INPUT_CHUNK) api.terminal.input(sessionId, data.slice(i, i + INPUT_CHUNK));
  }

  function fit(): void {
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    const before = `${term.cols}x${term.rows}`;
    fitAddon.fit();
    if (sessionId && `${term.cols}x${term.rows}` !== before) api.terminal.resize(sessionId, term.cols, term.rows);
  }

  async function start(): Promise<void> {
    exited = false;
    const s = await api.terminal.spawn();
    sessionId = s.sessionId;
    fitAddon.fit();
    api.terminal.resize(s.sessionId, term.cols, term.rows);
  }

  api.terminal.onData((id, data) => {
    if (id !== sessionId) return;
    term.write(data, () => {
      pendingAck += data.length;
      ackTimer ??= window.setTimeout(flushAck, ACK_FLUSH_MS);
    });
  });

  api.terminal.onExit((id, exitCode, signal) => {
    if (id !== sessionId) return;
    flushAck();
    exited = true;
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
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) void api.clipboard.write(sel);
      return false;
    }
    // Panic hide is handled at window level; keep xterm from also sending it to the shell.
    if (e.code === 'KeyH') return false;
    if (e.code === 'KeyV') {
      // term.paste() applies bracketed-paste markers when the shell asked for them.
      void api.clipboard.read().then((t) => term.paste(t));
      return false;
    }
    return true;
  });

  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fit);
  }).observe(container);

  void start();
  return { focus: () => term.focus(), fit };
}
