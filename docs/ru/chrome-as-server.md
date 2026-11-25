# Chrome как клиентский сервер: что работает в 2026

Разбор тезисов из обзора «Продвинутые технологии использования Chrome в качестве клиентского
сервера»: что подтверждается первичными источниками, что устарело или сформулировано неточно,
чего в обзоре не хватает — и что из этого применимо к StackEdit.

Проверка: ноябрь 2026. Пять независимых проходов по первоисточникам (sqlite.org, MDN и
browser-compat-data, chromestatus, release notes Chrome/Firefox, WebKit blog, WICG-спеки, RFC).
Текущая стабильная ветка Chrome на дату проверки — 159 (по данным Chromium Dash).

Обозначения:

- ✅ — подтверждено первичным источником (ссылка рядом);
- ⚠️ — верно с существенной оговоркой;
- ✖ — опровергнуто;
- ❓ — первичного подтверждения не нашлось; в тексте такие места не подаются как факт.

## Короткий ответ

1. Браузер **не может** открыть входящий TCP/UDP-порт так, как это делает сервер. Единственное
   исключение — Direct Sockets API, и он доступен **только внутри Isolated Web App** (подписанный
   Web Bundle, отдельная установка, Chrome 131+). Для обычного сайта на GitHub Pages этого пути нет.
2. «Сервер в вкладке» реально собирается из трёх частей: Service Worker (роутинг запросов),
   воркер с хранилищем (SQLite Wasm + OPFS) и Web Locks/BroadcastChannel для согласования вкладок.
   Всё это работает, но живёт ровно столько, сколько живёт вкладка/воркер.
3. Данные в OPFS/IndexedDB **не защищены от удаления**: по умолчанию это best-effort хранилище,
   которое браузер вытесняет по LRU, а пользователь удаляет одной кнопкой. `navigator.storage.persist()`
   защищает только от вытеснения браузером и выдаётся по эвристике (Chrome), промптом (Firefox) или
   эвристикой Home Screen Web App (Safari).
4. SharedWorker в 2026 — уже не «десктопная фича»: Chrome для Android получил его в 148 (май 2026),
   Safari — в 16 (2022). Статус фичи — newly available, widely available ожидается 2028.
5. WebRTC «в обход внешних серверов» — только после сигналлинга, и на практике большинство соединений
   идёт через NAT-hairpin или TURN. Host-кандидаты в Chrome обфусцированы mDNS и резолвятся только
   внутри одной подсети без client isolation.
6. WebGPU пригоден как «локальный инференс внутри страницы» для моделей 1–4B на десктопном
   Chromium/Safari. Как замена серверному Ollama он не годится: нет общего GPU-пула, воркер убивается,
   кэш весов вытесняется, Firefox на Linux и Android не поддерживается.

## Где исходный обзор прав

Механика описана верно и подтверждается источниками:

- WebContainers требуют `SharedArrayBuffer`, а значит cross-origin isolation через
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
  (допустим и `credentialless` при `coep: 'credentialless'` в `WebContainer.boot`)
  — [webcontainers.io/guides/quickstart](https://webcontainers.io/guides/quickstart),
  [MDN crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated).
- Проксирование портов через Service Worker и виртуальная ФС — заявленная механика WebContainer
  (`server-ready` → iframe).
- SQLite-Wasm поверх OPFS с синхронным доступом только в Dedicated Worker
  (`FileSystemSyncAccessHandle`) — [sqlite.org/wasm/doc/trunk/persistence.md](https://sqlite.org/wasm/doc/trunk/persistence.md).
- Роутинг API в `sw.js` через `FetchEvent.respondWith` — рабочий приём; сам приём описан в обзоре
  корректно.
- SharedWorker/BroadcastChannel как межвкладочная шина — верно по сути (уточнения по версиям ниже).
- WebRTC DataChannel как способ передать данные между браузерами — верно; неточна только фраза
  «в обход внешних серверов» (см. § 5).

## Что неточно

| Утверждение обзора | Как на самом деле | Статус |
| :--- | :--- | :--- |
| WebContainers — «полноценная ОС», «ядро, эмулирующее syscalls» | Документация позиционирует продукт как браузерный рантайм для Node.js-приложений и «operating system commands». Слов «Wasm-ядро», «эмуляция syscalls», «полноценная ОС» в проверенных страницах документации нет | ⚠️ формулировка вендорского маркетинга, не подтверждена |
| В WebContainers не запускаются нативные бинарники (pandoc, xelatex, python) | Вывод логичен (это Node.js-совместимый рантайм, а не Linux), но **прямого утверждения в проверенных первичных источниках нет** — пост StackBlitz, где это обсуждалось, отдаёт 404. В документации API нет и списка поддерживаемых бинарников | ❓ не подтверждено; практический вывод для PDF-экспорта см. § 9 |
| OPFS/SQLite «защищены от случайного удаления пользователем» | ✖ По умолчанию — best-effort; браузер вытесняет данные origin'а целиком по LRU; пользователь удаляет их через «очистить данные сайта»; инкогнито удаляет при закрытии; Safari вытесняет после 7 дней без взаимодействия | ✖ опровергнуто |
| SharedWorker «не поддерживается в некоторых мобильных браузерах» | Формально верно, но вводит в заблуждение: iOS Safari — с 16.0 (2022), Firefox Android — с 33, Chrome Android — только с **148 (2026-05-05)**; нет в Samsung Internet. Статус — newly available, widely available ожидается 2028-11-05 | ⚠️ устаревшая формулировка |
| WebRTC: «прямое UDP-соединение в обход внешних серверов» | Сигналлинг обязателен по определению; host-кандидаты в Chrome обфусцированы mDNS (`.local`) и работают только в одной подсети; в тесте IETF через NAT шло 94% соединений при mDNS на одной стороне и 97% — при mDNS на обеих | ⚠️ верно лишь частично |
| Лицензия WebContainer API | Коммерческая лицензия нужна для продакшена; прототипы/POC — нет; «always free for Open Source» — лозунг без юридических границ; публичных цен нет, только «contact sales» | ⚠️ верно по странице `/enterprise`; цен и текста лицензии в открытом доступе нет |
| COOP/COEP на GitHub Pages | Задать нельзя: GitHub подтвердил в обсуждении, что кастомные заголовки не поддерживаются; `coi-serviceworker` даёт только `crossOriginIsolated`, но не сетевые сокеты | ✅ |

## 1. WebContainers: Node.js в вкладке, а не ОС

Что подтверждается: один инстанс на страницу (`boot()` можно вызвать один раз), ФС через `fs` и
`mount()`, процессы через `spawn('npm', ['install'])`, превью — по событию `server-ready` в iframe.
В гайде есть и требование HTTPS в продакшене (localhost — исключение) — раздел «Before you deploy».
Источник: [webcontainers.io/guides/quickstart](https://webcontainers.io/guides/quickstart).

Цена:

- лицензия требуется для коммерческого продакшена, POC — без лицензии
  ([webcontainers.io/enterprise](https://webcontainers.io/enterprise));
- публичных цен нет — только запрос в sales; конкретные цифры в статьях не выдумывать;
- «always free for Open Source» — маркетинговый тезис без юридических границ.

Практическое следствие для статического хостинга: WebContainers требуют COOP/COEP, а GitHub Pages
эти заголовки задать не даёт. Обходной путь `coi-serviceworker` добавляет изоляцию через Service
Worker, но не даёт ни входящих сокетов, ни Direct Sockets.

✅ Подтверждено, что «просто задеплоить на Pages» с WebContainers не получится: нужен хостинг с
управляемыми заголовками (Cloudflare/Netlify/Vercel/свой nginx).

## 2. Service Worker как API-роутер

### Что гарантирует API

- `FetchEvent.respondWith()` принимает `Response` или промис на него; иначе запрос получает сетевую
  ошибку. Бросает `NetworkError`/`InvalidStateError` в описанных спекой случаях
  ([MDN respondWith](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith)).
- У Service Worker нет DOM; он может быть остановлен браузером в любой момент, поэтому асинхронную
  работу нужно «пинить» через `event.waitUntil(...)`
  ([web.dev: service worker lifecycle](https://web.dev/articles/service-worker-lifecycle)).
- **Service Worker не перехватывает свои собственные запросы** (⚠️ это вывод, отдельной цитаты под
  него нет). Косвенное подтверждение — в алгоритме `cache.addAll`: для запросов, чей клиент —
  `ServiceWorkerGlobalScope`, принудительно ставится `service-workers mode = "none"`
  ([Service Workers Nightly, § 5.4.4](https://w3c.github.io/ServiceWorker/#cache-addAll)); иначе любая
  `cache.addAll` рекурсивно попадала бы в свой же `fetch`-обработчик.
- Область действия по умолчанию — `./` относительно URL скрипта; расширяется только заголовком
  `Service-Worker-Allowed`; регистрация требует secure context (HTTPS или localhost).

### Стриминг: что можно утверждать

Тело `Response` по спеке — `BodyInit`, куда входит `ReadableStream`, то есть `respondWith(new
Response(stream))` синтаксически законен. Практическую поддержку SSE и потоковых ответов из Service
Worker в конкретных браузерах в этом прогоне проверить не удалось (❓). Для статьи/внедрения это
значит: «по спеке возможно, на своём стенде проверьте отдельно» — и не выдавать за гарантию.

### Cache API: почему падала установка Service Worker

Контракт `cache.addAll()` задан спекой и он **атомарный** (MDN даёт сокращённую выжимку — схема и
не-2xx):

- `TypeError`, если схема URL не `http`/`https`, метод не `GET`;
- `TypeError`, если статус любого ответа не ok или равен `206`;
- `TypeError`, если в ответе `Vary: *`;
- при одной ошибке в массиве откатывается вся операция, и `install` не завершается — значит воркер
  не активируется вовсе
  ([Service Workers Nightly § 5.4.4](https://w3c.github.io/ServiceWorker/#cache-addAll),
  [MDN Cache.addAll](https://developer.mozilla.org/en-US/docs/Web/API/Cache/addAll)).

Отдельная ловушка — редиректы, и здесь частая формулировка «301 ломает `addAll`» неверна: в спеке про
редиректы в `addAll` ничего нет, запрос уходит с `redirect mode: follow`, и цепочка 301 → 200 даёт
обычный ok-ответ, который в кэш кладётся (с пометкой `redirected`). Ломается precache двумя другими
способами:

1. если `Location` уводит на другой хост или порт (за реверс-прокси порт теряется), fetch внутри
   `addAll` завершается сетевой ошибкой — и отклоняется вся пачка, то есть установка воркера;
2. даже успешно закэшированный ответ, пришедший через редирект, браузер не отдаёт на навигацию;
   поэтому `start_url` и precache не должны опираться на редиректящий URL.

Именно поэтому `offline-plugin` (он собирает `sw.js` в этом проекте) пересобирает `Response` из тела,
отбрасывая признак редиректа. В собранном `dist/sw.js` это функции `a()` и `c()`:

```javascript
function a(e){return !e||!e.redirected||!e.ok||"opaqueredirect"===e.type}
function c(e){return a(e)?Promise.resolve(e):("body"in e?Promise.resolve(e.body):e.blob())
  .then(function(n){return new Response(n,{headers:e.headers,status:e.status})})}
```

Практический вывод, проверенный на этом проекте: в precache должны попадать только URL, отдающиеся
напрямую (200), без редиректов. В StackEdit из списка пришлось убрать `<base>app` (сервер отвечает на
него 301, а за реверс-прокси `Location` может потерять порт — тогда precache умирает сетевой
ошибкой), заменить его на `<base>app/` и добавить `<base>oauth2/callback` и сам `<base>`
(`scripts/prepare-static.sh`, шаг 3).

## 3. SQLite Wasm + OPFS: локальная СУБД

### Что это официально

- Подпроект `sqlite3 WASM/JS` — «first effort officially associated with the SQLite project»
  ([about.md](https://sqlite.org/wasm/doc/trunk/about.md));
  артефакт лежит на [sqlite.org/download.html](https://sqlite.org/download.html)
  (на дату проверки — 3.54.1).
- npm-пакет `@sqlite.org/sqlite-wasm` — версия 3.54.1-build1, лицензия Apache-2.0; ядро SQLite —
  public domain. В документации есть внутреннее противоречие: `npm.md` называет пакет
  «community-maintained», `news.md` — «official». Для статьи честная формулировка: «публикуется под
  эгидой проекта, мейнтейнеры — Thomas Steiner и Stephan Beal».

### Варианты персистентности — это разные компромиссы, а не опции

| VFS | Требует COOP/COEP | Кто использует | Ограничение |
| :--- | :--- | :--- | :--- |
| `kvvfs` | нет | main thread | localStorage/sessionStorage, порядка 5 МБ (ориентир, точный лимит задаёт браузер) |
| `opfs` | **да** (`SharedArrayBuffer`) | только Worker | нужна изоляция origin |
| `opfs-wl` (3.53+) | да | Worker, Web Locks | нужен `Atomics.waitAsync()` |
| `opfs-sahpool` | **нет** | Worker | нет многопоточной конкуренции, самый быстрый |
| `WASMFS` | — | кастомная сборка | не поддерживается официально |

Источник: [persistence.md](https://sqlite.org/wasm/doc/trunk/persistence.md).

`opfs-sahpool` — единственный вариант, который официально рекомендуется тем, «кто ценит
производительность выше конкурентности или не может задать COOP/COEP», то есть ровно для GitHub Pages.

### `FileSystemSyncAccessHandle`

- Только Dedicated Worker, только для файлов внутри OPFS, только в secure context.
- Версии: Chrome/Edge 102, Chrome Android 109, Firefox 111, Safari 15.2
  ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemFileHandle.json)).
- Блокировка: по умолчанию один хэндл на файл; второй вызов даёт `NoModificationAllowedError`.
  С Chrome 121 есть `mode: "readwrite-unsafe"` (несколько писателей), но Firefox и Safari этот режим
  не поддерживают.
- Следствие для SQLite: по документации второй таб, открывший ту же БД, получает ошибку блокировки;
  для конкурентности нужны Web Locks (`opfs-wl`) или обработка `SQLITE_BUSY` с ретраями
  (`sqlite3_js_retry_busy()`, 3.53+). На стенде прототипа (`prototype/sqlite-opfs`) два воркера из
  разных вкладок в Chrome 150 открыли один файл и писали параллельно без ошибок, но один прогон дал
  зависание запроса больше 10 с. То есть поведение недетерминированное и полагаться на него нельзя:
  нужен один владелец БД на origin (см. ниже).

### ACID и durability — не одно и то же

Целостность транзакций обеспечивает сам SQLite. **Durability при отключении питания в браузере не
документирована**: единственная документированная точка сброса на диск — `FileSystemSyncAccessHandle.flush()`
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle/flush)),
а как на неё отображаются `PRAGMA synchronous` и журнал — в документации sqlite.org не описано (❓).
Формулировка для документации проекта: «транзакции атомарны, сохранность при пропадании питания —
на усмотрение браузера и ОС».

Известные особенности, о которых стоит знать до внедрения:

- до 3.54 в `opfs-sahpool` была ошибка блокировок, которая при двух подключениях в одном треде могла
  повредить БД; исправлено в 3.54;
- `opfs-sahpool` по умолчанию **стирает** своё хранилище, если инициализация VFS провалилась;
  с 3.54 это отключается флагом `preserveOnInitFailure`;
- WAL на OPFS возможен в актуальных версиях (3.47+), но требует `PRAGMA locking_mode=exclusive`
  и убивает конкурентность;
- импортировать готовую БД в WAL-режиме нельзя — в WASM нет shared-memory API.

### Долговечность хранения: разбор тезиса «защищено от удаления»

✖ Тезис опровергнут.

- По умолчанию — best-effort; persistent — только через `navigator.storage.persist()`.
- Вытеснение идёт по LRU **на весь origin**; persistent-origin'ы пропускаются
  ([MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
- Квоты: Chromium — до 60% диска на origin (суммарно браузер ~80%); Firefox — min(10% диска, 10 GiB),
  persistent до 50%; Safari 17+ — 60% для браузера, 15% для прочих WebKit-приложений
  ([WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)).
- `persist()`: Chrome/Edge решают **автоматически, без промпта** (по engagement, установке, закладкам);
  Firefox показывает промпт; Safari — по эвристике, например «сайт открыт как Home Screen Web App».
  «Требуется установка PWA» — это эвристика, а не жёсткое условие.
- Safari вытесняет проактивно: если у origin'а не было клика/тапа 7 дней, скриптовые данные удаляются.
- Инкогнито и «очистить данные сайта» удаляют всё независимо от `persist()`.

Storage Buckets (Chrome 122+, в Firefox и Safari нет) дают гранулярность: несколько bucket'ов, которые
браузер может вытеснять по отдельности, плюс `durability: 'strict'` (про риск потери при отключении
питания, а не про защиту от пользователя)
([chromestatus 5739224579964928](https://chromestatus.com/feature/5739224579964928)).

## 4. SharedWorker и BroadcastChannel

### SharedWorker

| Браузер | С версии |
| :--- | :--- |
| Chrome desktop | 5 |
| Chrome for Android | **148** (2026-05-05) |
| Firefox / Firefox Android | 29 / 33 |
| Safari / iOS | 16 / 16 |
| Samsung Internet | нет (в текущих версиях: Chromium-база старее 148; BCD зеркалит Chrome Android, то есть появится по мере обновления) |

Источники: [BCD SharedWorker](https://github.com/mdn/browser-compat-data/blob/main/api/SharedWorker.json),
[web-features: shared-workers](https://web-platform-dx.github.io/web-features-explorer/features/shared-workers/),
[caniuse](https://caniuse.com/sharedworkers).

Chrome 148 — это **повторное включение**, а не первое появление. Release notes дословно:

> For a long time, SharedWorker has been disabled on Android due to concerns about its unpredictable
> process lifecycle. SharedWorker instances might terminate unexpectedly, without notifying users or
> web developers.

Практический вывод: на Android воркер могут убить молча. Состояние, живущее только в SharedWorker,
не должно быть единственным источником истины — нужна персистентная копия (IndexedDB/OPFS).

Прочее:

- `type: 'module'` — Chrome 80, Firefox 114, Safari 15;
- `name` — не поддерживается в Safari;
- `extendedLifetime` — только Chrome 148 (experimental);
- lifetime: воркер живёт, пока на него ссылается хоть один документ; «может пережить навигацию» —
  не гарантия контракта. С `extendedLifetime: true` (Chrome 148, experimental) воркер живёт
  ограниченное время и после закрытия последней ссылки — на это опираться тоже нельзя;
- отладка: `chrome://inspect/#workers` / `about:debugging#workers`.

Точная формулировка вместо обзорной: «SharedWorker поддерживают все актуальные десктопные браузеры,
мобильные Safari и Firefox; в Chrome для Android — только с 148 (май 2026), в Samsung Internet нет».

### BroadcastChannel

Chrome 54, Firefox 38, Safari 15.4; Baseline widely available с марта 2022. Ограничения по существу:

- только same-origin; сообщение получают все живые объекты канала, **кроме отправителя**;
- structured clone: функции и DOM-узлы не передаются;
- хранения нет: вкладка, закрытая в момент отправки, сообщение не получит — нужен handshake и
  полная синхронизация состояния при подключении;
- остановленный Service Worker сообщением не разбудить (❓ прямого утверждения в спеке не найдено,
  но это следует из модели «доставка живым объектам»; подавать как предостережение, а не как цитату).

Отличие от `MessageChannel`: 1:1 адресный канал с передачей `MessagePort` (может пересекать границу
origin), тогда как BroadcastChannel — 1:N по имени в пределах origin.

## 5. WebRTC DataChannels

Что подтверждается и что нет:

- **Сигналлинг обязателен.** MDN: «WebRTC can't create connections without some sort of server in the
  middle» — но это не обязательно HTTP-сервер: offer/answer можно передать QR-кодом или руками.
- **STUN нужен, TURN часто тоже.** Типы кандидатов: `host`, `srflx` (через STUN), `prflx`, `relay` (TURN).
- **Host-кандидаты обфусцируются.** В Chrome адрес заменяется на `<uuid>.local`, который резолвится
  mDNS только внутри локальной сети
  ([draft-ietf-mmusic-mdns-ice-candidates-03](https://www.ietf.org/archive/id/draft-ietf-mmusic-mdns-ice-candidates-03.txt);
  черновик истёк, это не RFC).
- **Цифры из того же черновика:** там сравнили mDNS на обеих сторонах против mDNS на одной стороне —
  доля соединений, ушедших через NAT, выросла с 94% до 97% (общий success rate просел примерно на 2%
  в относительных величинах). То есть mDNS срабатывал примерно в половине локальных случаев,
  остальное уходило в hairpin или TURN; напрямую соединялись единицы процентов пар.
- **Одна Wi-Fi сеть — не гарантия:** в гостевых и корпоративных сетях часто включён client/AP isolation
  или порезан multicast, и mDNS-имена не резолвятся; тогда ICE уходит в NAT-hairpin (домашние роутеры
  поддерживают его не всегда) или в TURN.

Лимиты DataChannel:

- размер сообщения по умолчанию — 64 КиБ (`a=max-message-size`, [RFC 8841 §6.1](https://www.rfc-editor.org/rfc/rfc8841.txt));
  браузеры обычно принимают ≥256 КиБ ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels));
- без interleaving рекомендуется ограничивать сообщение 16 КБ, иначе одно большое сообщение занимает
  всю ассоциацию ([RFC 8831 §6.6](https://datatracker.ietf.org/doc/html/rfc8831));
- backpressure — по `bufferedAmount` и событию `bufferedamountlow`; размер буфера не настраивается;
- `send()` бросает `OperationError`, если данных не влезает в буфер, и `TypeError`, если сообщение
  слишком велико для получателя.

Важное изменение 2026 года: с **Chrome 147** WebSocket-подключения к локальным адресам гейтятся
разрешением Local Network Access (см. § 7). WebRTC под это требование пока не подпадает — но это
временное преимущество, направление регуляторики обратное.

## 6. WebGPU: локальный инференс внутри страницы

Матрица на ноябрь 2026:

| Платформа | Статус |
| :--- | :--- |
| Chrome/Edge, Win/macOS/ChromeOS | 113+ |
| Chrome Android | 121+ (узкий список GPU; Imagination — 139+, Android 16+) |
| Chrome Linux | 144+ только Intel Gen12+; NVIDIA — 147+ и Wayland; остальное — за флагами |
| Safari (macOS/iOS/iPadOS/visionOS) | 26+; MDN считает поддержку полной, caniuse — частичной (разница в том, что считается: наличие API или полнота покрытия) |
| Firefox | Windows 141, Apple Silicon macOS 145/147; **Linux и Android — нет**, Intel Mac — нет |

- WebGPU **не требует** cross-origin isolation — только secure context. Изоляция нужна для
  многопоточного WASM (`numThreads > 1` в onnxruntime-web).
- В Service Worker WebGPU доступен: Chrome 124+, Firefox 148+ (Bugzilla 1942431, milestone 148 —
  MDN/browser-compat-data по этому пункту отстаёт и до сих пор пишет «except service workers»).
  Про Safari подтверждения нет (❓).
- Дефолтные лимиты малы: 256 МиБ на буфер, 128 МиБ на storage-binding
  ([MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits)).
- Оценки VRAM (данные WebLLM): Llama-3.2-1B q4f16 — ~0,88 ГБ; Phi-3.5-mini (3.8B) q4f16 — ~3,6 ГБ;
  8B q4f16 — ~4,9 ГБ.
- Скорость: единственные проверяемые цифры — из статьи WebLLM на MacBook Pro M3 Max: 41,1 tok/s для
  8B и 71,1 tok/s для 3.8B при нативном 57,7/89,3 (то есть до 80% нативной производительности).
  Для интегрированной графики публичных замеров нет.
- Кэш весов: по умолчанию Cache API, есть IndexedDB и OPFS; вытесняется целиком по origin (в Safari —
  через 7 дней без клика), после чего модель скачивается заново.

Вердикт: это «локальный инференс как фича страницы», а не «локальный Ollama». Работает для
суммаризации/ASR/эмбеддингов на моделях 1–4B в q4 на десктопном Chromium или Safari; не работает как
фоновый сервер для других приложений, на Linux-Firefox и на мобильных с моделями 3B+.

## 7. Чего в обзоре не было: как всё-таки открыть входящий порт

### Direct Sockets в Isolated Web App — единственный настоящий «сервер»

- `TCPSocket`, `TCPServerSocket` (входящие соединения как `ReadableStream`; `backlog` — в IDL спеки и
  explainer, в гайде Chrome не описан),
  `UDPSocket` в режимах connected и bound, multicast
  ([developer.chrome.com/docs/iwa/direct-sockets](https://developer.chrome.com/docs/iwa/direct-sockets),
  [WICG explainer](https://github.com/WICG/direct-sockets/blob/main/docs/explainer.md)).
- Chrome 131 — базовый API (release notes 131), Chrome 138 — отладка трафика в панели Network,
  Chrome 144 — multicast (release notes 144).
- В манифесте нужно явно объявить `"direct-sockets": ["self"]` и `"cross-origin-isolated"`;
  без этого конструкторы падают с `NotAllowedError`. Для multicast — `direct-sockets-multicast`
  (ключ `direct-sockets-private`, встречающийся в примере Chrome, в спеке не описан).
- IWA — это подписанный Web Bundle (`.swbn`, Ed25519/ECDSA P-256), origin вида
  `isolated-app://<bundle-id>/`, платформа сама ставит COOP/COEP/CORP и строгий CSP.
- Установка: enterprise-политики (`IsolatedWebAppInstallForceList`) или dev-mode через
  `chrome://web-app-internals`. С Chrome 143 на ChromeOS установка/обновление через Admin Panel
  возможна только для приложений из allowlist Google; критерий — «use case не достижим существующими
  открытыми веб-API» ([allowlist](https://developer.chrome.com/docs/iwa/allowlist)).
- В других браузерах реализации нет.
- Политика IWA прямо запрещает «интерпретатор + привилегированная сеть»: нельзя скачивать и исполнять
  внешний код (Python/Lua в WASM) с доступом к Direct Sockets, нельзя сканировать локальную сеть.

То есть «браузер как сервер» технически возможен — но только как отдельно устанавливаемое
enterprise-приложение, а не как сайт.

### Local Network Access

- Chrome 138 — опт-ин тест под флагом; Chrome 142 — промпт «Look for and connect to any device on
  your local network» для запросов с публичного сайта на локальные/loopback-адреса; Chrome 145 —
  единое разрешение разделено на `local-network` и `loopback-network`; Chrome 147 — под это попали
  WebSocket и WebTransport
  ([blog](https://developer.chrome.com/blog/local-network-access), [142](https://developer.chrome.com/release-notes/142),
  [145](https://developer.chrome.com/release-notes/145), [147](https://developer.chrome.com/release-notes/147)).
- Последствия для сценария «сайт на GitHub Pages стучится в `http://localhost:8080`»: с Chrome 142
  это промпт у каждого посетителя, а из Service Worker запрос пройдёт только если origin уже получил
  разрешение.
- Edge: `LocalNetworkAccessRestrictionsEnabled` объявлена obsolete после 144, управление сместилось на
  per-URL политики `LocalNetworkBlockedForUrls` / `LoopbackNetworkBlockedForUrls`
  ([Microsoft Edge docs](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/localnetworkaccessrestrictionsenabled)).

### Native Messaging

Работает только из расширения (не из веб-страницы), требует установленного хост-манифеста в системе
(реестр Windows / фиксированные каталоги на macOS и Linux) и разрешения `nativeMessaging`; лимиты
1 МБ от хоста и 64 МиБ к хосту. Это «сервер рядом с браузером», а не «сервер в браузере».

### WASI, Pyodide, MicroPython

- Pyodide: `threading`, `multiprocessing`, `sockets` импортируются, но не работают; все сетевые вызовы
  идут через браузерный `fetch` с CORS и теми же ограничениями
  ([wasm-constraints](https://pyodide.org/en/stable/usage/wasm-constraints.html)).
- WASI-сокеты существуют как proposal (Phase 3), но это host-API для Wasmtime-подобных рантаймов;
  браузер не является WASI-хостом с сетевыми capability.
- MicroPython в Wasm общается с сетью через JS-мост; слушающих сокетов нет.

### Умершее и обходное

- `chrome.sockets.*` (Chrome Apps): платформа deprecated с 2020, Chrome Apps EOL для управляемых сред —
  октябрь 2028 ([developer.chrome.com/docs/apps](https://developer.chrome.com/docs/apps)). Историческая
  сноска; Direct Sockets вырос именно из этого.
- `registerProtocolHandler`: регистрирует обработчик схемы, `http`/`https` зарегистрировать нельзя —
  это не сервер.
- WebTransport/Web Push: только исходящие соединения или доставка через push-сервис.

## 8. Сводная таблица (исправленная)

| Технология | Что заменяет | Где живёт | Реальные ограничения 2026 |
| :--- | :--- | :--- | :--- |
| Direct Sockets + IWA | TCP/UDP-сервер | Chrome, только IWA | подписанный бандл, allowlist, enterprise-установка, Chrome-only |
| Service Worker | nginx/Express (роутинг) | worker | нет DOM, убивается браузером, HTTPS, атомарный precache |
| SQLite Wasm + OPFS | SQLite/Postgres | Dedicated Worker | эксклюзивная блокировка файла, COOP/COEP для `opfs`, недокументированный durability |
| SharedWorker | демон/координатор | shared worker | Chrome Android 148+, Samsung Internet нет, убивается молча |
| BroadcastChannel | pub/sub шина | окна и воркеры | same-origin, без хранения, SW сообщением не разбудить (❓) |
| WebGPU + WebLLM | Ollama (частично) | окно/воркер, GPU | нет Linux-Firefox и Android-Firefox, лимиты буферов, вытеснение кэша |
| WebRTC DataChannel | P2P-транспорт | сетевой стек | сигналлинг, STUN/TURN, mDNS и client isolation |
| WebContainers | Node.js-рантайм | Wasm + воркер | COOP/COEP, один инстанс, коммерческая лицензия |

## 9. Что применимо к StackEdit

Проверено по коду проекта (ветка `master`, коммит `bd2d3617`).

### Приложение уже работает как PWA без локального сервера

Статическая раздача (`scripts/prepare-static.sh`) + `sw.js` + манифест дают установку и офлайн без
Node на машине пользователя. Ни одна из «серверных» технологий для этого не нужна — они решают другие
задачи, и добавлять их «для солидности» не стоит.

### Service Worker уже есть, и его ограничения уже видны

- `sw.js` собирает `offline-plugin` 5.0.5 (`build/webpack.prod.conf.js`), конфиг попадает в `__wpo`.
- Precache правится в `scripts/prepare-static.sh`: пути переводятся на `<base>`, добавляются
  `<base>`, `<base>app/`, `<base>oauth2/callback`, а `<base>app` **удаляется**: этот URL отдаётся
  редиректом, который за реверс-прокси теряет порт (precache умирает сетевой ошибкой), а вдобавок сам
  redirect-ответ не годится для офлайн-старта.
- Роутов «внутри SW» в проекте нет: `/conf` и `/oauth2/callback` — либо реальные маршруты сервера
  (`server/index.js`), либо файлы, которые создаёт `prepare-static.sh`. Перевести их на SW-роутинг
  технически можно, но выигрыш невелик: `conf` нужен приложению
  (`src/services/networkSvc.js` запрашивает `conf`), а SW не управляет первым визитом — до активации
  запрос всё равно уйдёт в сеть. Плюс появляется риск для сценария «первый запуск офлайн».

### Хранилище: IndexedDB, а не SQLite

- `src/services/localDbSvc.js` открывает нативный IndexedDB (`indexedDB.open(dbName, 1)`, store
  `objects`), в `src/index.js` подключён `indexeddbshim` — для окружений без IndexedDB.
- SQLite-Wasm + OPFS — возможная замена, но не бесплатная: нужен Dedicated Worker, эксклюзивный доступ
  к файлу, `navigator.storage.persist()` и честный UI про то, что данные могут исчезнуть. Для
  key-value документов StackEdit выигрыша не даёт; смысл появляется, если понадобятся SQL-запросы по
  истории документов.

### Проверено прототипом (`prototype/sqlite-opfs`)

Стенд с SQLite-Wasm 3.54.1 в Chrome 150 (см. `prototype/sqlite-opfs/README.md`) дал такие факты:

- SQLite поверх OPFS работает: БД открывается за 31–77 мс, 1000 строк одной транзакцией — 113–162 мс,
  `PRAGMA integrity_check` — `ok`.
- `navigator.storage.persist()` в Dedicated Worker отсутствует (в окне есть) — разрешение должен
  запрашивать оконный контекст.
- **SharedWorker не может владеть OPFS-БД**: `crossOriginIsolated = false`, `SharedArrayBuffer` нет,
  `createSyncAccessHandle` бросает `SecurityError`. Плюс две ловушки: top-level await в module
  SharedWorker и статический импорт `sqlite3.wasm` не дают выполниться `onconnect` вообще.
- «Воркер на вкладку» для одной БД — недетерминированный отказ: два воркера открывают один файл,
  обычно пишут без ошибок, но один прогон дал зависание запроса больше 10 с.
- Рабочая схема — **один владелец на origin**: Web Locks выбирают вкладку-лидера, она держит воркер
  с БД, остальные ходят через BroadcastChannel. В прогоне: 20 100 строк из двух вкладок, потерь нет,
  `integrity_check` = `ok`; после закрытия лидера вторая вкладка заняла его за 194 мс.

Вывод для StackEdit не изменился: это не «замена `indexedDB.open` на `OpfsDb`», а отдельный сервис
с выбором лидера. Пока нет задачи с настоящими SQL-запросами, менять хранилище нечего.

### BroadcastChannel и SharedWorker не используются вообще

`grep` по `src/` и `index.js` не находит ни `BroadcastChannel`, ни `SharedWorker` (проверено
выборочно, не исчерпывающим обходом); единственный воркер — `worker-loader` для
`src/services/templateWorker.js` (экспорт через `src/services/exportSvc.js`).

Реалистичный сценарий, если понадобится: BroadcastChannel как сигнальная шина «документ изменён в
другой вкладке» + перечитывание состояния из IndexedDB. SharedWorker — только когда появится реальная
разделяемая работа (пул соединений, фоновая синхронизация), и с персистентной копией состояния.

### WebContainers и WebGPU не решают задачу PDF-экспорта

PDF в проекте делает серверный `server/pandoc.js`: он `spawn`-ит нативный `pandoc` с
`--pdf-engine=xelatex` и `-o <файл>.pdf` (для docx/epub/odt/rtf — те же нативные форматы pandoc).
То есть в цепочке два нативных бинаря: pandoc и xelatex. Ни WebContainers (Node.js-рантайм без
гарантий запуска нативных Linux-бинарников), ни WebGPU (инференс, а не вёрстка) этот путь не
заменяют. Если когда-нибудь понадобится PDF без сервера, реалистичный вариант — отрисовка раскладки
на клиенте или `print()`-диалог браузера, а не «pandoc в Wasm».

### WebRTC и Direct Sockets — не про StackEdit

Синхронизация в StackEdit идёт через внешние сервисы (GitHub, GitLab, Gist, Google Drive, Dropbox,
WordPress и др.), а не «ПК ↔ телефон в одной сети». Direct Sockets требует IWA, чего для публичного
PWA-приложения с GitHub Pages сделать нельзя. Если когда-нибудь появится «локальная синхронизация без
облака», порядок выбора: WebSocket-релей (просто, но LNA-промпт) → WebRTC DataChannel с QR-обменом SDP
(без сервера, но нужен TURN-фолбэк) → и только потом Direct Sockets.

## 10. Источники

Первичные, по разделам:

- WebContainers: [introduction](https://webcontainers.io/guides/introduction),
  [quickstart](https://webcontainers.io/guides/quickstart),
  [configuring headers](https://webcontainers.io/guides/configuring-headers),
  [enterprise](https://webcontainers.io/enterprise).
- Service Worker: [MDN respondWith](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith),
  [MDN Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers),
  [MDN Cache.addAll](https://developer.mozilla.org/en-US/docs/Web/API/Cache/addAll),
  [web.dev lifecycle](https://web.dev/articles/service-worker-lifecycle),
  [Service Workers Nightly](https://w3c.github.io/ServiceWorker/).
- Хранилище: [sqlite.org WASM/JS persistence](https://sqlite.org/wasm/doc/trunk/persistence.md),
  [cookbook](https://sqlite.org/wasm/doc/trunk/cookbook.md),
  [MDN Storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria),
  [web.dev persistent storage](https://web.dev/articles/persistent-storage),
  [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/),
  [MDN FileSystemSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle).
- Воркеры и сеть: [BCD SharedWorker](https://github.com/mdn/browser-compat-data/blob/main/api/SharedWorker.json),
  [Chrome 148 release notes](https://developer.chrome.com/release-notes/148),
  [MDN BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel),
  [MDN WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity),
  [draft-ietf-mmusic-mdns-ice-candidates-03](https://www.ietf.org/archive/id/draft-ietf-mmusic-mdns-ice-candidates-03.txt),
  [RFC 8831](https://datatracker.ietf.org/doc/html/rfc8831),
  [RFC 8841](https://www.rfc-editor.org/rfc/rfc8841.txt).
- GPU: [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status),
  [Chrome 124 (WebGPU в воркерах)](https://developer.chrome.com/blog/new-in-webgpu-124),
  [Архив статьи WebLLM (arXiv:2412.15803v2)](https://arxiv.org/html/2412.15803v2),
  [WebLLM models](https://webllm.mlc.ai/models/).
- Входящий порт: [Direct Sockets](https://developer.chrome.com/docs/iwa/direct-sockets),
  [IWA allowlist](https://developer.chrome.com/docs/iwa/allowlist),
  [IWA developer policy](https://developer.chrome.com/docs/iwa/developer-policy),
  [Local Network Access](https://developer.chrome.com/blog/local-network-access),
  [Chrome 142](https://developer.chrome.com/release-notes/142),
  [Chrome 145](https://developer.chrome.com/release-notes/145),
  [Chrome 147](https://developer.chrome.com/release-notes/147),
  [github/community#13309](https://github.com/orgs/community/discussions/13309),
  [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
  [Pyodide wasm-constraints](https://pyodide.org/en/stable/usage/wasm-constraints.html).

Что осталось непроверенным (и не должно попадать в документацию как факт):

- список бинарников, которые WebContainers заведомо не запускает (первичного документа нет);
- потоковые ответы (SSE/`ReadableStream`) из Service Worker — поддержка в конкретных браузерах;
- поведение Safari при WebGPU в Service Worker;
- детали durability SQLite-Wasm при отключении питания;
- точный триггер раскрытия локальных IP в ICE у Chrome (`chrome://webrtc-internals`).
