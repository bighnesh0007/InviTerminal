import type { RendererApi } from '../shared/ipc';
import type { AiStatus } from '../shared/ai';
import type { SttStatus } from '../shared/audio';
import { AI_PROVIDER } from '../shared/ai';
import { button, el } from './dom';
import { createMicRecorder, type MicRecorder } from './mic-recorder';

export interface PracticePanelView {
  element: HTMLElement;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
}

const PRESETS = ['System design', 'Behavioral / STAR', 'JavaScript & the browser', 'Data structures & algorithms'];

/**
 * Interview practice (7e): the model interviews the user one question at a time;
 * the user answers out loud (recorded + transcribed locally via 7d) or by
 * typing, and the model gives feedback and the next question. Behind the gate.
 */
export function mountPracticePanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): PracticePanelView {
  const panel = el('aside', { className: 'library practice-panel' });
  panel.hidden = true;

  const statusLine = el('p', { className: 'lib-status' });
  const convo = el('div', { className: 'practice-convo' });
  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);

  let aiReady = false;
  let sttReady = false;
  let ttsReady = false;
  let running = false;
  let streaming = false;
  let current: HTMLElement | null = null; // the interviewer bubble being streamed into
  let recorder: MicRecorder | null = null;

  function bubble(kind: 'interviewer' | 'you', text = ''): HTMLElement {
    const b = el('div', { className: `bubble ${kind}` }, el('span', { className: 'bubble-who', text: kind === 'you' ? 'You' : 'Interviewer' }), el('div', { className: 'bubble-text', text }));
    convo.append(b);
    convo.scrollTop = convo.scrollHeight;
    return b.querySelector('.bubble-text') as HTMLElement;
  }

  api.practice.onDelta((c) => {
    if (!current) current = bubble('interviewer');
    current.textContent += c;
    convo.scrollTop = convo.scrollHeight;
  });
  api.practice.onTurn((full) => {
    current = null;
    streaming = false;
    // Speak the finished question aloud only when the user asked for it (off by default).
    if (readAloud.checked && ttsReady && full.trim()) void api.tts.speak(full).catch(() => undefined);
    setControls();
  });
  api.practice.onError((m) => {
    current = null;
    streaming = false;
    say(`Error: ${m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    setControls();
  });

  // ---- controls ------------------------------------------------------------------------
  const topic = el('input');
  topic.placeholder = 'Interview topic (e.g. system design)';
  const startBtn = button('Start interview', () => startInterview(), say);
  const presets = el('div', { className: 'lib-actions' }, ...PRESETS.map((p) => button(p, () => { topic.value = p; void startInterview(); }, say)));

  const answerText = el('textarea');
  answerText.rows = 2;
  answerText.placeholder = 'Type your answer, or use Record answer…';
  const recordBtn = button('🎤 Record answer', () => toggleRecord(), say);
  const sendBtn = button('Send answer', () => submitAnswer(answerText.value), say);
  const endBtn = button('End', () => endInterview(), say);
  const readAloud = Object.assign(el('input'), { type: 'checkbox' });
  readAloud.addEventListener('change', () => {
    if (!readAloud.checked) api.tts.stop();
  });
  const readAloudLabel = el('label', { className: 'practice-tts' }, readAloud, el('span', { text: '🔊 Read questions aloud' }));
  const answerRow = el('div', { className: 'practice-answer' }, answerText, el('div', { className: 'lib-actions' }, recordBtn, sendBtn, endBtn, readAloudLabel));

  function setControls(): void {
    topic.disabled = running;
    startBtn.disabled = running || !aiReady;
    for (const b of presets.querySelectorAll('button')) (b as HTMLButtonElement).disabled = running || !aiReady;
    answerRow.hidden = !running;
    const busy = streaming || recorder !== null;
    sendBtn.disabled = busy;
    recordBtn.disabled = busy && recorder === null;
    recordBtn.textContent = recorder ? '■ Stop & submit' : '🎤 Record answer';
    recordBtn.hidden = !sttReady;
    readAloudLabel.hidden = !ttsReady;
  }

  async function startInterview(): Promise<void> {
    if (!aiReady) {
      say(`Add your ${AI_PROVIDER} API key in Settings first.`);
      return;
    }
    if (!topic.value.trim()) {
      say('Enter a topic to practise.');
      return;
    }
    convo.replaceChildren();
    running = true;
    streaming = true;
    current = null;
    setControls();
    say('');
    try {
      await api.practice.start(topic.value.trim());
    } catch (e) {
      streaming = false;
      say(`Error: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
      setControls();
    }
  }

  async function submitAnswer(text: string): Promise<void> {
    const answer = text.trim();
    if (!answer || streaming) return;
    api.tts.stop(); // stop the interviewer talking over the candidate
    bubble('you', answer);
    answerText.value = '';
    streaming = true;
    current = null;
    setControls();
    try {
      await api.practice.answer(answer);
    } catch (e) {
      streaming = false;
      say(`Error: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
      setControls();
    }
  }

  async function toggleRecord(): Promise<void> {
    if (recorder) {
      const rec = recorder.stopAndEncode();
      recorder = null;
      await api.audio.stop();
      setControls();
      if (rec.samples === 0) {
        say('No audio captured.');
        return;
      }
      say('Transcribing your answer locally…');
      try {
        const r = await api.stt.transcribe(rec.wav);
        if (r.text) await submitAnswer(r.text);
        else say('No speech detected — try again or type your answer.');
      } catch (e) {
        say(`Transcription failed: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
      }
      return;
    }
    const err = await api.audio.start('practice');
    if (err) {
      say(err);
      return;
    }
    recorder = createMicRecorder();
    try {
      await recorder.start();
      say('Recording your answer. Click Stop & submit when done.');
    } catch (e) {
      recorder = null;
      await api.audio.stop();
      say(`Could not open the microphone: ${(e as Error).message}`);
    }
    setControls();
  }

  async function endInterview(): Promise<void> {
    api.tts.stop();
    recorder?.dispose();
    recorder = null;
    await api.audio.stop();
    api.practice.cancel();
    await api.practice.end();
    running = false;
    streaming = false;
    setControls();
    say('Practice ended.');
  }

  const renderAi = (s: AiStatus) => {
    aiReady = s.key.present;
    statusLine.textContent = aiReady ? `Interviewer: ${s.model}` : 'No API key — add one in Settings to run interview practice.';
    statusLine.dataset.state = aiReady ? 'ready' : 'unavailable';
    setControls();
  };
  void api.ai.status().then(renderAi);
  api.ai.onStatus(renderAi);
  void api.stt.status().then((s: SttStatus) => {
    sttReady = s.available;
    setControls();
  });
  void api.tts.status().then((s) => {
    ttsReady = s.available;
    setControls();
  });

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Interview practice' }), button('Close', () => close())),
    statusLine,
    el('div', { className: 'lib-field' }, topic, startBtn),
    presets,
    convo,
    answerRow,
    message,
  );
  answerRow.hidden = true;

  function close(): void {
    if (panel.hidden) return;
    void endInterview();
    panel.hidden = true;
    opts.onOpenChange(false);
  }

  return {
    element: panel,
    isOpen: () => !panel.hidden,
    toggle() {
      panel.hidden = !panel.hidden;
      opts.onOpenChange(!panel.hidden);
    },
    close,
  };
}
