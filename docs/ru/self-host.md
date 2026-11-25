# Свой сервер: HTTPS-адрес для ПК и телефона

Цель: получить `https://md.example.com/app`, с которого работают установка PWA и офлайн. Дальше — три
сценария, от простого к полному.

## 1. Только статика (nginx, без Node на сервере)

Сервер собирает `dist/` на своей машине, на VPS уезжают лишь файлы.

```bash
npm run build
rsync -av --delete dist/ user@vps:/var/www/stackedit/
```

`/etc/nginx/sites-available/stackedit`:

```nginx
server {
    listen 80;
    server_name md.example.com;

    root /var/www/stackedit;
    index index.html;

    # Приложение живёт по /app (как и в оригинальном сервере StackEdit)
    location = /app {
        try_files /index.html =404;
    }

    # Публичные ключи провайдеров. Пустой объект = без облачных провайдеров.
    location = /conf {
        default_type application/json;
        return 200 '{"allowSponsorship":false}';
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/stackedit /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d md.example.com     # сертификат Let's Encrypt
```

Проверка: `https://md.example.com/app` открывается, `https://md.example.com/sw.js` отдаёт JS,
`https://md.example.com/manifest.c9128ce574e7548a3b0d3bcd8bfa212c.json` — JSON.

Чего в этом варианте нет: эндпоинтов `/oauth2/githubToken`, `/pdfExport`, `/pandocExport` — то есть
GitHub-синхронизации и PDF-экспорта. Всё остальное (редактор, файлы, офлайн, установка как приложение)
работает.

## 2. Node-сервер из репозитория (Caddy + systemd)

Нужен, если хотите GitHub OAuth и посадочную страницу апстрима.

На сервере: Node 14 (см. [build.md](build.md), шаг 1 — `scripts/build-local.sh` делает всё сразу),
затем сборка.

```bash
git clone https://github.com/DNikulshin/stackedit.git /opt/stackedit
cd /opt/stackedit && ./scripts/build-local.sh
```

`/etc/systemd/system/stackedit.service`:

```ini
[Unit]
Description=StackEdit
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/stackedit
Environment=PORT=8080
Environment=NODE_ENV=production
# ключи провайдеров — см. ниже
# Environment=GITHUB_CLIENT_ID=...
# Environment=GITHUB_CLIENT_SECRET=...
ExecStart=/opt/stackedit/.toolchain/node-v14.21.3-linux-x64/bin/node .
Restart=on-failure
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now stackedit
curl -s http://127.0.0.1:8080/conf; echo
```

Caddy (`/etc/caddy/Caddyfile`) сам получит сертификат:

```
md.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
systemctl reload caddy
```

Без Caddy — nginx с `proxy_pass http://127.0.0.1:8080;` и `certbot`.

## 3. GitHub OAuth: синхронизация с репозиториями

Провайдеры в StackEdit работают на OAuth. Публичные ключи отдаются фронтенду через `/conf`, а
`client_secret` остаётся на сервере и используется в `/oauth2/githubToken`.

1. <https://github.com/settings/developers> → **New OAuth App**.
2. Заполнить:
   - *Application name*: StackEdit (self-hosted)
   - *Homepage URL*: `https://md.example.com`
   - *Authorization callback URL*: `https://md.example.com/oauth2/callback`
     (путь зашит в приложении: `${origin}/oauth2/callback`)
3. Полученные `Client ID` и `Client secret` прописать в юните:

```ini
Environment=GITHUB_CLIENT_ID=Iv1.xxxxxxxx
Environment=GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxx
```

4. `systemctl restart stackedit`, обновить страницу, `curl -s https://md.example.com/conf` — должен
   появиться `githubClientId`.
5. В приложении: `Ctrl+S` → «Sync with GitHub» / «Publish with GitHub». Токен хранится в браузере, не
   на сервере.

Аналогично для остальных провайдеров (переменные из `server/conf.js`):

| Провайдер | Переменные | Колбэк |
| --- | --- | --- |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `/oauth2/callback` |
| Google Drive | `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` | `/oauth2/callback` |
| Dropbox | `DROPBOX_APP_KEY`, `DROPBOX_APP_KEY_FULL` | `/oauth2/callback` |
| WordPress | `WORDPRESS_CLIENT_ID` | `/oauth2/callback` |

GitLab, Gist (через GitHub-токен), CouchDB, Blogger/Zendesk — см. `src/services/providers/`; часть из
них требует только валидного GitHub-токена с нужными scope.

Проверить у себя, что OAuth реально проходит, можно только создав приложение в консоли провайдера —
в рамках подготовки этой сборки ключи не заводились.

## 4. Docker

Самодостаточный образ (в апстриме `Dockerfile` тянет `benweet/stackedit-base` с Docker Hub, где лежит
старый тулчейн; здесь Node 14 ставится явно). Файл — `docker/Dockerfile`:

```bash
docker build -f docker/Dockerfile -t stackedit-local .
docker run -d --name stackedit -p 8080:8080 \
  -e PORT=8080 stackedit-local
```

Дальше — Caddy/nginx перед ним, как в разделе 2. Сборка образа требует доступа к npm-реестру и GitHub
(бинарник node-sass). В рамках этой документации образ не проверялся: на машине сборки нет Docker.

## 5. Домашний сервер + туннель (без VPS и белого IP)

Если своего домена/VPS нет, а сервер живёт дома:

- **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:8080`) — бесплатный HTTPS-адрес
  без проброса портов. Учтите: Cloudflare в РФ работает нестабильно (замедление/блокировки), проверьте
  доступность со своего мобильного оператора до того, как ставить на телефон.
- **Tailscale Funnel / ngrok** — аналогично, HTTPS-адрес наружу; Funnel требует установленного клиента
  Tailscale на телефоне (это уже VPN-схема, зато адрес стабильный).
- **Свой VPS за рубежом + домен** — самый предсказуемый вариант; см. разделы 1–3.

Ограничение любого туннеля: адрес живёт, пока жив процесс туннеля. Установленная PWA продолжит
работать офлайн из кеша, но синхронизация/обновления потребуют доступного сервера.

## 6. Что проверить после развёртывания

```bash
curl -s -o /dev/null -w 'app %{http_code}\n'   https://md.example.com/app
curl -s -o /dev/null -w 'sw  %{http_code}\n'   https://md.example.com/sw.js
curl -s https://md.example.com/conf; echo
```

Ожидаемо: `200`, `200`, JSON с ключами провайдеров. Затем открыть `/app` в Chrome на телефоне и
поставить приложение — см. [phone.md](phone.md).

Безопасность: StackEdit не хранит файлы на сервере — только статику и проксирование OAuth. Если
включаете провайдеров, держите `client_secret` только в переменных окружения юнита, не в `dist/`.
