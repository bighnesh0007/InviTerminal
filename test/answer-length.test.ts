import { describe, expect, it } from 'vitest';
import { ANSWER_LENGTHS, answerParams, answerSystem, askSystem, summarizeSystem } from '../src/shared/ai';

describe('answerParams', () => {
  it('caps tokens and tightens the instruction as length shrinks', () => {
    expect(answerParams('short').maxTokens).toBeLessThan(answerParams('medium').maxTokens);
    expect(answerParams('medium').maxTokens).toBeLessThan(answerParams('detailed').maxTokens);
    expect(answerParams('short').instruction).toMatch(/1.2|crisp|sentence/i);
  });
  it('covers every length', () => {
    for (const len of ANSWER_LENGTHS) {
      expect(answerParams(len).maxTokens).toBeGreaterThan(0);
      expect(answerParams(len).instruction.length).toBeGreaterThan(0);
    }
  });
});

describe('answerSystem', () => {
  it('embeds the length instruction in the system prompt', () => {
    expect(answerSystem('short')).toContain(answerParams('short').instruction);
    expect(answerSystem('short')).toMatch(/concise|directly/i);
  });
});

describe('askSystem', () => {
  it('summarize mode uses the summary prompt; answer mode the answer prompt', () => {
    expect(askSystem('summarize', 'medium')).toBe(summarizeSystem('medium'));
    expect(askSystem('answer', 'short')).toBe(answerSystem('short'));
    expect(summarizeSystem('detailed')).toMatch(/never invent/i);
    expect(summarizeSystem('detailed')).toMatch(/action items/i);
  });
});
