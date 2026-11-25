#!/usr/bin/env bash
# Проверяет, что подготовленный статический каталог (dist-static/) самодостаточен:
# все URL из precache-списка Service Worker и служебные роуты обязаны отдавать 200.
# Если что-то из них 404 — SW не установится, а значит не будет ни офлайна, ни установки PWA.
#
# Использование:
#   ./scripts/check-static.sh [каталог]      # по умолчанию dist-static/
#
# Зависимости: python3 и curl (больше ничего).

set -euo pipefail

DIR="${1:-dist-static}"
PORT="${PORT:-8097}"
[ -f "$DIR/sw.js" ] || { echo "Нет $DIR/sw.js — сначала выполните ./scripts/prepare-static.sh" >&2; exit 1; }

python3 -m http.server "$PORT" --directory "$DIR" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
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

echo "Служебные роуты:"
check /app
check /app/
check /conf
check /oauth2/callback
check /sw.js
check /index.html

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
if grep -q '"start_url": *"/app/"' "$DIR"/manifest.*.json; then
  echo "  ok   manifest start_url = /app/"
else
  echo "  FAIL manifest start_url не /app/ (офлайн-запуск установленного приложения сломается)"
  fail=1
fi
if grep -q '"/app/","/app"' "$DIR/sw.js"; then
  echo "  ok   /app/ добавлен в precache"
else
  echo "  FAIL /app/ отсутствует в precache"
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
