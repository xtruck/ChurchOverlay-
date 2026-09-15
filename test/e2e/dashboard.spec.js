// test/e2e/dashboard.spec.js — test de fumée fondation : le tableau de
// bord charge, la sidebar/les sections/la carte verset sont visibles, et
// la navigation par onglet fonctionne réellement dans un vrai navigateur.
// Première pierre du chantier "couverture automatisée du tableau de bord"
// (jusqu'ici zéro, malgré 7 lots de redesign visuel et un lot entier sur
// la navigation responsive — voir le plan). D'autres specs viendront
// couvrir les fonctionnalités des lots suivants.
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Tableau de bord — fumée', () => {
  test('charge, affiche la sidebar/les sections/la carte verset, et la navigation par onglet fonctionne', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.locator('.sidebar')).toBeVisible();
    // CORRECTIF (redesign IA — étapes 3-5) : DEUX espaces désormais —
    // "Opérateur" (console de diffusion, actif par défaut) et "Paramètres"
    // (ex-Préparation + ex-Régie fusionnés ; #analysis a depuis été retirée
    // entièrement, tout son contenu relocalisé dans #secondaryDrawer, voir
    // dashboard.html).
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Opérateur');
    await expect(page.locator('#propresenter-live')).toBeVisible();
    await expect(page.locator('#verseDisplay')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();

    // Clic sur "Paramètres" -> ses sections apparaissent, "Opérateur" disparaît.
    await page
      .locator('.sidebar .nav-item[data-sections="studio,settings,overlay"]')
      .click();
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Paramètres');
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#propresenter-live')).toBeHidden();

    // Retour à "Opérateur".
    await page
      .locator('.sidebar .nav-item[data-sections="propresenter-live,media-wall,studio"]')
      .click();
    await expect(page.locator('#propresenter-live')).toBeVisible();
    await expect(page.locator('#verseDisplay')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
  });
});
