import { describe, expect, it } from 'vitest';
import { judge } from '../src/shared/selftest-verdict';

describe('judge', () => {
  it('passes only when the control is seen and the protected canary is not', () => {
    expect(judge(false, true).verdict).toBe('pass');
  });
  it('fails whenever the protected canary is seen, control or not', () => {
    expect(judge(true, true).verdict).toBe('fail');
    expect(judge(true, false).verdict).toBe('fail');
  });
  it('is inconclusive when the control is missing — never a pass', () => {
    expect(judge(false, false).verdict).toBe('inconclusive');
  });
});
