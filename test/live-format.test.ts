import { describe, expect, it } from 'vitest';
import { buildTranscriptMarkdown, plainTranscript, shouldMerge } from '../src/renderer/live-format';

const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 10, 0, s)).toISOString();
const display = (raw?: string) => (raw === 'Them' ? 'Interviewer' : (raw ?? ''));

describe('shouldMerge', () => {
  it('merges consecutive lines from the same speaker within the window', () => {
    expect(shouldMerge({ at: at(0), speaker: 'You', text: 'a' }, { at: at(6), speaker: 'You' })).toBe(true);
  });
  it('never merges without speaker labels, across speakers, after a long gap, or into an answered line', () => {
    expect(shouldMerge({ at: at(0), text: 'a' }, { at: at(6) })).toBe(false);
    expect(shouldMerge({ at: at(0), speaker: 'You', text: 'a' }, { at: at(6), speaker: 'Them' })).toBe(false);
    expect(shouldMerge({ at: at(0), speaker: 'You', text: 'a' }, { at: at(45), speaker: 'You' })).toBe(false);
    expect(shouldMerge({ at: at(0), speaker: 'You', text: 'a', thread: { label: 'x', question: 'a', mode: 'answer', turns: [] } }, { at: at(6), speaker: 'You' })).toBe(false);
  });
  it('measures the gap from the latest merged line (lastAt)', () => {
    expect(shouldMerge({ at: at(0), lastAt: at(25), speaker: 'You', text: 'a' }, { at: at(50), speaker: 'You' })).toBe(true);
  });
});

describe('plainTranscript / buildTranscriptMarkdown', () => {
  const items = [
    { at: at(1), speaker: 'Them', text: 'Tell me about a hard bug.' },
    { at: at(9), speaker: 'You', text: 'A race in the cache.' },
  ];
  it('plain text uses renamed speakers', () => {
    expect(plainTranscript(items, display)).toMatch(/Interviewer: Tell me about a hard bug\.\n.*You: A race in the cache\./);
  });
  it('markdown has the transcript and every answered thread with follow-ups', () => {
    const md = buildTranscriptMarkdown(
      items,
      [
        { label: 'Answer', question: 'Tell me about a hard bug.', mode: 'answer', turns: [{ role: 'user', content: 'Tell me about a hard bug.' }, { role: 'assistant', content: 'Describe impact first.' }, { role: 'user', content: 'Shorter?' }, { role: 'assistant', content: 'Impact first.' }] },
        { label: 'Summary so far', question: '...', mode: 'summarize', turns: [{ role: 'user', content: '...' }, { role: 'assistant', content: 'They discussed a cache race.' }] },
        { label: 'Unanswered', question: 'q', mode: 'answer', turns: [] },
      ],
      display,
      'you-them',
    );
    expect(md).toContain('# Live transcript');
    expect(md).toContain('Speakers: You / Them · 2 turns');
    expect(md).toContain('· Interviewer** — Tell me about a hard bug.');
    expect(md).toContain('## AI answers');
    expect(md).toContain('> Tell me about a hard bug.');
    expect(md).toContain('**Follow-up:** Shorter?');
    expect(md).toContain('They discussed a cache race.');
    expect(md).not.toContain('Unanswered'); // threads with no answer are left out
  });
});
