import type { AskMode, ChatTurn } from '../shared/ai';
import { type SpeakerMode, SPEAKER_MODE_LABELS } from '../shared/audio';

/** The parts of a transcript entry these helpers need (kept structural so they're testable without a DOM). */
export interface TranscriptEntry {
  at: string;
  lastAt?: string;
  speaker?: string;
  text: string;
  thread?: ThreadLike;
}

export interface ThreadLike {
  label: string;
  question: string;
  mode: AskMode;
  turns: ChatTurn[];
}

/** Consecutive lines merge only when both carry the same speaker, the earlier one has no AI thread yet, and they're close in time. */
export function shouldMerge(prev: TranscriptEntry, line: { at: string; speaker?: string }, windowMs = 30_000): boolean {
  if (!prev.speaker || !line.speaker || prev.speaker !== line.speaker) return false;
  if (prev.thread) return false;
  const gap = Date.parse(line.at) - Date.parse(prev.lastAt ?? prev.at);
  return Number.isFinite(gap) && gap >= 0 && gap <= windowMs;
}

const hhmmss = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
};

/** "[10:01:02] You: text" lines, for the clipboard. */
export function plainTranscript(items: TranscriptEntry[], display: (raw?: string) => string): string {
  return items.map((i) => `[${hhmmss(i.at)}] ${i.speaker ? `${display(i.speaker)}: ` : ''}${i.text}`).join('\n');
}

const quote = (s: string) =>
  s
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');

function threadMarkdown(t: ThreadLike, display: (raw?: string) => string): string {
  void display;
  const out: string[] = [`### ${t.label}`];
  if (t.mode !== 'summarize') out.push(quote(t.question.length > 1500 ? `${t.question.slice(0, 1500)}…` : t.question));
  for (let i = 0; i < t.turns.length; i += 2) {
    const q = t.turns[i];
    const a = t.turns[i + 1];
    if (i > 0 && q) out.push(`**Follow-up:** ${q.content}`);
    if (a) out.push(a.content);
  }
  return out.join('\n\n');
}

/** Transcript + every AI thread (per-line answers, selections, summaries) as one Markdown document. */
export function buildTranscriptMarkdown(items: TranscriptEntry[], threads: readonly ThreadLike[], display: (raw?: string) => string, mode: SpeakerMode, now = new Date()): string {
  const lines: string[] = ['# Live transcript', `_Exported ${now.toLocaleString()} · Speakers: ${SPEAKER_MODE_LABELS[mode]} · ${items.length} turn${items.length === 1 ? '' : 's'}_`, ''];
  for (const i of items) lines.push(`**${hhmmss(i.at)}${i.speaker ? ` · ${display(i.speaker)}` : ''}** — ${i.text}`, '');
  const done = threads.filter((t) => t.turns.length > 0);
  if (done.length) {
    lines.push('---', '', '## AI answers', '');
    for (const t of done) lines.push(threadMarkdown(t, display), '');
  }
  return `${lines.join('\n').trim()}\n`;
}
