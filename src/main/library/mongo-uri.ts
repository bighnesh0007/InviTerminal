export type UriCheck =
  | { ok: true; dbName: string; host: string; loopback: boolean }
  | { ok: false; reason: string };

const RESERVED_DBS = new Set(['admin', 'local', 'config']);

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Snippets are often commands with secrets in them, and this is a "private"
 * terminal: a non-loopback MongoDB would send them off the machine. That is
 * refused unless explicitly allowed. The URI must also name its own
 * database, never admin/local/config, so the library cannot write into
 * another project's database by accident.
 */
export function checkMongoUri(uri: string, allowRemote: boolean): UriCheck {
  if (uri.startsWith('mongodb+srv://')) {
    if (!allowRemote) return { ok: false, reason: 'mongodb+srv:// is always remote; set INVI_MONGODB_ALLOW_REMOTE=1 to allow snippets to leave this machine.' };
  } else if (!uri.startsWith('mongodb://')) {
    return { ok: false, reason: 'URI must start with mongodb:// or mongodb+srv://.' };
  }
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const authority = afterScheme.split('/')[0] ?? '';
  const hostList = (authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority).split(',');
  const hosts = hostList.map((h) => (h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0] ?? ''));
  if (hosts.some((h) => !h)) return { ok: false, reason: 'URI has an empty host.' };
  const loopback = !uri.startsWith('mongodb+srv://') && hosts.every(isLoopbackHost);
  if (!loopback && !allowRemote) {
    return { ok: false, reason: `MongoDB host ${hosts.join(',')} is not on this machine; set INVI_MONGODB_ALLOW_REMOTE=1 to allow snippets to leave it.` };
  }
  const path = afterScheme.slice(authority.length + 1).split('?')[0] ?? '';
  const dbName = decodeURIComponent(path);
  if (!dbName) return { ok: false, reason: 'URI must name a database, e.g. mongodb://127.0.0.1:27017/inviterminal.' };
  if (RESERVED_DBS.has(dbName)) return { ok: false, reason: `Refusing to use the reserved "${dbName}" database.` };
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) return { ok: false, reason: `Invalid database name "${dbName}".` };
  return { ok: true, dbName, host: hosts.join(','), loopback };
}
