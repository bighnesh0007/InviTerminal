import type { Connection, Model, Schema, Types } from 'mongoose';

/**
 * Mongoose is loaded on first connect, not at startup: `inviterminal --toggle`
 * starts a second process that only hands its flag over, and parsing the
 * driver there doubled the hotkey latency (measured ~190 → ~400 ms).
 */
type MongooseModule = typeof import('mongoose');
let mongooseModule: Promise<MongooseModule> | null = null;
const loadMongoose = (): Promise<MongooseModule> => (mongooseModule ??= import('mongoose'));
import { LANGUAGES, rankSnippets, type Language, type SearchQuery, type Snippet, type SnippetInput } from '../../shared/snippet';
import { escapeRegex, normalizeFolder, normalizeTags } from './normalize';

export interface SnippetDoc {
  _id: Types.ObjectId;
  title: string;
  body: string;
  description: string;
  language: Language;
  tags: string[];
  folder: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  useCount: number;
  deletedAt: Date | null;
}

export const LIMITS = { title: 200, body: 262_144, description: 2000 } as const;

/** Built once, after Mongoose has loaded. Exported for tests of the schema itself. */
let schemaCache: Schema<SnippetDoc> | null = null;
export async function buildSnippetSchema(): Promise<Schema<SnippetDoc>> {
  if (schemaCache) return schemaCache;
  const { Schema } = await loadMongoose();
  const snippetSchema = new Schema<SnippetDoc>(
    {
      title: { type: String, required: true, trim: true, minlength: 1, maxlength: LIMITS.title },
      body: { type: String, required: true, maxlength: LIMITS.body },
      description: { type: String, default: '', maxlength: LIMITS.description },
      language: { type: String, enum: LANGUAGES, default: 'bash' },
      tags: { type: [String], default: [] },
      folder: { type: String, default: '' },
      lastUsedAt: { type: Date, default: null },
      useCount: { type: Number, default: 0, min: 0 },
      deletedAt: { type: Date, default: null },
    },
    {
      timestamps: true,
      // Unknown fields are an error, not silently dropped or stored.
      strict: 'throw',
      // Indexes are created explicitly in connect(), only after the URI passed validation.
      autoIndex: false,
      autoCreate: false,
    },
  );
  snippetSchema.index({ deletedAt: 1, updatedAt: -1 });
  snippetSchema.index({ folder: 1 });
  snippetSchema.index({ tags: 1 });
  schemaCache = snippetSchema;
  return snippetSchema;
}

const SEARCH_LIMIT = 500;

function toDto(d: SnippetDoc): Snippet {
  return {
    id: d._id.toHexString(),
    title: d.title,
    body: d.body,
    description: d.description,
    language: d.language,
    tags: d.tags,
    folder: d.folder,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    lastUsedAt: d.lastUsedAt ? d.lastUsedAt.toISOString() : null,
    useCount: d.useCount,
    deletedAt: d.deletedAt ? d.deletedAt.toISOString() : null,
  };
}

function objectId(m: MongooseModule, id: string): Types.ObjectId {
  if (!m.Types.ObjectId.isValid(id) || !/^[0-9a-f]{24}$/.test(id)) throw new Error('Invalid snippet id.');
  return new m.Types.ObjectId(id);
}

/**
 * Snippet persistence on MongoDB. The connection is private to this store
 * (mongoose.createConnection, not the global default), so nothing else in
 * the process can end up writing through it.
 */
export class LibraryStore {
  private constructor(
    private readonly m: MongooseModule,
    private readonly conn: Connection,
    private readonly Snippets: Model<SnippetDoc>,
  ) {}

  static async connect(uri: string, opts: { serverSelectionTimeoutMS?: number } = {}): Promise<LibraryStore> {
    const m = await loadMongoose();
    const conn = m.default.createConnection(uri, { serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 2000, autoIndex: false, autoCreate: false });
    await conn.asPromise();
    const model = conn.model<SnippetDoc>('Snippet', await buildSnippetSchema(), 'snippets');
    await model.createCollection();
    await model.createIndexes();
    return new LibraryStore(m, conn, model);
  }

  async close(): Promise<void> {
    await this.conn.close();
  }

  async search(query: SearchQuery = {}): Promise<Snippet[]> {
    const filter: Record<string, unknown> = { deletedAt: query.deleted ? { $ne: null } : null };
    if (query.folder !== undefined && query.folder !== '') {
      const f = normalizeFolder(query.folder);
      filter.folder = { $regex: `^${escapeRegex(f)}(/|$)` };
    }
    if (query.tag) filter.tags = normalizeTags([query.tag])[0];
    const q = query.q?.trim();
    if (q) {
      const re = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ title: re }, { tags: re }, { folder: re }, { description: re }, { body: re }];
    }
    const docs = await this.Snippets.find(filter).sort({ updatedAt: -1 }).limit(SEARCH_LIMIT).lean<SnippetDoc[]>();
    return rankSnippets(docs.map(toDto), q);
  }

  async get(id: string): Promise<Snippet | null> {
    const d = await this.Snippets.findById(objectId(this.m, id)).lean<SnippetDoc>();
    return d ? toDto(d) : null;
  }

  /** Fields are picked one by one — the input object is never spread into the model. */
  async create(input: SnippetInput): Promise<Snippet> {
    const doc = await this.Snippets.create({
      title: input.title,
      body: input.body,
      description: input.description ?? '',
      language: input.language ?? 'bash',
      tags: normalizeTags(input.tags ?? []),
      folder: normalizeFolder(input.folder ?? ''),
    });
    return toDto(doc.toObject());
  }

  async update(id: string, patch: Partial<SnippetInput>): Promise<Snippet> {
    const set: Partial<Record<keyof SnippetDoc, unknown>> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.language !== undefined) set.language = patch.language;
    if (patch.tags !== undefined) set.tags = normalizeTags(patch.tags);
    if (patch.folder !== undefined) set.folder = normalizeFolder(patch.folder);
    const d = await this.Snippets.findOneAndUpdate({ _id: objectId(this.m, id), deletedAt: null }, { $set: set }, { new: true, runValidators: true }).lean<SnippetDoc>();
    if (!d) throw new Error('Snippet not found.');
    return toDto(d);
  }

  /** Moves to trash; restore() undoes it. Nothing in the app hard-deletes. */
  async trash(id: string): Promise<Snippet> {
    const d = await this.Snippets.findOneAndUpdate({ _id: objectId(this.m, id), deletedAt: null }, { $set: { deletedAt: new Date() } }, { new: true, timestamps: false }).lean<SnippetDoc>();
    if (!d) throw new Error('Snippet not found.');
    return toDto(d);
  }

  async restore(id: string): Promise<Snippet> {
    const d = await this.Snippets.findOneAndUpdate({ _id: objectId(this.m, id), deletedAt: { $ne: null } }, { $set: { deletedAt: null } }, { new: true, timestamps: false }).lean<SnippetDoc>();
    if (!d) throw new Error('Snippet not found in trash.');
    return toDto(d);
  }

  /** Bumps usage for ranking; does not count as an edit (updatedAt unchanged). */
  async recordUse(id: string): Promise<void> {
    await this.Snippets.updateOne({ _id: objectId(this.m, id), deletedAt: null }, { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } }, { timestamps: false });
  }

  async folders(): Promise<string[]> {
    const all = (await this.Snippets.distinct('folder', { deletedAt: null })) as string[];
    // Include parents, so "deploy/k8s" also lists "deploy".
    const set = new Set<string>();
    for (const f of all) {
      const parts = f.split('/');
      for (let i = 1; i <= parts.length; i++) if (parts[0]) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort();
  }

  async tags(): Promise<string[]> {
    return ((await this.Snippets.distinct('tags', { deletedAt: null })) as string[]).sort();
  }
}
