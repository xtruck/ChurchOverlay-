// test/e2e/responsive-nav.spec.js — couvre le lot 5 du redesign visuel
// (barre d'onglets de repli sous 1024px) et son correctif de
// synchronisation d'état actif entre la sidebar et cette barre, resté
// sans couverture automatisée jusqu'ici.
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Navigation responsive — repli sous 1024px', () => {
  test('la sidebar cède la place à la barre d’onglets en bas, et les deux restent synchronisées', async ({
    page,
  }) => {
    await page.goto('/');

    // Largeur bureau : sidebar visible, barre du bas masquée.
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.bottom-tab-bar')).toBeHidden();

    // Largeur tablette (<1024px) : l'inverse.
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.bottom-tab-bar')).toBeVisible();

    // Clic sur "Régie" dans la barre du bas -> les sections changent
    // exactement comme depuis la sidebar (même gestionnaire, voir
    // dashboard/state.js).
    // CORRECTIF (audit e2e — stale depuis la refonte "trois espaces") :
    // l'ancien sélecteur combiné visait un unique onglet "Réglages" qui
    // n'existe plus (voir dashboard.spec.js pour le même correctif) — 3
    // espaces distincts désormais (Direct/Préparation/Régie).
    await page.locator('.bottom-tab-bar .nav-item[data-sections="settings,overlay"]').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#overview')).toBeHidden();

    // Retour en largeur bureau : la sidebar doit refléter le DERNIER
    // onglet cliqué ("Régie"), pas être restée bloquée sur "Direct"
    // — c'est précisément le bug que le correctif du lot 5 a corrigé.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar .nav-item[data-sections="settings,overlay"]')).toHaveClass(
      /active/
    );
    await expect(
      page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]')
    ).not.toHaveClass(/active/);
  });
});
