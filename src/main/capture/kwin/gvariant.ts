/**
 * Minimal readers for the GVariant text that `gdbus call` prints. We only
 * need a few scalar fields, so these are targeted regexes rather than a
 * general parser — and they are tested against recorded real output.
 */

const UUID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/;

export function isKwinUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** WindowsRunner.Match ids look like '0_{uuid}'; the number is a runner action. */
export function parseMatchUuids(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/'\d+_(\{[0-9a-f-]{36}\})'/g)) {
    if (isKwinUuid(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}

export interface KwinWindowInfo {
  uuid: string;
  pid: number;
  caption: string;
  resourceClass: string;
  /** undefined when KWin is too old to know the property (< 6.6). */
  excludeFromCapture: boolean | undefined;
}

function field(text: string, key: string): string | undefined {
  // Values are wrapped as <...>; strings as <'...'> with \' escapes.
  const re = new RegExp(`'${key}': <('(?:[^'\\\\]|\\\\.)*'|[^>]*)>`);
  return re.exec(text)?.[1];
}

function unquote(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v;
}

/** Returns null for KWin's empty reply (`(@a{sv} {},)`), i.e. no such window. */
export function parseWindowInfo(text: string): KwinWindowInfo | null {
  const uuid = unquote(field(text, 'uuid'));
  const pid = Number(field(text, 'pid'));
  if (!uuid || !isKwinUuid(uuid) || !Number.isInteger(pid)) return null;
  const efc = field(text, 'excludeFromCapture');
  return {
    uuid,
    pid,
    caption: unquote(field(text, 'caption')) ?? '',
    resourceClass: unquote(field(text, 'resourceClass')) ?? '',
    excludeFromCapture: efc === 'true' ? true : efc === 'false' ? false : undefined,
  };
}

/** loadScript replies `(0,)`; -1 means KWin refused (e.g. name already loaded). */
export function parseInt32Reply(text: string): number | null {
  const m = /^\((-?\d+),\)\s*$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

export function parseBoolReply(text: string): boolean | null {
  const m = /^\((true|false),\)\s*$/.exec(text.trim());
  return m ? m[1] === 'true' : null;
}
