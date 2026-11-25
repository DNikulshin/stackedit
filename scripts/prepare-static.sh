#!/usr/bin/env bash
# Готовит каталог для раздачи ЛЮБЫМ статическим хостингом — без Node, без npm,
# без сборки на стороне пользователя.
#
# Что делает (правки к dist/):
#   1. app/index.html — чтобы приложение отдавалось по URL <base>app/ статикой
#      (как это делает сервер из репозитория);
#   2. oauth2/callback и conf — файлы вместо серверных роутов: их запрашивает Service
#      Worker при установке, а приложение — за списком провайдеров. Без них SW не
#      установится, и не будет ни офлайна, ни установки PWA;
#   3. в sw.js и манифесте пути переводятся на <base>, в precache добавляется <base>app/,
#      а start_url манифеста — <base>app/ (иначе офлайн-запуск установленного приложения
#      не работает: статические серверы отдают на <base>app редирект 301, а редирект-ответ
#      Service Worker для навигации не использует).
#
# <base> — путь, по которому каталог будет доступен на хостинге:
#   /                 корень домена (Netlify Drop, Cloudflare Pages, свой домен)
#   /stackedit/       подкаталог (проектный GitHub Pages, /preview/name/)
#   Сборка должна быть сделана с тем же base: STACKEDIT_BASE=/stackedit/ ./scripts/build-local.sh
#
# Использование:
#   ./scripts/prepare-static.sh [каталог-назначения] [--base /путь/] [--tar]
#     --tar — дополнительно собрать архивы для раздачи:
#             stackedit-pwa-<версия>.tar.gz (Linux/macOS) и .zip (Windows, файлы в корне)
#   python3 -m http.server 8080 --directory dist-static    # локальная раздача при base=/
#   → http://localhost:8080/

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/dist"
ARGS=()
MAKE_TAR=0
BASE="/"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tar) MAKE_TAR=1; shift ;;
    --base) BASE="${2:?--base требует значение}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
OUT="${ARGS[0]:-$ROOT/dist-static}"

# Нормализуем base: ведущий и завершающий слэш обязательны
case "$BASE" in /*) ;; *) BASE="/$BASE" ;; esac
case "$BASE" in */) ;; *) BASE="$BASE/" ;; esac

[ -f "$SRC/index.html" ] || {
  echo "Нет $SRC/index.html — сначала соберите проект (./scripts/build-local.sh)" >&2
  exit 1
}

# Проверяем, что сборка сделана под этот base
if ! grep -qF "$BASE""static/" "$SRC/index.html"; then
  echo "Сборка в $SRC сделана не под base=$BASE." >&2
  echo "Пересоберите: STACKEDIT_BASE=$BASE ./scripts/build-local.sh" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/app" "$OUT/oauth2"
cp -R "$SRC/." "$OUT/"

# 1. Приложение по <base>app/ (и <base>app/), как на сервере из репозитория
cp "$SRC/index.html" "$OUT/app/index.html"

# 1a. .nojekyll — чтобы GitHub Pages (Jekyll) отдавал файлы как есть
: > "$OUT/.nojekyll"

# 2. Роуты, которые ожидает Service Worker и приложение
cp "$ROOT/static/oauth2/callback.html" "$OUT/oauth2/callback"
printf '{"allowSponsorship":false}\n' > "$OUT/conf"
cp "$OUT/conf" "$OUT/app/conf"

# 3. Пути в sw.js и манифесте под выбранный base
[ -f "$OUT/sw.js" ] || { echo "Нет $OUT/sw.js — сборка неполная" >&2; exit 1; }
python3 - "$OUT" "$BASE" <<'PYPATCH'
import glob, json, os, re, sys

out, base = sys.argv[1], sys.argv[2]


def with_base(url):
    """Абсолютный путь '/' -> '<base>'.

    Сборка с STACKEDIT_BASE уже отдаёт пути с префиксом (webpack publicPath),
    поэтому повторно не префиксуем — иначе получится /base/base/...
    """
    if not isinstance(url, str) or not url.startswith('/'):
        return url
    if base == '/' or url.startswith(base):
        return url
    return base + url.lstrip('/')


def map_list(items):
    return [with_base(u) for u in items] if isinstance(items, list) else items


# --- Service Worker: precache-список, hashesMap, externals -------------------
sw_path = os.path.join(out, 'sw.js')
src = open(sw_path, encoding='utf-8').read()
match = re.search(r'var __wpo = (\{.*?\});', src, re.S)
if not match:
    sys.exit('не найден __wpo в sw.js')
data = json.loads(match.group(1))

for key in ('main', 'additional', 'optional'):
    if key in data.get('assets', {}):
        data['assets'][key] = map_list(data['assets'][key])
if isinstance(data.get('externals'), list):
    data['externals'] = [
        u for u in map_list(data['externals'])
        # <base>app без слэша — редирект: ломает cache.addAll (см. ниже)
        if u != base + 'app'
    ]
if isinstance(data.get('hashesMap'), dict):
    data['hashesMap'] = {h: with_base(u) for h, u in data['hashesMap'].items()}

# Обязательные записи в precache. Все — URL, которые отдаются напрямую (200),
# без редиректов: cache.addAll в Service Worker падает на редиректе, и тогда
# воркер не активируется (нет ни офлайна, ни установки приложения).
# Именно поэтому здесь НЕТ '<base>app' без слэша — большинство серверов отдают
# на него 301, а Location может потерять порт (nginx за туннелем), и precache ломается.
main = data['assets'].setdefault('main', [])
# webpack добавляет в precache <base>app без слэша (externals в webpack.prod.conf.js) —
# убираем: такой URL отдаётся редиректом и рушит установку Service Worker.
main[:] = [u for u in main if u != base + 'app']
for extra in (base, base + 'app/', base + 'oauth2/callback'):
    if extra not in main:
        main.append(extra)

open(sw_path, 'w', encoding='utf-8').write(
    src[:match.start(1)] + json.dumps(data, separators=(',', ':')) + src[match.end(1):],
)

# --- Манифест: start_url, scope, иконки -------------------------------------
manifests = glob.glob(os.path.join(out, 'manifest*.json'))
if not manifests:
    sys.exit('не найден manifest.*.json')
manifest = manifests[0]
md = json.load(open(manifest, encoding='utf-8'))
# start_url — сам корень выкладки: он всегда отдаётся 200 (в отличие от '<base>app'
# без слэша, где сервер отвечает 301, а редирект для запуска приложения ненадёжен).
md['start_url'] = base
if 'scope' in md:
    md['scope'] = with_base(md['scope'])
for icon in md.get('icons', []):
    if 'src' in icon:
        icon['src'] = with_base(icon['src'])
json.dump(md, open(manifest, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('start_url =', md['start_url'])
PYPATCH

# 4. Пусковые файлы для локальной раздачи — имеют смысл только при base=/
if [ "$BASE" = "/" ]; then
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
fi

cat > "$OUT/КАК-ЗАПУСТИТЬ.txt" <<TXT
STACKEDIT — ГОТОВОЕ ПРИЛОЖЕНИЕ (PWA)

ЭТО НЕ РАСШИРЕНИЕ CHROME.
  Не загружайте эту папку через chrome://extensions ("Загрузить распакованное
  расширение"): Chrome ответит "Файл манифеста отсутствует или недоступен для
  чтения" / "Не удалось загрузить манифест" — там нужен manifest.json расширения,
  а не манифест PWA. Установка делается иначе: откройте приложение по адресу
  и выберите в меню Chrome "Установить приложение".

ПОЧЕМУ НЕЛЬЗЯ ПРОСТО ОТКРЫТЬ ФАЙЛ
  По file:// браузер не даёт ни манифест, ни Service Worker: Chrome проверяет
  установку и сообщает not-from-secure-origin + no-manifest. Нужен адрес
  https://... либо http://localhost. Отсюда два пути:
    A) свой хостинг (ATS: файлы этой папки — на хост, приложение откроется
       по https://ваш-адрес${BASE}), установка из меню Chrome;
    B) локальный сервер (start-windows.cmd / start.sh) — только при base=/.

БАЗОВЫЙ ПУТЬ (BASE)
  Эти файлы собраны для base=${BASE}. То есть на хостинге они должны лежать так,
  чтобы приложение открывалось по https://ваш-адрес${BASE}
  (для base=/ — в корне сайта).

ТЕЛЕФОН
  Поставить PWA можно только по HTTPS. Откройте https://ваш-адрес${BASE} на телефоне:
  Chrome (Android) — меню > "Установить приложение";
  Safari (iOS) — "Поделиться" > "На экран Домой".

ПРОВЕРКА РАЗДАЧИ
  Должны открываться (200), иначе установки не будет:
    https://ваш-адрес${BASE}                        — приложение
    https://ваш-адрес${BASE}conf                    — {"allowSponsorship":false}
    https://ваш-адрес${BASE}sw.js                   — код Service Worker
    https://ваш-адрес${BASE}manifest.c9128ce574e7548a3b0d3bcd8bfa212c.json

Подробная документация: README.ru.md и docs/ru/quickstart.md в репозитории.
TXT

echo "Готово: $OUT ($(du -sh "$OUT" | cut -f1)), base=$BASE"
echo "Проверка установки:  node scripts/check-installability.mjs $OUT --base $BASE"
if [ "$BASE" = "/" ]; then
  echo "Локально:  Windows — двойной клик по start-windows.cmd; Linux/macOS — ./start.sh"
  echo "Открыть:   http://localhost:8080/   (Далее: Chrome → «Установить приложение»)"
else
  echo "Хостинг:   положите СОДЕРЖИМОЕ каталога так, чтобы приложение было на ${BASE}"
  echo "Установка: откройте https://ваш-адрес${BASE} → Chrome → «Установить приложение»"
fi

if [ "$MAKE_TAR" -eq 1 ]; then
  VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
  SUFFIX=""
  [ "$BASE" != "/" ] && SUFFIX="-base$(printf '%s' "$BASE" | tr -c 'a-zA-Z0-9' '-')"
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  cp -R "$OUT" "$STAGE/stackedit-pwa"
  TARBALL="$ROOT/stackedit-pwa-$VERSION$SUFFIX.tar.gz"
  tar -czf "$TARBALL" -C "$STAGE" stackedit-pwa

  # ZIP — для Windows: файлы лежат прямо в корне архива, без лишней вложенной папки.
  # "Извлечь всё" в Проводнике создаёт одну папку, и она уже правильный корень раздачи.
  ZIPFILE="$ROOT/stackedit-pwa-$VERSION$SUFFIX.zip"
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
