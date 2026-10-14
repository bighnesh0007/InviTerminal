import { join } from 'node:path';
import { loadDotEnv } from './dotenv';

/**
 * Side-effect import: load a `.env` from the project root (or INVI_ENV_FILE) BEFORE
 * config.ts and the key store read `process.env`, so `GROQ_API_KEY` set there is picked
 * up without the OS keychain. Real environment variables still win. Imported first in
 * index.ts. Only variable NAMES are logged, never values.
 */
const envFile = process.env.INVI_ENV_FILE ?? join(process.cwd(), '.env');
const applied = loadDotEnv(envFile);
if (applied.length > 0) console.log(`[env] loaded ${applied.length} variable(s) from ${envFile}: ${applied.join(', ')}`);
