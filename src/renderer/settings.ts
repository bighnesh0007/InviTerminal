import type { RendererApi } from '../shared/ipc';
import { APP_ACTIONS, canonicalChord, chordFromEvent, keymapProblems, type AppAction, type Keymap } from '../shared/keymap';
import type { SettingsPatch, SettingsView } from '../shared/settings';
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
    for (const a of APP_ACTIONS) chordInputs[a].value = canonicalChord(s.shortcuts[a]) ?? s.shortcuts[a];
    for (const [input, path] of [[mongoUri, 'library.mongoUri'], [allowRemote, 'library.allowRemote'], [globalShortcut, 'globalShortcut']] as const) {
      input.disabled = view.overriddenByEnv.includes(path);
      input.title = input.disabled ? 'Set by an INVI_* environment variable for this run' : '';
    }
    renderBanner();
    validateChords();
  }

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
    el('div', { className: 'lib-actions' }, button('Save', save, say), button('Revert', () => load(), say)),
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
