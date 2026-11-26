#!/bin/sh
# Container entrypoint (run as root, under tini): checks and prepares the photos folder, then
# starts the app as PUID:PGID, not as root.
#
# Idempotent: it runs on every start and only changes what is not already right.
#  - a folder that Docker has just created (empty, owned by root) is handed over to PUID:PGID;
#  - the .cache/ and originals/ subfolders (the app's own) are created if missing, owned by PUID:PGID;
#  - the config folder (settings, journal) is owned by PUID:PGID;
#  - an existing photos folder with wrong permissions is never modified: photos are blocked instead,
#    with the command to fix it.
# Blocking problems are written to $STATUS_FILE: the app still starts (so /admin and the tablet
# can show the problem) but refuses to take photos until it is fixed.
#
# The app runs as PUID:PGID with the USB_GID group added: the group of the camera's USB device
# on the host (plugdev, 46, on Debian, Ubuntu and Raspberry Pi OS). Without PUID/PGID, or with
# PUID=0, it runs as root.
set -eu

PHOTOS_DIR=${PHOTOS_DIR:-/app/photos}
CONFIG_DIR=${CONFIG_DIR:-/app/config}
HOST_PATH=${PHOTOS_HOST_PATH:-$PHOTOS_DIR}   # path on the host, for messages only
STATUS_FILE=/run/flash-and-furious/storage  # read by the server (empty = OK)
PUID=${PUID:-}
PGID=${PGID:-}
USB_GID=${USB_GID:-}
if [ -n "$PUID" ] && [ -n "$PGID" ] && [ "$PUID" != "0" ]; then AS_USER=true; else AS_USER=false; fi

# runs a command as the app's user (or as root when the app runs as root)
as_app() {
  if $AS_USER; then setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"; else "$@"; fi
}

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

  # 3. Folder just created by Docker (empty and owned by root): hand it over to PUID:PGID
  if $AS_USER && [ "$(stat -c %u "$PHOTOS_DIR")" = "0" ] && [ -z "$(ls -A "$PHOTOS_DIR")" ]; then
    if chown "$PUID:$PGID" "$PHOTOS_DIR" 2>/dev/null; then
      log "new folder $HOST_PATH handed over to $PUID:$PGID"
    else
      warn "could not hand $HOST_PATH over to $PUID:$PGID (file system without Unix owners, e.g. exFAT/NTFS?)"
    fi
  fi

  # 4. The app must be able to write to it (read-only disk, wrong mount options, wrong owner...)
  probe="$PHOTOS_DIR/.write-test.$$"
  # shellcheck disable=SC2016 # $1 is expanded by the inner shell, run as the app's user
  if ! as_app sh -c ': > "$1" && rm -f "$1"' sh "$probe" 2>/dev/null; then
    rm -f "$probe"
    if $AS_USER; then
      error notWritable "user $PUID:$PGID cannot write to $HOST_PATH (owner $(stat -c '%u:%g, mode %a' "$PHOTOS_DIR")). Photos are blocked. On the host: sudo chown -R $PUID:$PGID '$HOST_PATH'"
    else
      error notWritable "$HOST_PATH is not writable (read-only disk or mount?). Photos are blocked."
    fi
    return
  fi

  # 5. Subfolders used by the app, owned by its user
  for sub in .cache originals; do
    if [ ! -d "$PHOTOS_DIR/$sub" ]; then
      mkdir -p "$PHOTOS_DIR/$sub"
      log "created $HOST_PATH/$sub"
    fi
    if $AS_USER && [ "$(stat -c %u:%g "$PHOTOS_DIR/$sub")" != "$PUID:$PGID" ]; then
      chown "$PUID:$PGID" "$PHOTOS_DIR/$sub" 2>/dev/null || true
    fi
  done
}

check_photos_dir
if [ -s "$STATUS_FILE" ]; then
  warn "photos are blocked until the problem above is fixed (then restart: docker compose restart)."
else
  log "photos folder OK: $HOST_PATH ($(df -h "$PHOTOS_DIR" | awk 'NR==2 {print $4 " free"}'))"
fi

# Settings and journal: written by the app (the folder is created when not mounted from the host)
mkdir -p "$CONFIG_DIR"
if $AS_USER; then
  chown -R "$PUID:$PGID" "$CONFIG_DIR" 2>/dev/null || warn "could not hand $CONFIG_DIR over to $PUID:$PGID: settings may not be saved"
fi

if $AS_USER; then
  groups="$PGID"
  [ -n "$USB_GID" ] && groups="$PGID,$USB_GID"
  echo "[app] running as $PUID:$PGID (groups $groups)"
  # no capabilities kept; HOME for gphoto2's own settings
  exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$groups" --inh-caps=-all --bounding-set=-all env HOME=/tmp "$@"
fi
echo "[app] running as root (PUID/PGID not set)"
exec "$@"
