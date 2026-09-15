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
    // CORRECTIF (redesign IA — étape 3, fusion Studio Pro / Direct
    // Classique) : le dashboard a maintenant TROIS espaces (voir
    // dashboard.html sidebar), pas quatre — "Direct Classique" a disparu
    // comme destination de navigation séparée ; son contenu réel
    // (#verseDisplay, transcription, panneau opérateur, langue de
    // projection...) vit désormais physiquement à l'intérieur de
    // #propresenter-live (voir dashboard.html pour le détail de chaque bloc
    // relocalisé). "Opérateur" (ex-"Studio Pro", data-sections=
    // "propresenter-live,media-wall,studio") reste l'espace actif par
    // défaut au chargement.
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Opérateur');
    await expect(page.locator('#propresenter-live')).toBeVisible();
    await expect(page.locator('#verseDisplay')).toBeVisible();
    await expect(page.locator('#analysis')).toBeHidden();

    // Clic sur "Préparation" -> ses sections (analysis/studio) apparaissent,
    // "Opérateur" (et #verseDisplay, maintenant à l'intérieur) disparaît.
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio"]').click();
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Préparation');
    await expect(page.locator('#analysis')).toBeVisible();
    await expect(page.locator('#propresenter-live')).toBeHidden();
    await expect(page.locator('#settings')).toBeHidden();

    // Clic sur "Régie" -> ses sections (settings/overlay) apparaissent.
    await page.locator('.sidebar .nav-item[data-sections="settings,overlay"]').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#analysis')).toBeHidden();

    // Retour à "Opérateur".
    await page
      .locator('.sidebar .nav-item[data-sections="propresenter-live,media-wall,studio"]')
      .click();
    await expect(page.locator('#propresenter-live')).toBeVisible();
    await expect(page.locator('#verseDisplay')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
  });
});
