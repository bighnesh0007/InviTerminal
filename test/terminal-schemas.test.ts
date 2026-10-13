import { describe, expect, it } from 'vitest';
import { AckMessage, InputMessage, ResizeMessage, SpawnRequest } from '../src/main/terminal/schemas';

const id = '0b8f6d1e-6f0a-4c1e-9f5e-3a2b1c0d9e8f';

describe('terminal IPC schemas', () => {
  it('accepts well-formed messages', () => {
    expect(InputMessage.parse({ sessionId: id, data: 'ls\r' })).toBeTruthy();
    expect(ResizeMessage.parse({ sessionId: id, cols: 120, rows: 40 })).toBeTruthy();
    expect(AckMessage.parse({ sessionId: id, chars: 5000 })).toBeTruthy();
    expect(SpawnRequest.parse({})).toEqual({});
    expect(SpawnRequest.parse({ profileId: 'bash-2' })).toEqual({ profileId: 'bash-2' });
  });

  it('refuses a path or command where a profile id belongs', () => {
    for (const p of ['/bin/bash', 'bash -c "rm -rf ~"', '../x', 'BASH', '']) expect(SpawnRequest.safeParse({ profileId: p }).success).toBe(false);
  });

  it('refuses extra fields (no smuggling file/args alongside a profile id)', () => {
    expect(SpawnRequest.safeParse({ profileId: 'bash', file: '/bin/sh' }).success).toBe(false);
    expect(InputMessage.safeParse({ sessionId: id, data: 'x', raw: true }).success).toBe(false);
  });

  it('bounds sizes and ids', () => {
    expect(InputMessage.safeParse({ sessionId: id, data: 'x'.repeat(65_537) }).success).toBe(false);
    expect(InputMessage.safeParse({ sessionId: 'not-a-uuid', data: 'x' }).success).toBe(false);
    expect(ResizeMessage.safeParse({ sessionId: id, cols: 0, rows: 24 }).success).toBe(false);
    expect(ResizeMessage.safeParse({ sessionId: id, cols: 80.5, rows: 24 }).success).toBe(false);
    expect(AckMessage.safeParse({ sessionId: id, chars: -1 }).success).toBe(false);
  });
});
