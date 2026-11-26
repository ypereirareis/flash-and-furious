# Green screen module

One of the [feature modules](../../../README.md#feature-modules): active when `FEATURES` includes `greenscreen`
(or is `all`).

Guests pose in front of a green cloth, and the green is replaced with a background: beach, space, party lights
and city at night are included, in the `backgrounds/` folder. Set it up in `/admin`, "Green screen" card:
1. **Calibrate**: takes a photo (not added to the gallery) to measure the exact green of the cloth under your
   lights. Someone may stand in front of it, which also helps the camera focus. The result is shown right away:
   the calibration photo with the chosen background. Calibrate again if the lights change.
2. Choose the **background**, then switch **Replace the green cloth** on.
3. **Tolerance** (50 = as calibrated): raise it if green remains around people, lower it if parts of people
   disappear. The preview follows.

Every photo then gets the background, with or without a frame, in two steps (see [Photo editing](../../../README.md#photo-editing)). In black & white, the background is in black & white too; the frame keeps its
colours. The original stays untouched in `photos/originals/`.

How it works: a pixel is cloth when its green is well above its red and blue (by thresholds measured at
calibration). Between "clearly person" and "clearly cloth", it is blended with the background, and the edges
are softened over 1-2 px, so hair stays natural. The green reflected by the cloth on people's edges and skin
is removed. The pixel work runs in a separate thread, so the booth stays responsive meanwhile (countdown,
live view). On a PC, it adds about 0.1 s to the tablet version and 0.3 s to the full size.

For a good result:
- a matte cloth without creases, wide enough for a group (about 2.5 × 2 m), filling the whole picture;
- the cloth lit evenly, with no shadows of people on it: people stand 1 to 2 m in front of it;
- no green clothes or accessories (they would become "transparent"); shiny objects and glasses can reflect green;
- the camera in manual exposure and white balance, so the green stays the same from one photo to the next.

Adding a background: drop a JPEG, PNG or SVG into `backgrounds/`, ideally 3:2 and at least the camera's
resolution (see the `README.txt` there). No restart needed. Live view on the tablet still shows the green cloth.

## Files

| Where | What |
|---|---|
| `index.js` | settings, routes, journal entries, its edit of the photos (stage `pixels`, first, in colour) |
| `images.js` | backgrounds, calibration, previews, the green replaced on a photo |
| `key.js`, `worker.js` | the pixel work, run in a worker thread |
| `backgrounds/` | the backgrounds (JPEG, PNG or SVG), mounted from the project by `docker-compose.yml` |
| `public/` | the `/admin` card (`admin.js`, `admin.css`) |
| `locales/` | its texts (`"greenscreen"` block); background names in `backgrounds.<file name>` |
| `tests/` | unit and functional tests |

`BACKGROUNDS_DIR` (environment) uses another backgrounds folder.

## API

- `GET /api/backgrounds`, `GET /api/backgrounds/:id.jpg`: backgrounds and their thumbnails
- `POST /api/greenscreen/calibrate`: takes a calibration photo of the green cloth (`422` if no green cloth is seen)
- `GET /api/greenscreen/preview.jpg`: that photo with the current background and tolerance
- Settings in `PUT /api/settings`: `"greenScreen"`, `"background"`, `"greenTolerance"` (0-100)
