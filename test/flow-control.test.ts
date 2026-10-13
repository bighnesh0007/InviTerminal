import { describe, expect, it } from 'vitest';
import { FlowControl } from '../src/main/terminal/FlowControl';

function setup() {
  const calls: string[] = [];
  const fc = new FlowControl(() => calls.push('pause'), () => calls.push('resume'), 100, 10);
  return { fc, calls };
}

describe('FlowControl', () => {
  it('pauses once when in-flight output crosses the high watermark', () => {
    const { fc, calls } = setup();
    fc.sent(60);
    expect(calls).toEqual([]);
    fc.sent(60);
    fc.sent(60);
    expect(calls).toEqual(['pause']);
  });

  it('resumes only below the low watermark (hysteresis)', () => {
    const { fc, calls } = setup();
    fc.sent(150);
    fc.acked(100);
    expect(calls).toEqual(['pause']);
    fc.acked(45);
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('never goes negative on over-acknowledgement', () => {
    const { fc } = setup();
    fc.sent(5);
    fc.acked(1000);
    expect(fc.inFlight).toBe(0);
  });

  it('rejects inverted watermarks', () => {
    expect(() => new FlowControl(() => {}, () => {}, 10, 10)).toThrow();
  });
});
