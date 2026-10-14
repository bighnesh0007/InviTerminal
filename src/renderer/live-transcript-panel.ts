import type { LiveLine, LiveTranscriptStatus } from '../shared/audio';
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

  const consent = Object.assign(el('input'), { type: 'checkbox' });
  const consentLabel = el('label', { className: 'live-consent' }, consent, el('span', { text: 'Everyone in the call has been told it is being transcribed on my machine.' }));
  consent.addEventListener('change', () => setControls());

  const startBtn = button('Start transcribing', () => start(), say);
  const stopBtn = button('Stop', () => stop(), say);

  function setControls(): void {
    startBtn.hidden = active;
    stopBtn.hidden = !active;
    startBtn.disabled = active || !sttReady || !consent.checked;
    consent.disabled = active;
  }

  function line(l: LiveLine): void {
    const row = el('div', { className: 'live-line' }, el('span', { className: 'live-time', text: new Date(l.at).toLocaleTimeString() }), el('span', { className: 'live-text', text: l.text }));
    feed.append(row);
    feed.scrollTop = feed.scrollHeight;
  }

  function render(s: LiveTranscriptStatus): void {
    active = s.active;
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
    try {
      render(await api.live.start(consent.checked));
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
  void api.live.status().then((s) => {
    sttReady = !s.reason;
    render(s);
  });

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Live transcript' }), button('Close', () => close())),
    el('p', { className: 'field-note', text: 'Transcribes the call/meeting audio playing on this computer, locally, and shows it here. Off by default; a visible "● Live" indicator shows while on. Audio stays on your machine.' }),
    statusLine,
    consentLabel,
    el('div', { className: 'lib-actions' }, startBtn, stopBtn),
    feed,
    message,
  );
  setControls();

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
