'use strict';

/**
 * Test module (functional tests only, never in the app): edits a photo when the shot asks for
 * it ({ testEdit: true }), so the tests of the core (queue, restart, originals, journal) do
 * not depend on the real modules, which can be removed.
 */
module.exports = () => ({
  forShot: (_conf, request) => (request && request.testEdit ? true : null),
  edit: { stage: 'image', make: () => (img) => img.negate({ alpha: false }) },
  step: { icon: '🧪', key: 'testedit.applying', priority: 0 },
  journalDetail: () => ({ key: 'testedit.with' }),
});
