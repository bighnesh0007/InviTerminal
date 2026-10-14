import { describe, expect, it } from 'vitest';
import { interviewerSystem } from '../src/main/ai/practice';

describe('interviewerSystem', () => {
  it('embeds the topic and instructs one question at a time with feedback', () => {
    const s = interviewerSystem('system design');
    expect(s).toContain('system design');
    expect(s).toMatch(/ONE question at a time/i);
    expect(s).toMatch(/feedback/i);
    expect(s).toMatch(/practice/i);
  });
  it('carries the topic verbatim (used to steer the interview)', () => {
    expect(interviewerSystem('Rust ownership & lifetimes')).toContain('Rust ownership & lifetimes');
  });
});
