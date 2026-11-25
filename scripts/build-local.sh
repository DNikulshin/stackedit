#!/usr/bin/env bash
# Сборка StackEdit из исходников без правки системного Node.
#
# Скрипт сам скачивает изолированный Node.js 14 в .toolchain/ (проект 2023 года
# требует Node <= 14: node-sass 4, webpack 2), ставит зависимости и собирает dist/.
#
# Использование:
#   ./scripts/build-local.sh                     # полная сборка (base=/)
#   ./scripts/build-local.sh --clean             # пересоздать node_modules и dist
#   ./scripts/build-local.sh --base /stackedit/  # сборка для раздачи из подкаталога
#                                                # (GitHub Pages проекта, /preview/имя/ и т.п.)
#
# Требуется: bash, curl или wget, tar, git, ~2.5 ГБ на диске.
# Проверено на Linux x64; для macOS архитектура определяется автоматически.

set -euo pipefail

NODE_VERSION=14.21.3
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

# --- определение платформы -------------------------------------------------
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "неизвестная ОС $(uname -s). Для Windows используйте WSL или шаги из docs/ru/build.md" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "неизвестная архитектура $(uname -m)" ;;
esac

DIST_NAME="node-v$NODE_VERSION-$OS-$ARCH"
NODE_DIR="$TOOLCHAIN/$DIST_NAME"

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 -o "$out" "$url"
  else
    wget -O "$out" "$url"
  fi
}

# --- Node 14 ---------------------------------------------------------------
if [ ! -x "$NODE_DIR/bin/node" ]; then
  log "Скачиваю Node.js $NODE_VERSION ($OS-$ARCH) в .toolchain/"
  mkdir -p "$TOOLCHAIN"
  ARCHIVE="$TOOLCHAIN/$DIST_NAME.tar.xz"
  # Зеркало быстрее из РФ; при его недоступности — официальный сайт.
  if ! download "https://cdn.npmmirror.com/binaries/node/v$NODE_VERSION/$DIST_NAME.tar.xz" "$ARCHIVE"; then
    log "Зеркало не ответило, пробую nodejs.org"
    download "https://nodejs.org/dist/v$NODE_VERSION/$DIST_NAME.tar.xz" "$ARCHIVE"
  fi
  tar -xf "$ARCHIVE" -C "$TOOLCHAIN"
  rm -f "$ARCHIVE"
fi

export PATH="$NODE_DIR/bin:$PATH"
log "Node $(node -v), npm $(npm -v)"

CLEAN=0
BASE="/"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    --base) BASE="${2:?--base требует значение}"; shift 2 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
done
case "$BASE" in /*) ;; *) BASE="/$BASE" ;; esac
case "$BASE" in */) ;; *) BASE="$BASE/" ;; esac

if [ "$CLEAN" -eq 1 ]; then
  log "Удаляю node_modules и dist"
  rm -rf "$ROOT/node_modules" "$ROOT/dist"
fi

cd "$ROOT"

# 1. Зависимости.
#    --ignore-scripts обязателен: транзитивная зависимость sqlite3@4.0.9 (из
#    indexeddbshim) не имеет готового бинарника для Node 14 и падает при сборке
#    из исходников. Для веб-сборки sqlite3 не нужен.
log "npm install (без install-скриптов)"
npm install --ignore-scripts --no-audit --no-fund

# 2. Бинарник node-sass (скачивается с GitHub, компиляция не нужна).
if [ ! -f "$ROOT/node_modules/node-sass/vendor/"*/binding.node ]; then
  log "Скачиваю бинарник node-sass"
  ( cd "$ROOT/node_modules/node-sass" && node scripts/install.js )
fi

# 3. postinstall из package.json: склейка prism.js для подсветки кода.
log "gulp build-prism"
npx gulp build-prism

# 4. Продакшн-сборка (webpack + отдельный проход по стилям).
# 4. Чистая сборка.
#    Старые файлы в dist/ мешают: prepare-static.sh копирует каталог целиком, и в выкладку
#    попадают манифест и каталог иконок от сборки с другим base (наблюдалось: index.html
#    с base=/, манифест от сборки под /preview/ → 404 на иконки в браузере).
log "Очищаю dist/"
rm -rf "$ROOT/dist"

log "npm run build (STACKEDIT_BASE=$BASE)"
STACKEDIT_BASE="$BASE" npm run build

log "Готово. Каталог сборки: $ROOT/dist (base=$BASE)"
log "Запуск: PATH=\"$NODE_DIR/bin:\$PATH\" node . и открыть http://localhost:8080/app"
