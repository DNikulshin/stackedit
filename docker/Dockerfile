# Самодостаточный образ StackEdit (Node 14 + сборка из исходников).
#
#   docker build -f docker/Dockerfile -t stackedit-local .
#   docker run -d --name stackedit -p 8080:8080 stackedit-local
#   → http://localhost:8080/app
#
# Отличия от апстримного Dockerfile: не используется образ benweet/stackedit-base
# (старый тулчейн на Docker Hub), а также учтены особенности сборки 2026 года:
# --ignore-scripts (sqlite3@4 не собирается на Node 14) и ручной install node-sass.
#
# ВНИМАНИЕ: в рамках подготовки документации образ не проверялся — на машине не было Docker.

FROM node:14-buster

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/stackedit

COPY package.json package-lock.json gulpfile.js ./

RUN npm install --ignore-scripts --no-audit --no-fund \
 && (cd node_modules/node-sass && node scripts/install.js) \
 && npx gulp build-prism

COPY . .

ENV NODE_ENV=production
RUN npm run build

EXPOSE 8080
CMD ["node", "."]
