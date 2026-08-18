// test/e2e/translation-picker.spec.js — couvre le sélecteur de version
// biblique et, avec lui, le tout premier traitement du message 'init'
// côté tableau de bord (jusqu'à ce lot, entièrement ignoré — voir
// dashboard/ws-dispatch.js).
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Sélecteur de version biblique', () => {
  test('se peuple depuis le message init et se met à jour après un changement', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();

    const frButtons = page.locator('#translationPicker [data-translation-lang="fr"]');
    await expect(frButtons).toHaveCount(2, { timeout: 5000 });

    const lsgBtn = page.locator('[data-translation-lang="fr"][data-translation-code="lsg"]');
    const darbyBtn = page.locator('[data-translation-lang="fr"][data-translation-code="darby"]');
    await expect(lsgBtn).toHaveClass(/active/);
    await expect(darbyBtn).not.toHaveClass(/active/);

    await darbyBtn.click();
    await expect(darbyBtn).toHaveClass(/active/);
    await expect(lsgBtn).not.toHaveClass(/active/);
  });

  test('la comparaison de traduction secondaire se peuple et se synchronise entre postes', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();

    const select = page.locator('#secondaryTranslationSelect');
    // 4 traductions au total dans FAKE_TRANSLATIONS (2 fr + 2 en) + "Aucune".
    await expect(select.locator('option')).toHaveCount(5, { timeout: 5000 });
    await expect(select).toHaveValue('');

    await select.selectOption('fr|darby');
    // AJOUT : simule un second poste opérateur connecté — vérifie que le
    // réglage se synchronise entre les deux (secondaryTranslationChanged
    // diffusé à tous les clients, pas seulement à celui qui a cliqué), même
    // raisonnement que dashboard-branding.spec.js pour un autre réglage.
    const context = page.context();
    const secondPage = await context.newPage();
    await secondPage.goto('/');
    await secondPage
      .locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]')
      .click();
    await expect(secondPage.locator('#secondaryTranslationSelect')).toHaveValue('fr|darby', {
      timeout: 5000,
    });
    await secondPage.close();

    // Désactivation : revient à "Aucune".
    await select.selectOption('');
    await expect(select).toHaveValue('');
  });
});
