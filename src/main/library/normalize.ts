/** Field normalisation shared by create and update, so stored data has one shape. */

export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;
export const MAX_FOLDER_DEPTH = 8;
export const MAX_FOLDER_SEGMENT = 40;

/** Lowercase, trimmed, deduplicated; characters outside [a-z0-9._-] become '-'. Empty tags are dropped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_TAG_LEN);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} tags.`);
  return out;
}

/**
 * "deploy / k8s/" → "deploy/k8s". Folders are labels, not filesystem paths,
 * but "." and ".." are still refused so nothing ever looks like traversal.
 */
export function normalizeFolder(folder: string): string {
  const segments = folder
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length > MAX_FOLDER_DEPTH) throw new Error(`Folders nest at most ${MAX_FOLDER_DEPTH} deep.`);
  for (const s of segments) {
    if (s === '.' || s === '..') throw new Error('Folder names cannot be "." or "..".');
    if (s.length > MAX_FOLDER_SEGMENT) throw new Error(`Folder names are at most ${MAX_FOLDER_SEGMENT} characters.`);
  }
  return segments.join('/');
}

/** For building a MongoDB $regex from user text without it being interpreted as a pattern. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
