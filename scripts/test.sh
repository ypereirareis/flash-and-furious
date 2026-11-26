#!/usr/bin/env bash
# Runs the tests in Docker (no Node needed on the host).
#
#   ./scripts/test.sh                      unit tests, then functional tests with the fake camera
#   ./scripts/test.sh unit                 unit tests only (a few seconds)
#   ./scripts/test.sh functional           functional tests, fake camera (a few minutes)
#   ./scripts/test.sh functional --real    functional tests with the camera plugged in (it fires!)
#
# Options (functional tests):
#   --real         use the camera on USB instead of the fake one: the app container is stopped
#                  during the tests (one program at a time on the camera), then started again
#   -y, --yes      no confirmation before firing the real camera
#   --only TEXT    only the test files whose name contains TEXT (e.g. --only queue)
#   --keep         keep the test photos, server logs and timings (folder printed at the end)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=flash-and-furious:test
APP_CONTAINER=flash-and-furious
suite=all real=false yes=false only='' keep=false
while (($#)); do
  case "$1" in
    unit | functional | all) suite=$1 ;;
    --real) real=true ;;
    -y | --yes) yes=true ;;
    --only) only=${2:?--only needs a text}; shift ;;
    --keep) keep=true ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
if $real && [[ $suite == unit ]]; then echo "--real only applies to the functional tests" >&2; exit 2; fi

tz=$(cat /etc/timezone 2>/dev/null || echo UTC)
run_node() { # run_node <docker options...> -- <node arguments...>
  local opts=()
  while [[ $1 != -- ]]; do opts+=("$1"); shift; done
  shift
  docker run --rm -e TZ="$tz" -e HOME=/tmp -v "$PWD/tests:/app/tests:ro" -v "$PWD/src:/app/src:ro" --entrypoint node "${opts[@]}" "$IMAGE" "$@"
}

echo "== Building the image =="
docker build -q -t "$IMAGE" . >/dev/null
failed=()

if [[ $suite != functional ]]; then
  echo "== Unit tests =="
  run_node -u "$(id -u):$(id -g)" -- --test --test-reporter=spec 'tests/unit/**/*.test.js' 'src/features/*/tests/unit/*.test.js' || failed+=(unit)
fi

if [[ $suite != unit ]]; then
  files=()
  # the app's, then those of the feature modules (src/features/<id>/tests/functional/)
  for f in tests/functional/*.test.js src/features/*/tests/functional/*.test.js; do
    [[ -z $only || $(basename "$f") == *"$only"* ]] && files+=("$f")
  done
  if ((${#files[@]} == 0)); then echo "No functional test file matches '$only'" >&2; exit 2; fi
  work=$(mktemp -d -t flash-and-furious-tests.XXXXXX)
  opts=(-v "$work:/work" -e TEST_WORK_DIR=/work -e PUID="$(id -u)" -e PGID="$(id -g)")
  restart_app=false

  cleanup() {
    if $real; then
      # files written as root: given back to the user
      docker run --rm -v "$work:/work" --entrypoint chown "$IMAGE" -R "$(id -u):$(id -g)" /work || true
    fi
    if $restart_app; then
      echo "== Starting the app again =="
      docker start "$APP_CONTAINER" >/dev/null && echo "$APP_CONTAINER started"
    fi
    if $keep; then echo "Test files kept in $work"; else rm -rf "$work"; fi
  }
  trap cleanup EXIT

  if $real; then
    echo "== Functional tests with the REAL camera =="
    echo "The camera will fire about 12 times. Point it at something lit (autofocus)."
    if ! $yes; then
      read -r -p "Continue? [y/N] " answer
      [[ $answer == [yYoO]* ]] || { echo "Cancelled."; exit 1; }
    fi
    if [[ -n $(docker ps -q -f "name=^${APP_CONTAINER}$") ]]; then
      echo "Stopping $APP_CONTAINER during the tests (it holds the camera)…"
      docker stop "$APP_CONTAINER" >/dev/null
      restart_app=true
    fi
    # the Ubuntu desktop automount (gvfs) locks the camera: release it
    if command -v gio >/dev/null; then
      for uri in $(gio mount -l 2>/dev/null | grep -o 'gphoto2://[^ ]*' | sort -u || true); do
        echo "Releasing the camera from the desktop automount ($uri)"
        gio mount -u "$uri" || true
      done
    fi
    opts+=(-e CAMERA=real -v /dev/bus/usb:/dev/bus/usb --device-cgroup-rule 'c 189:* rmw')
  else
    echo "== Functional tests with the fake camera =="
    opts+=(-u "$(id -u):$(id -g)" -e CAMERA=fake)
  fi

  run_node "${opts[@]}" -- --test --test-concurrency=1 --test-reporter=spec "${files[@]}" || failed+=(functional)
  run_node -v "$work:/work:ro" -- tests/functional/report.js /work || true
fi

echo
if ((${#failed[@]})); then
  echo "✗ Failed: ${failed[*]}"
  exit 1
fi
echo "✓ All tests passed"
