// test/e2e/fixtures.js — fixture Playwright partagée pour tout test/e2e/*.spec.js.
//
// CORRECTIF (audit — 7 des 12 specs e2e échouaient) : un contexte Playwright
// frais n'a pas le flag localStorage `churchoverlay_wizard_seen` que
// dashboard/features/startup-wizard.js pose après une vraie première visite
// — sans lui, l'assistant de démarrage s'ouvre tout seul après 1500ms
// (overlay z-index élevé) et intercepte tous les clics suivants, faisant
// échouer par timeout tout test qui interagit avec la page après ce délai.
// Même bug déjà trouvé et corrigé isolément dans
// test/integration-scene-composer.js (suite `npm test`, pas celle-ci) —
// corrigé ici une seule fois, pour TOUTES les specs e2e, via une fixture
// `page` étendue plutôt que de dupliquer un addInitScript() dans chacun des
// 9 fichiers.
'use strict';

const base = require('@playwright/test');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    });
    await use(page);
  },
});

module.exports = { test, expect: base.expect };
