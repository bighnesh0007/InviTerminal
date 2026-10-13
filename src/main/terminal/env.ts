/**
 * The shell inherits the user's environment, minus what Electron, npm and this
 * app inject. Leaking ELECTRON_RUN_AS_NODE into a child, for instance, turns
 * any Electron app the user launches from this terminal into plain Node.
 */
const STRIP_PREFIXES = ['ELECTRON_', 'INVI_', 'npm_'];
const STRIP_EXACT = new Set(['CHROME_DESKTOP', 'ORIGINAL_XDG_CURRENT_DESKTOP', 'GOOGLE_API_KEY', 'GOOGLE_DEFAULT_CLIENT_ID', 'GOOGLE_DEFAULT_CLIENT_SECRET']);

export function buildChildEnv(parent: Readonly<Record<string, string | undefined>>, appVersion: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined || STRIP_EXACT.has(k) || STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'InviTerminal';
  env.TERM_PROGRAM_VERSION = appVersion;
  return env;
}
