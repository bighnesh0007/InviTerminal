import { execFile } from 'node:child_process';
import { parseBoolReply, parseInt32Reply, parseMatchUuids, parseWindowInfo, type KwinWindowInfo } from './gvariant';

/**
 * Talks to KWin through the `gdbus` CLI (glib2, present on any desktop Arch
 * install) with an explicit argv — no shell, no string interpolation. This
 * avoids a native D-Bus dependency; the maintained-looking JS option
 * (dbus-next) pulls in node-gyp/request with open critical advisories.
 */

const DEST = 'org.kde.KWin';

function gdbusCall(objectPath: string, method: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gdbus',
      ['call', '--session', '--dest', DEST, '--object-path', objectPath, '--method', method, ...args],
      // Match replies embed window icons, so they can be large.
      { timeout: 4000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(`${method} failed: ${stderr.trim() || err.message}`)) : resolve(stdout)),
    );
  });
}

export async function matchWindowUuids(term: string): Promise<string[]> {
  return parseMatchUuids(await gdbusCall('/WindowsRunner', 'org.kde.krunner1.Match', [term]));
}

export async function getWindowInfo(uuid: string): Promise<KwinWindowInfo | null> {
  return parseWindowInfo(await gdbusCall('/KWin', 'org.kde.KWin.getWindowInfo', [uuid]));
}

export async function loadScript(filePath: string, pluginName: string): Promise<number> {
  const id = parseInt32Reply(await gdbusCall('/Scripting', 'org.kde.kwin.Scripting.loadScript', [filePath, pluginName]));
  if (id === null || id < 0) throw new Error(`KWin refused to load script ${pluginName} (reply id ${id})`);
  return id;
}

export async function runScript(id: number): Promise<void> {
  await gdbusCall(`/Scripting/Script${id}`, 'org.kde.kwin.Script.run');
}

export async function unloadScript(pluginName: string): Promise<boolean> {
  return parseBoolReply(await gdbusCall('/Scripting', 'org.kde.kwin.Scripting.unloadScript', [pluginName])) ?? false;
}
