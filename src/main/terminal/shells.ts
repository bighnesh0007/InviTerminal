import { posix } from 'node:path';

export interface ShellProfile {
  /** Stable id the renderer refers to; the renderer never supplies a path. */
  id: string;
  label: string;
  /** Path as listed (not realpath): bash changes behaviour by argv[0], e.g. sh → POSIX mode. */
  file: string;
  args: string[];
}

export interface ShellFacts {
  /** Contents of /etc/shells. */
  etcShells: string;
  /** $SHELL, if set. */
  userShell: string | undefined;
  isExecutable: (path: string) => boolean;
  realpath: (path: string) => string;
}

/** Listed in /etc/shells on Arch but not interactive shells a user wants. */
const NOT_INTERACTIVE = new Set(['git-shell', 'rbash', 'nologin', 'false', 'true', 'systemd-home-fallback-shell']);

export function parseEtcShells(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/') && !l.includes(' '));
}

export function detectShellProfiles(f: ShellFacts): { profiles: ShellProfile[]; defaultId: string } {
  const candidates = parseEtcShells(f.etcShells);
  const user = f.userShell && posix.isAbsolute(f.userShell) ? f.userShell : undefined;
  // $SHELL goes first so that, of /bin/bash and /usr/bin/bash, the one the user chose is kept.
  if (user) candidates.unshift(user);

  const seen = new Set<string>();
  const profiles: ShellProfile[] = [];
  let defaultId: string | undefined;
  for (const file of candidates) {
    const name = posix.basename(file);
    if (NOT_INTERACTIVE.has(name) || !f.isExecutable(file)) continue;
    let real: string;
    try {
      real = f.realpath(file);
    } catch {
      continue;
    }
    const key = `${name}\0${real}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let id = name;
    for (let n = 2; profiles.some((p) => p.id === id); n++) id = `${name}-${n}`;
    profiles.push({ id, label: id === name ? name : `${name} (${file})`, file, args: [] });
    if (file === user) defaultId = id;
  }
  defaultId ??= profiles.find((p) => p.id === 'bash')?.id ?? profiles[0]?.id;
  if (!defaultId) throw new Error('No usable shell found in /etc/shells or $SHELL.');
  return { profiles, defaultId };
}
