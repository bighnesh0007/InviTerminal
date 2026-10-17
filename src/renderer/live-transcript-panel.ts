import { ANSWER_LENGTHS, ANSWER_LENGTH_LABELS, type AiStatus, type AnswerLength } from '../shared/ai';
import { type LiveLine, type LiveTranscriptStatus, SPEAKER_MODE_LABELS, SPEAKER_MODES, type SpeakerMode } from '../shared/audio';
import type { RendererApi } from '../shared/ipc';
import { button, el } from './dom';
import { track } from './usage';
import { createAnswerHub, type Thread } from './live-answers';
import { buildTranscriptMarkdown, plainTranscript, shouldMerge } from './live-format';

export interface LiveTranscriptPanelView {
  element: HTMLElement;
  /** Always-visible header badge while transcribing. */
  badge: HTMLElement;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
}

/** One transcript entry (possibly several merged same-speaker lines). */
export interface Item {
  id: number;
  at: string;
  /** Time of the latest line merged in (merging stops after a pause). */
  lastAt: string;
  speaker?: string;
  text: string;
  el: HTMLElement;
  textEl: HTMLElement;
  speakerEl: HTMLElement | null;
  pick: HTMLInputElement;
  slot: HTMLElement;
  thread?: Thread;
}

const clean = (m: string) => m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/**
 * Live transcript. Captures the call audio playing on this machine (plus your microphone in
 * "You / Them" mode), transcribes it locally with whisper, and streams it here. Consent-gated with
 * a visible "● Live" indicator; audio never leaves the machine. On top of the transcript:
 * search, select/edit/merge turns, rename speakers, copy/export, and on-demand AI (per line, per
 * selection, or "summarize so far") with follow-ups — all manual, never automatic.
 */
export function mountLiveTranscriptPanel(api: RendererApi, opts: { onOpenChange(open: boolean): void }): LiveTranscriptPanelView {
  const panel = el('aside', { className: 'library live-panel' });
  panel.hidden = true;
  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);
  const badge = el('span', { className: 'rec-badge live-badge' });
  badge.hidden = true;

  let status: LiveTranscriptStatus | null = null;
  let aiReady = false;
  let nextId = 1;
  const items = new Map<number, Item>();
  let lastItem: Item | null = null;

  // ---- speaker names (renames survive sessions: "Them" → "Interviewer") ----------------------
  const names = new Map<string, string>(Object.entries(JSON.parse(store.get('invi.speakerNames') ?? '{}') as Record<string, string>));
  const display = (raw?: string) => (raw ? names.get(raw) || raw : '');

  // ---- answer length (remembered per viewer) ---------------------------------------------------
  let length: AnswerLength = (ANSWER_LENGTHS as readonly string[]).includes(store.get('invi.askLength') ?? '') ? (store.get('invi.askLength') as AnswerLength) : 'short';

  const hub = createAnswerHub(api, { length: () => length, aiReady: () => aiReady, say });

  // ---- setup: consent + speaker mode -------------------------------------------------------
  const statusLine = el('p', { className: 'lib-status' });
  const consent = Object.assign(el('input'), { type: 'checkbox' });
  consent.addEventListener('change', () => setControls());
  const consentLabel = el('label', { className: 'live-consent' }, consent, el('span', { text: 'Everyone in the call knows it is being transcribed on my machine.' }));
  const modeSelect = el('select', { className: 'live-mode' });
  for (const m of SPEAKER_MODES) modeSelect.append(Object.assign(el('option', { text: SPEAKER_MODE_LABELS[m] }), { value: m }));
  const modeHint = el('span', { className: 'field-note' });
  modeSelect.addEventListener('change', () => {
    track(api, 'live.speakerMode');
    renderModeHint();
    void api.settings.update({ liveTranscript: { speakerMode: modeSelect.value as SpeakerMode } }).catch(() => undefined);
  });
  const modeRow = el('label', { className: 'live-mode-row' }, el('span', { text: 'Speakers:' }), modeSelect, modeHint);
  const setup = el('div', { className: 'live-setup' }, consentLabel, modeRow);

  const MODE_HELP: Record<SpeakerMode, string> = {
    off: 'Plain transcript.',
    turns: 'Guesses speaker changes from the call audio — often misses them.',
    'you-them': 'Your mic vs the call audio — reliable "You" / "Them" labels.',
    stereo: 'Uses the source’s left/right channels (only if speakers are on separate sides).',
  };
  function renderModeHint(): void {
    const m = modeSelect.value as SpeakerMode;
    const a = status?.modes[m];
    modeHint.textContent = a && !a.available ? ` — unavailable: ${a.reason ?? ''}` : ` — ${MODE_HELP[m]}`;
  }

  // ---- run controls -----------------------------------------------------------------------
  const startBtn = button('▶ Start', () => start(), say);
  const pauseBtn = button('⏸ Pause', async () => render(await api.live.pause()), say);
  const resumeBtn = button('▶ Resume', async () => render(await api.live.resume()), say);
  const stopBtn = button('■ Stop', async () => {
    await api.live.stop();
    say('Stopped. The transcript stays here until you start again — copy or export it first if you need it.');
  }, say);
  const runRow = el('div', { className: 'lib-actions' }, startBtn, pauseBtn, resumeBtn, stopBtn);

  // ---- toolbar: search · select · copy · export · summarize --------------------------------
  const search = Object.assign(el('input', { className: 'live-search' }), { type: 'search', placeholder: 'Search transcript…' });
  search.addEventListener('input', () => applySearch());
  const selAll = button('All', () => setPicks(true), say);
  const selNone = button('None', () => setPicks(false), say);
  selAll.title = 'Tick every visible turn';
  selNone.title = 'Untick every visible turn';
  const copyBtn = button('Copy', async () => {
    track(api, 'live.copy');
    await api.clipboard.write(plainTranscript([...items.values()], display));
    say('Transcript copied.');
  }, say);
  const exportBtn = button('Export .md', async () => {
    track(api, 'live.export');
    const md = buildTranscriptMarkdown([...items.values()], hub.threads(), display, status?.speakerMode ?? (modeSelect.value as SpeakerMode));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const path = await api.live.exportMarkdown(md, `transcript-${stamp}.md`);
    if (path) say(`Saved ${path}`);
  }, say);
  const summarizeBtn = button('✨ Summarize', () => summarize(), say);
  summarizeBtn.title = 'Summarize the whole conversation so far';
  // Irreversible, so it asks once: the first click arms it for 3s, the second clears.
  const clearBtn = el('button', { text: '🗑 Clear', className: 'live-clear' });
  clearBtn.type = 'button';
  clearBtn.title = 'Delete the transcript and AI answers here and on the paired phone';
  let clearArmed: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (clearArmed) clearTimeout(clearArmed);
    clearArmed = null;
    clearBtn.textContent = '🗑 Clear';
    clearBtn.classList.remove('armed');
  };
  clearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      clearBtn.textContent = 'Click again to clear';
      clearBtn.classList.add('armed');
      clearArmed = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    void clearConversation().catch((e: Error) => say(clean(e.message)));
  });
  const toolbar = el('div', { className: 'live-toolbar' }, search, selAll, selNone, copyBtn, exportBtn, summarizeBtn, clearBtn);

  // ---- speakers row (rename) ----------------------------------------------------------------
  const speakersRow = el('div', { className: 'live-speakers' });
  const seenSpeakers = new Set<string>();
  function noteSpeaker(raw: string): void {
    if (seenSpeakers.has(raw)) return;
    seenSpeakers.add(raw);
    const input = Object.assign(el('input'), { value: names.get(raw) ?? '', placeholder: raw });
    input.title = `Rename "${raw}"`;
    input.addEventListener('change', () => {
      const v = input.value.trim().slice(0, 30);
      if (v) names.set(raw, v);
      else names.delete(raw);
      store.set('invi.speakerNames', JSON.stringify(Object.fromEntries(names)));
      for (const it of items.values()) if (it.speaker === raw && it.speakerEl) it.speakerEl.textContent = display(raw);
    });
    speakersRow.append(el('label', { className: 'live-speaker-name' }, el('span', { text: `${raw} →` }), input));
    speakersRow.hidden = false;
  }

  // ---- ask row: length · ask selected · merge ------------------------------------------------
  const lengthButtons = ANSWER_LENGTHS.map((len) => {
    const b = el('button', { text: ANSWER_LENGTH_LABELS[len] });
    b.type = 'button';
    b.dataset.len = len;
    b.addEventListener('click', () => {
      length = len;
      store.set('invi.askLength', len);
      refreshLength();
    });
    return b;
  });
  function refreshLength(): void {
    for (const b of lengthButtons) b.classList.toggle('active', b.dataset.len === length);
  }
  refreshLength();
  const askSelectedBtn = button('✨ Ask selected', () => askSelected(), say);
  askSelectedBtn.className = 'live-ask-selected';
  const merge = Object.assign(el('input'), { type: 'checkbox', checked: store.get('invi.mergeSpeakers') !== '0' });
  merge.addEventListener('change', () => store.set('invi.mergeSpeakers', merge.checked ? '1' : '0'));
  const askRow = el(
    'div',
    { className: 'live-length' },
    el('span', { className: 'field-note', text: 'Answer:' }),
    ...lengthButtons,
    askSelectedBtn,
    el('label', { className: 'live-merge' }, merge, el('span', { text: 'Merge same speaker' })),
  );

  const results = el('div', { className: 'live-results' });
  // Selection answers and summaries collect here; collapsible and height-capped so the transcript stays in view.
  const resultsCount = el('span', { className: 'field-note' });
  const resultsToggle = el('button', { text: 'Hide', className: 'thread-btn' });
  resultsToggle.type = 'button';
  const resultsHead = el('div', { className: 'live-results-head' }, el('strong', { text: 'AI answers' }), resultsCount, resultsToggle);
  resultsHead.hidden = true;
  const showResults = (open: boolean) => {
    results.hidden = !open;
    resultsToggle.textContent = open ? 'Hide' : 'Show';
  };
  resultsToggle.addEventListener('click', () => showResults(results.hidden !== false));
  const noteResult = () => {
    resultsHead.hidden = false;
    resultsCount.textContent = `(${results.children.length})`;
    showResults(true);
    results.scrollTop = 0;
  };
  const feed = el('div', { className: 'live-feed' });
  const empty = el('p', { className: 'live-empty', text: 'Tick consent, pick how to label speakers, and press Start. Play the call through this computer.' });

  // ---- behaviour -------------------------------------------------------------------------------
  function selectedItems(): Item[] {
    return [...items.values()].filter((i) => i.pick.checked);
  }

  function setControls(): void {
    const active = !!status?.active;
    const paused = !!status?.paused;
    const sttOk = !!status && !status.reason;
    const modeOk = !!status?.modes[modeSelect.value as SpeakerMode]?.available;
    setup.hidden = active;
    startBtn.hidden = active;
    startBtn.disabled = !sttOk || !consent.checked || !modeOk;
    startBtn.title = !consent.checked ? 'Tick the consent box first' : !modeOk ? 'This speaker mode is unavailable here' : '';
    pauseBtn.hidden = !active || paused;
    resumeBtn.hidden = !active || !paused;
    stopBtn.hidden = !active;
    const has = items.size > 0;
    toolbar.hidden = !has;
    askRow.hidden = !has;
    empty.hidden = has;
    const n = selectedItems().length;
    askSelectedBtn.textContent = n ? `✨ Ask selected (${n})` : '✨ Ask selected';
    askSelectedBtn.disabled = n === 0 || !aiReady;
    askSelectedBtn.title = aiReady ? 'Send the ticked turns to the AI as one conversation' : 'Add a Groq key in Settings to use Ask';
    summarizeBtn.disabled = !has || !aiReady;
    for (const it of items.values()) {
      const ask = it.el.querySelector('.live-ask') as HTMLButtonElement | null;
      if (ask) ask.disabled = !aiReady;
    }
  }

  function render(s: LiveTranscriptStatus): void {
    status = s;
    badge.hidden = !s.active;
    badge.textContent = s.paused ? `⏸ ${s.lines}` : `● Live ${s.lines}`;
    badge.title = s.paused ? `Live transcript paused · ${s.lines} lines` : `Live transcript · ${s.lines} lines`;
    badge.classList.toggle('paused', s.paused);
    if (s.reason && !s.active) statusLine.textContent = `Not ready — ${s.reason}`;
    else if (s.paused) statusLine.textContent = 'Paused — nothing is being recorded. Resume to continue.';
    else if (s.active) statusLine.textContent = `Transcribing locally · ${SPEAKER_MODE_LABELS[s.speakerMode]}`;
    else statusLine.textContent = 'Ready. Transcription runs on your machine; audio is never uploaded.';
    statusLine.dataset.state = s.reason && !s.active ? 'unavailable' : 'ready';
    for (const opt of modeSelect.options) {
      const a = s.modes[opt.value as SpeakerMode];
      opt.disabled = !a?.available;
      opt.title = a?.available ? '' : (a?.reason ?? '');
    }
    renderModeHint();
    setControls();
  }

  /** Forget everything on screen (transcript, answers, selection, search) — not the session itself. */
  function wipe(): void {
    feed.replaceChildren();
    results.replaceChildren();
    resultsHead.hidden = true;
    items.clear();
    lastItem = null;
    hub.reset();
    search.value = '';
  }

  async function clearConversation(): Promise<void> {
    track(api, 'live.clear');
    wipe();
    render(await api.live.clear());
    say(status?.active ? 'Cleared here and on the phone. New speech keeps appearing below.' : 'Cleared here and on the phone.');
  }

  async function start(): Promise<void> {
    track(api, 'live.start');
    say('');
    wipe();
    try {
      render(await api.live.start(consent.checked, modeSelect.value as SpeakerMode));
      say('Transcribing. New turns are ticked automatically — untick any you want to leave out, then Ask.');
    } catch (e) {
      say(clean((e as Error).message));
      setControls();
    }
  }

  function addLine(l: LiveLine): void {
    if (lastItem && merge.checked && shouldMerge(lastItem, l)) {
      lastItem.text = `${lastItem.text} ${l.text}`;
      lastItem.lastAt = l.at;
      lastItem.textEl.textContent = lastItem.text;
      applySearch(lastItem);
      feed.scrollTop = feed.scrollHeight;
      return;
    }
    const id = nextId++;
    const pick = Object.assign(el('input'), { type: 'checkbox', checked: true, className: 'live-pick', title: 'Include this turn in Ask selected' });
    pick.addEventListener('change', () => setControls());
    const textEl = el('span', { className: 'live-text', text: l.text });
    const speakerEl = l.speaker ? el('span', { className: 'live-speaker', text: display(l.speaker) }) : null;
    if (l.speaker) noteSpeaker(l.speaker);
    const editBtn = el('button', { text: '✎', className: 'live-edit' });
    editBtn.type = 'button';
    editBtn.title = 'Edit this line (fix a transcription mistake)';
    const askBtn = el('button', { text: '✨ Ask', className: 'live-ask' });
    askBtn.type = 'button';
    askBtn.disabled = !aiReady;
    const slot = el('div', { className: 'live-slot' });
    const row = el('div', { className: 'live-line' }, pick, el('span', { className: 'live-time', text: new Date(l.at).toLocaleTimeString() }), ...(speakerEl ? [speakerEl] : []), textEl, editBtn, askBtn);
    const itemEl = el('div', { className: 'live-item' }, row, slot);
    const item: Item = { id, at: l.at, lastAt: l.at, text: l.text, el: itemEl, textEl, speakerEl, pick, slot, ...(l.speaker ? { speaker: l.speaker } : {}) };
    editBtn.addEventListener('click', () => editLine(item));
    askBtn.addEventListener('click', () => {
      track(api, 'live.ask');
      if (item.thread) (item.thread.el.querySelector('.thread-follow') as HTMLInputElement | null)?.focus();
      else item.thread = hub.open(item.slot, { label: 'Answer', question: item.text });
    });
    items.set(id, item);
    lastItem = item;
    feed.append(itemEl);
    applySearch(item);
    setControls();
    if (!search.value) feed.scrollTop = feed.scrollHeight;
  }

  function editLine(item: Item): void {
    const before = item.text;
    item.textEl.contentEditable = 'true';
    item.textEl.classList.add('editing');
    item.textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(item.textEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = (save: boolean) => {
      item.textEl.contentEditable = 'false';
      item.textEl.classList.remove('editing');
      const v = (item.textEl.textContent ?? '').replace(/\s+/g, ' ').trim();
      item.text = save && v ? v : before;
      item.textEl.textContent = item.text;
      item.textEl.removeEventListener('keydown', onKey);
      item.textEl.removeEventListener('blur', onBlur);
      // Editing a line stops merging into it, so later speech isn't glued onto a corrected sentence.
      if (lastItem === item) lastItem = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation(); // never let these keys reach the terminal shortcuts
    };
    const onBlur = () => finish(true);
    item.textEl.addEventListener('keydown', onKey);
    item.textEl.addEventListener('blur', onBlur);
  }

  function applySearch(only?: Item): void {
    const q = search.value.trim().toLowerCase();
    const list = only ? [only] : [...items.values()];
    for (const it of list) {
      const hit = !q || it.text.toLowerCase().includes(q) || display(it.speaker).toLowerCase().includes(q);
      it.el.hidden = !hit;
      it.el.classList.toggle('match', !!q && hit);
    }
    if (!only && q) say(`${[...items.values()].filter((i) => !i.el.hidden).length} matching turn(s).`);
  }

  function setPicks(on: boolean): void {
    for (const it of items.values()) if (!it.el.hidden) it.pick.checked = on;
    setControls();
  }

  function asConversation(list: Item[]): string {
    return list.map((i) => (i.speaker ? `${display(i.speaker)}: ${i.text}` : i.text)).join('\n');
  }

  function askSelected(): void {
    const list = selectedItems();
    if (!list.length) return;
    track(api, 'live.askSelected');
    hub.open(results, { label: `Selection · ${list.length} turn${list.length === 1 ? '' : 's'}`, question: asConversation(list).slice(0, 15_000), prepend: true });
    noteResult();
  }

  function summarize(): void {
    const list = [...items.values()];
    if (!list.length) return;
    track(api, 'live.summarize');
    // Long meetings: keep the most recent part that fits (the request is capped at 16k chars).
    let text = asConversation(list);
    if (text.length > 15_000) text = `…${text.slice(-15_000)}`;
    hub.open(results, { label: 'Summary so far', question: text, mode: 'summarize', prepend: true });
    noteResult();
  }

  // ---- wiring ---------------------------------------------------------------------------------
  api.live.onStatus(render);
  api.live.onLine(addLine);
  api.live.onError((m) => say(`Error: ${clean(m)}`));
  void api.live.status().then(render);
  void api.settings
    .get()
    .then((v) => {
      modeSelect.value = v.effective.liveTranscript.speakerMode;
      renderModeHint();
      setControls();
    })
    .catch(() => undefined);
  const renderAi = (s: AiStatus) => {
    aiReady = s.key.present;
    hub.refresh();
    setControls();
  };
  void api.ai.status().then(renderAi);
  api.ai.onStatus(renderAi);

  speakersRow.hidden = true;
  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Live transcript' }), button('Close', () => close())),
    statusLine,
    setup,
    runRow,
    toolbar,
    speakersRow,
    askRow,
    resultsHead,
    results,
    feed,
    empty,
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
