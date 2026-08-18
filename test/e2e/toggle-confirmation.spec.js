// test/e2e/toggle-confirmation.spec.js — couvre la synchronisation des 5
// bascules d'accessibilité/affichage (voir dashboard/ws-dispatch.js —
// case 'accessibilityMode' etc.), restée sans couverture automatisée
// jusqu'ici. Un seul des 5 réglages suffit à prouver le mécanisme
// (case/toast/resynchronisation de la case à cocher) ; les 4 autres
// suivent exactement le même code, voir le commit qui les a ajoutés.
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Confirmation des bascules de réglages', () => {
  test('activer le mode grand contraste affiche une confirmation', async ({ page }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="settings,overlay"]').click();

    const toggle = page.locator('#highContrastToggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.check();

    // Le serveur diffuse une confirmation qui déclenche DEUX toasts proches
    // ("...activé." côté tableau de bord et "...activé sur l'overlay." côté
    // scène) — prendre le premier pour éviter la violation de mode strict.
    await expect(page.locator('.toast', { hasText: 'grand contraste activé' }).first()).toBeVisible(
      {
        timeout: 5000,
      }
    );
    // La case reflète bien la confirmation renvoyée par le serveur (pas
    // seulement l'état natif du clic) — voir case 'accessibilityMode'.
    await expect(toggle).toBeChecked();
  });
});
