# Black & white module

A "Black & white" button on the tablet: the guests choose black & white photos. The choice is remembered on
the tablet, and live view is shown in black & white too.
One of the [feature modules](../../../README.md#feature-modules): active when `FEATURES` includes `bw` (or is `all`).

The photo turns grey after the green screen (its background turns grey too) and before the layers: the frame
and the theme decorations keep their colours. No setting in `/admin`.

## Files

| Where | What |
|---|---|
| `index.js` | its edit of the photos (stage `image`): `greyscale()` with slightly more contrast |
| `public/` | the tablet button (`booth.js`, `bw.css`) |
| `locales/` | its texts (`"bw"` block) |
| `tests/` | unit and functional tests |

## API

- `POST /api/shoot` `{ "bw": true }`: a photo in black & white
