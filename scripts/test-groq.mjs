#!/usr/bin/env node
// Standalone end-to-end check of the Groq integration, independent of the Electron app.
// Reads GROQ_API_KEY from the environment or ./.env, lists models, and runs one tiny
// streamed completion with the default model. Run: node scripts/test-groq.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env read (same precedence as the app: real env wins).
function keyFromDotEnv() {
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.replace(/^export\s+/, '').match(/^GROQ_API_KEY\s*=\s*(.*)$/);
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return undefined;
}

const DEFAULT_MODEL = 'llama-3.1-8b-instant';
const key = process.env.GROQ_API_KEY?.trim() || keyFromDotEnv();

if (!key) {
  console.error('❌ No GROQ_API_KEY found.\n   Put it in a .env file at the project root:\n     GROQ_API_KEY=gsk_your_key_here\n   (copy .env.example to .env), then re-run.');
  process.exit(1);
}
console.log(`🔑 Key found (${key.slice(0, 6)}…${key.slice(-4)}), ${key.startsWith('gsk_') ? 'looks like a Groq key' : 'does NOT start with gsk_ — is this a Groq key?'}`);

const { default: Groq } = await import('groq-sdk');
const client = new Groq({ apiKey: key });

try {
  const list = await client.models.list();
  const ids = (list.data ?? []).map((m) => m.id);
  console.log(`📋 ${ids.length} models available. Default "${DEFAULT_MODEL}" present: ${ids.includes(DEFAULT_MODEL) ? '✅ yes' : '❌ NO — it may be deprecated'}`);
  if (!ids.includes(DEFAULT_MODEL)) console.log('   Available ids:', ids.join(', '));

  process.stdout.write(`💬 Completion with ${DEFAULT_MODEL}: `);
  const stream = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: InviTerminal Groq test OK' }],
    max_tokens: 32,
    stream: true,
  });
  let out = '';
  for await (const chunk of stream) {
    const d = chunk.choices[0]?.delta?.content;
    if (d) { out += d; process.stdout.write(d); }
  }
  console.log(`\n✅ Groq works end-to-end.${out.includes('OK') ? '' : ' (unexpected text, but the call succeeded)'}`);
} catch (e) {
  const status = e?.status;
  const map = { 401: 'key rejected (401) — wrong or inactive key', 403: 'not authorised (403)', 404: 'model not found (404) — deprecated model', 429: 'rate limited (429) — free-tier limit, wait and retry' };
  console.error(`\n❌ Groq call failed: ${map[status] ?? (e?.message ?? e)}`);
  process.exit(1);
}
