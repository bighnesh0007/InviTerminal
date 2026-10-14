import { z } from 'zod';
import { LANGUAGES } from '../../shared/snippet';
import { LIMITS } from './LibraryStore';

// Renderer → main library messages, parsed at the boundary. .strict() refuses extra keys.

export const SnippetId = z.string().regex(/^[0-9a-f]{24}$/);

const Tags = z.array(z.string().max(80)).max(40);
const Folder = z.string().max(400);

export const SnippetInputSchema = z
  .object({
    title: z.string().trim().min(1).max(LIMITS.title),
    body: z.string().min(1).max(LIMITS.body),
    description: z.string().max(LIMITS.description).optional(),
    language: z.enum(LANGUAGES).optional(),
    tags: Tags.optional(),
    folder: Folder.optional(),
  })
  .strict();

export const SnippetPatchSchema = SnippetInputSchema.partial().strict();

export const UpdateRequest = z.object({ id: SnippetId, patch: SnippetPatchSchema }).strict();

export const IdRequest = z.object({ id: SnippetId }).strict();

export const SearchRequest = z
  .object({
    q: z.string().max(200).optional(),
    folder: Folder.optional(),
    tag: z.string().max(80).optional(),
    deleted: z.boolean().optional(),
  })
  .strict();
