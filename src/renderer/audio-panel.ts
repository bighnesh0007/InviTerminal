import type { RendererApi } from '../shared/ipc';
import { AUDIO_KIND_LABEL, type AudioStatus, type SttStatus } from '../shared/audio';
import { encodeWav } from '../shared/wav';
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
 * Microphone panel (7c + 7d): starts/stops an audio session (which flips the
 * mic permission on), shows a live input meter, and — with whisper.cpp — records
 * speech and transcribes it locally. Audio never leaves the machine: the WAV is
 * sent to the main process, transcribed by the local binary, and deleted.
 */
export function mountAudioPanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): AudioPanelView {
  const panel = el('aside', { className: 'library audio-panel' });
  panel.hidden = true;

  const sttLine = el('p', { className: 'lib-status' });
  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);
  const meter = el('div', { className: 'mic-meter' }, el('div', { className: 'mic-meter-fill' }));
  const meterFill = meter.firstElementChild as HTMLElement;
  const transcript = el('pre', { className: 'ai-output', text: '' });

  const badge = el('span', { className: 'rec-badge' });
  badge.hidden = true;

  let status: AudioStatus = { active: false, kind: null, since: null, meetingConsented: false };
  let stt: SttStatus | null = null;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let capture: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let raf = 0;
  let transcribing = false;

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
    recordBtn.disabled = s.active || transcribing || !stt?.available;
    stopBtn.disabled = !s.active;
    if (!s.active) teardown();
  }
  api.audio.onStatus(onStatus);
  void api.audio.status().then(onStatus);
  window.setInterval(() => status.active && renderBadge(), 1000);

  void api.stt.status().then((s) => {
    stt = s;
    sttLine.dataset.state = s.available ? 'ready' : 'unavailable';
    sttLine.textContent = s.available ? `Speech-to-text ready (local whisper.cpp, ${s.model.split('/').pop()}).` : `Speech-to-text unavailable — ${s.reason}`;
    recordBtn.disabled = !s.available || status.active;
  });

  function teardown(): void {
    cancelAnimationFrame(raf);
    capture?.disconnect();
    analyser?.disconnect();
    capture = null;
    analyser = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void audioCtx?.close();
    audioCtx = null;
    meterFill.style.width = '0%';
  }

  async function startCapture(): Promise<void> {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    // ScriptProcessor is deprecated but dependency-free; fine for short dictation clips.
    capture = audioCtx.createScriptProcessor(4096, 1, 1);
    chunks = [];
    capture.onaudioprocess = (ev) => chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    src.connect(capture);
    capture.connect(audioCtx.destination);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser!.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      meterFill.style.width = `${Math.min(100, Math.round((peak / 128) * 140))}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  async function transcribe(): Promise<void> {
    const rate = audioCtx?.sampleRate ?? 48000;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    teardown();
    await api.audio.stop();
    if (total === 0) {
      say('No audio was captured.');
      return;
    }
    transcribing = true;
    recordBtn.disabled = true;
    say('Transcribing locally…');
    try {
      const wav = encodeWav(pcm, rate);
      const r = await api.stt.transcribe(wav);
      transcript.textContent = r.text || '(no speech detected)';
      say(`Transcribed ${(total / rate).toFixed(1)}s of audio in ${(r.ms / 1000).toFixed(1)}s. Audio was not saved.`);
    } catch (e) {
      say(`Transcription failed: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    } finally {
      transcribing = false;
      recordBtn.disabled = status.active || !stt?.available;
    }
  }

  const recordBtn = button('Record & transcribe', async () => {
    transcript.textContent = '';
    say('Requesting the microphone…');
    const err = await api.audio.start('mic-test');
    if (err) {
      say(err);
      return;
    }
    try {
      await startCapture();
      say('Recording. Speak, then click Stop & transcribe.');
    } catch (e) {
      await api.audio.stop();
      say(`Could not open the microphone: ${(e as Error).message}`);
    }
  }, say);
  recordBtn.disabled = true;

  const stopBtn = button('Stop & transcribe', () => transcribe(), say);
  stopBtn.disabled = true;

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Microphone' }), button('Close', () => close())),
    sttLine,
    el('p', { className: 'field-note', text: 'The microphone is off until you record, a red badge shows in the header while it is live, and transcription runs locally (whisper.cpp). Audio is deleted after transcribing — nothing is uploaded.' }),
    el('div', { className: 'lib-actions' }, recordBtn, stopBtn),
    meter,
    transcript,
    message,
  );

  function close(): void {
    if (panel.hidden) return;
    if (status.active) void api.audio.stop();
    teardown();
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
