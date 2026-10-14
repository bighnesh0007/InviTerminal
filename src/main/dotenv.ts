import { readFileSync } from 'node:fs';

/**
 * Minimal .env parser (no dependency). Supports `KEY=value`, `export KEY=value`,
 * `#` comments, blank lines, and single/double-quoted values. Values are trimmed
 * unless quoted. Not a full dotenv implementation — just enough to hold an API key.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue; // no '=', or line starts with '=': skip
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // only valid env-var names
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1); // keep quoted content verbatim (spaces, '#')
    } else {
      const hash = value.indexOf(' #'); // strip a trailing inline comment on unquoted values
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads `path` into `env` for any key not already set (real environment variables
 * win, matching dotenv convention). Missing/unreadable file is a silent no-op.
 * Returns the names it set, for logging. Never logs values (secrets).
 */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // no .env is fine
  }
  const parsed = parseDotEnv(text);
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
