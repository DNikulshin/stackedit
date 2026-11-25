# Ошибки и решения

## Сборка

**`npm ERR! sqlite3@4.0.9 install: node-pre-gyp install --fallback-to-build`**

Транзитивная зависимость `sqlite3` (из `indexeddbshim`) не имеет бинарника для Node 14 и не собирается.
Для веб-сборки не нужна → ставьте зависимости с `--ignore-scripts`, а нужные install-шаги выполните
вручную (см. [build.md](build.md), шаги 2–4). Скрипт `scripts/build-local.sh` делает это сам.

**`remote: Repository not found. fatal: repository 'https://github.com/paulrosen/MIDI.js.git/' not found`**

Репозиторий git-зависимости `midi` удалён. В этом форке URL уже исправлен. Если собираете апстрим:

```bash
sed -i.bak 's|paulrosen/MIDI.js|mudcube/MIDI.js|g' package-lock.json
```

**`Module build failed: Error: Missing binding .../node_sass.node` или `Node Sass does not yet support your current environment`**

Не скачался/не подошёл бинарник node-sass. Проверьте версию Node (`node -v` → должно быть `v14.x`) и
запустите:

```bash
node node_modules/node-sass/scripts/install.js
```

Если GitHub медленный: `SASS_BINARY_SITE=https://cdn.npmmirror.com/binaries/node-sass node node_modules/node-sass/scripts/install.js`.

**`error:0308010C:digital envelope routines::unsupported` / `ERR_OSSL_EVP_UNSUPPORTED`**

Запущен не тот Node (webpack 2 использует `md4`). Нужен Node 14, а не 18+. Проверьте `which node` —
`.toolchain` должен быть первым в `PATH`.

**`SyntaxError: Unexpected token 'export'` / `Cannot find module 'prismjs/prism.js'`**

Пропущен `gulp build-prism` (postinstall). Запустите `npx gulp build-prism`.

**`npm install` идёт часами / `ETIMEDOUT registry.npmjs.org`**

Плохой канал до реестра. Альтернатива:

```bash
npm config set registry https://registry.npmmirror.com
```
(после установки можно вернуть `https://registry.npmjs.org`). Скачивание самого Node — через
`cdn.npmmirror.com/binaries/node/`, это заложено в `scripts/build-local.sh`.

**`gyp: No Xcode or CLT version detected` (macOS)**

`xcode-select --install`. Для Node 14 на Apple Silicon (arm64) бинарник node-sass есть; если нет —
запустите сборку под Rosetta или используйте Linux/WSL.

## Запуск

**`Opening index.html over file:// won't work`** — это из вывода сборки. Так и есть: открывайте через
`node .` и `http://localhost:8080/app`, а не двойным щелчком по файлу.

**`Error: listen EADDRINUSE: address already in use :::8080`** — порт занят: `ss -ltnp | grep 8080`,
запуск с другим портом: `PORT=8081 node .`.

**Порт открыт, но `/app` отдаёт 404** — сервер запущен не из корня проекта (`dist/` не найден) или
`dist` не собран. `cd` в каталог с `package.json`, `npm run build`.

**Страница белая, в консоли 404 на `/static/js/*`** — сервер раздаёт не тот каталог (например, вы
положили файлы из `dist/` не в корень). Проверьте `curl -s -o /dev/null -w '%{http_code}' http://host/static/js/app.*.js`.

**Консоль: `GET /app/conf 404`** — нормально для статического хостинга без файла `conf`. Приложение
работает, облачные провайдеры просто отключены. Чтобы убрать ошибку, положите рядом с `index.html`
файл `conf` с содержимым `{"allowSponsorship":false}` (для схемы `/app/`) или отдайте `/conf` на сервере
(для схемы `/app`, как в оригинальном сервере).

## PWA и офлайн

**Статика: нет офлайна и не предлагается установка** — Service Worker не устанавливается, если при
установке не отдаются 200 URL `/app/` и `/oauth2/callback` (они в precache-списке). Готовый каталог
и проверку см. в [quickstart.md](quickstart.md); если готовили вручную:
`./scripts/prepare-static.sh && ./scripts/check-static.sh`.

**Нет кнопки «Установить приложение»** — только `https://` или `http://localhost`. По
`http://192.168.x.x` установка недоступна (см. [phone.md](phone.md), способ 2).

**Офлайн не работает после установки** — первая загрузка должна пройти полностью (Service Worker
активируется в фоне). DevTools → Application → Service Workers: статус должен быть `activated and
running`. На iOS PWA кешируется только при запуске с домашнего экрана.

**После обновления `dist/` видна старая версия** — Service Worker отдаёт кеш. DevTools → Application →
Service Workers → Update, либо «Clear storage» и перезагрузка. Пользователям ничего делать не нужно:
новая версия подхватится сама и приложение один раз перезагрузится.

**Данные пропали** — файлы лежат в IndexedDB браузера. Их удаляют: очистка «данных сайтов», режим
инкогнито, смена профиля, удаление PWA на iOS, разные адреса (`localhost` и `192.168.x.x` — разные
хранилища!). Экспорт: `Ctrl+S` → Import/Export.

## Docker

**`docker pull` падает с `net/http: timeout awaiting response headers`** — Docker Hub недоступен из РФ.
Берите базовый образ через зеркало:

```bash
docker build -f docker/Dockerfile -t stackedit-local \
  --build-arg BASE_IMAGE=mirror.gcr.io/library/debian:trixie-slim .
```

Проверено: `mirror.gcr.io` работает, `dockerhub.timeweb.cloud` отвечает, `docker.m.daocloud.io`
отвечает, но медленно. Подробности — в [self-host.md](self-host.md), раздел 4.

**`apt-get update` в `node:14-buster`: `does not have a Release file`** — Debian 10 переехал в
`archive.debian.org`. Не берите `node:14-*` как базовый образ: нужен актуальный Debian + Node 14
из тарбола (как в `docker/Dockerfile`).

**Контейнер падает: `Cannot find module 'express'`** — если вы использовали `npm prune --production`
или `npm install --production`: `express` в апстриме объявлен в `devDependencies`, хотя серверу
(`index.js`) нужен в рантайме. Перенесите его в `dependencies` перед установкой: так сделано в
`docker/Dockerfile` (315 МБ `node_modules` вместо 568 МБ с dev-набором).

**`docker: command not found`, хотя демон работает** (бывает, когда стоит только `dockerd`, а CLI — нет).
Клиент — один статический бинарник:

```bash
curl -fL -o /tmp/docker.tgz \
  https://mirrors.aliyun.com/docker-ce/linux/static/stable/x86_64/docker-29.7.2.tgz
tar xzf /tmp/docker.tgz docker/docker && install -m 755 docker/docker ~/.local/bin/docker
docker version    # клиент 29.7.2 + сервер 29.8.0 — проверено
```

Если сокет `/var/run/docker.sock` есть, а доступа нет: пользователь должен быть в группе `docker`.

## Провайдеры и экспорт

**Нет пунктов «Sync with GitHub», «Export to Google Drive»** — в `/conf` нет ключей: задайте
`GITHUB_CLIENT_ID` и остальные переменные на сервере (см. [self-host.md](self-host.md), раздел 3).

**Экспорт в PDF/docx/epub падает** — серверные обработчики `/pdfExport` и `/pandocExport` в
самостоятельной сборке не работают: они требуют бэкенда stackedit.io (проверка спонсорства через AWS).
Используйте `Export to styled HTML` → печать в PDF из браузера, либо соберите Pandoc локально:
`pandoc file.md -o file.docx`.

**OAuth-окно закрывается с ошибкой `redirect_uri_mismatch`** — в консоли провайдера колбэк должен быть
ровно `https://ваш-домен/oauth2/callback`.
