import { describe, expect, it } from 'vitest';
import { isValidGlobalAccelerator } from '../src/main/visibility/accelerator';

describe('isValidGlobalAccelerator', () => {
  it('accepts modifier + key combinations', () => {
    for (const a of ['Control+Alt+T', 'Ctrl+Shift+F12', 'Super+Space', 'CommandOrControl+Alt+Shift+`', 'Alt+F1', 'Meta+Return']) expect(isValidGlobalAccelerator(a)).toBe(true);
  });

  it('rejects a bare key: it would be stolen from every other app', () => {
    for (const a of ['T', 'F12', 'Space']) expect(isValidGlobalAccelerator(a)).toBe(false);
  });

  it('rejects malformed or duplicated input', () => {
    for (const a of ['', 'Control+', '+T', 'Control+Control+T', 'Control+Alt+Shift+Super+Meta+T', 'Ctrl+t', 'Ctrl+F25', 'Hyper+T', 'Ctrl+T; rm -rf ~']) expect(isValidGlobalAccelerator(a)).toBe(false);
  });
});
