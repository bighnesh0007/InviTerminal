import { describe, expect, it } from 'vitest';
import { classifyEnvironment } from '../src/main/capture/detect';

// The environment this was developed on (verified 2026-10-14).
const KDE_WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':1', XDG_CURRENT_DESKTOP: 'KDE' };

describe('classifyEnvironment', () => {
  it('accepts KDE on Wayland (XWayland DISPLAY present is fine)', () => {
    expect(classifyEnvironment('linux', KDE_WAYLAND)).toEqual({ kind: 'kwin-wayland' });
  });

  it('rejects X11 sessions, including KDE on X11', () => {
    // The reason matters: the user must be told *why* (X11 has no exclusion), not "no session".
    for (const env of [{ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, { DISPLAY: ':0' }]) {
      const r = classifyEnvironment('linux', env);
      expect(r.kind === 'unsupported' && r.reason).toMatch(/X11 session: any X client can read/);
    }
  });

  it('rejects other Wayland compositors by name', () => {
    for (const d of ['GNOME', 'Hyprland', 'sway', 'ubuntu:GNOME']) {
      const r = classifyEnvironment('linux', { ...KDE_WAYLAND, XDG_CURRENT_DESKTOP: d });
      expect(r.kind).toBe('unsupported');
    }
  });

  it('accepts a colon-separated desktop list containing KDE', () => {
    expect(classifyEnvironment('linux', { ...KDE_WAYLAND, XDG_CURRENT_DESKTOP: 'foo:KDE' }).kind).toBe('kwin-wayland');
  });

  it('marks Windows as not yet implemented rather than silently pretending', () => {
    const r = classifyEnvironment('win32', {});
    expect(r.kind).toBe('unsupported');
    expect(r.kind === 'unsupported' && r.reason).toMatch(/later phase/);
  });

  it('rejects a headless session', () => {
    expect(classifyEnvironment('linux', {}).kind).toBe('unsupported');
  });
});
