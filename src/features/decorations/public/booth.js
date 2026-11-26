'use strict';

/*
 * Theme decorations on the tablet (module features/decorations/): shown or hidden as set in
 * /admin, right away. The drawings themselves are in decorations.css.
 * Registered in BOOTH_PARTS: app.js calls render({ settings }) whenever the settings change.
 */
(window.BOOTH_PARTS = window.BOOTH_PARTS || []).push({
  render({ settings }) {
    document.documentElement.classList.toggle('screen-deco', Boolean(settings.screenDeco));
  },
});
