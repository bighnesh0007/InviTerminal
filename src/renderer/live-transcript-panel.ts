import type { LiveLine, LiveTranscriptStatus } from '../shared/audio';
import { ANSWER_LENGTHS, ANSWER_LENGTH_LABELS, type AnswerLength, type AiStatus } from '../shared/ai';
import type { RendererApi } from '../shared/ipc';
import { button, el } from './dom';

export interface LiveTranscriptPanelView {
  element: HTMLElement;
  /** Always-visible header badge while transcribing. */
  badge: HTMLElement;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
}

/**
 * Live meeting transcript (Phase 1). Captures the call audio playing on this
 * machine, transcribes it locally with whisper, and streams the text here. It is
 * CONSENT-GATED — recording a call records everyone in it — and shows a visible
 * "● Live" indicator while on. Audio never leaves the machine. Behind the gate.
 */
export function mountLiveTranscriptPanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): LiveTranscriptPanelView {
  const panel = el('aside', { className: 'library live-panel' });
  panel.hidden = true;

  const statusLine = el('p', { className: 'lib-status' });
  const feed = el('div', { className: 'live-feed' });
  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);
  const badge = el('span', { className: 'rec-badge live-badge' });
  badge.hidden = true;

  let sttReady = false;
  let active = false;
  let diarizeAvailable = false;
  let aiReady = false;

  // ---- Ask AI: length selector + per-line streaming answers --------------------------------
  let askLength: AnswerLength = readStoredLength();
  let nextId = 1;
  const asks = new Map<number, { answer: HTMLElement; btn: HTMLButtonElement; started: boolean; busy: boolean }>();

  const lengthButtons = ANSWER_LENGTHS.map((len) => {
    const b = button(ANSWER_LENGTH_LABELS[len], () => {
      askLength = len;
      try {
        localStorage.setItem('invi.askLength', len);
      } catch {
        /* private mode */
      }
      refreshLength();
    });
    b.dataset.len = len;
    return b;
  });
  const lengthRow = el('div', { className: 'live-length' }, el('span', { className: 'field-note', text: 'Answer length:' }), ...lengthButtons);
  function refreshLength(): void {
    for (const b of lengthButtons) b.classList.toggle('active', b.dataset.len === askLength);
  }
  refreshLength();

  const consent = Object.assign(el('input'), { type: 'checkbox' });
  const consentLabel = el('label', { className: 'live-consent' }, consent, el('span', { text: 'Everyone in the call has been told it is being transcribed on my machine.' }));
  consent.addEventListener('change', () => setControls());

  const diarize = Object.assign(el('input'), { type: 'checkbox' });
  const diarizeNote = el('span', { className: 'field-note' });
  const diarizeLabel = el('label', { className: 'live-consent' }, diarize, el('span', { text: '🗣 Label speaker turns' }), diarizeNote);

  const startBtn = button('Start transcribing', () => start(), say);
  const stopBtn = button('Stop', () => stop(), say);

  function setControls(): void {
    startBtn.hidden = active;
    stopBtn.hidden = !active;
    startBtn.disabled = active || !sttReady || !consent.checked;
    consent.disabled = active;
    diarize.disabled = active || !diarizeAvailable;
    diarizeNote.textContent = diarizeAvailable ? '' : ' — needs the speaker model (Settings → Live transcript)';
  }

  function line(l: LiveLine): void {
    const id = nextId++;
    const parts = [el('span', { className: 'live-time', text: new Date(l.at).toLocaleTimeString() })];
    if (l.speaker) parts.push(el('span', { className: 'live-speaker', text: l.speaker }));
    parts.push(el('span', { className: 'live-text', text: l.text }));
    const askBtn = button('✨ Ask', () => ask(id, l.text));
    askBtn.className = 'live-ask';
    askBtn.disabled = !aiReady;
    askBtn.title = aiReady ? 'Ask the AI about this line' : `Add a ${'Groq'} key in Settings to use Ask`;
    parts.push(askBtn);
    const answer = el('div', { className: 'live-answer' });
    answer.hidden = true;
    feed.append(el('div', { className: 'live-item' }, el('div', { className: 'live-line' }, ...parts), answer));
    asks.set(id, { answer, btn: askBtn, started: false, busy: false });
    feed.scrollTop = feed.scrollHeight;
  }

  async function ask(id: number, text: string): Promise<void> {
    const entry = asks.get(id);
    if (!entry || entry.busy) return;
    entry.busy = true;
    entry.started = false;
    entry.btn.disabled = true;
    entry.answer.hidden = false;
    entry.answer.textContent = '…';
    try {
      await api.live.ask(id, text, askLength);
    } catch (e) {
      entry.answer.textContent = `Error: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
      entry.busy = false;
      entry.btn.disabled = !aiReady;
    }
  }

  function render(s: LiveTranscriptStatus): void {
    active = s.active;
    diarizeAvailable = s.diarizeAvailable;
    badge.hidden = !s.active;
    badge.textContent = `● Live · ${s.lines} line${s.lines === 1 ? '' : 's'}`;
    if (s.reason && !s.active) statusLine.textContent = `Not ready — ${s.reason}`;
    else if (s.active) statusLine.textContent = `Transcribing ${s.source ?? 'system audio'} locally…`;
    else statusLine.textContent = sttReady ? 'Ready. Transcription runs on your machine; audio is never uploaded.' : 'Waiting for the local speech-to-text model…';
    statusLine.dataset.state = s.reason && !s.active ? 'unavailable' : 'ready';
    setControls();
  }

  async function start(): Promise<void> {
    say('');
    feed.replaceChildren();
    asks.clear();
    try {
      render(await api.live.start(consent.checked, diarize.checked));
      say('Transcribing. Play the call through your speakers; text appears below.');
    } catch (e) {
      say((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }

  async function stop(): Promise<void> {
    await api.live.stop();
    say('Stopped.');
  }

  api.live.onStatus(render);
  api.live.onLine(line);
  api.live.onError((m) => say(`Error: ${m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`));
  api.live.onAnswerDelta(({ id, chunk }) => {
    const entry = asks.get(id);
    if (!entry) return;
    if (!entry.started) {
      entry.answer.textContent = '';
      entry.started = true;
    }
    entry.answer.textContent += chunk;
    feed.scrollTop = feed.scrollHeight;
  });
  api.live.onAnswerDone(({ id }) => {
    const entry = asks.get(id);
    if (!entry) return;
    entry.busy = false;
    entry.btn.disabled = !aiReady;
  });
  api.live.onAnswerError(({ id, message }) => {
    const entry = asks.get(id);
    if (!entry) return;
    entry.answer.textContent = `Error: ${message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
    entry.busy = false;
    entry.btn.disabled = !aiReady;
  });
  void api.live.status().then((s) => {
    sttReady = !s.reason;
    render(s);
  });

  const renderAi = (s: AiStatus) => {
    aiReady = s.key.present;
    for (const e of asks.values()) e.btn.disabled = e.busy || !aiReady;
  };
  void api.ai.status().then(renderAi);
  api.ai.onStatus(renderAi);

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Live transcript' }), button('Close', () => close())),
    el('p', { className: 'field-note', text: 'Transcribes the call/meeting audio playing on this computer, locally, and shows it here. Off by default; a visible "● Live" indicator shows while on. Audio stays on your machine.' }),
    statusLine,
    consentLabel,
    diarizeLabel,
    el('div', { className: 'lib-actions' }, startBtn, stopBtn),
    lengthRow,
    feed,
    message,
  );
  setControls();

  function readStoredLength(): AnswerLength {
    try {
      const v = localStorage.getItem('invi.askLength');
      if (v && (ANSWER_LENGTHS as readonly string[]).includes(v)) return v as AnswerLength;
    } catch {
      /* private mode */
    }
    return 'short';
  }

  function close(): void {
    if (panel.hidden) return;
    panel.hidden = true;
    opts.onOpenChange(false);
  }

  return {
    element: panel,
    badge,
    isOpen: () => !panel.hidden,
    toggle() {
      panel.hidden = !panel.hidden;
      opts.onOpenChange(!panel.hidden);
    },
    close,
  };
}
