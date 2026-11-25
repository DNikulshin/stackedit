#!/usr/bin/env node
// Стенд для прототипа SQLite-Wasm + OPFS.
//
// Зачем свой сервер: VFS `opfs` в sqlite-wasm требует cross-origin isolation,
// то есть заголовки COOP/COEP. python -m http.server их не ставит.
//
// Запуск: node prototype/sqlite-opfs/server.mjs [порт]
// Открыть: http://localhost:8791/

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  // COOP/COEP: без них нет crossOriginIsolated, нет SharedArrayBuffer,
  // а значит VFS `opfs` не поднимется (opfs-sahpool поднялся бы).
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = normalize(join(ROOT, rel));

  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`Стенд: http://localhost:${PORT}/  (COOP/COEP включены)`);
});
