// test/e2e/translation-picker.spec.js — couvre le sélecteur de version
// biblique et, avec lui, le tout premier traitement du message 'init'
// côté tableau de bord (jusqu'à ce lot, entièrement ignoré — voir
// dashboard/ws-dispatch.js).
'use strict';
const { test, expect } = require('@playwright/test');

test.describe('Sélecteur de version biblique', () => {
  test('se peuple depuis le message init et se met à jour après un changement', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .locator('.sidebar .nav-item[data-sections*="controls,analysis,settings,overlay"]')
      .click();

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
});
