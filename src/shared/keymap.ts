/**
 * In-app shortcuts. Chords are written like "Ctrl+Shift+H" and matched on
 * KeyboardEvent.code (the physical key), so they behave the same on any
 * keyboard layout.
 */

export const APP_ACTIONS = ['panicHide', 'toggleLibrary', 'openSettings', 'newTab', 'closeTab', 'nextTab', 'prevTab'] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
export type Keymap = Record<AppAction, string>;

export const DEFAULT_KEYMAP: Keymap = {
  panicHide: 'Ctrl+Shift+H',
  toggleLibrary: 'Ctrl+Shift+L',
  openSettings: 'Ctrl+Shift+Comma',
  newTab: 'Ctrl+Shift+T',
  closeTab: 'Ctrl+Shift+W',
  nextTab: 'Ctrl+PageDown',
  prevTab: 'Ctrl+PageUp',
};

/** Handled by the terminal itself (copy/paste); no action may take them. */
export const RESERVED_CHORDS = ['Ctrl+Shift+C', 'Ctrl+Shift+V'];

const NAMED_KEYS = ['PageUp', 'PageDown', 'Tab', 'Enter', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Insert', 'Delete', 'Backspace', 'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Minus', 'Equal', 'Backquote'];
const FKEY = /^F([1-9]|1[0-9]|2[0-4])$/;

interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

const MOD_ALIASES: Record<string, keyof Omit<Chord, 'key'>> = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', meta: 'meta', super: 'meta' };

function keyName(k: string): string | null {
  if (/^[A-Z]$/i.test(k)) return k.toUpperCase();
  if (/^[0-9]$/.test(k)) return k;
  if (FKEY.test(k.toUpperCase())) return k.toUpperCase();
  return NAMED_KEYS.find((n) => n.toLowerCase() === k.toLowerCase()) ?? null;
}

export function parseChord(s: string): Chord | null {
  const parts = s.split('+').map((p) => p.trim());
  if (parts.length < 1 || parts.some((p) => !p)) return null;
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts.slice(0, -1)) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (!m || chord[m]) return null;
    chord[m] = true;
  }
  const key = keyName(parts[parts.length - 1]!);
  if (!key) return null;
  chord.key = key;
  return chord;
}

function format(c: Chord): string {
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.meta && 'Super', c.key].filter(Boolean).join('+');
}

/** "control+shift+h" → "Ctrl+Shift+H"; null if unparseable. */
export function canonicalChord(s: string): string | null {
  const c = parseChord(s);
  return c ? format(c) : null;
}

/** Keys Ctrl alone may take: none of them produce a terminal control character or readline binding. */
const CTRL_ONLY_SAFE = new Set(['PageUp', 'PageDown', 'Tab']);

/**
 * Why a chord may not be used as an app shortcut, or null if it is fine.
 * The rule: never steal a key the shell needs — Ctrl+letter (control
 * characters), Alt+letter (readline Meta bindings), Shift+key (typing,
 * scrollback), Ctrl+arrows (word movement).
 */
export function chordProblem(s: string): string | null {
  const c = parseChord(s);
  if (!c) return `"${s}" is not a valid shortcut (e.g. Ctrl+Shift+H).`;
  const mods = [c.ctrl, c.shift, c.alt, c.meta].filter(Boolean).length;
  const isF = FKEY.test(c.key);
  if (RESERVED_CHORDS.includes(format(c))) return `${format(c)} is reserved for copy/paste.`;
  if (mods === 0) return `${format(c)} has no modifier; the terminal needs that key.`;
  if (c.meta || mods >= 2) return null;
  if (c.ctrl) return CTRL_ONLY_SAFE.has(c.key) || isF ? null : `Ctrl+${c.key} reaches the shell (control character or readline); add Shift or Alt.`;
  if (c.alt) return isF ? null : `Alt+${c.key} is a readline (Meta) binding; add Ctrl or Shift.`;
  return `Shift+${c.key} is needed for typing or scrollback; add Ctrl or Alt.`;
}

/** Problems with a whole keymap: each chord, plus duplicates. */
export function keymapProblems(km: Keymap): Partial<Record<AppAction, string>> {
  const out: Partial<Record<AppAction, string>> = {};
  const seen = new Map<string, AppAction>();
  for (const action of APP_ACTIONS) {
    const p = chordProblem(km[action]);
    if (p) {
      out[action] = p;
      continue;
    }
    const canon = canonicalChord(km[action])!;
    const other = seen.get(canon);
    if (other) out[action] = `${canon} is already used for ${other}.`;
    else seen.set(canon, action);
  }
  return out;
}

const CODE_TO_KEY: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };

/** The canonical chord for a keyboard event, or null for a bare modifier press. */
export function chordFromEvent(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; code: string }): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else key = keyName(CODE_TO_KEY[e.code] ?? e.code);
  if (!key) return null;
  return format({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, key });
}

/** Which action, if any, a keyboard event triggers. */
export function actionForEvent(km: Keymap, e: Parameters<typeof chordFromEvent>[0]): AppAction | null {
  const chord = chordFromEvent(e);
  if (!chord) return null;
  return APP_ACTIONS.find((a) => canonicalChord(km[a]) === chord) ?? null;
}
