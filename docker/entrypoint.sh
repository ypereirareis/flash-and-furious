#!/bin/sh
# Container entrypoint: checks and prepares the photos folder, then starts the app.
#
# Idempotent: it runs on every start and only changes what is not already right.
#  - a folder that Docker has just created (empty, owned by root) is handed over to PUID:PGID;
#  - the .cache/ and originals/ subfolders are created if missing;
#  - an existing folder with wrong permissions is never modified: a warning is printed instead.
# Blocking problems are written to $STATUS_FILE: the app still starts (so /admin and the tablet
# can show the problem) but refuses to take photos until it is fixed.
set -eu

PHOTOS_DIR=${PHOTOS_DIR:-/app/photos}
CONFIG_DIR=${CONFIG_DIR:-/app/config}
HOST_PATH=${PHOTOS_HOST_PATH:-$PHOTOS_DIR}   # path on the host, for messages only
STATUS_FILE=/run/flash-and-furious/storage  # read by the server (empty = OK)
PUID=${PUID:-}
PGID=${PGID:-}

mkdir -p "$(dirname "$STATUS_FILE")"
: > "$STATUS_FILE"

log()   { echo "[storage] $*"; }
warn()  { echo "[storage] WARNING: $*" >&2; }
error() { echo "[storage] ERROR: $2" >&2; [ -s "$STATUS_FILE" ] || echo "$1" > "$STATUS_FILE"; }

check_photos_dir() {
  # 1. The folder must come from the host, otherwise photos would be lost with the container
  if ! mountpoint -q "$PHOTOS_DIR"; then
    error notMounted "$PHOTOS_DIR is not a folder mounted from the host: photos would be lost with the container. Check PHOTOS_PATH."
    return
  fi

  # 2. External disk expected: the folder must not be on the same disk as the project
  if [ "${PHOTOS_EXTERNAL:-false}" = "true" ] && [ -d "$CONFIG_DIR" ] \
     && [ "$(stat -c %d "$PHOTOS_DIR")" = "$(stat -c %d "$CONFIG_DIR")" ]; then
    error externalMissing "$HOST_PATH is on the system disk, not on an external disk: is the disk plugged in and mounted? Photos are blocked."
    return
  fi

  # 3. The folder must be writable (read-only disk, wrong mount options...)
  probe="$PHOTOS_DIR/.write-test.$$"
  if ! ( : > "$probe" ) 2>/dev/null; then
    error notWritable "$HOST_PATH is not writable (read-only disk or mount?). Photos are blocked."
    return
  fi
  rm -f "$probe"

  if [ -z "$PUID" ] || [ -z "$PGID" ]; then
    log "PUID/PGID not set: ownership is not checked."
    return
  fi

  # 4. Folder just created by Docker (empty and owned by root): hand it over to PUID:PGID
  if [ "$(stat -c %u "$PHOTOS_DIR")" = "0" ] && [ "$PUID" != "0" ] && [ -z "$(ls -A "$PHOTOS_DIR")" ]; then
    if chown "$PUID:$PGID" "$PHOTOS_DIR" 2>/dev/null; then
      log "new folder $HOST_PATH handed over to $PUID:$PGID"
    else
      warn "could not hand $HOST_PATH over to $PUID:$PGID (file system without Unix owners, e.g. exFAT/NTFS?)"
    fi
  fi

  # 5. Subfolders used by the app
  for sub in .cache originals; do
    if [ ! -d "$PHOTOS_DIR/$sub" ]; then
      mkdir -p "$PHOTOS_DIR/$sub"
      chown "$PUID:$PGID" "$PHOTOS_DIR/$sub" 2>/dev/null || true
      log "created $HOST_PATH/$sub"
    fi
  done

  # 6. The host user must be able to manage the photos (alert only, nothing is changed)
  if ! setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$PHOTOS_DIR" -a -x "$PHOTOS_DIR" 2>/dev/null; then
    warn "user $PUID:$PGID cannot write to $HOST_PATH (owner $(stat -c '%u:%g, mode %a' "$PHOTOS_DIR")). The app still works, but to manage the photos as that user, run on the host: sudo chown $PUID:$PGID '$HOST_PATH'"
  fi
}

check_photos_dir
if [ -s "$STATUS_FILE" ]; then
  warn "photos are blocked until the problem above is fixed (then restart: docker compose restart)."
else
  log "photos folder OK: $HOST_PATH ($(df -h "$PHOTOS_DIR" | awk 'NR==2 {print $4 " free"}'))"
fi

exec "$@"
