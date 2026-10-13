import { z } from 'zod';

// Every renderer → main terminal message is parsed with one of these at the boundary.

const SessionId = z.uuid();

export const SpawnRequest = z.object({ profileId: z.string().regex(/^[a-z0-9-]{1,64}$/).optional() }).strict();

/** 64 KiB per message: larger pastes arrive in chunks from the renderer. */
export const InputMessage = z.object({ sessionId: SessionId, data: z.string().max(65_536) }).strict();

export const ResizeMessage = z
  .object({
    sessionId: SessionId,
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(500),
  })
  .strict();

export const AckMessage = z.object({ sessionId: SessionId, chars: z.number().int().min(0).max(10_000_000) }).strict();

export const KillMessage = z.object({ sessionId: SessionId }).strict();

export const ClipboardWrite = z.object({ text: z.string().max(1_048_576) }).strict();
