#!/usr/bin/env bash
# Готовит каталог dist-static/ для раздачи ЛЮБЫМ статическим хостингом:
# без Node, без npm, без сборки на стороне пользователя.
#
# Зачем нужна подготовка (три правки к dist/):
#   1. app/index.html — чтобы URL /app отдавался статикой (как это делает сервер из репозитория);
#   2. oauth2/callback и conf — файлы вместо серверных роутов: их запрашивает Service Worker
#      при установке, а приложение — за списком провайдеров. Без них SW-установка падает и
#      офлайна/установки PWA не будет;
#   3. /app и /app/ добавляются в precache, а start_url манифеста переводится на /app/ —
#      иначе офлайн-запуск установленного приложения не работает: статические серверы
#      отдают на /app редирект 301 на /app/, а редирект-ответ Service Worker'ом для
#      навигации не используется.
#
# Использование:
#   ./scripts/prepare-static.sh [каталог-назначения] [--tar]
#     --tar — дополнительно собрать архив для раздачи (stackedit-pwa-<версия>.tar.gz)
#   python3 -m http.server 8080 --directory dist-static  # раздача (Python 3.7+)
#   → http://localhost:8080/app/

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/dist"
ARGS=()
MAKE_TAR=0
for arg in "$@"; do
  case "$arg" in
    --tar) MAKE_TAR=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
OUT="${ARGS[0]:-$ROOT/dist-static}"

[ -f "$SRC/index.html" ] || {
  echo "Нет $SRC/index.html — сначала соберите проект (./scripts/build-local.sh)" >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT/app" "$OUT/oauth2"
cp -R "$SRC/." "$OUT/"

# 1. Приложение по /app (и /app/), как на сервере из репозитория
cp "$SRC/index.html" "$OUT/app/index.html"

# 2. Роуты, которые ожидает Service Worker и приложение
cp "$ROOT/static/oauth2/callback.html" "$OUT/oauth2/callback"
printf '{"allowSponsorship":false}\n' > "$OUT/conf"
cp "$OUT/conf" "$OUT/app/conf"

# 3. Правки sw.js и манифеста под раздачу статикой
SW="$OUT/sw.js"
[ -f "$SW" ] || { echo "Нет $SW — сборка неполная" >&2; exit 1; }
sed -i.bak 's|"/app"|"/app/","/app"|' "$SW" && rm -f "$SW.bak"

MANIFEST="$(ls "$OUT"/manifest.*.json 2>/dev/null | head -1 || true)"
[ -n "$MANIFEST" ] || { echo "Не найден manifest.*.json в $OUT" >&2; exit 1; }
sed -i.bak 's|"start_url": *"app"|"start_url": "/app/"|' "$MANIFEST" && rm -f "$MANIFEST.bak"

echo "Готово: $OUT ($(du -sh "$OUT" | cut -f1))"

echo "Раздача:  cd $OUT && python3 -m http.server 8080"
echo "Открыть:  http://localhost:8080/app/   (Далее: Chrome → «Установить приложение»)"
echo "Телефон:  нужен HTTPS — положите содержимое каталога на любой статический хостинг"
echo "          (Netlify Drop, Cloudflare Pages, GitHub Pages) и откройте его на телефоне."

if [ "$MAKE_TAR" -eq 1 ]; then
  VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  cp -R "$OUT" "$STAGE/stackedit-pwa"
  TARBALL="$ROOT/stackedit-pwa-$VERSION.tar.gz"
  tar -czf "$TARBALL" -C "$STAGE" stackedit-pwa
  echo
echo "Архив:   $TARBALL ($(du -h "$TARBALL" | cut -f1))"
fi
