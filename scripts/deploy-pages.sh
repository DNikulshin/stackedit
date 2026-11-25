#!/usr/bin/env bash
# Публикация готового статического каталога на GitHub Pages (ветка gh-pages).
#
# Даёт адрес https://<user>.github.io/<repo>/ (или https://ваш-домен/<repo>/,
# если у пользователя настроен кастомный домен) — то есть готовый PWA в браузере
# без локального сервера и без магазина.
#
# Важно: каталог должен быть собран и подготовлен ПОД ТОТ ЖЕ путь, по которому он
# будет доступен, то есть для проектного Pages — под /<repo>/:
#   ./scripts/build-local.sh --base /stackedit/        # или STACKEDIT_BASE=... npm run build
#   ./scripts/prepare-static.sh dist-pages --base /stackedit/
#   ./scripts/check-static.sh dist-pages --base /stackedit/
#   ./scripts/check-installability.mjs dist-pages --base /stackedit/
#   ./scripts/deploy-pages.sh dist-pages
#
# Если у сайта корневой домен и каталог кладётся в корень (Netlify Drop, свой домен),
# base должен быть '/', и тогда --base в командах не нужен.
#
# Использование:
#   ./scripts/deploy-pages.sh <каталог> [--remote URL] [--branch gh-pages] [--dry-run]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_NAME="$(git -C "$ROOT" config user.name 2>/dev/null || true)"
GIT_EMAIL="$(git -C "$ROOT" config user.email 2>/dev/null || true)"

DIR=""
REMOTE="origin"
BRANCH="gh-pages"
DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:?}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) DIR="$1"; shift ;;
  esac
done

[ -n "$DIR" ] || { echo "Укажите каталог: ./scripts/deploy-pages.sh dist-pages" >&2; exit 2; }
[ -d "$DIR" ] || { echo "Нет каталога $DIR" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"

for f in index.html sw.js .nojekyll; do
  [ -f "$DIR/$f" ] || { echo "В $DIR нет $f — сначала ./scripts/prepare-static.sh" >&2; exit 2; }
done
ls "$DIR"/manifest*.json >/dev/null 2>&1 || { echo "В $DIR нет manifest*.json" >&2; exit 2; }

# Проверяем, что сборка сделана под тот путь, по которому её будут открывать
# webpack отдаёт атрибуты без кавычек: src=/stackedit/static/js/manifest.<hash>.js
BASE_FROM_HTML="$(grep -o 'src=[^ >"]*static/js/manifest[^ >"]*' "$DIR/index.html" | head -1 | sed 's/^src=//; s/["'"'"']//g; s#static/js/manifest.*##')" || true
if [ -z "$BASE_FROM_HTML" ]; then
  echo "Не удалось определить base из index.html (нет ссылки на static/js/manifest...)" >&2
  exit 2
fi

REPO_URL="$(git -C "$ROOT" remote get-url "$REMOTE")"
SLUG="$(basename "$REPO_URL" .git)"
OWNER="$(printf '%s' "$REPO_URL" | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#')"
PAGES_URL="https://$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]').github.io$BASE_FROM_HTML"
echo "Репозиторий: $OWNER/$SLUG, ветка $BRANCH, base=$BASE_FROM_HTML"
echo "Ожидаемый адрес: $PAGES_URL"

if [ "$BASE_FROM_HTML" != "/$SLUG/" ]; then
  echo
  echo "ВНИМАНИЕ: base сборки ($BASE_FROM_HTML) не совпадает с путём проектного Pages (/$SLUG/)."
  echo "Пересоберите: ./scripts/build-local.sh --base /$SLUG/ && ./scripts/prepare-static.sh <каталог> --base /$SLUG/"
  echo "Исключение: у сайта корневой домен (тогда base должен быть /) — тогда это предупреждение можно игнорировать,"
  echo "но такой каталог нужно кладть в корень сайта, а не в /$SLUG/."
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$DIR/." "$STAGE/"
rm -rf "$STAGE/.git"          # на случай, если в подготовленном каталоге уже есть репозиторий
cd "$STAGE"
git init -q
git checkout -q -b "$BRANCH"
git add -A
git -c user.name="${GIT_NAME:-stackedit-deploy}" \
    -c user.email="${GIT_EMAIL:-deploy@localhost}" \
    commit -q -m "PWA: публикация сборки (base=$BASE_FROM_HTML)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry-run: коммит готов, push не выполнялся ($(git rev-parse --short HEAD))"
  exit 0
fi

git push -q -f "$REPO_URL" "$BRANCH"
echo "Опубликовано: ветка $BRANCH ($(git rev-parse --short HEAD))"
echo "Через 1-2 минуты проверьте:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' $PAGES_URL"
echo "  node scripts/check-installability.mjs $PAGES_URL"
echo "Если Pages ещё не включён: gh api -X POST repos/$OWNER/$SLUG/pages -f 'source[branch]=$BRANCH' -f 'source[path]=/'"
