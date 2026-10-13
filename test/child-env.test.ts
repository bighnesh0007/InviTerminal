import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../src/main/terminal/env';

describe('buildChildEnv', () => {
  const parent = {
    HOME: '/home/u',
    PATH: '/usr/bin',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_PA_APP_NAME: 'x',
    CHROME_DESKTOP: 'x.desktop',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'KDE',
    INVI_AUTOTEST: 'terminal',
    npm_lifecycle_event: 'start',
    TERM: 'dumb',
    EMPTY: undefined,
  };

  it('keeps the user environment', () => {
    const env = buildChildEnv(parent, '0.1.0');
    expect(env.HOME).toBe('/home/u');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips what Electron, npm and this app inject — ELECTRON_RUN_AS_NODE above all', () => {
    const env = buildChildEnv(parent, '0.1.0');
    for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_PA_APP_NAME', 'CHROME_DESKTOP', 'ORIGINAL_XDG_CURRENT_DESKTOP', 'INVI_AUTOTEST', 'npm_lifecycle_event', 'EMPTY']) {
      expect(env).not.toHaveProperty(k);
    }
  });

  it('sets terminal identity, overriding an inherited TERM', () => {
    const env = buildChildEnv(parent, '0.1.0');
    expect(env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'InviTerminal', TERM_PROGRAM_VERSION: '0.1.0' });
  });
});
