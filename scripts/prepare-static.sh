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

# 4. Пусковые файлы: чтобы не открывать index.html двойным кликом.
#    Открытие файла напрямую (file://) ломает приложение: манифест и /sw.js не читаются,
#    Chrome показывает «Файл манифеста отсутствует или недоступен для чтения».
#    Корень раздачи обязан быть каталогом stackedit-pwa (там, где лежат app/, manifest, sw.js).
cat > "$OUT/start-windows.cmd" <<'BAT'
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PORT=8080
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python 3 не найден. Установите его с https://python.org/downloads
  echo При установке отметьте галочку "Add python.exe to PATH", затем запустите этот файл снова.
  pause
  exit /b 1
)
echo StackEdit запускается на http://localhost:%PORT%/app/
echo Это окно должно оставаться открытым, пока вы работаете. Ctrl+C — остановить.
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%/app/"
%PY% -m http.server %PORT%
BAT

cat > "$OUT/start.sh" <<'SH'
#!/usr/bin/env sh
# Запуск StackEdit локально: http://localhost:8080/app/
# Открывать index.html напрямую (file://) нельзя — приложение не загрузится.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8080}"
PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "Нужен Python 3 (python3 или python)." >&2
  exit 1
fi
echo "StackEdit: http://localhost:$PORT/app/  (Ctrl+C — остановить)"
( sleep 2; (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/app/") || \
            (command -v open >/dev/null && open "http://localhost:$PORT/app/") ) >/dev/null 2>&1 &
exec "$PY" -m http.server "$PORT"
SH
chmod +x "$OUT/start.sh"
# cmd.exe надёжнее работает с CRLF — переводим переводы строк у .cmd
sed -i 's/$/\r/' "$OUT/start-windows.cmd"

cat > "$OUT/КАК-ЗАПУСТИТЬ.txt" <<'TXT'
STACKEDIT — ГОТОВОЕ ПРИЛОЖЕНИЕ (PWA)

ВАЖНО: не открывайте app\index.html двойным кликом. Так приложение не работает:
браузер не может прочитать манифест и Service Worker, и Chrome пишет
"Файл манифеста отсутствует или недоступен для чтения".

WINDOWS
  1. Двойной клик по start-windows.cmd в этой папке.
     Нужен Python 3 (python.org/downloads, галочка "Add python.exe to PATH").
  2. Откроется браузер на http://localhost:8080/app/
  3. Значок "Установить" в адресной строке Chrome (или меню > Сохранить и поделиться
     > Установить приложение). Дальше приложение запускается с рабочего стола и
     работает без интернета.

LINUX / MACOS
  ./start.sh   (или: python3 -m http.server 8080, затем http://localhost:8080/app/)

ТЕЛЕФОН
  Поставить PWA можно только по HTTPS. Загрузите содержимое этой папки
  (не саму папку, а файлы внутри) на любой бесплатный статический хостинг:
  Netlify Drop (app.netlify.com/drop) — перетащить папку, или Cloudflare Pages,
  или GitHub Pages. Затем откройте выданный адрес https://... на телефоне:
  Chrome (Android) — меню > "Установить приложение";
  Safari (iOS) — "Поделиться" > "На экран Домой".

Если адрес открывается, но установки нет — проверьте, что
  https://ваш-адрес/app/        открывается
  https://ваш-адрес/conf        отдаёт {"allowSponsorship":false}
  https://ваш-адрес/sw.js       отдаёт код
Если /conf или /sw.js дают 404 — файлы загружены не на тот уровень (корень
должен содержать app/, manifest..., sw.js, а не папку app целиком).

Подробная документация: README.ru.md и docs/ru/quickstart.md в репозитории.
TXT

echo "Готово: $OUT ($(du -sh "$OUT" | cut -f1))"

echo "Раздача:  Windows — двойной клик по start-windows.cmd"
echo "          Linux/macOS — ./start.sh   (или python3 -m http.server 8080)"
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
