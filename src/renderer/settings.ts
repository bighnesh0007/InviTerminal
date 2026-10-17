import type { RendererApi } from '../shared/ipc';
import { APP_ACTIONS, canonicalChord, chordFromEvent, keymapProblems, type AppAction, type Keymap } from '../shared/keymap';
import { AI_MODEL_LABELS, AI_MODELS, AI_PROVIDER, type AiStatus } from '../shared/ai';
import type { SettingsPatch, SettingsView } from '../shared/settings';
import type { UsageView } from '../shared/usage';
import { button, el } from './dom';

export interface SettingsPanel {
  element: HTMLElement;
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

const ACTION_LABELS: Record<AppAction, string> = {
  panicHide: 'Hide now (panic)',
  toggleLibrary: 'Snippet library',
  openSettings: 'Settings',
  explainSelection: 'Explain selection with AI',
  newTab: 'New tab',
  closeTab: 'Close tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
};

/**
 * Settings panel. The main process validates and saves; this panel checks
 * shortcuts as you type so problems show before saving. Shortcut fields
 * record a key press instead of taking typed text.
 */
export function mountSettings(api: RendererApi, opts: { onOpenChange(open: boolean): void }): SettingsPanel {
  const panel = el('aside', { className: 'library settings' });
  panel.hidden = true;
  const banner = el('div', { className: 'settings-banner' });
  const message = el('p', { className: 'lib-message' });
  const say = (t: string) => (message.textContent = t);

  const fontSize = Object.assign(el('input'), { type: 'number', min: '8', max: '32' });
  const scrollback = Object.assign(el('input'), { type: 'number', min: '500', max: '100000', step: '500' });
  const defaultProfile = el('select');
  const mongoUri = el('input');
  mongoUri.spellcheck = false;
  const allowRemote = Object.assign(el('input'), { type: 'checkbox' });
  const globalShortcut = el('input');
  globalShortcut.placeholder = 'e.g. Control+Alt+T (empty = none)';
  const chordInputs = {} as Record<AppAction, HTMLInputElement>;
  const chordErrors = {} as Record<AppAction, HTMLSpanElement>;

  const aiModel = el('select');
  for (const m of AI_MODELS) aiModel.append(Object.assign(el('option', { text: AI_MODEL_LABELS[m] }), { value: m }));
  const apiKey = Object.assign(el('input'), { type: 'password', autocomplete: 'off', placeholder: 'gsk_…' });
  apiKey.spellcheck = false;
  const aiKeyStatus = el('span', { className: 'field-note' });
  const sttModel = el('input');
  sttModel.spellcheck = false;
  sttModel.placeholder = 'default: <data dir>/models/ggml-base.en.bin';
  const sttStatus = el('span', { className: 'field-note' });
  const ttsBinary = el('input');
  ttsBinary.spellcheck = false;
  ttsBinary.placeholder = 'default: espeak-ng (on PATH)';
  const ttsVoice = el('input');
  ttsVoice.spellcheck = false;
  ttsVoice.placeholder = 'voice/language, e.g. en (empty = engine default)';
  const ttsStatus = el('span', { className: 'field-note' });
  const companionPort = Object.assign(el('input'), { type: 'number', min: '0', max: '65535' });
  const shareChecks = {
    rememberPairing: Object.assign(el('input'), { type: 'checkbox' }),
    autoStart: Object.assign(el('input'), { type: 'checkbox' }),
    sendTranscript: Object.assign(el('input'), { type: 'checkbox' }),
    mdns: Object.assign(el('input'), { type: 'checkbox' }),
  };
  const SHARE_LABELS: Record<keyof typeof shareChecks, string> = {
    rememberPairing: 'Remember pairing (a phone that scanned once reconnects by itself)',
    autoStart: 'Start sharing automatically when I start Live or ask the AI',
    sendTranscript: 'Also send the live transcript to the phone',
    mdns: 'Answer inviterminal.local on my network',
  };
  const liveSource = el('input');
  liveSource.spellcheck = false;
  liveSource.placeholder = 'default: your output device’s monitor';
  const liveChunk = Object.assign(el('input'), { type: 'number', min: '3', max: '30' });
  const liveTdrz = el('input');
  liveTdrz.spellcheck = false;
  liveTdrz.placeholder = 'default: <data dir>/models/ggml-small.en-tdrz.bin';

  // ---- Usage (local-only) --------------------------------------------------------------
  const usageTotal = el('p', { className: 'field-note' });
  const usageTable = el('table', { className: 'usage-table' });
  let usageArmed: ReturnType<typeof setTimeout> | null = null;
  const usageResetBtn = button('Reset counts', () => armOrResetUsage(), (m) => say(m));
  const usageExportBtn = button('Export JSON', async () => {
    const path = await api.usage.export();
    say(path ? `Usage counts saved to ${path}.` : 'Export cancelled.');
  }, (m) => say(m));
  const usageRefreshBtn = button('Refresh', () => loadUsage(), (m) => say(m));

  function renderUsage(v: UsageView): void {
    usageTotal.textContent = v.loadWarning ? v.loadWarning : `${v.total} tracked action${v.total === 1 ? '' : 's'} recorded on this machine. Nothing here is sent anywhere.`;
    const header = el('tr', {}, el('th', { text: 'Action' }), el('th', { text: 'Count' }), el('th', { text: 'Last used' }));
    const rows = v.rows.map((r) =>
      el(
        'tr',
        { className: r.count === 0 ? 'usage-unused' : '' },
        el('td', { text: r.label }),
        el('td', { className: 'usage-count', text: String(r.count) }),
        el('td', { className: 'usage-when', text: r.lastUsed ? new Date(r.lastUsed).toLocaleString() : '—' }),
      ),
    );
    usageTable.replaceChildren(header, ...rows);
  }

  async function loadUsage(): Promise<void> {
    renderUsage(await api.usage.get());
  }

  function disarmUsage(): void {
    if (usageArmed) clearTimeout(usageArmed);
    usageArmed = null;
    usageResetBtn.textContent = 'Reset counts';
    usageResetBtn.classList.remove('armed');
  }

  // Reset is irreversible, so it asks once: first click arms for 3s, second click wipes.
  async function armOrResetUsage(): Promise<void> {
    if (!usageArmed) {
      usageResetBtn.textContent = 'Click again to reset';
      usageResetBtn.classList.add('armed');
      usageArmed = setTimeout(disarmUsage, 3000);
      return;
    }
    disarmUsage();
    renderUsage(await api.usage.reset());
    say('Usage counts reset.');
  }

  const field = (label: string, input: HTMLElement, note?: HTMLElement) => el('label', { className: 'lib-field' }, el('span', { text: label }), input, ...(note ? [note] : []));

  const shortcutRows = APP_ACTIONS.map((a) => {
    const input = el('input', { className: 'chord-input' });
    input.readOnly = true;
    input.dataset.action = a;
    input.title = 'Click, then press the shortcut';
    // Records the pressed combination instead of letting the key act.
    let beforeRecording = '';
    input.addEventListener('focus', () => (beforeRecording = input.value));
    input.addEventListener('keydown', (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      // A recording field takes every key, so Escape is the way out: it cancels and leaves the field.
      if (e.code === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        input.value = beforeRecording;
        input.blur();
        validateChords();
        return;
      }
      const chord = chordFromEvent(e);
      if (chord) input.value = chord;
      validateChords();
    });
    chordInputs[a] = input;
    chordErrors[a] = el('span', { className: 'field-error' });
    return field(ACTION_LABELS[a], input, chordErrors[a]);
  });

  function currentKeymap(): Keymap {
    return Object.fromEntries(APP_ACTIONS.map((a) => [a, chordInputs[a].value])) as Keymap;
  }

  function validateChords(): boolean {
    const problems = keymapProblems(currentKeymap());
    for (const a of APP_ACTIONS) chordErrors[a].textContent = problems[a] ?? '';
    return Object.keys(problems).length === 0;
  }

  let view: SettingsView | null = null;

  async function load(): Promise<void> {
    view = await api.settings.get();
    const s = view.effective;
    fontSize.value = String(s.terminal.fontSize);
    scrollback.value = String(s.terminal.scrollback);
    const profiles = await api.terminal.profiles();
    defaultProfile.replaceChildren(Object.assign(el('option', { text: 'Detected default' }), { value: '' }), ...profiles.map((p) => Object.assign(el('option', { text: p.label }), { value: p.id })));
    defaultProfile.value = s.terminal.defaultProfile ?? '';
    mongoUri.value = s.library.mongoUri;
    allowRemote.checked = s.library.allowRemote;
    globalShortcut.value = s.globalShortcut ?? '';
    aiModel.value = s.ai.model;
    aiModel.disabled = view.overriddenByEnv.includes('ai.model');
    renderAiStatus(await api.ai.status());
    for (const a of APP_ACTIONS) chordInputs[a].value = canonicalChord(s.shortcuts[a]) ?? s.shortcuts[a];
    sttModel.value = s.stt.modelPath ?? '';
    void api.stt.status().then((st) => {
      sttStatus.textContent = st.available ? `Speech-to-text ready — ${st.binary}, ${st.model}` : `Not ready — ${st.reason}`;
    });
    ttsBinary.value = s.tts.binaryPath ?? '';
    ttsVoice.value = s.tts.voice ?? '';
    void api.tts.status().then((st) => {
      ttsStatus.textContent = st.available ? `Text-to-speech ready — ${st.binary}${st.voice ? `, voice ${st.voice}` : ''}` : `Not ready — ${st.reason}`;
    });
    companionPort.value = String(s.companion.port);
    for (const k of Object.keys(shareChecks) as (keyof typeof shareChecks)[]) shareChecks[k].checked = s.companion[k];
    companionPort.disabled = view.overriddenByEnv.includes('companion.port');
    liveSource.value = s.liveTranscript.source ?? '';
    liveChunk.value = String(s.liveTranscript.chunkSeconds);
    liveTdrz.value = s.liveTranscript.tdrzModelPath ?? '';
    for (const [input, path] of [[mongoUri, 'library.mongoUri'], [allowRemote, 'library.allowRemote'], [globalShortcut, 'globalShortcut']] as const) {
      input.disabled = view.overriddenByEnv.includes(path);
      input.title = input.disabled ? 'Set by an INVI_* environment variable for this run' : '';
    }
    renderBanner();
    validateChords();
    void loadUsage().catch(() => undefined);
  }

  function renderAiStatus(st: AiStatus): void {
    aiModel.value = st.model;
    apiKey.value = '';
    if (st.key.source === 'env') {
      apiKey.disabled = true;
      apiKey.placeholder = `Set from the environment (${st.key.hint ?? ''})`;
      aiKeyStatus.textContent = 'The API key comes from GROQ_API_KEY for this run; it is not editable here.';
    } else if (st.key.keychainUnavailable) {
      apiKey.disabled = true;
      apiKey.placeholder = 'No OS keychain available';
      aiKeyStatus.textContent = 'No OS keychain is available, so a key cannot be stored. Use the GROQ_API_KEY environment variable.';
    } else {
      apiKey.disabled = false;
      apiKey.placeholder = 'gsk_…';
      aiKeyStatus.textContent = st.key.present ? `A key is stored in your OS keychain (${st.key.hint}).` : 'No key stored. Paste one and click Save key.';
    }
  }
  api.ai.onStatus(renderAiStatus);

  function renderBanner(): void {
    if (!view) return;
    const lines: string[] = [];
    if (view.loadWarning) lines.push(view.loadWarning);
    if (view.restartRequired.length) lines.push(`Restart InviTerminal to apply: ${view.restartRequired.join(', ')}.`);
    if (view.overriddenByEnv.length) lines.push(`Set by environment for this run (not editable here): ${view.overriddenByEnv.join(', ')}.`);
    banner.replaceChildren(...lines.map((l) => el('p', { text: l })));
    banner.hidden = lines.length === 0;
  }

  async function save(): Promise<void> {
    if (!view) return;
    if (!validateChords()) throw new Error('Fix the highlighted shortcuts first.');
    const s = view.effective;
    const patch: SettingsPatch = {
      terminal: { fontSize: Number(fontSize.value), scrollback: Number(scrollback.value), defaultProfile: defaultProfile.value || null },
      shortcuts: currentKeymap(),
    };
    if (!view.overriddenByEnv.includes('library.mongoUri') && mongoUri.value !== s.library.mongoUri) patch.library = { ...patch.library, mongoUri: mongoUri.value };
    if (!view.overriddenByEnv.includes('library.allowRemote') && allowRemote.checked !== s.library.allowRemote) patch.library = { ...patch.library, allowRemote: allowRemote.checked };
    const gs = globalShortcut.value.trim() || null;
    if (!view.overriddenByEnv.includes('globalShortcut') && gs !== s.globalShortcut) patch.globalShortcut = gs;
    if (aiModel.value !== s.ai.model) patch.ai = { model: aiModel.value as (typeof AI_MODELS)[number] };
    const sm = sttModel.value.trim() || null;
    if (sm !== s.stt.modelPath) patch.stt = { modelPath: sm };
    const tb = ttsBinary.value.trim() || null;
    if (tb !== s.tts.binaryPath) patch.tts = { ...patch.tts, binaryPath: tb };
    const tv = ttsVoice.value.trim() || null;
    if (tv !== s.tts.voice) patch.tts = { ...patch.tts, voice: tv };
    const cp = Number(companionPort.value);
    if (!view.overriddenByEnv.includes('companion.port') && cp !== s.companion.port) patch.companion = { port: cp };
    for (const k of Object.keys(shareChecks) as (keyof typeof shareChecks)[]) {
      if (shareChecks[k].checked !== s.companion[k]) patch.companion = { ...patch.companion, [k]: shareChecks[k].checked };
    }
    const ls = liveSource.value.trim() || null;
    if (ls !== s.liveTranscript.source) patch.liveTranscript = { ...patch.liveTranscript, source: ls };
    const lc = Number(liveChunk.value);
    if (lc !== s.liveTranscript.chunkSeconds) patch.liveTranscript = { ...patch.liveTranscript, chunkSeconds: lc };
    const lt = liveTdrz.value.trim() || null;
    if (lt !== s.liveTranscript.tdrzModelPath) patch.liveTranscript = { ...patch.liveTranscript, tdrzModelPath: lt };
    view = await api.settings.update(patch);
    // Leave any shortcut field, so the next key press acts instead of being recorded.
    if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) document.activeElement.blur();
    renderBanner();
    say(`Saved to ${view.file}.`);
  }

  panel.append(
    el('div', { className: 'lib-head' }, el('strong', { text: 'Settings' }), button('Close', () => close())),
    banner,
    el('h3', { text: 'Terminal' }),
    field('Font size', fontSize),
    field('Scrollback lines', scrollback),
    field('Shell for new tabs', defaultProfile),
    el('h3', { text: 'Shortcuts (click a field, press the keys; Esc cancels)' }),
    ...shortcutRows,
    el('h3', { text: 'Snippet library' }),
    field('MongoDB URI', mongoUri),
    el('label', { className: 'lib-trash' }, allowRemote, el('span', { text: 'Allow a non-local MongoDB (snippets leave this machine)' })),
    el('h3', { text: 'Global shortcut (portal)' }),
    field('Toggle window from anywhere', globalShortcut, el('span', { className: 'field-note', text: 'Applies after restart. On KDE it needs an installed .desktop file (packaged builds); until then bind `inviterminal --toggle` in System Settings.' })),
    el('h3', { text: 'AI assistant' }),
    field('Model', aiModel),
    field(`${AI_PROVIDER} API key`, apiKey, aiKeyStatus),
    el(
      'div',
      { className: 'lib-actions' },
      button('Save key', async () => {
        const err = await api.ai.setKey(apiKey.value);
        if (err) {
          say(err);
        } else {
          apiKey.value = '';
          say('API key saved to the OS keychain.');
        }
      }, say),
      button('Clear key', async () => {
        await api.ai.clearKey();
        say('API key removed.');
      }, say),
      button('Test key', async () => {
        say('Testing the key…');
        const r = await api.ai.testKey();
        say(r.detail);
      }, say),
    ),
    el('span', { className: 'field-note', text: `The key is stored encrypted in your OS keychain, never in settings.json, and is sent only to ${AI_PROVIDER} when you use the AI features. Get a free key at console.groq.com.` }),
    el('h3', { text: 'Speech-to-text (local whisper.cpp)' }),
    field('Whisper model path', sttModel, sttStatus),
    el('span', { className: 'field-note', text: 'Transcription runs on your machine with whisper-cli; audio is never uploaded. Download a ggml model (e.g. ggml-base.en.bin) and point this at it.' }),
    el('h3', { text: 'Text-to-speech (local, for interview practice)' }),
    field('TTS binary', ttsBinary, ttsStatus),
    field('Voice', ttsVoice),
    el('span', { className: 'field-note', text: 'The interviewer can read questions aloud (toggle it on in the Practice panel). Speech is generated on your machine — install espeak-ng (e.g. "sudo pacman -S espeak-ng"), or point this at another engine that accepts [-v VOICE] followed by the text.' }),
    el('h3', { text: 'Share to phone' }),
    field('Port', companionPort),
    ...(Object.keys(shareChecks) as (keyof typeof shareChecks)[]).map((k) => el('label', { className: 'lib-trash' }, shareChecks[k], el('span', { text: SHARE_LABELS[k] }))),
    el('span', { className: 'field-note', text: 'The LAN port your phone connects to. A fixed port means you add a firewall rule only once; set it to 0 for a random port each time. If your phone can’t connect, the exact firewall command is shown in the Share panel while sharing.' }),
    el('h3', { text: 'Live transcript (local)' }),
    field('Capture source', liveSource),
    field('Chunk seconds (3–30)', liveChunk),
    field('Speaker-turn model (tinydiarize)', liveTdrz),
    el('span', { className: 'field-note', text: 'Transcribes the meeting audio playing on this machine, locally. For speaker-turn labels, download the whisper tinydiarize model (~465MB) into <data dir>/models/: curl -L -o ~/.config/inviterminal/models/ggml-small.en-tdrz.bin https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin' }),
    el('div', { className: 'lib-actions' }, button('Save', save, say), button('Revert', () => load(), say)),
    el('h3', { text: 'Usage (local only)' }),
    usageTotal,
    el('span', { className: 'field-note', text: 'Counts of which features you use, kept only on this machine (never sent to the phone, MongoDB, or any AI provider). It stores action names, counts and times — never your commands, transcripts, prompts or answers.' }),
    usageTable,
    el('div', { className: 'lib-actions' }, usageRefreshBtn, usageExportBtn, usageResetBtn),
    message,
  );

  api.settings.onChange((v) => {
    view = v;
    renderBanner();
  });

  function close(): void {
    if (panel.hidden) return;
    // A hidden shortcut field that kept focus would keep swallowing key presses.
    if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) document.activeElement.blur();
    panel.hidden = true;
    opts.onOpenChange(false);
  }

  return {
    element: panel,
    toggle() {
      if (!panel.hidden) return close();
      panel.hidden = false;
      opts.onOpenChange(true);
      void load().catch((e: Error) => say(e.message));
    },
    close,
    isOpen: () => !panel.hidden,
  };
}
