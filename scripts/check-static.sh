#!/usr/bin/env bash
# Проверяет, что подготовленный статический каталог (dist-static/) самодостаточен:
# все URL из precache-списка Service Worker и служебные роуты обязаны отдавать 200.
# Если что-то из них 404 — SW не установится, а значит не будет ни офлайна, ни установки PWA.
#
# Использование:
#   ./scripts/check-static.sh [каталог] [--base /путь/]
#   --base не обязателен: без него base выводится из index.html проверяемого каталога
#   (по путям к static/), поэтому dist-pages больше не даёт ложных FAIL про start_url и /app.
#
# Зависимости: python3 и curl (больше ничего).

set -euo pipefail

DIR="dist-static"
BASE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base требует значение}"; shift 2 ;;
    *) DIR="$1"; shift ;;
  esac
done
[ -f "$DIR/sw.js" ] || { echo "Нет $DIR/sw.js — сначала выполните ./scripts/prepare-static.sh" >&2; exit 1; }

# base по умолчанию — тот, под который сделан сам каталог: prepare-static.sh оставляет
# в index.html пути вида <base>static/…, иначе проверка ругалась бы на чужой base
# (start_url, /app/ в precache) и на 404 по всем статическим файлам.
if [ -z "$BASE" ]; then
  FIRST_ASSET=$(grep -oE '(href|src)="?[^"[:space:]>]*static/' "$DIR/index.html" 2>/dev/null | head -1 || true)
  if [ -z "$FIRST_ASSET" ]; then
    echo "Не удалось определить base по $DIR/index.html — укажите его через --base" >&2
    exit 1
  fi
  BASE="${FIRST_ASSET#*=}"   # href=/stackedit/static/ → /stackedit/static/
  BASE="${BASE%static/}"     # → /stackedit/
fi
case "$BASE" in /*) ;; *) BASE="/$BASE" ;; esac
case "$BASE" in */) ;; *) BASE="$BASE/" ;; esac
PORT="${PORT:-8097}"
echo "Каталог: $DIR, base=$BASE"

# Для base != / каталог должен быть доступен по этому пути: раздаём временный корень
# со симлинком <base> -> каталог.
if [ "$BASE" = "/" ]; then
  SERVE_ROOT="$DIR"
else
  SERVE_ROOT="$(mktemp -d)"
  LINK="$SERVE_ROOT$(printf '%s' "$BASE" | sed 's:/$::')"
  mkdir -p "$(dirname "$LINK")"
  ln -s "$(cd "$DIR" && pwd)" "$LINK"
  echo "Каталог: $DIR доступен как $BASE (временный корень $SERVE_ROOT)"
fi

python3 -m http.server "$PORT" --directory "$SERVE_ROOT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; [ "$BASE" != "/" ] && rm -rf "$SERVE_ROOT"' EXIT
sleep 1

fail=0
check() { # url ожидаемый_код
  local url="$1" want="${2:-200}" code
  code=$(curl -s -o /dev/null -w '%{http_code}' -L "http://127.0.0.1:$PORT$url" || echo 000)
  if [ "$code" = "$want" ]; then
    printf '  ok   %-26s %s\n' "$url" "$code"
  else
    printf '  FAIL %-26s %s (ожидалось %s)\n' "$url" "$code" "$want"
    fail=1
  fi
}

echo "Служебные роуты (base=$BASE):"
check "${BASE}app"
check "${BASE}app/"
check "${BASE}conf"
check "${BASE}oauth2/callback"
check "${BASE}sw.js"
check "${BASE}index.html"

echo "Все URL из precache Service Worker:"
while read -r url; do
  [ -n "$url" ] && check "$url"
done < <(python3 - "$DIR/sw.js" <<'PY'
import json, re, sys
src = open(sys.argv[1], encoding='utf-8').read()
match = re.search(r'var __wpo = (\{.*?\});', src, re.S)
if not match:
    sys.exit('не найден __wpo в sw.js')
out = set()

def walk(value):
    if isinstance(value, dict):
        for item in value.values():
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)
    elif isinstance(value, str) and value.startswith('/'):
        out.add(value)

walk(json.loads(match.group(1)))
print('\n'.join(sorted(out)))
PY
)

echo "Содержимое:"
if grep -qF "\"start_url\": \"${BASE}\"" "$DIR"/manifest.*.json; then
  echo "  ok   manifest start_url = ${BASE}"
else
  echo "  FAIL manifest start_url не ${BASE} (офлайн-запуск установленного приложения сломается)"
  fail=1
fi
# В precache не должно быть URL без завершающего слэша для каталогов: сервер отдаёт
# на них 301, а cache.addAll на редиректе падает — Service Worker не установится.
if grep -qF "\"${BASE}app\"" "$DIR/sw.js"; then
  echo "  FAIL в precache есть ${BASE}app без слэша (сервер отдаёт 301 → SW не установится)"
  fail=1
fi
if grep -qF "\"${BASE}app/\"" "$DIR/sw.js"; then
  echo "  ok   ${BASE}app/ добавлен в precache (start_url манифеста)"
else
  echo "  FAIL ${BASE}app/ отсутствует в precache"
  fail=1
fi
if grep -qF "\"${BASE}oauth2/callback\"" "$DIR/sw.js"; then
  echo "  ok   ${BASE}oauth2/callback в precache"
else
  echo "  FAIL ${BASE}oauth2/callback отсутствует в precache"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo
  echo "Проверка пройдена: каталог $DIR готов к раздаче статикой без Node."
else
  echo
  echo "Есть проблемы — см. FAIL выше." >&2
  exit 1
fi
