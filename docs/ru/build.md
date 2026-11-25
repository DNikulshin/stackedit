# Сборка StackEdit из исходников

Проверено: Linux x64, Node.js 14.21.3 (npm 6.14.18), 4 ядра, ~10 минут от чистого клона до готового
`dist/`. Ниже — что именно происходит и почему каждое действие обязательно.

## 0. Клонирование

```bash
git clone https://github.com/DNikulshin/stackedit.git
cd stackedit
```

Апстрим (`https://github.com/benweet/stackedit`) собирается так же, но там придётся вручную поправить
`package-lock.json` — см. шаг 2.

## 1. Node.js именно 14.x

Проект от 2023 года: webpack 2, node-sass 4, babel 6. На современных Node он не собирается принципиально:

| Что ломается | Почему |
| --- | --- |
| `node-sass@4` | Нет бинарников для Node ≥ 16, а сборка из исходников требует Python 2 |
| `webpack@2` | Использует хеш `md4`, удалённый из OpenSSL 3 (Node ≥ 17) — ошибка `error:0308010C` |
| старые `node-gyp`/`nan` | Не знают новые ABI Node |

Системный Node не трогаем — ставим отдельный тулчейн:

```bash
# вариант А (то, что делает scripts/build-local.sh)
curl -fL -o /tmp/node14.tar.xz https://cdn.npmmirror.com/binaries/node/v14.21.3/node-v14.21.3-linux-x64.tar.xz
mkdir -p .toolchain && tar -xf /tmp/node14.tar.xz -C .toolchain
export PATH="$PWD/.toolchain/node-v14.21.3-linux-x64/bin:$PATH"
node -v   # v14.21.3

# вариант Б — nvm
nvm install 14.21.3 && nvm use 14.21.3
```

macOS: тот же архив, но `darwin-x64` / `darwin-arm64`. Официальный сайт `nodejs.org/dist/v14.21.3/`
из РФ часто отдаёт ~1 КБ/с; зеркало `cdn.npmmirror.com/binaries/node/` — 5–7 МБ/с.

## 2. `npm install` с `--ignore-scripts`

```bash
npm install --ignore-scripts --no-audit --no-fund
```

Два подводных камня, из-за которых обычный `npm install` падает:

1. **git-зависимость `midi`** (её требует `abcjs` — рендер нотных записей). В апстриме она указывает на
   `https://github.com/paulrosen/MIDI.js.git#abcjs`, а этот репозиторий удалён. Ошибка выглядит так:

   ```
   npm error /usr/bin/git ls-remote -h -t https://github.com/paulrosen/MIDI.js.git
   remote: Repository not found.
   ```

   В этом форке URL уже переставлен на живой оригинал `mudcube/MIDI.js` с тем же коммитом
   `e593ffef81a0350f99448e3ab8111957145ff6b2`. Если собираете апстрим — поправьте сами:

   ```bash
   sed -i.bak 's|paulrosen/MIDI.js|mudcube/MIDI.js|g' package-lock.json
   ```

2. **`sqlite3@4.0.9`** приходит транзитивно (`indexeddbshim` → `websql`) и в install-скрипте пытается
   скачать/собрать нативный модуль под Node 14 — готового бинарника нет, компиляция падает:

   ```
   npm ERR! sqlite3@4.0.9 install: `node-pre-gyp install --fallback-to-build`
   npm ERR! Exit status 1
   ```

   Для веб-сборки `sqlite3` не нужен вообще (это путь для Node-side IndexedDB), поэтому
   `--ignore-scripts` пропускает его сборку. Остальные install-скрипты нам нужны — их запустим руками
   на шагах 3–4.

## 3. Бинарник node-sass

`--ignore-scripts` не дал `node-sass` скачать бинарник, поэтому:

```bash
cd node_modules/node-sass && node scripts/install.js && cd ../..
# → Binary saved to .../node_modules/node-sass/vendor/linux-x64-83/binding.node
```

Если GitHub отдаёт медленно, укажите зеркало:

```bash
SASS_BINARY_SITE=https://cdn.npmmirror.com/binaries/node-sass \
  node node_modules/node-sass/scripts/install.js
```

Без этого шага сборка упадёт с `Missing binding ... node_sass.node` / `Module build failed: Error: Node Sass does not yet support your current environment`.

## 4. Postinstall: подсветка кода

В `package.json` есть `postinstall: gulp build-prism`, который склеивает `prism.js` из компонентов Prism.
`--ignore-scripts` его пропустил — запускаем вручную:

```bash
npx gulp build-prism
```

## 5. Сборка

```bash
npm run build
```

Это `node build/build.js` (webpack, продакшн, минификация) + `webpack --config build/webpack.style.conf.js`
(отдельный проход по SCSS). На 4 ядрах — около 1 мин 45 с. Успех выглядит так:

```
Build complete.
Tip: built files are meant to be served over an HTTP server.
     Opening index.html over file:// won't work.
```

Результат в `dist/` (≈29 МБ, карты исходников включены — `productionSourceMap: true` в `config/index.js`):

| Файл | Что это |
| --- | --- |
| `index.html` | точка входа приложения (открывается по адресу `/app`) |
| `static/js/*.js` | бандлы: `manifest`, `vendor`, `app` |
| `static/css/*.css`, `style.css` | стили |
| `sw.js` | Service Worker (офлайн-кэш, автообновление) |
| `manifest.*.json`, `icon_*.png`, `icons-*/` | PWA-манифест и иконки |
| `appcache/` | устаревший AppCache-манифест, можно игнорировать |

## 6. Проверка сборки

```bash
node .            # сервер на 8080 (порт меняется через PORT=…)
```

- <http://localhost:8080/app> — редактор;
- <http://localhost:8080/> — посадочная страница апстрима (не ваша сборка, просто статика);
- <http://localhost:8080/conf> — JSON с публичными ключами провайдеров; в самостоятельной сборке это
  `{"allowSponsorship":false}`.

Что должно быть видно: приветственный файл, живой предпросмотр справа, панель форматирования сверху.
Горячие клавиши: `Ctrl+S` — панель синхронизации/экспорта, `Ctrl+Shift+F` — поиск, `F9` — файловый
менеджер.

Проверка офлайна: откройте `/app`, обновите страницу, затем в DevTools → Network поставьте «Offline» и
обновите ещё раз — приложение должно открыться из Service Worker.

## Весь процесс одной командой

```bash
./scripts/build-local.sh          # или с полной очисткой:
./scripts/build-local.sh --clean
```

Скрипт делает шаги 1–5: скачивает Node 14 в `.toolchain/`, ставит зависимости, бинарник node-sass,
`build-prism` и продакшн-сборку.

## Режим разработки

```bash
npm start         # dev-server с hot reload, http://localhost:8080/app
```

Первая компиляция — около 40 с, дальше горячая перезагрузка. Порт задаётся в `config/index.js` (`dev.port`).

## Windows

Родной `cmd`/PowerShell не подойдёт для ветки `scripts/*` (используется bash-логика, node-sass 4 и
симлинки). Рабочие варианты:

- **WSL2 (Ubuntu)**: `sudo apt install build-essential git python3`, дальше всё по этой инструкции.
- **Git Bash / MSYS2** — работает для `npm install` и `npm run build`, но `scripts/build-local.sh`
  скачает не тот архив (нужен `win-x64.zip`). Проще WSL.

Собранный `dist/` переносимый: его можно собрать на Linux и раздать на любой хост — см.
[docs/ru/pc.md](pc.md) и [docs/ru/self-host.md](self-host.md).
