#!/usr/bin/env node
// Скачивает @sqlite.org/sqlite-wasm в prototype/sqlite-opfs/public/vendor/sqlite-wasm.
// Vendor-файлы не коммитятся: это 1.5 МБ сторонних артефактов.

import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3.54.1-build1';
const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const out = resolve(here, 'public/vendor/sqlite-wasm');
const tmp = resolve(here, '.vendor-tmp');
const tgz = resolve(tmp, 'sqlite-wasm.tgz');

await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
await mkdir(out, { recursive: true });

const url = `https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-${VERSION}.tgz`;
console.log(`Скачиваю ${url}`);
// curl, а не fetch: на медленном канале undici отваливается по таймауту тела ответа.
execFileSync('curl', ['-sSL', '--max-time', '180', '-o', tgz, url], { stdio: 'inherit' });

execFileSync('tar', ['xzf', tgz, '-C', tmp]);
for (const file of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) {
  execFileSync('cp', [resolve(tmp, 'package/dist', file), resolve(out, file)]);
}
await rm(tmp, { recursive: true, force: true });
console.log(`Готово: ${out} (sqlite-wasm ${VERSION})`);
console.log('Запуск стенда: node prototype/sqlite-opfs/server.mjs');
