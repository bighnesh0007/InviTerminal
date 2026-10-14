/**
 * Validates an Electron accelerator for a *global* shortcut. At least one
 * modifier is required: a bare key registered globally would be stolen from
 * every other application.
 */
const MODIFIER = '(?:CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|AltGr|Shift|Super|Meta)';
const KEY = '(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|Plus|`|-|=|\\[|\\]|;|\'|,|\\.|/|\\\\)';
const ACCELERATOR_RE = new RegExp(`^(?:${MODIFIER}\\+){1,4}${KEY}$`);

export function isValidGlobalAccelerator(s: string): boolean {
  if (!ACCELERATOR_RE.test(s)) return false;
  const mods = s.split('+').slice(0, -1);
  return new Set(mods).size === mods.length;
}
