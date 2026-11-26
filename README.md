# Flash & Furious

Self-hosted DIY photobooth. A Node.js server (in Docker) drives a USB DSLR through **gphoto2**, with a web app for a tablet (shutter button + gallery).
Tested with a **Canon EOS 1000D**. The interface is available in English and French.

## Getting started

```bash
docker compose up -d --build
```

On the tablet (same Wi-Fi network as the host): `http://<host-ip>:3000`.
Use ⛶ to go full screen, or "Add to Home Screen".

Photos are copied to `./data/photos/` by default (see [Photos folder](#photos-folder) to use another folder or an external disk).
They can **only be retrieved on the host**: the tablet has no download button,
and no image is kept in its browser cache (`Cache-Control: no-store` on every response).

## Project layout

| Folder | What |
|---|---|
| `src/server/` | the Node.js server (camera, photos, settings, journal, the loader of the modules) |
| `src/public/` | the pages: tablet, `/admin`, slideshow, their texts (`locales/`) |
| `src/features/` | the [feature modules](#feature-modules), each with its code, screen files, texts, images and tests |
| `data/` | created while the booth is used, never committed: `photos/` (default photos folder), `config/` (settings, journal) |
| `tests/` | tests of the core, fake camera, test module |
| `scripts/` | tests, smoke test, translations check, dependency updates |
| `docker/` | entrypoint of the container, udev rule for the camera (`Dockerfile` and `docker-compose.yml` stay at the root) |

## Photos folder

The photos folder on the host is set in a `.env` file next to `docker-compose.yml` (copy `.env.example`):

| Variable | Default | Role |
|---|---|---|
| `PHOTOS_PATH` | `./data/photos` | Folder on the host: relative to the project or absolute, on the system disk or on an external disk |
| `PHOTOS_CREATE` | `true` | Missing folder: `true` = created at start-up, `false` = `docker compose up` fails ("bind source path does not exist") |
| `PHOTOS_EXTERNAL` | `false` | `true` = the folder must be on another disk than the project: if the external disk is not plugged in or not mounted, photos are blocked instead of silently filling the system disk |
| `STORAGE_MIN_FREE_MB` | `200` | Photos are blocked (with an alert) when less free space than this is left on the disk |
| `PUID` / `PGID` | `1000` | The app runs as this user: owner of the folder, of the photos and of the settings on the host |

On every start, the container entrypoint (`docker/entrypoint.sh`) checks the folder, as root, then starts the app as
`PUID:PGID` (see [Running as a user, not root](#running-as-a-user-not-root)). It is idempotent: it only changes what is not already right.

- A folder that Docker has just created (empty, owned by root) is handed over to `PUID:PGID`; the `.cache/` and `originals/` subfolders are created if missing, owned by `PUID:PGID`.
- An existing folder is never modified: if `PUID:PGID` cannot write to it, photos are blocked and the message gives the command to fix it on the host (`sudo chown …`).
- Blocking problems (folder not mounted from the host, external disk missing, read-only folder, disk almost full) are logged, shown on the tablet and in `/admin`, and photos are refused until they are fixed.
- The server checks again before every photo with a real write test, so a disk unplugged or a folder deleted during an event is detected. If a photo could not be saved, the camera is not fired again for nothing: the storage problem is reported instead.

```bash
docker compose logs | grep storage   # what the entrypoint checked or changed
```

External disk example (ext4 recommended; exFAT/NTFS work but have no Unix owners):

```bash
# /etc/fstab: mount the disk at boot, without blocking the boot if it is missing
UUID=<disk uuid>  /mnt/photos  ext4  defaults,nofail  0  2
```
```bash
# .env
PHOTOS_PATH=/mnt/photos/flash-and-furious
PHOTOS_EXTERNAL=true
```

## The three pages

| URL | For | Content |
|---|---|---|
| `http://<host-ip>:3000/` | guests (tablet) | preview, shutter, gallery: no settings (`/#gallery` opens the gallery directly) |
| `http://<host-ip>:3000/admin` | the organiser | language, live view, mirror, theme, green screen, frame, AF/MF focus, event journal |
| `http://<host-ip>:3000/slideshow` | a screen / TV | photos in a loop, 3 s each, crossfade and slow zoom; new photos are shown first (4K version, 3840 px) |

`/admin` settings are saved in `data/config/settings.json` (kept across restarts) and applied immediately
on every tablet. The `/admin` page is not password-protected: only use the app on a trusted local network,
and don't give its address to guests.

## Language

The interface (tablet, slideshow, admin) is translated in English and French. The language is picked in `/admin`
(Display card); the default comes from `DEFAULT_LANG` (`fr` in `docker-compose.yml`).
Texts live in `src/public/locales/<lang>.json`, shared by the server and the browser. To add a language, copy `en.json`
to `<code>.json` and translate it: it shows up in `/admin` automatically after a rebuild.

## Event journal

The **Journal** button at the top of `/admin` opens what happened during the event, newest first, grouped by day:
photos taken (with their edits and file name), photos that failed and why, camera plugged in, unplugged, asleep or
used by another program, focus mode, storage blocked or available again, settings changed, start and stop.
Older entries load as the list is scrolled down; new ones appear on top while it is open. Messages follow the
language chosen in `/admin`.

It is saved in `data/config/journal.jsonl`, so it survives a restart or a power cut. The technical details for
troubleshooting stay in the Docker logs (`docker logs flash-and-furious`).

The journal can neither slow the booth down nor fill the disk:
- entries are written in memory, then to the file asynchronously, in batches (at most one write a second);
- the file keeps the last 5,000 entries and at most 2 MB (`JOURNAL_MAX_ENTRIES`, `JOURNAL_MAX_BYTES`):
  past that, it is rewritten with the newest entries;
- texts are cut, so an entry stays small;
- at most 120 entries a minute (`JOURNAL_MAX_PER_MINUTE`): beyond, entries are counted, and one entry says how many
  were skipped;
- the camera, polled every 4 seconds, only writes changes;
- if the disk refuses to write (full, read-only), nothing breaks: writing pauses for a minute, the journal goes on
  in memory.

## Live view (Live mode)

On a DSLR, live view raises the mirror and keeps the shutter open. It therefore **only runs during the countdown
of a photo**, and only if "Live" is enabled in `/admin`:

1. Shutter button pressed: the server starts live view and waits for the first frame.
2. The countdown is shown on top of live view (mirrored if enabled in `/admin`).
3. Live view stops right before focusing (`FOCUS_BEFORE_END`), then the photo is taken.
4. Safety: live view is cut off after `LIVE_MAX_SECONDS` (10 s) no matter what, and after every shot.

Throughput: about 18 frames/s, 768×512, about 5 Mbit/s over Wi-Fi. Outside of shots, the tablet shows the last photo in large.

**On the 1000D, the mode dial must be on P, Av, Tv or M** (not Auto or a scene mode),
and "Live View shooting" must be enabled in the menu. Otherwise the preview stays black and the tablet shows a message.

Live view drains the battery faster: for an event, use the mains adapter (ACK-E5).

## Tablet address

At the top of `/admin`, a card shows the address to open on the tablet (private IP of the host, e.g. `192.168.1.42:3000`) and its QR code.
The container uses the host network (`network_mode: host`) to know this address; if it is wrong,
force it with the `HOST_IP` variable in `docker-compose.yml`.

## Colour theme

In `/admin`, "Colour theme" card: 13 themes (including Halloween, Christmas, Wedding, Birthday, Acid pop), applied to the tablet right away.
To try a theme on a single screen without saving it: `http://<host>:3000/?theme=halloween`.
The Gallery and Back buttons take the theme's bright colour.
A theme is only colours. Drawings matching it (pumpkins, fir trees, roses and rings, cake with candles… for Halloween,
Christmas, Wedding and Birthday) come from the [`decorations`](src/features/decorations/README.md) module: on the tablet,
on the photos, or both, with two switches in the Theme card. Decorations are optional for a theme.
To add or change a theme: `src/server/themes.js` (one entry per theme) and its name in `src/public/locales/*.json`, then `docker compose up -d --build`.

## Photo editing

The edits of the [feature modules](#feature-modules) (green screen, black & white chosen by the guests on
the tablet, frame, theme decorations) are applied in two steps:
1. a 1920 px version for the tablet, in a fraction of a second: the photo shows up and the next shot can start;
2. the full-size photo, then its 4K version for the slideshow, in the background, one photo at a time.

The result:
- `photos/<name>.jpg`: edited photo at full size (shown in the gallery), dated from the shot;
- `photos/originals/<name>.jpg` (and the RAW file, if any): untouched original.

A photo still waiting for its full-size version is noted in `photos/.cache/pending_<name>.json`: after a restart
or a power cut, its processing resumes on start-up. A clean stop (`docker compose stop`) waits for it.

## Feature modules

Everything that changes the photos, and its settings in `/admin`, is a module of the `src/features/` folder,
documented in its own `README.md`:

| Module | What it does | In `/admin` |
|---|---|---|
| [`greenscreen`](src/features/greenscreen/README.md) | replaces a green cloth with a background | Green screen card: on/off, calibration, background, tolerance |
| [`bw`](src/features/bw/README.md) | black & white button on the tablet (the guests' choice) | — |
| [`frames`](src/features/frames/README.md) | a frame on the photos and over live view | Frames card: frame, text |
| [`decorations`](src/features/decorations/README.md) | the theme's drawings on the tablet and/or on the photos | Colour theme card: on the tablet, on the photos |

**Choosing the modules**: `FEATURES` in `.env` (then `docker compose up -d`): `all` (default), `none`, or a
list such as `FEATURES=bw,frames`. The active modules keep all their settings in `/admin`, to change during the
event (frame, green screen on or off…). An inactive module is not loaded at all: no card, no button, no
routes, never applied to the photos; its settings stay saved for when it is switched back on.

**Removing a module from the code**: delete its folder, images included (`src/features/frames/frames/`,
`src/features/greenscreen/backgrounds/`). Nothing else refers to it.

**How the edits stack up**: the photo is decoded once, goes through the steps of the modules of the shot,
then is encoded once (`src/server/photo.js`, which knows none of them). There are three stages, in this order:
1. `pixels`: changes the RGB pixels (green screen, in colour);
2. `image`: image operations (black & white: the photo and its background turn grey);
3. `layers`: images laid over the photo in their own colours (frame, then decorations).

The edits of a shot are decided when it is taken (with the settings of that moment), and saved with the photo
until its full-size version is done.

**Writing a module**: a folder `src/features/<id>/` with
- `README.md`: what it does, its settings, files and routes;
- `index.js`: `module.exports = (core) => ({ ... })`, the hooks are described in `src/server/features.js`
  (settings, routes, the edit of a shot and its stage, tablet message, journal entries, screen files);
- `locales/en.json`, `locales/fr.json`: its texts, in a `"<id>"` block;
- `public/`: its files for the tablet and `/admin`, served at `/features/<id>/` (they register in
  `BOOTH_PARTS` or `ADMIN_PARTS`, see `src/public/features.js`);
- `tests/unit/`, `tests/functional/`: found by `./scripts/test.sh`.

## Automatic or manual focus

On the 1000D, AF/MF is selected with the **physical switch on the lens** (no software can change it).
The "Focus: Auto / Manual" selector in `/admin` shows its actual position (read from the camera).
Tapping the other mode opens a box explaining what to do; it closes as soon as the camera detects the change:

- **Switch to manual** (recommended in low light): have someone stand where people will pose, half-press
  the camera's shutter button until it beeps, then set the lens to MF without touching the ring. (The 1000D cannot
  focus remotely; on a camera that can, a "Focus now" button appears.) The camera then fires every time, without searching for focus.
- **Switch back to auto**: set the lens to AF.

In auto, if the camera does not fire (could not focus), the server refocuses and tries once more.

## How a photo is taken

1. Live view starts, then "Look at the lens, not the screen!" for 2 s (`LOOK_MESSAGE`, `LOOK_MESSAGE_SECONDS`), then "Don't move until the flash!!" for 2 s (`PRE_MESSAGE`, `PRE_MESSAGE_SECONDS`), then a 3 s countdown (`DEFAULT_DELAY`).
2. `FOCUS_BEFORE_END` seconds before the end (2 s by default), live view stops, then a one-off focus (`autofocusdrive`, same as a half-press).
3. Capture, then the file is copied to the host (`--capture-image-and-download --keep`). The photo is shown in large; live view does not resume.

**No camera setting is ever changed**: no firmware, mode, capture target or exposure.
With `--keep`, the photo also stays on the memory card if the camera records to it.

## Recommended settings, to set yourself on the camera

- Mode dial on P, Av, Tv or M; "Live View shooting" enabled in the menu.
- Lens switch on **AF**.
- Optional: "Auto power off" set to "Disable", otherwise the camera goes to sleep and disappears from USB.
- JPEG or RAW+JPEG quality. With RAW only, there is no preview in the gallery.

## Running as a user, not root

The entrypoint prepares the folders as root, then replaces itself with [tini](https://github.com/krallin/tini) and
the app, both as `PUID:PGID` with no capabilities kept: nothing keeps running as root. tini is PID 1: it passes the
stop signals on to the app and reaps orphan processes. `docker compose stop` (SIGTERM) stops it cleanly: live view closed, current camera command and
photos being processed finished (12 s at most), journal written.

To use the camera, the app's user also gets the group of its USB device on the host, `USB_GID` (46 = `plugdev` on
Debian, Ubuntu and Raspberry Pi OS). The libgphoto2 package of the host gives cameras to that group. On a host without
it (e.g. a minimal Raspberry Pi OS), install the rule in `docker/udev/` (see the comments in the file), then
unplug and plug the camera again. To check: `ls -l /dev/bus/usb/*/*` with the camera plugged in shows a device of group
`plugdev` with mode `crw-rw-r--`.

Without `PUID`/`PGID` (or with `PUID=0`), the app runs as root.

## "The camera is already used by another program"

The Ubuntu desktop (gvfs) automatically mounts the camera when it is plugged in, and locks it. To release it:

```bash
gio mount -u "gphoto2://Canon_Inc._Canon_Digital_Camera/"
```

This has to be done every time the camera is plugged in or switched on. To disable this automount permanently
(for the current user only, reversible with `unmask`):

```bash
systemctl --user mask --now gvfs-gphoto2-volume-monitor.service
```

## Using another camera

All camera-specific code lives in `src/server/cameras/`. The rest of the app only uses the interface described
at the top of `src/server/cameras/index.js`.

| File | Role |
|---|---|
| `src/server/cameras/index.js` | picks the driver (`CAMERA_DRIVER`) and documents the interface |
| `src/server/cameras/gphoto2.js` | common gphoto2 base: detection, capture, live view, autofocus, errors |
| `src/server/cameras/canon-eos-1000d.js` | 1000D specifics: AF/MF reading, retry in One Shot |
| `src/server/cameras/gphoto2-generic.js` | fallback driver for any gphoto2-compatible camera |

For a new camera:
1. First try `CAMERA_DRIVER=gphoto2-generic` (capture + live view, without reading the focus mode).
2. If needed, copy `canon-eos-1000d.js` to `my-camera.js`, adapt it (focus mode reading,
   `liveView` / `remoteAutofocus` / `focusMode` capabilities), then add it to the `DRIVERS` list in `index.js`.
   Help texts specific to the camera go under `cameras.<driver id>` in `src/public/locales/*.json`.
3. Set `CAMERA_DRIVER=my-camera` in `docker-compose.yml` and restart with `docker compose up -d --build`.

The admin page adapts by itself: help texts provided by the driver, sections hidden when the camera does not support them.

## Variables (docker-compose.yml)

| Variable | Default | Role |
|---|---|---|
| `DEFAULT_LANG` | fr (`en` without docker-compose) | Default UI language, then changeable in `/admin` |
| `DEFAULT_DELAY` | 3 | Countdown duration (s) |
| `LOOK_MESSAGE` | translated text | First message: look at the lens, not the screen (empty = none) |
| `LOOK_MESSAGE_SECONDS` | 2 | How long it is shown (s) |
| `PRE_MESSAGE` | translated text | Second message, right before the countdown: don't move until the flash (empty = none) |
| `PRE_MESSAGE_SECONDS` | 2 | How long it is shown (s) |
| `FOCUS_BEFORE_END` | 2 | When focusing starts before the end of the countdown (s) |
| `LIVE_QUALITY` | 70 | JPEG quality of the live stream (lower = lighter) |
| `LIVE_MAX_SECONDS` | 10 | Maximum live view duration (s) |
| `CAMERA_DRIVER` | canon-eos-1000d | Camera driver (`src/server/cameras/`) |
| `FEATURES` | all | active [feature modules](#feature-modules): `all`, `none`, or e.g. `bw,frames,decorations,greenscreen` |
| `FRAME_TITLE` | Flash & Furious | Frame text on first start (then editable in `/admin`) |
| `HOST_IP` | (auto) | Address shown in `/admin` for the tablet |
| `TZ` | Europe/Paris | Time zone used to name files |
| `PUID` / `PGID` | 1000 | The app runs as this user, owner of the files it creates ([details](#running-as-a-user-not-root)) |
| `USB_GID` | 46 | Group of the camera's USB device on the host, added to the app's user |
| `PHOTOS_PATH`, `PHOTOS_CREATE`, `PHOTOS_EXTERNAL`, `STORAGE_MIN_FREE_MB` | see [Photos folder](#photos-folder) | Photos folder on the host |
| `JOURNAL_MAX_ENTRIES`, `JOURNAL_MAX_BYTES`, `JOURNAL_MAX_PER_MINUTE` | 5000, 2097152, 120 | Limits of the [event journal](#event-journal) |
| `BACKGROUNDS_DIR` | `src/features/greenscreen/backgrounds/` (mounted from the project) | [Green screen](src/features/greenscreen/README.md) backgrounds |

## The camera stops responding ("PTP Timeout")

Switch the camera off and on again. The server cleanly closes live view when the container stops (`docker compose stop/restart`),
but a hard stop (`docker kill`, host power cut) can still leave the camera stuck.

## Updating dependencies

Node does not need to be installed on the host: everything runs in Docker.

```bash
./scripts/update-deps.sh --check   # lists what is outdated, changes nothing
./scripts/update-deps.sh           # updates package-lock.json, rebuilds and restarts
```

Only updates compatible with the `package.json` ranges are applied (e.g. `^4.21.2`: 4.x).
If the rebuild fails or the app stops responding, the previous versions are restored and restarted.
To move to a major version (e.g. express 5), change the version in `package.json`, then run the script.

## Tests

Everything runs in Docker, in the app image (no Node needed on the host):

```bash
./scripts/test.sh                       # unit tests, then functional tests with the fake camera
./scripts/test.sh unit                  # unit tests only (a few seconds)
./scripts/test.sh functional            # functional tests, fake camera (about 1 min)
./scripts/test.sh functional --real     # functional tests with the camera plugged in: it fires about 12 times
./scripts/test.sh functional --only queue --keep   # one test file; keep photos, server logs and timings
```

- **Unit tests** (`tests/unit/` and `src/features/*/tests/unit/`, Node's built-in `node:test`): photo processing
  (orientation, stages), black & white, theme decorations, frames (text fitting, transparent parts, colour, black & white, screen
  versions, settings), settings, storage checks, translations, themes, gphoto2 drivers,
  photo names and addresses (`src/server/photos.js`), event journal (limits on disk, in memory and per minute),
  green screen (thresholds, calibration, soft edges, green reflections, backgrounds).
- **Functional tests** (`tests/functional/` and `src/features/*/tests/functional/`): each test file starts the real server with its own photos and
  config folders, and drives it like the tablet does (HTTP API and events). Covered: camera detection and
  problems (unplugged, used by another program, asleep), photos as taken and in black & white, decorations
  without frame, upright photo, RAW+JPEG, photo refused while another is in progress, live view,
  the queue of full-size photos, storage problems, focus failure, request limit, power cut and clean stop
  during processing, event journal, green screen (calibration, backgrounds, photos with decorations and in
  black & white), frames (colour, black & white, decorations, broken frame, settings, module off), modules chosen with `FEATURES`. A timings table is printed at the end.
- **Test module** (`tests/functional/modules/testedit`): loaded by the test servers only, it edits a photo on
  request, so the tests of the core do not depend on the real modules (which can be removed).
- **Fake camera** (`tests/fake-camera/gphoto2`): answers like a Canon EOS 1000D; the tests switch it to
  "unplugged", "used by another program", "asleep", "focus not found" or "slow" while the server runs.
- **`--real`**: the tests that need the fake camera (failure modes, special photos) are skipped. The
  `flash-and-furious` container is stopped during the tests (only one program can use the camera), then
  started again; the desktop automount is released if needed. Your photos and settings are not touched:
  the tests use temporary folders.

## Contributing

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org):
`<type>[(scope)][!]: <description>`, with the types `build chore ci docs feat fix perf refactor revert style test`
(e.g. `feat(admin): add a language selector`).

- Locally, a `commit-msg` hook rejects other messages. Enable it once per clone:
  ```bash
  git config core.hooksPath .githooks
  ```
- On GitHub, `main` only changes through squash-merged pull requests: the PR title becomes the commit message,
  and a check (`.github/workflows/conventional-commits.yml`) must pass.

Every pull request must also pass these checks (`.github/workflows/`). Nothing is published: the Docker image
is only built on GitHub to be tested and scanned, then thrown away.

| Check | What it does | Run it locally |
|---|---|---|
| Lint | JavaScript syntax, translations (same keys in every language, every used key exists), ShellCheck, hadolint | `node scripts/check-i18n.js` |
| Unit tests | `tests/unit/` in the app image (the functional tests are run by hand: too long for every pull request) | `./scripts/test.sh unit` |
| Docker build & smoke test | builds the image, starts it without a camera and checks pages, API, translations, frame rendering and cache headers | `./scripts/smoke-test.sh` (against a running instance) |
| Trivy | fails on fixable HIGH / CRITICAL vulnerabilities in the image (also runs every Monday) | see `ci.yml` |
| CodeQL analysis | static security analysis of the JavaScript code (results in Security > Code scanning) | |

Workflows only use official GitHub actions pinned to a commit SHA, and tools from Docker images pinned to a digest.

The Docker image is built locally in two stages: npm packages are installed in a cached stage that is only
rebuilt when `package.json` or `package-lock.json` change.

## API

- `GET /api/status`: camera detected or not, shot in progress
- `POST /api/shoot`: takes a photo (with the `/admin` settings)
- `GET /api/settings`, `PUT /api/settings` `{ "mirror", "live", "theme", "lang" }` and those of the active modules
  (`"frame", "frameTitle"`, `"screenDeco", "photoDeco"`, `"greenScreen", "background", "greenTolerance"`), `GET /api/themes`, `GET /api/languages`: settings
- `GET /api/features`: active feature modules and their files for the screens
- routes of the modules: see their `README.md` (e.g. `GET /api/frames`, `GET /api/backgrounds`)
- `GET /api/camera`: driver, capabilities and camera help texts
- `POST /api/focus`: one-off focus
- `GET /api/photos`: photo list (most recent first)
- `GET /api/live.mjpeg`: live stream (MJPEG), only available during a countdown in Live mode
- `GET /api/events`: SSE stream (countdown, phases, new photo, errors, journal entries)
- `GET /api/journal?limit=50&before=<id>`: event journal, newest first, in the UI language; `before` gives the next page
- `/media/thumb/:name`, `/media/view/:name`, `/media/tv/:name`: thumbnail, preview (1920 px), slideshow (3840 px); no access to originals: they are retrieved on the host
- `/locales/:lang.json`: UI texts (with those of the modules)

## License

[MIT](LICENSE) © Yannick Pereira-Reis
