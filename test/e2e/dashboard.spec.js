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
    // CORRECTIF (audit e2e — stale depuis PR #259, refonte "Studio Pro") :
    // le dashboard a désormais 4 espaces (voir dashboard.html sidebar),
    // pas les 3 précédents — "Studio Pro" (data-sections="propresenter-live")
    // a été ajouté et est maintenant l'espace actif par défaut au
    // chargement, avant "Direct Classique" (overview/transcript/controls,
    // ex-"Direct"). #verseDisplay/#overview/#controls vivent dans l'espace
    // "Direct Classique" et ne sont donc plus visibles au chargement.
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Studio Pro');
    await expect(page.locator('#propresenter-live')).toBeVisible();
    await expect(page.locator('#overview')).toBeHidden();

    // Clic sur "Direct Classique" -> ses sections apparaissent, "Studio Pro"
    // disparaît.
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Direct Classique');
    await expect(page.locator('#verseDisplay')).toBeVisible();
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#controls')).toBeVisible();
    await expect(page.locator('#propresenter-live')).toBeHidden();
    await expect(page.locator('#analysis')).toBeHidden();
    await expect(page.locator('#settings')).toBeHidden();

    // Clic sur "Préparation" -> ses sections (analysis/studio/media-wall)
    // apparaissent, celles de "Direct Classique" disparaissent.
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();
    await expect(page.locator('#analysis')).toBeVisible();
    await expect(page.locator('#overview')).toBeHidden();
    await expect(page.locator('#controls')).toBeHidden();

    // Clic sur "Régie" -> ses sections (settings/overlay) apparaissent.
    await page.locator('.sidebar .nav-item[data-sections="settings,overlay"]').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#analysis')).toBeHidden();

    // Retour à "Direct Classique".
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#controls')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
  });
});
