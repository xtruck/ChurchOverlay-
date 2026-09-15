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
    // CORRECTIF (redesign IA — étape 3, fusion Studio Pro / Direct
    // Classique) : #overview a disparu (fusionné dans #propresenter-live,
    // voir dashboard.html) — l'espace vérifié comme masqué ici est
    // désormais "Opérateur" (ex-"Studio Pro"), 3 espaces distincts au
    // total (Opérateur/Préparation/Régie).
    await page.locator('.bottom-tab-bar .nav-item[data-sections="settings,overlay"]').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#propresenter-live')).toBeHidden();

    // Retour en largeur bureau : la sidebar doit refléter le DERNIER
    // onglet cliqué ("Régie"), pas être restée bloquée sur "Opérateur"
    // — c'est précisément le bug que le correctif du lot 5 a corrigé.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar .nav-item[data-sections="settings,overlay"]')).toHaveClass(
      /active/
    );
    await expect(
      page.locator('.sidebar .nav-item[data-sections="propresenter-live,media-wall,studio"]')
    ).not.toHaveClass(/active/);
  });
});
