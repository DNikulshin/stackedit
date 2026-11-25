# StackEdit — самодостаточный образ (Node 14 + сборка из исходников).
#
#   docker build -f docker/Dockerfile -t stackedit-local .
#   docker run -d --name stackedit -p 8080:8080 stackedit-local
#   → http://localhost:8080/app
#
# Почему не апстримный Dockerfile: он тянет benweet/stackedit-base со старым тулчейном
# с Docker Hub и не учитывает особенности сборки 2026 года.
#
# Почему не node:14-buster: Debian 10 (buster) переведён в archive.debian.org, и `apt-get
# update` в этом образе больше не работает. Здесь берётся актуальный Debian, а Node 14
# скачивается отдельно — как в scripts/build-local.sh.
#
# Из России Docker Hub (registry-1.docker.io) часто недоступен: используйте зеркало.
#   docker build -f docker/Dockerfile -t stackedit-local \
#     --build-arg BASE_IMAGE=mirror.gcr.io/library/debian:trixie-slim .
#
# Проверено: docker build (3–6 минут), образ 731 МБ, docker run → контейнер healthy, /app и /conf
# отвечают 200, Service Worker активируется, офлайн-перезагрузка работает.

ARG BASE_IMAGE=debian:trixie-slim

# --- Этап 1: сборка приложения ---------------------------------------------
FROM ${BASE_IMAGE} AS builder

ARG NODE_VERSION=14.21.3
ARG NODE_MIRROR=https://cdn.npmmirror.com/binaries/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fL "$NODE_MIRROR/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /opt \
 && mv "/opt/node-v$NODE_VERSION-linux-x64" /opt/node \
 && rm -f /tmp/node.tar.xz

ENV PATH=/opt/node/bin:$PATH
WORKDIR /opt/stackedit

# 1) Зависимости без install-скриптов: sqlite3@4 (из indexeddbshim) не имеет бинарника
#    для Node 14 и не собирается; для веб-сборки не нужен.
# 2) Бинарник node-sass скачивается вручную (prebuilt, без компиляции).
# 3) postinstall из package.json — склейка prism.js.
COPY package.json package-lock.json gulpfile.js ./
RUN npm install --ignore-scripts --no-audit --no-fund \
 && ( cd node_modules/node-sass && node scripts/install.js ) \
 && npx gulp build-prism

COPY . .
RUN npm run build

# Отдельная установка только рантайм-зависимостей для этапа запуска.
# Важно: express (сервер из index.js) в апстриме объявлен в devDependencies, поэтому
# для рантайм-набора он переносится в dependencies, а установка идёт с --only=production.
# (`npm prune --production` его выкидывает, а `npm install express` без --only=production
# довозит весь dev-набор обратно — проверено.)
RUN mkdir -p /opt/rt \
 && cp package.json package-lock.json /opt/rt/ \
 && cd /opt/rt \
 && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies.express=p.devDependencies.express;delete p.devDependencies.express;fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
 && npm install --only=production --ignore-scripts --no-audit --no-fund

# --- Этап 2: запуск ---------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime

ARG NODE_VERSION=14.21.3
ARG NODE_MIRROR=https://cdn.npmmirror.com/binaries/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fL "$NODE_MIRROR/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /opt \
 && mv "/opt/node-v$NODE_VERSION-linux-x64" /opt/node \
 && rm -f /tmp/node.tar.xz

ENV PATH=/opt/node/bin:$PATH \
    NODE_ENV=production \
    PORT=8080

WORKDIR /opt/stackedit

COPY --from=builder /opt/stackedit/package.json /opt/stackedit/package-lock.json ./
COPY --from=builder /opt/rt/node_modules ./node_modules
COPY index.js ./
COPY config ./config
COPY server ./server
COPY static ./static
COPY --from=builder /opt/stackedit/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||8080) +'/conf', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "."]
