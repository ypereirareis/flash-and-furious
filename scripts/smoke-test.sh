#!/usr/bin/env bash
# Smoke test of a running instance, without a camera: pages, API, translations, frame rendering
# and privacy headers. Usage: ./scripts/smoke-test.sh [base URL]   (default http://localhost:3000)
set -euo pipefail
BASE=${1:-http://localhost:3000}
failures=0

ok()   { echo "✓ $1"; }
fail() { echo "✗ $1" >&2; failures=$((failures + 1)); }
# expect <description> <path> <expected HTTP code> [text that the body must contain]
expect() {
  local body code
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' "$BASE$2" || true)
  if [[ "$code" != "$3" ]]; then fail "$1: HTTP $code (expected $3)"
  elif [[ -n "${4:-}" ]] && ! grep -qF -- "$4" "$body"; then fail "$1: body does not contain '$4'"
  else ok "$1"; fi
  rm -f "$body"
}

echo "Waiting for $BASE…"
for _ in $(seq 1 30); do curl -fsS "$BASE/api/status" >/dev/null 2>&1 && break; sleep 1; done

expect "status (no camera)"   /api/status              200 '"camera":null'
expect "settings"             /api/settings            200 '"lang":'
expect "languages"            /api/languages           200 '"id":"fr"'
expect "camera driver"        /api/camera              200 '"capabilities"'
expect "themes"               /api/themes              200 '"id":"halloween"'
expect "themes CSS"           /themes.css              200 '[data-theme="night"]'
expect "feature modules"      /api/features            200 '['
# frames module, when active
if curl -fsS "$BASE/api/features" | grep -q '"id":"frames"'; then
  expect "frames"               /api/frames              200 '"id":"01-polaroid"'
  expect "frame preview (SVG)"  /api/frames/02-party.png 200
  expect "frames texts"         /locales/en.json         200 '"frames":{'
fi
expect "photos list"          /api/photos              200 '['
expect "guest page"           /                        200 'Flash &amp; Furious'
expect "admin page"           /admin                   200 'data-i18n="admin.display"'
expect "slideshow page"       /slideshow               200 'data-i18n="slideshow.newPhoto"'
expect "English texts"        /locales/en.json         200 '"smile":"Smile!"'
expect "French texts"         /locales/fr.json         200 '"smile":"Souriez !"'
expect "theme decoration"     /deco/christmas-corner.svg 200 '<svg'
expect "no direct photo URL"  /photos/x.jpg            404
expect "unknown media"        /media/view/missing.jpg  404

headers=$(curl -sI "$BASE/" || true)
if grep -qi '^cache-control: no-store' <<<"$headers"; then ok "no-store cache header"; else fail "no-store cache header missing"; fi

if (( failures )); then echo "$failures check(s) failed" >&2; exit 1; fi
echo "All checks passed"
