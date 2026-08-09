// test/e2e/dashboard.spec.js — test de fumée fondation : le tableau de
// bord charge, la sidebar/les sections/la carte verset sont visibles, et
// la navigation par onglet fonctionne réellement dans un vrai navigateur.
// Première pierre du chantier "couverture automatisée du tableau de bord"
// (jusqu'ici zéro, malgré 7 lots de redesign visuel et un lot entier sur
// la navigation responsive — voir le plan). D'autres specs viendront
// couvrir les fonctionnalités des lots suivants.
'use strict';
const { test, expect } = require('@playwright/test');

test.describe('Tableau de bord — fumée', () => {
  test('charge, affiche la sidebar/les sections/la carte verset, et la navigation par onglet fonctionne', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#verseDisplay')).toBeVisible();
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('En Direct');

    // Section "En Direct" visible par défaut, "Réglages" masqué.
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#controls')).toBeHidden();

    // Clic sur "Réglages" -> ses sections apparaissent, "En Direct" disparaît.
    await page
      .locator('.sidebar .nav-item[data-sections="controls,analysis,settings,overlay"]')
      .click();
    await expect(page.locator('#controls')).toBeVisible();
    await expect(page.locator('#analysis')).toBeVisible();
    await expect(page.locator('#overview')).toBeHidden();

    // Retour à "En Direct".
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript"]').click();
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#controls')).toBeHidden();
  });
});
