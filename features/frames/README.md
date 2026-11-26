# Frames module

A frame laid over every photo, with the event title and the date, and shown over live view on the tablet.
One of the [feature modules](../../README.md#feature-modules): active when `FEATURES` includes `frames`
(or is `all`).

The applied frame is chosen in `/admin`, among the frames of the `frames/` folder (Polaroid, Party, Cinema, Elegant included),
with the text shown on them (event title). The chosen frame is shown on top of live view so people can place
themselves inside it. In black & white, the frame keeps its colours.

Adding a frame: drop a transparent PNG or a 3:2 SVG into `frames/` (see the `README.txt` there). No restart needed.
In SVGs, `{{title}}` is replaced with the text typed in `/admin` (the same for every frame) and `{{date}}` with today's date.

The theme decorations on photos do not depend on it: they are the [`decorations`](../decorations/README.md) module.

## In /admin

"Frames" card: the frame applied to the photos (or none), and the text of the frames.

## Files

| Where | What |
|---|---|
| `index.js` | settings (frame, text), routes, journal entries, its edit of the photos (stage `layers`, before the decorations) |
| `render.js` | the frame images: list, text fitting, rendering, previews, cached layers |
| `frames/` | the frames (PNG or SVG), mounted from the project by `docker-compose.yml` |
| `public/` | the frame over live view on the tablet (`booth.js`), the `/admin` card (`admin.js`), styles (`frames.css`) |
| `locales/` | its texts (`"frames"` block); frame names in `names.<file name>` |
| `tests/` | unit and functional tests |

`FRAMES_DIR` (environment) uses another frames folder. `FRAME_TITLE` sets the default text.

## API

- `GET /api/frames`: frame list, with their preview URL
- `GET /api/frames/:id.png`: preview of a frame (transparent PNG, 1200 × 800) with the current text and decorations
- Settings in `PUT /api/settings`: `"frame"` (id or null), `"frameTitle"`
