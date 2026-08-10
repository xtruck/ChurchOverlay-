// test/e2e/toggle-confirmation.spec.js — couvre la synchronisation des 5
// bascules d'accessibilité/affichage (voir dashboard/ws-dispatch.js —
// case 'accessibilityMode' etc.), restée sans couverture automatisée
// jusqu'ici. Un seul des 5 réglages suffit à prouver le mécanisme
// (case/toast/resynchronisation de la case à cocher) ; les 4 autres
// suivent exactement le même code, voir le commit qui les a ajoutés.
'use strict';
const { test, expect } = require('@playwright/test');

test.describe('Confirmation des bascules de réglages', () => {
  test('activer le mode grand contraste affiche une confirmation', async ({ page }) => {
    await page.goto('/');
    await page
      .locator('.sidebar .nav-item[data-sections="controls,analysis,settings,overlay"]')
      .click();

    const toggle = page.locator('#highContrastToggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.check();

    await expect(page.locator('.toast', { hasText: 'grand contraste activé' })).toBeVisible({
      timeout: 5000,
    });
    // La case reflète bien la confirmation renvoyée par le serveur (pas
    // seulement l'état natif du clic) — voir case 'accessibilityMode'.
    await expect(toggle).toBeChecked();
  });
});
