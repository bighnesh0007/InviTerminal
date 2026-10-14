// Bundles main, preload and renderer separately: each runs in a different
// context (Node, sandboxed preload, browser), so they cannot share one config.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const common = { bundle: true, sourcemap: 'linked', logLevel: 'info', target: 'es2023' };

await rm('dist', { recursive: true, force: true });
await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron', 'node-pty', 'mongodb-memory-server-core', 'mongoose', 'groq-sdk', 'ws', 'selfsigned', 'qrcode'] }),
  // Sandboxed preloads cannot require() local files, so it must be one self-contained file.
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife' }),
]);
await mkdir('dist/renderer', { recursive: true });
await cp('src/renderer/index.html', 'dist/renderer/index.html');
await cp('src/renderer/styles.css', 'dist/renderer/styles.css');
await cp('node_modules/@xterm/xterm/css/xterm.css', 'dist/renderer/xterm.css');
await cp('assets', 'dist/assets', { recursive: true });
