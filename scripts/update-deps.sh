#!/usr/bin/env bash
# Updates the npm dependencies (no Node needed on the host: everything runs in Docker),
# then rebuilds and restarts the app.
#
#   ./scripts/update-deps.sh          compatible updates (within the package.json ranges)
#   ./scripts/update-deps.sh --check  only shows what is outdated, changes nothing
#
# If the rebuild fails, package.json and package-lock.json are restored.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_IMAGE=node:22-alpine3.24
npm_docker() {
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e NPM_CONFIG_UPDATE_NOTIFIER=false \
    -v "$PWD:/w" -w /w "$NODE_IMAGE" npm "$@"
}

echo "== Outdated dependencies =="
# npm outdated needs node_modules: run it in the image's "deps" stage (the final image has no npm)
docker build -q --target deps -t flash-and-furious:deps . >/dev/null
docker run --rm flash-and-furious:deps npm outdated || true

if [[ "${1:-}" == "--check" ]]; then
  echo "(--check: nothing was changed)"
  exit 0
fi

backup=$(mktemp -d)
cp package.json package-lock.json "$backup/"
restore() {
  echo "!! Failed: restoring package.json and package-lock.json"
  cp "$backup/package.json" "$backup/package-lock.json" .
}
trap restore ERR

echo "== Updating package-lock.json =="
npm_docker update --package-lock-only --ignore-scripts --no-audit --no-fund

if cmp -s "$backup/package-lock.json" package-lock.json; then
  echo "Already up to date, nothing to do."
  trap - ERR; rm -rf "$backup"; exit 0
fi
diff -u "$backup/package-lock.json" package-lock.json | grep -E '^[-+]\s+"version"' -B3 | grep -E '"node_modules/|"version"' || true

echo "== Rebuilding and restarting =="
docker compose up -d --build

echo "== Checking =="
for _ in $(seq 1 30); do
  if curl -fsS localhost:3000/api/status >/dev/null 2>&1; then
    trap - ERR; rm -rf "$backup"
    echo "OK: the app responds. $(curl -fsS localhost:3000/api/status)"
    exit 0
  fi
  sleep 1
done
echo "!! The app does not respond after the update."
restore
echo "Restarting with the previous versions…"
docker compose up -d --build
exit 1
