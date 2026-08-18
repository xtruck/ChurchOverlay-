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
    await expect(page.locator('#verseDisplay')).toBeVisible();
    // CORRECTIF (audit e2e — stale depuis la refonte "trois espaces") : le
    // dashboard a depuis été réorganisé en 3 espaces (Direct/Préparation/
    // Régie, voir dashboard/state.js), pas les 2 anciens onglets "En
    // Direct"/"Réglages" que cette assertion et les sélecteurs
    // data-sections ci-dessous supposaient encore. showSectionsFor()
    // (dashboard/state.js) affiche TOUTES les sections listées dans
    // data-sections de l'item actif, y compris au chargement initial (pas
    // seulement "overview" sans display:none en dur) — #controls fait donc
    // partie du groupe "Direct" actif par défaut, il n'est plus masqué.
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Direct');

    // Espace "Direct" (actif par défaut) : ses 3 sections groupées sont
    // visibles ensemble, celles des 2 autres espaces sont masquées.
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#controls')).toBeVisible();
    await expect(page.locator('#analysis')).toBeHidden();
    await expect(page.locator('#settings')).toBeHidden();

    // Clic sur "Préparation" -> ses sections (analysis/studio/media-wall)
    // apparaissent, celles de "Direct" disparaissent.
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();
    await expect(page.locator('#analysis')).toBeVisible();
    await expect(page.locator('#overview')).toBeHidden();
    await expect(page.locator('#controls')).toBeHidden();

    // Clic sur "Régie" -> ses sections (settings/overlay) apparaissent.
    await page.locator('.sidebar .nav-item[data-sections="settings,overlay"]').click();
    await expect(page.locator('#settings')).toBeVisible();
    await expect(page.locator('#analysis')).toBeHidden();

    // Retour à "Direct".
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#controls')).toBeVisible();
    await expect(page.locator('#settings')).toBeHidden();
  });
});
