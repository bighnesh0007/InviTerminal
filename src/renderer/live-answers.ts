import { ANSWER_LENGTHS, ANSWER_LENGTH_LABELS, type AnswerLength, type AskMode, type ChatTurn } from '../shared/ai';
import type { RendererApi } from '../shared/ipc';
import { el } from './dom';

/** One conversation with the AI about some transcript text: the first answer plus follow-ups. */
export interface Thread {
  label: string;
  /** The text first sent (a line, a selection, or the whole transcript for a summary). */
  question: string;
  mode: AskMode;
  length: AnswerLength;
  /** Completed exchanges, oldest first — sent as history with a follow-up. */
  turns: ChatTurn[];
  el: HTMLElement;
}

interface Pending {
  thread: Thread;
  bubble: HTMLElement;
  question: string;
  length: AnswerLength;
  /** Retry/Shorter/Longer replace the last exchange instead of adding one. */
  replace: boolean;
  started: boolean;
}

export interface AnswerHub {
  /** Start a new thread inside `host` (prepended when `prepend`), and ask its first question. */
  open(host: HTMLElement, opts: { label: string; question: string; mode?: AskMode; prepend?: boolean }): Thread;
  /** Every thread this session, oldest first (for export). */
  threads(): readonly Thread[];
  /** Forget all threads (a new live session). */
  reset(): void;
  /** Re-evaluate enabled state (AI key added/removed). */
  refresh(): void;
}

const clean = (m: string) => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Renders and drives AI answer threads for the Live panel. Each thread shows the answer streaming
 * in, then: Copy · Save to library · Retry · Shorter · Longer, and a follow-up box that continues
 * the same thread (earlier turns go along as history). One request is in flight at a time; asks made
 * meanwhile queue ("Queued…") and run in order, so nothing the user asked for is silently dropped.
 */
export function createAnswerHub(api: RendererApi, opts: { length(): AnswerLength; aiReady(): boolean; say(msg: string): void }): AnswerHub {
  let nextReq = 1;
  let current: number | null = null;
  const pending = new Map<number, Pending>();
  /** Asks made while one is streaming wait here (shown "Queued…") instead of cancelling it. */
  const queue: (() => void)[] = [];
  const next = () => {
    current = null;
    queue.shift()?.();
  };
  const all: Thread[] = [];
  const controls = new Map<Thread, HTMLElement[]>();
  const busy = new Set<Thread>();

  function setBusy(t: Thread, on: boolean): void {
    if (on) busy.add(t);
    else busy.delete(t);
    refreshThread(t);
  }

  function refreshThread(t: Thread): void {
    const off = busy.has(t) || !opts.aiReady();
    for (const c of controls.get(t) ?? []) (c as HTMLButtonElement | HTMLInputElement).disabled = off;
  }

  function lastAnswer(t: Thread): string {
    for (let i = t.turns.length - 1; i >= 0; i--) if (t.turns[i]!.role === 'assistant') return t.turns[i]!.content;
    return '';
  }

  function send(t: Thread, question: string, history: ChatTurn[], replace: boolean, length: AnswerLength): void {
    const id = nextReq++;
    const bubbles = t.el.querySelector('.thread-bubbles') as HTMLElement;
    let bubble: HTMLElement;
    if (replace && bubbles.lastElementChild) {
      bubble = bubbles.lastElementChild.querySelector('.thread-a') as HTMLElement;
    } else {
      const wrap = el('div', { className: 'thread-turn' });
      if (history.length > 0) wrap.append(el('div', { className: 'thread-q', text: question }));
      bubble = el('div', { className: 'thread-a' });
      wrap.append(bubble);
      bubbles.append(wrap);
    }
    pending.set(id, { thread: t, bubble, question, length, replace, started: false });
    setBusy(t, true);
    const go = () => {
      if (!pending.has(id)) return next(); // dropped by reset()
      current = id;
      bubble.textContent = '…';
      api.live.ask(id, question, length, { history, mode: t.mode }).catch((e: Error) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        bubble.textContent = `Error: ${clean(e.message)}`;
        setBusy(t, false);
        if (current === id) next();
      });
    };
    // One request in flight (kind to the free tier); later asks queue up rather than cancel it.
    if (current === null) go();
    else {
      bubble.textContent = 'Queued…';
      queue.push(go);
    }
  }

  /** Re-ask the latest question of the thread at `length`, replacing that answer. */
  function retry(t: Thread, length: AnswerLength): void {
    const done = t.turns.length >= 2;
    const question = done ? t.turns[t.turns.length - 2]!.content : t.question;
    const history = done ? t.turns.slice(0, -2) : [];
    send(t, question, history, true, length);
  }

  api.live.onAnswerDelta(({ id, chunk }) => {
    const p = pending.get(id);
    if (!p) return;
    if (!p.started) {
      p.bubble.textContent = '';
      p.started = true;
    }
    p.bubble.textContent += chunk;
  });
  api.live.onAnswerDone(({ id, full }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (current === id) next();
    const pair: ChatTurn[] = [
      { role: 'user', content: p.question },
      { role: 'assistant', content: full },
    ];
    if (p.replace && p.thread.turns.length >= 2) p.thread.turns.splice(-2, 2, ...pair);
    else p.thread.turns.push(...pair);
    p.thread.length = p.length;
    setBusy(p.thread, false);
  });
  api.live.onAnswerError(({ id, message }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.bubble.textContent = `Error: ${clean(message)}`;
    setBusy(p.thread, false);
    if (current === id) next();
  });

  /** A plain action button: its enabled state is owned by setBusy/refresh (not auto-toggled per click). */
  function act(text: string, fn: () => unknown, onError: (m: string) => void = opts.say): HTMLButtonElement {
    const b = el('button', { text, className: 'thread-btn' });
    b.type = 'button';
    b.addEventListener('click', () => {
      void Promise.resolve()
        .then(fn)
        .catch((e: Error) => onError(clean(e.message)));
    });
    return b;
  }

  function open(host: HTMLElement, o: { label: string; question: string; mode?: AskMode; prepend?: boolean }): Thread {
    const container = el('div', { className: `thread${o.mode === 'summarize' ? ' summary' : ''}` });
    const t: Thread = { label: o.label, question: o.question, mode: o.mode ?? 'answer', length: opts.length(), turns: [], el: container };

    const copyBtn = act('Copy', async () => {
      await api.clipboard.write(lastAnswer(t));
      opts.say('Answer copied.');
    });
    const saveBtn = act('Save', async () => {
      const a = lastAnswer(t);
      if (!a) return;
      const q = t.mode === 'summarize' ? 'Conversation summary' : t.question;
      await api.library.create({
        title: `${t.mode === 'summarize' ? 'Summary' : 'Q'}: ${q.replace(/\s+/g, ' ').slice(0, 80)}`,
        body: `${t.mode === 'summarize' ? '' : `Q: ${q}\n\n`}${a}`,
        language: 'text',
        folder: 'AI answers',
        tags: ['ai', 'live'],
      });
      opts.say('Saved to the snippet library (folder "AI answers").');
    }, (m) => opts.say(`Couldn't save: ${clean(m)}`));
    saveBtn.title = 'Save this Q&A to the snippet library';
    const retryBtn = act('↻ Retry', () => retry(t, t.length));
    const step = (d: -1 | 1) => () => {
      const i = Math.min(ANSWER_LENGTHS.length - 1, Math.max(0, ANSWER_LENGTHS.indexOf(t.length) + d));
      retry(t, ANSWER_LENGTHS[i]!);
    };
    const shorterBtn = act('Shorter', step(-1));
    const longerBtn = act('Longer', step(1));
    shorterBtn.title = longerBtn.title = `Now: ${ANSWER_LENGTH_LABELS[t.length]}`;

    const follow = el('input', { className: 'thread-follow' }) as HTMLInputElement;
    follow.placeholder = 'Ask a follow-up…';
    follow.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !follow.value.trim()) return;
      e.preventDefault();
      const q = follow.value.trim();
      follow.value = '';
      send(t, q, [...t.turns], false, opts.length());
    });

    controls.set(t, [copyBtn, saveBtn, retryBtn, shorterBtn, longerBtn, follow]);
    container.append(
      el('div', { className: 'thread-head' }, el('span', { className: 'thread-label', text: o.label })),
      el('div', { className: 'thread-bubbles' }),
      el('div', { className: 'thread-actions' }, copyBtn, saveBtn, retryBtn, shorterBtn, longerBtn),
      follow,
    );
    if (o.prepend) host.prepend(container);
    else host.append(container);
    all.push(t);
    send(t, o.question, [], false, t.length);
    return t;
  }

  return {
    open,
    threads: () => all,
    reset() {
      queue.length = 0;
      current = null;
      api.live.cancelAsk();
      all.length = 0;
      controls.clear();
      busy.clear();
      pending.clear();
    },
    refresh() {
      for (const t of all) refreshThread(t);
    },
  };
}
