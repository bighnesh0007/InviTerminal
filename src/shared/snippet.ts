export const LANGUAGES = ['bash', 'sh', 'zsh', 'fish', 'powershell', 'cmd', 'python', 'text'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Snippet {
  id: string;
  title: string;
  body: string;
  description: string;
  language: Language;
  tags: string[];
  folder: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
  deletedAt: string | null;
}

export interface SnippetInput {
  title: string;
  body: string;
  description?: string;
  language?: Language;
  tags?: string[];
  folder?: string;
}

export interface SearchQuery {
  q?: string;
  folder?: string;
  tag?: string;
  deleted?: boolean;
}

export type LibraryStatus =
  | { state: 'connecting'; target: string }
  | { state: 'ready'; target: string }
  | { state: 'unavailable'; target: string; reason: string };

/**
 * Orders search results: title prefix, then title substring, then tag,
 * folder, description, body; ties go to the most used, then the most
 * recently edited. Pure, so the ranking is tested without a database.
 */
export function rankSnippets(items: readonly Snippet[], q: string | undefined): Snippet[] {
  const needle = (q ?? '').trim().toLowerCase();
  const score = (s: Snippet): number => {
    if (!needle) return 0;
    const title = s.title.toLowerCase();
    if (title.startsWith(needle)) return 6;
    if (title.includes(needle)) return 5;
    if (s.tags.some((t) => t.includes(needle))) return 4;
    if (s.folder.toLowerCase().includes(needle)) return 3;
    if (s.description.toLowerCase().includes(needle)) return 2;
    if (s.body.toLowerCase().includes(needle)) return 1;
    return 0;
  };
  return [...items]
    .map((s) => ({ s, k: score(s) }))
    .filter(({ k }) => !needle || k > 0)
    .sort((a, b) => b.k - a.k || b.s.useCount - a.s.useCount || b.s.updatedAt.localeCompare(a.s.updatedAt))
    .map(({ s }) => s);
}

/** Text that will be typed into the terminal: never ends in a newline, so inserting never runs it. */
export function textForInsert(body: string): { text: string; multiline: boolean } {
  const text = body.replace(/\r\n/g, '\n').replace(/[\r\n]+$/, '');
  return { text, multiline: text.includes('\n') };
}
