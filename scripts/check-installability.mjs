#!/usr/bin/env node
// Проверяет, что собранный каталог Chrome действительно считает устанавливаемым
// приложением (PWA), и печатает причины, если нет.
//
// Зачем: «установка приложения» в Chrome падает молча и с разными сообщениями, а
// разработчик видит только «не предлагается установить». Здесь те же проверки,
// что в DevTools → Application → Manifest, но через CDP
// (Page.getAppManifest + Page.getInstallabilityErrors).
//
// Отдельная частая путаница: «Файл манифеста отсутствует или недоступен для чтения»
// («Manifest file is missing or unreadable») — это ошибка chrome://extensions при
// загрузке распакованного РАСШИРЕНИЯ, а не про установку PWA. Такой сценарий здесь
// тоже проверяется ключом --as-extension.
//
// Использование:
//   node scripts/check-installability.mjs dist-static          # каталог: поднимет свой сервер
//   node scripts/check-installability.mjs http://localhost:8080/
//   node scripts/check-installability.mjs dist-static --as-extension   # что скажет chrome://extensions
//
// Требования: Node.js ≥ 22 (встроенный WebSocket), Chrome/Chromium, python3 (для каталога).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('Не найден Chrome. Задайте путь в переменной CHROME_BIN.');
  process.exit(2);
}

const args = process.argv.slice(2);
const asExtension = args.includes('--as-extension');
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('Укажите каталог сборки или URL.');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function spawnChrome(port, extra = []) {
  const child = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(process.env.TMPDIR || '/tmp', `cdp-stackedit-${process.pid}`)}`,
    ...extra,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return { child, getStderr: () => stderr };
}

async function connect(port) {
  let ws;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const { webSocketDebuggerUrl } = await res.json();
      ws = new WebSocket(webSocketDebuggerUrl);
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!ws) throw new Error('Chrome не поднялся за 30 секунд');
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return ws;
}

function rpc(ws, method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage);
        resolve(msg);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

let server;
let chrome;
let failed = false;

try {
  // --- chrome://extensions: загрузка каталога как распакованного расширения ---
  if (asExtension) {
    const dir = path.resolve(target);
    const port = await freePort();
    chrome = spawnChrome(port, ['--enable-unsafe-extension-debugging']);
    const ws = await connect(port);
    const res = await rpc(ws, 'Extensions.loadUnpacked', { path: dir });
    ws.close();
    console.log(`Каталог: ${dir}`);
    if (res.error) {
      console.log(`chrome://extensions → «Загрузить распакованное расширение»: ${res.error.message}`);
      console.log('(в русской локали Chrome это «Файл манифеста отсутствует или недоступен для чтения»)');
    } else {
      console.log(`Расширение загрузилось: ${res.result.id}`);
    }
  } else {
    // --- установка как приложение (PWA) ---
    let url = target;
    let dir;
    if (!/^https?:\/\//.test(target)) {
      dir = path.resolve(target);
      const port = await freePort();
      server = spawn('python3', ['-m', 'http.server', String(port), '--directory', dir], {
        stdio: 'ignore',
      });
      await sleep(1200);
      url = `http://localhost:${port}/`;
      console.log(`Каталог: ${dir}  →  ${url}`);
    }

    const port = await freePort();
    chrome = spawnChrome(port);
    const ws = await connect(port);
    const { result: { targetId } } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
    await rpc(ws, 'Page.enable', {}, sessionId);
    await rpc(ws, 'Page.navigate', { url }, sessionId);
    await sleep(7000);

    const manifest = (await rpc(ws, 'Page.getAppManifest', {}, sessionId)).result || {};
    const install = (await rpc(ws, 'Page.getInstallabilityErrors', {}, sessionId)).result || {};
    const errors = install.installabilityErrors || [];

    console.log(`Манифест: ${manifest.url || 'не найден'}`);
    if (manifest.errors && manifest.errors.length) {
      console.log(`Ошибки разбора манифеста: ${JSON.stringify(manifest.errors)}`);
    }
    if (errors.length === 0) {
      console.log('Установка как приложения: Chrome ошибок не видит — можно ставить.');
    } else {
      failed = true;
      console.log('Chrome не считает страницу устанавливаемой. Причины:');
      for (const e of errors) {
        const argsText = (e.errorArguments || []).map((a) => `${a.name}=${a.value}`).join(', ');
        console.log(`  - ${e.errorId}${argsText ? ` (${argsText})` : ''}`);
      }
      console.log('\nЧастые причины: манифест отдаётся не с того адреса (404), нет иконок 192/512,');
      console.log('нет start_url, display не standalone, нет Service Worker, страница не на https/localhost.');
    }
    ws.close();
  }
} finally {
  if (chrome) chrome.child.kill('SIGKILL');
  if (server) server.kill('SIGKILL');
}

process.exit(failed ? 1 : 0);
