import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectShellProfiles, parseEtcShells, type ShellFacts } from '../src/main/terminal/shells';

// Copied from this machine's /etc/shells on 2026-10-14 (Arch: /bin -> usr/bin; sh, rbash -> bash).
const ARCH_SHELLS = readFileSync(join(__dirname, 'fixtures', 'etc-shells-arch.txt'), 'utf8');

/** Mirrors the dev machine's filesystem: /bin is a symlink to /usr/bin, and sh/rbash are bash. */
function archFacts(userShell: string | undefined, extra: Record<string, string> = {}): ShellFacts {
  const real: Record<string, string> = {
    '/usr/bin/bash': '/usr/bin/bash',
    '/usr/bin/sh': '/usr/bin/bash',
    '/usr/bin/rbash': '/usr/bin/bash',
    '/usr/bin/git-shell': '/usr/bin/git-shell',
    '/usr/bin/systemd-home-fallback-shell': '/usr/bin/systemd-home-fallback-shell',
    ...extra,
  };
  const resolve = (p: string) => {
    const r = real[p.replace(/^\/bin\//, '/usr/bin/')];
    if (!r) throw new Error(`ENOENT ${p}`);
    return r;
  };
  return {
    etcShells: ARCH_SHELLS,
    userShell,
    isExecutable: (p) => {
      try {
        resolve(p);
        return true;
      } catch {
        return false;
      }
    },
    realpath: resolve,
  };
}

describe('parseEtcShells', () => {
  it('skips comments, blanks and non-absolute lines', () => {
    expect(parseEtcShells('# comment\n\n/bin/bash\nrelative\n  /usr/bin/zsh  \n')).toEqual(['/bin/bash', '/usr/bin/zsh']);
  });
});

describe('detectShellProfiles (Arch layout)', () => {
  it('offers bash and sh once each, never rbash, git-shell or the systemd fallback', () => {
    const { profiles, defaultId } = detectShellProfiles(archFacts('/usr/bin/bash'));
    expect(profiles.map((p) => p.id)).toEqual(['bash', 'sh']);
    expect(defaultId).toBe('bash');
  });

  it('keeps the listed path, not the realpath: sh must be launched as sh', () => {
    const { profiles } = detectShellProfiles(archFacts('/usr/bin/bash'));
    expect(profiles.find((p) => p.id === 'sh')?.file).toMatch(/\/sh$/);
  });

  it('prefers $SHELL as the default and as the kept duplicate', () => {
    const { profiles, defaultId } = detectShellProfiles(archFacts('/usr/bin/bash'));
    expect(defaultId).toBe('bash');
    expect(profiles[0]?.file).toBe('/usr/bin/bash');
  });

  it('includes a $SHELL that is not in /etc/shells (e.g. a user-installed zsh)', () => {
    const { profiles, defaultId } = detectShellProfiles(archFacts('/home/u/.nix-profile/bin/zsh', { '/home/u/.nix-profile/bin/zsh': '/nix/store/x/zsh' }));
    expect(defaultId).toBe('zsh');
    expect(profiles.map((p) => p.id)).toContain('bash');
  });

  it('falls back to bash when $SHELL is unset, relative or missing', () => {
    for (const s of [undefined, 'bash', '/usr/bin/doesnotexist']) expect(detectShellProfiles(archFacts(s)).defaultId).toBe('bash');
  });

  it('disambiguates two different shells with the same name', () => {
    const { profiles } = detectShellProfiles({
      ...archFacts(undefined, { '/usr/local/bin/bash': '/usr/local/bin/bash' }),
      etcShells: '/usr/bin/bash\n/usr/local/bin/bash\n',
    });
    expect(profiles.map((p) => p.id)).toEqual(['bash', 'bash-2']);
  });

  it('throws when nothing usable exists', () => {
    expect(() => detectShellProfiles({ etcShells: '/usr/bin/git-shell\n', userShell: undefined, isExecutable: () => true, realpath: (p) => p })).toThrow();
  });
});

describe('detectShellProfiles (this machine, real filesystem)', () => {
  it('finds at least the user shell', () => {
    const facts: ShellFacts = {
      etcShells: readFileSync('/etc/shells', 'utf8'),
      userShell: process.env.SHELL,
      isExecutable: (p) => {
        try {
          accessSync(p, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      realpath: (p) => realpathSync(p),
    };
    const { profiles, defaultId } = detectShellProfiles(facts);
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.some((p) => p.id === defaultId)).toBe(true);
  });
});
