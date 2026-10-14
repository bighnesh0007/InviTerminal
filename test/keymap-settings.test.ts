import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/main/settings/SettingsStore';
import { detectWindowsShellProfiles, parseWslList } from '../src/main/terminal/windows-shells';
import { actionForEvent, canonicalChord, chordProblem, DEFAULT_KEYMAP, keymapProblems } from '../src/shared/keymap';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const ev = (code: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) => ({ code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta });

describe('keymap', () => {
  it('canonicalises chords', () => {
    expect(canonicalChord('control+shift+h')).toBe('Ctrl+Shift+H');
    expect(canonicalChord('Shift+Ctrl+pagedown')).toBe('Ctrl+Shift+PageDown');
    expect(canonicalChord('super+f5')).toBe('Super+F5');
    expect(canonicalChord('Ctrl+Ctrl+H')).toBeNull();
    expect(canonicalChord('Ctrl+Hyper')).toBeNull();
  });

  it('accepts the defaults', () => {
    expect(keymapProblems(DEFAULT_KEYMAP)).toEqual({});
  });

  it('refuses chords the shell needs', () => {
    for (const c of ['Ctrl+C', 'Ctrl+D', 'Ctrl+R', 'Ctrl+Left', 'Ctrl+BracketLeft', 'Alt+B', 'Alt+F', 'Alt+Period', 'Shift+PageUp', 'Shift+A', 'F5', 'H']) {
      expect(chordProblem(c), c).not.toBeNull();
    }
  });

  it('allows chords the shell does not use', () => {
    for (const c of ['Ctrl+Shift+T', 'Ctrl+Alt+K', 'Alt+Shift+N', 'Super+J', 'Ctrl+PageDown', 'Ctrl+Tab', 'Ctrl+F2', 'Alt+F4']) expect(chordProblem(c), c).toBeNull();
  });

  it('refuses the reserved copy/paste chords and duplicates', () => {
    expect(chordProblem('Ctrl+Shift+C')).toMatch(/reserved/);
    expect(keymapProblems({ ...DEFAULT_KEYMAP, newTab: 'ctrl+shift+h' })).toEqual({ newTab: 'Ctrl+Shift+H is already used for panicHide.' });
  });

  it('maps keyboard events to actions by physical key', () => {
    expect(actionForEvent(DEFAULT_KEYMAP, ev('KeyH', { ctrl: true, shift: true }))).toBe('panicHide');
    expect(actionForEvent(DEFAULT_KEYMAP, ev('PageDown', { ctrl: true }))).toBe('nextTab');
    expect(actionForEvent(DEFAULT_KEYMAP, ev('Comma', { ctrl: true, shift: true }))).toBe('openSettings');
    expect(actionForEvent(DEFAULT_KEYMAP, ev('KeyH', { ctrl: true }))).toBeNull();
    expect(actionForEvent(DEFAULT_KEYMAP, ev('ShiftLeft', { shift: true }))).toBeNull();
    expect(actionForEvent({ ...DEFAULT_KEYMAP, panicHide: 'Ctrl+Alt+H' }, ev('KeyH', { ctrl: true, shift: true }))).toBeNull();
  });
});

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'invi-settings-test-'));
}

describe('SettingsStore', () => {
  it('starts from defaults without writing a file', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir);
    expect(s.effective()).toEqual(DEFAULT_SETTINGS);
    expect(await readdir(dir)).toEqual([]);
  });

  it('writes atomically with mode 0600 and reloads what it wrote', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir);
    await s.update({ terminal: { fontSize: 16 }, shortcuts: { newTab: 'Ctrl+Alt+T' } });
    const st = await stat(join(dir, 'settings.json'));
    expect(st.mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const again = await SettingsStore.load(dir);
    expect(again.effective().terminal.fontSize).toBe(16);
    expect(again.effective().shortcuts.newTab).toBe('Ctrl+Alt+T');
    expect(again.effective().shortcuts.panicHide).toBe('Ctrl+Shift+H');
  });

  it('rejects an invalid patch and leaves memory and file untouched', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir);
    await s.update({ terminal: { fontSize: 14 } });
    const before = await readFile(join(dir, 'settings.json'), 'utf8');
    await expect(s.update({ terminal: { fontSize: 99 } })).rejects.toThrow(/fontSize/);
    await expect(s.update({ shortcuts: { panicHide: 'Ctrl+C' } })).rejects.toThrow(/panicHide/);
    await expect(s.update({ shortcuts: { newTab: 'Ctrl+Shift+L' } })).rejects.toThrow(/already used/);
    await expect(s.update({ library: { mongoUri: 'mongodb://db.example.com/inv' } })).rejects.toThrow(/not on this machine/);
    await expect(s.update({ globalShortcut: 'T' })).rejects.toThrow(/globalShortcut/);
    expect(s.effective().terminal.fontSize).toBe(14);
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(before);
  });

  it('moves an unreadable file aside instead of overwriting it, and says so', async () => {
    for (const content of ['{ not json', JSON.stringify({ version: 1, surprise: true })]) {
      const dir = await tempDir();
      await writeFile(join(dir, 'settings.json'), content);
      const s = await SettingsStore.load(dir, {}, () => new Date('2026-10-14T12:00:00Z'));
      expect(s.effective()).toEqual(DEFAULT_SETTINGS);
      expect(s.view().loadWarning).toMatch(/moved to/);
      const files = await readdir(dir);
      expect(files).toContain('settings.json.corrupt-2026-10-14T12-00-00-000Z');
      expect(await readFile(join(dir, 'settings.json.corrupt-2026-10-14T12-00-00-000Z'), 'utf8')).toBe(content);
    }
  });

  it('applies environment overrides without saving them, and reports them', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir, { mongoUri: 'mongodb://127.0.0.1:9/other', globalShortcut: 'Control+Alt+T' });
    expect(s.effective().library.mongoUri).toBe('mongodb://127.0.0.1:9/other');
    expect(s.view().overriddenByEnv).toEqual(['library.mongoUri', 'globalShortcut']);
    await s.update({ terminal: { fontSize: 15 } });
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')).library.mongoUri).toBe(DEFAULT_SETTINGS.library.mongoUri);
  });

  it('round-trips the AI model and rejects an unknown model', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir);
    expect(s.effective().ai.model).toBe('claude-opus-5-5');
    await s.update({ ai: { model: 'claude-sonnet-5-5' } });
    expect((await SettingsStore.load(dir)).effective().ai.model).toBe('claude-sonnet-5-5');
    await expect(s.update({ ai: { model: 'gpt-4' as never } })).rejects.toThrow();
  });

  it('flags startup-only settings as needing a restart', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir);
    expect(s.view().restartRequired).toEqual([]);
    await s.update({ globalShortcut: 'Control+Alt+Shift+T' });
    expect(s.view().restartRequired).toEqual(['globalShortcut']);
  });

  it('serialises concurrent updates (last write wins, nothing lost mid-merge)', async () => {
    const dir = await tempDir();
    const s = await SettingsStore.load(dir);
    await Promise.all([s.update({ terminal: { fontSize: 15 } }), s.update({ terminal: { scrollback: 9000 } })]);
    const again = await SettingsStore.load(dir);
    expect(again.effective().terminal).toMatchObject({ fontSize: 15, scrollback: 9000 });
  });
});

describe('Windows profile slots (logic only; not run on Windows)', () => {
  const sys = 'C:\\Windows';
  const present = new Set(['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\wsl.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']);
  const facts = { systemRoot: sys, comSpec: 'C:\\Windows\\System32\\cmd.exe', exists: (p: string) => present.has(p), pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', wslListOutput: Buffer.from('\uFEFFUbuntu-24.04\r\nDebian\r\n\r\n', 'utf16le') };

  it('parses UTF-16LE wsl --list --quiet output and drops junk names', () => {
    expect(parseWslList(Buffer.from('Ubuntu\r\nbad name; rm\r\nArch\r\n', 'utf16le'))).toEqual(['Ubuntu', 'Arch']);
  });

  it('offers cmd (default), Windows PowerShell, pwsh and one profile per distro', () => {
    const { profiles, defaultId } = detectWindowsShellProfiles(facts);
    expect(defaultId).toBe('cmd');
    expect(profiles.map((p) => p.id)).toEqual(['cmd', 'powershell', 'pwsh', 'wsl-ubuntu-24-04', 'wsl-debian']);
    expect(profiles.find((p) => p.id === 'wsl-debian')?.args).toEqual(['-d', 'Debian']);
  });

  it('falls back to System32\\cmd.exe when ComSpec is bogus, and omits what is absent', () => {
    const { profiles } = detectWindowsShellProfiles({ ...facts, comSpec: 'cmd.exe', pwshPath: null, wslListOutput: null });
    expect(profiles.map((p) => p.id)).toEqual(['cmd', 'powershell']);
    expect(profiles[0]?.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});
