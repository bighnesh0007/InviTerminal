import type { RendererApi } from '../shared/ipc';
import { AI_MODEL_LABELS, AI_PROVIDER, type AiStatus } from '../shared/ai';
import { redactSecrets, summarizeRedactions } from '../shared/redact';
import { button, el } from './dom';

export interface AiPanelView {
  element: HTMLElement;
  isOpen(): boolean;
  close(): void;
  /** Trigger from a button or the shortcut: offers to explain the current selection/viewport. */
  request(getText: () => { selection: string; viewport: string }): void;
}

const PREVIEW_HEAD = 8;
const PREVIEW_TAIL = 4;

function previewOf(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_HEAD + PREVIEW_TAIL) return text;
  return [...lines.slice(0, PREVIEW_HEAD), `… ${lines.length - PREVIEW_HEAD - PREVIEW_TAIL} more lines …`, ...lines.slice(-PREVIEW_TAIL)].join('\n');
}

/**
 * The "Explain terminal output" panel. Nothing is sent until the
 * user confirms a preview that shows exactly what will go to the provider (Groq), with
 * secrets masked by default. Sits behind the protection gate like the other
 * side panels.
 */
export function mountAiPanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): AiPanelView {
  const panel = el('aside', { className: 'library ai-panel' });
  panel.hidden = true;

  const statusLine = el('p', { className: 'lib-status' });
  const confirm = el('div', { className: 'ai-confirm' });
  confirm.hidden = true;
  const output = el('pre', { className: 'ai-output' });
  const outputWrap = el('div', { className: 'ai-output-wrap' }, output);
  outputWrap.hidden = true;
  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);

  let status: AiStatus | null = null;
  const prefs = { redact: true, wantImage: false, skipConfirm: false };
  let streaming = false;

  function renderStatus(s: AiStatus): void {
    status = s;
    statusLine.textContent = s.key.present ? `Model: ${AI_MODEL_LABELS[s.model]} (${AI_PROVIDER})` : 'No API key set — add one in Settings (Ctrl+Shift+Comma) to use AI.';
    statusLine.dataset.state = s.key.present ? 'ready' : 'unavailable';
  }
  api.ai.onStatus(renderStatus);
  void api.ai.status().then(renderStatus);

  // ---- streaming output ----------------------------------------------------------------
  const stopButton = button('Stop', () => api.ai.cancelExplain());
  api.ai.onExplainDelta((chunk) => {
    output.textContent += chunk;
    outputWrap.scrollTop = outputWrap.scrollHeight;
  });
  const endStream = (note: string) => {
    streaming = false;
    stopButton.hidden = true;
    if (note) say(note);
  };
  api.ai.onExplainDone(() => endStream('Done.'));
  api.ai.onExplainError((m) => endStream(`Error: ${m}`));
  api.ai.onExplainCancelled(() => endStream('Stopped.'));

  async function startStream(text: string): Promise<void> {
    confirm.hidden = true;
    output.textContent = '';
    outputWrap.hidden = false;
    stopButton.hidden = false;
    streaming = true;
    say(`Asking ${AI_PROVIDER}…`);
    try {
      await api.ai.explain({ text, redact: prefs.redact, wantImage: prefs.wantImage });
    } catch (e) {
      endStream(`Error: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    }
  }

  // ---- confirm-before-send -------------------------------------------------------------
  function showConfirm(text: string): void {
    const { redacted, redactions } = redactSecrets(text);
    const shownText = prefs.redact ? redacted : text;
    const bytes = new TextEncoder().encode(shownText).length;

    const redactBox = Object.assign(el('input'), { type: 'checkbox' });
    redactBox.checked = prefs.redact;
    const skipBox = Object.assign(el('input'), { type: 'checkbox' });

    const previewPre = el('pre', { className: 'ai-preview', text: previewOf(shownText) });
    const summary = el('p', { className: 'field-note' });
    const refresh = () => {
      prefs.redact = redactBox.checked;
      const t = prefs.redact ? redacted : text;
      previewPre.textContent = previewOf(t);
      summary.textContent = `${new TextEncoder().encode(t).length} bytes · ${prefs.redact ? summarizeRedactions(redactions) : 'Secrets NOT masked.'}`;
    };
    redactBox.addEventListener('change', refresh);

    confirm.replaceChildren(
      el('p', { text: `This will send the following terminal text to ${AI_PROVIDER}:` }),
      previewPre,
      summary,
      el('label', { className: 'lib-trash' }, redactBox, el('span', { text: 'Mask obvious secrets (recommended)' })),
      el('label', { className: 'lib-trash' }, skipBox, el('span', { text: "Don't ask again this session" })),
      el(
        'div',
        { className: 'lib-actions' },
        button(`Send to ${AI_PROVIDER}`, () => {
          prefs.skipConfirm = skipBox.checked;
          void startStream(text);
        }),
        button('Cancel', () => {
          confirm.hidden = true;
          say('Cancelled. Nothing was sent.');
        }),
      ),
    );
    refresh();
    confirm.hidden = false;
    outputWrap.hidden = true;
  }

  function open(): void {
    if (panel.hidden) {
      panel.hidden = false;
      opts.onOpenChange(true);
    }
  }

  function request(getText: () => { selection: string; viewport: string }): void {
    open();
    if (streaming) {
      say('An explanation is already running — Stop it first.');
      return;
    }
    if (!status?.key.present) {
      confirm.hidden = true;
      outputWrap.hidden = true;
      say(`No API key set. Open Settings (Ctrl+Shift+Comma) and add your ${AI_PROVIDER} API key.`);
      return;
    }
    const { selection, viewport } = getText();
    const text = selection.trim() || viewport.trim();
    if (!text) {
      say('Select some terminal output first (or there is nothing on screen to explain).');
      return;
    }
    say('');
    if (prefs.skipConfirm) void startStream(text);
    else showConfirm(text);
  }

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: `Explain with ${AI_PROVIDER}` }), stopButton, button('Close', () => close())),
    statusLine,
    message,
    confirm,
    outputWrap,
  );
  stopButton.hidden = true;

  function close(): void {
    if (panel.hidden) return;
    if (streaming) api.ai.cancelExplain();
    panel.hidden = true;
    opts.onOpenChange(false);
  }

  return { element: panel, isOpen: () => !panel.hidden, close, request };
}
