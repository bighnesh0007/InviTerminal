import type { RendererApi } from '../shared/ipc';
import { AUDIO_KIND_LABEL, type AudioStatus } from '../shared/audio';
import { button, el } from './dom';

export interface AudioPanelView {
  element: HTMLElement;
  /** The always-visible recording badge, for the header (never concealed). */
  badge: HTMLElement;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
}

/**
 * Microphone panel (7c): starts/stops an audio session — which is what flips
 * the mic permission on in the main process — and shows a live input-level
 * meter to prove the mic only works during a session. No transcription yet.
 * A persistent recording badge is shown in the header whenever the mic is live.
 */
export function mountAudioPanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): AudioPanelView {
  const panel = el('aside', { className: 'library audio-panel' });
  panel.hidden = true;

  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);
  const meter = el('div', { className: 'mic-meter' }, el('div', { className: 'mic-meter-fill' }));
  const meterFill = meter.firstElementChild as HTMLElement;

  // Header badge — deliberately conspicuous; recording is never hidden.
  const badge = el('span', { className: 'rec-badge' });
  badge.hidden = true;

  let status: AudioStatus = { active: false, kind: null, since: null, meetingConsented: false };
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let raf = 0;

  function fmtElapsed(sinceIso: string): string {
    const secs = Math.max(0, Math.floor((Date.now() - Date.parse(sinceIso)) / 1000));
    return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  }

  function renderBadge(): void {
    badge.hidden = !status.active;
    if (status.active && status.kind && status.since) badge.textContent = `● REC — ${AUDIO_KIND_LABEL[status.kind]} ${fmtElapsed(status.since)}`;
  }

  function onStatus(s: AudioStatus): void {
    status = s;
    renderBadge();
    startBtn.disabled = s.active;
    stopBtn.disabled = !s.active;
    if (!s.active) teardownMeter();
  }
  api.audio.onStatus(onStatus);
  void api.audio.status().then(onStatus);
  // The badge elapsed time ticks every second while recording.
  window.setInterval(() => {
    if (status.active) renderBadge();
  }, 1000);

  function teardownMeter(): void {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void audioCtx?.close();
    audioCtx = null;
    meterFill.style.width = '0%';
  }

  async function startMeter(): Promise<void> {
    // This only succeeds because the session (started above) flipped the mic permission on.
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      meterFill.style.width = `${Math.min(100, Math.round((peak / 128) * 140))}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  const startBtn = button('Start microphone test', async () => {
    say('Requesting the microphone…');
    const err = await api.audio.start('mic-test');
    if (err) {
      say(err);
      return;
    }
    try {
      await startMeter();
      say('Microphone live. The bar moves with input level. Click Stop when done.');
    } catch (e) {
      await api.audio.stop();
      say(`Could not open the microphone: ${(e as Error).message}`);
    }
  }, say);

  const stopBtn = button('Stop', async () => {
    teardownMeter();
    await api.audio.stop();
    say('Stopped. The microphone is off.');
  }, say);
  stopBtn.disabled = true;

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Microphone' }), button('Close', () => close())),
    el('p', { className: 'field-note', text: 'The microphone is off until you start a session, and a red recording badge shows in the header while it is live. Nothing is transcribed or saved yet (that comes next).' }),
    el('div', { className: 'lib-actions' }, startBtn, stopBtn),
    meter,
    message,
  );

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
