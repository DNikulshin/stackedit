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
#     --tar — дополнительно собрать архивы для раздачи:
#             stackedit-pwa-<версия>.tar.gz (Linux/macOS) и .zip (Windows, файлы в корне)
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

rem Serve root = folder with sw.js and manifest*.json (and app\).
rem If the folder is nested (e.g. stackedit-pwa-5.15.4\stackedit-pwa after unpacking),
rem look 1-2 levels deep and use the matching folder.
set "ROOT="
call :check "%CD%"
if not defined ROOT for /d %%d in (*) do call :check "%%~fd"
if not defined ROOT for /d %%d in (*) do for /d %%e in ("%%~fd\*") do call :check "%%~fe"
if not defined ROOT goto :nofound

:run
cd /d "%ROOT%"
set "PORT=8080"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python 3 не найден. Установите его с https://python.org/downloads
  echo При установке отметьте галочку "Add python.exe to PATH", затем запустите этот файл снова.
  pause
  exit /b 1
)
echo.
echo Папка раздачи: %ROOT%
echo Адрес:         http://localhost:%PORT%/      (адрес /app/ — то же приложение)
echo Это окно должно оставаться открытым, пока вы работаете. Ctrl+C — остановить.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/"
%PY% -m http.server %PORT%
exit /b 0

:check
if exist "%~1\sw.js" (
  for /f "delims=" %%m in ('dir /b "%~1\manifest*.json" 2^>nul') do (
    if not defined ROOT set "ROOT=%~1"
  )
)
exit /b 0

:nofound
echo.
echo Не нашёл файлы приложения ^(sw.js, manifest*.json, app^) ни в этой папке, ни рядом.
echo Распакуйте архив целиком и запустите этот файл из папки, где лежат sw.js и app.
echo.
pause
exit /b 1
BAT

cat > "$OUT/start.sh" <<'SH'
#!/usr/bin/env sh
# Запуск StackEdit локально: http://localhost:8080/
# Открывать index.html напрямую (file://) нельзя — приложение не загрузится.
cd "$(dirname "$0")" || exit 1

# Корень раздачи — папка с sw.js и manifest*.json (может быть вложенной после распаковки).
find_root() {
  for d in "$1" "$1"/* "$1"/*/*; do
    [ -d "$d" ] || continue
    [ -f "$d/sw.js" ] || continue
    set +f
    for m in "$d"/manifest*.json; do
      [ -f "$m" ] && { printf '%s\n' "$d"; return 0; }
    done
    set -f
  done
  return 1
}
ROOT="$(find_root "$(pwd)")" || {
  echo "Не нашёл sw.js и manifest*.json в текущей папке и рядом." >&2
  echo "Запустите скрипт из папки, где лежат sw.js, app и manifest*.json." >&2
  exit 1
}
cd "$ROOT" || exit 1

PORT="${PORT:-8080}"
PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "Нужен Python 3 (python3 или python)." >&2
  exit 1
fi
echo "Папка раздачи: $ROOT"
echo "Адрес:         http://localhost:$PORT/   (и /app/ — то же приложение)"
echo "Ctrl+C — остановить."
( sleep 2; (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/") || \
            (command -v open >/dev/null && open "http://localhost:$PORT/") ) >/dev/null 2>&1 &
exec "$PY" -m http.server "$PORT"
SH
chmod +x "$OUT/start.sh"
# cmd.exe надёжнее работает с CRLF — переводим переводы строк у .cmd
sed -i 's/$/\r/' "$OUT/start-windows.cmd"

cat > "$OUT/КАК-ЗАПУСТИТЬ.txt" <<'TXT'
STACKEDIT — ГОТОВОЕ ПРИЛОЖЕНИЕ (PWA)

ЭТО НЕ РАСШИРЕНИЕ CHROME.
  Не загружайте эту папку через chrome://extensions ("Загрузить распакованное
  расширение"): Chrome ответит "Файл манифеста отсутствует или недоступен для
  чтения" / "Не удалось загрузить манифест" — там нужен manifest.json расширения,
  а не манифест PWA. Установка делается иначе: запустите сервер (ниже) и выберите
  в меню Chrome "Установить приложение".

ДВЕ ГЛАВНЫЕ ОШИБКИ ПРИ ЗАПУСКЕ
  1. Открыть app\index.html двойным кликом. Так нельзя: браузер не может прочитать
     манифест и Service Worker. Нужен локальный сервер (см. ниже).
  2. Запустить сервер в папке НА УРОВЕНЬ ВЫШЕ. Если после распаковки получилось
     stackedit-pwa-5.15.4\stackedit-pwa\..., то сервер надо запускать в папке
     stackedit-pwa (в ней лежат app\, sw.js, manifest...json), а не в
     stackedit-pwa-5.15.4. start-windows.cmd и start.sh находят её сами.

WINDOWS
  1. Двойной клик по start-windows.cmd в этой папке. Скрипт сам находит нужную папку
     (даже если она вложена), запускает сервер и открывает браузер.
     Нужен Python 3 (python.org/downloads, галочка "Add python.exe to PATH").
  2. Откроется http://localhost:8080/  (адрес /app/ — то же приложение).
  3. Значок "Установить" в адресной строке Chrome (или меню > Сохранить и поделиться
     > Установить приложение). Дальше приложение запускается с рабочего стола и
     работает без интернета.
  Окно cmd закрывать нельзя, пока работаете. Ctrl+C — остановить.

LINUX / MACOS
  ./start.sh   (или вручную: python3 -m http.server 8080, затем http://localhost:8080/)

ПРОВЕРКА, ЧТО СЕРВЕР ЗАПУЩЕН В ПРАВИЛЬНОЙ ПАПКЕ
  Откройте http://localhost:8080/manifest.c9128ce574e7548a3b0d3bcd8bfa212c.json
  Должен быть JSON. Если "404 Not Found" — сервер запущен не в той папке.

ТЕЛЕФОН
  Поставить PWA можно только по HTTPS. Загрузите содержимое этой папки
  (не саму папку, а файлы внутри) на любой бесплатный статический хостинг:
  Netlify Drop (app.netlify.com/drop) — перетащить папку, или Cloudflare Pages,
  или GitHub Pages. Затем откройте выданный адрес https://... на телефоне:
  Chrome (Android) — меню > "Установить приложение";
  Safari (iOS) — "Поделиться" > "На экран Домой".

Если адрес открывается, но установки нет — проверьте, что
  https://ваш-адрес/            открывается (приложение)
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

  # ZIP — для Windows: файлы лежат прямо в корне архива, без лишней вложенной папки.
  # "Извлечь всё" в Проводнике создаёт одну папку, и она уже правильный корень раздачи.
  ZIPFILE="$ROOT/stackedit-pwa-$VERSION.zip"
  rm -f "$ZIPFILE"
  python3 - "$OUT" "$ZIPFILE" <<'PYZIP'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for base, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, src)
            z.write(full, rel)
PYZIP
  echo
  echo "Архив:   $TARBALL ($(du -h "$TARBALL" | cut -f1))"
  echo "ZIP:     $ZIPFILE ($(du -h "$ZIPFILE" | cut -f1))"
fi
