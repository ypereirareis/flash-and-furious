# Theme decorations module

The drawings of the colour theme (pumpkins, fir trees, cake…) also placed on the corners of the photos, with
or without a frame, in colour even on black & white photos. No effect for a theme without decorations.
One of the [feature modules](../../README.md#feature-modules): active when `FEATURES` includes `decorations`
(or is `all`).

The drawings belong to the themes (`public/deco/`, `server/themes.js`), which also show them on the screens:
this module only adds them to the photos.

## In /admin

"Theme decorations on photos" switch, in the "Colour theme" card.

## Files

| Where | What |
|---|---|
| `index.js` | setting, journal entries, its edit of the photos (stage `layers`, after the frame), cached layers |
| `public/` | the `/admin` switch (`admin.js`) |
| `locales/` | its texts (`"decorations"` block) |
| `tests/` | unit and functional tests |

## API

- Settings in `PUT /api/settings`: `"photoDeco"`
