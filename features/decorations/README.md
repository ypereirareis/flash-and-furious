# Theme decorations module

Drawings matching the colour theme (pumpkins, fir trees, roses and rings, cake with candles…):
- **on the tablet**: on the corners of the preview and as a pattern in the right-hand column;
- **on the photos**: on their corners, with or without a frame, in colour even on black & white photos.

One of the [feature modules](../../README.md#feature-modules): active when `FEATURES` includes `decorations`
(or is `all`). Switched off, there are no decorations anywhere; the themes keep their colours.

## In /admin

Two switches in the "Colour theme" card, to change during the event:
- **Theme decorations on the tablet** (on by default);
- **Theme decorations on the photos** (off by default).

A theme without decorations: the switches have no effect (the card says so).

## Decorations of a theme

Optional, and found by the theme's id (`server/themes.js`), in `public/deco/`:

| File | Where |
|---|---|
| `<theme>-corner.svg` | bottom-left corner of the preview, and of the photos (about 26 % of their width) |
| `<theme>-top.svg` | top-left corner of the preview, and of the photos (about 22 % of their width) |
| `<theme>-pattern.svg` | pattern of the control column on the tablet (tile of 120 px) |

Any of them may be missing. To give decorations to a theme, drop its files there (then `docker compose up -d --build`);
the themes themselves know nothing about them. A test checks that every file matches an existing theme
(a renamed theme would otherwise lose its decorations without any error).

## Files

| Where | What |
|---|---|
| `index.js` | the files of a theme, settings, journal entries, the CSS of the themes, its edit of the photos (stage `layers`, after the frame), cached layers |
| `public/deco/` | the drawings |
| `public/decorations.css`, `public/booth.js` | the drawings on the tablet, shown or hidden as set in `/admin` |
| `public/admin.js` | the two `/admin` switches |
| `locales/` | its texts (`"decorations"` block) |
| `tests/` | unit and functional tests |

## API

- `GET /api/decorations/themes.css`: the drawings of each theme, as CSS variables
- Settings in `PUT /api/settings`: `"screenDeco"`, `"photoDeco"`; `GET /api/settings` also gives `"decoThemes"` (themes that have decorations)
