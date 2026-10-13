/**
 * Decides which provider to try from the session environment alone. This is
 * only a pre-filter: the KWin provider still probes KWin for the property
 * before claiming support.
 */
export type EnvironmentClass = { kind: 'kwin-wayland' } | { kind: 'unsupported'; reason: string };

export function classifyEnvironment(platform: NodeJS.Platform, env: Record<string, string | undefined>): EnvironmentClass {
  if (platform === 'win32') {
    return { kind: 'unsupported', reason: 'Windows support (SetWindowDisplayAffinity) is planned for a later phase.' };
  }
  if (platform !== 'linux') {
    return { kind: 'unsupported', reason: `Platform "${platform}" is not supported.` };
  }
  const session = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (session === 'x11' || (!env.WAYLAND_DISPLAY && env.DISPLAY)) {
    return {
      kind: 'unsupported',
      reason: 'X11 session: any X client can read the whole screen and there is no exclusion mechanism. Log in to a Wayland session.',
    };
  }
  if (session !== 'wayland' && !env.WAYLAND_DISPLAY) {
    return { kind: 'unsupported', reason: 'No graphical session detected (neither Wayland nor X11).' };
  }
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').split(':').map((d) => d.trim().toUpperCase());
  if (!desktops.includes('KDE')) {
    return {
      kind: 'unsupported',
      reason: `Compositor "${env.XDG_CURRENT_DESKTOP ?? 'unknown'}" has no per-window capture exclusion this app knows how to request. Only KDE Plasma 6.6+ (KWin) is supported on Linux for now.`,
    };
  }
  return { kind: 'kwin-wayland' };
}
