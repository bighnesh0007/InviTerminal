import { win32 } from 'node:path';
import type { ShellProfile } from './shells';

/**
 * Windows profile detection. NOT YET RUN ON WINDOWS — Windows is a later
 * phase; this exists so the profile model already has the slots, and its
 * logic is unit-tested with fakes.
 */
export interface WindowsShellFacts {
  /** %SystemRoot%, e.g. C:\Windows */
  systemRoot: string;
  /** %ComSpec%, usually C:\Windows\System32\cmd.exe */
  comSpec: string | undefined;
  exists(path: string): boolean;
  /** Absolute path of pwsh.exe if installed (PowerShell 7+), else null. */
  pwshPath: string | null;
  /** Raw stdout of `wsl.exe --list --quiet` (UTF-16LE), or null if WSL is absent. */
  wslListOutput: Buffer | null;
}

/** WSL distro names as accepted by `wsl.exe -d`; anything else is ignored, never passed on. */
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `wsl --list --quiet` writes UTF-16LE with CRLF line ends (and sometimes a BOM and NULs). */
export function parseWslList(out: Buffer): string[] {
  const text = out.toString('utf16le').replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => DISTRO.test(l)))];
}

export function detectWindowsShellProfiles(f: WindowsShellFacts): { profiles: ShellProfile[]; defaultId: string } {
  const sys32 = win32.join(f.systemRoot, 'System32');
  const profiles: ShellProfile[] = [];
  const cmd = f.comSpec && win32.isAbsolute(f.comSpec) && f.exists(f.comSpec) ? f.comSpec : win32.join(sys32, 'cmd.exe');
  if (f.exists(cmd)) profiles.push({ id: 'cmd', label: 'Command Prompt', file: cmd, args: [] });
  const ps = win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (f.exists(ps)) profiles.push({ id: 'powershell', label: 'Windows PowerShell', file: ps, args: ['-NoLogo'] });
  if (f.pwshPath && win32.isAbsolute(f.pwshPath) && f.exists(f.pwshPath)) profiles.push({ id: 'pwsh', label: 'PowerShell 7', file: f.pwshPath, args: ['-NoLogo'] });
  const wsl = win32.join(sys32, 'wsl.exe');
  if (f.wslListOutput && f.exists(wsl)) {
    for (const distro of parseWslList(f.wslListOutput)) {
      const slug = distro.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
      let id = `wsl-${slug}`;
      for (let n = 2; profiles.some((p) => p.id === id); n++) id = `wsl-${slug}-${n}`;
      profiles.push({ id, label: `WSL: ${distro}`, file: wsl, args: ['-d', distro] });
    }
  }
  // The brief starts Windows support with CMD.
  const defaultId = profiles.find((p) => p.id === 'cmd')?.id ?? profiles[0]?.id;
  if (!defaultId) throw new Error('No usable Windows shell found.');
  return { profiles, defaultId };
}
