'use strict';

/*
 * Black & white button of the tablet (module features/bw/): the guests' choice, remembered on
 * this tablet; live view is shown in black & white too.
 * Registered in BOOTH_PARTS: app.js adds shootOptions() to the shot request, and provides
 * busy, toast() and t().
 */
(function blackAndWhite() {
  const KEY = 'flash-and-furious.bw';
  let bw = false;
  try { bw = localStorage.getItem(KEY) === '1'; } catch (_) { /* storage unavailable */ }

  const btn = document.createElement('button');
  btn.id = 'bwBtn';
  btn.className = 'big-btn bw-btn';
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>
    <span data-i18n="bw.button"></span>`;
  const shutter = document.getElementById('shootBtn');
  shutter.parentNode.insertBefore(btn, shutter);

  function render() {
    btn.classList.toggle('active', bw);
    btn.setAttribute('aria-pressed', String(bw));
    document.body.classList.toggle('bw', bw); // live view shown in black & white
  }
  btn.addEventListener('click', () => {
    if (busy) return;
    bw = !bw;
    try { localStorage.setItem(KEY, bw ? '1' : '0'); } catch (_) { /* ignored */ }
    render();
    toast(t(bw ? 'bw.on' : 'bw.off'), 'ok');
  });
  render();

  (window.BOOTH_PARTS = window.BOOTH_PARTS || []).push({ shootOptions: () => ({ bw }) });
})();
