'use strict';

/*
 * Frame laid over live view (and the empty screen) on the tablet, so people can place
 * themselves inside it (module features/frames/).
 * Registered in BOOTH_PARTS: app.js calls render({ settings, stageFree }) whenever the
 * settings or the screen change.
 */
(function frameOverlay() {
  const img = Object.assign(document.createElement('img'), { className: 'frame-overlay', alt: '', hidden: true });
  const stage = document.getElementById('stage');
  stage.insertBefore(img, document.getElementById('lastBadge'));

  // stageFree: live view or the empty screen is shown (not the last photo)
  function render({ settings, stageFree }) {
    const frame = settings.frame;
    if (frame && img.getAttribute('src') !== frame.preview) img.src = frame.preview;
    img.hidden = !frame || !stageFree;
  }

  (window.BOOTH_PARTS = window.BOOTH_PARTS || []).push({ render });
})();
