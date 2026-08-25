// test/e2e/command-palette.spec.js — la palette Ctrl+K doit lire ses
// libellés/catégories depuis action-registry.js (window.ACTION_REGISTRY,
// chargé en <script> classique par dashboard.html), pas d'une liste dupliquée
// à la main dans command-palette.js (voir Partie 2.4 du chantier — "un seul
// vocabulaire pour la voix et le manuel").
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Palette de commandes (Ctrl+K)', () => {
  test('window.ACTION_REGISTRY est chargé et les libellés de la palette en dérivent réellement', async ({
    page,
  }) => {
    await page.goto('/');

    // window.ACTION_REGISTRY doit exister AVANT que command-palette.js (un
    // module différé) ne s'exécute — c'est tout l'objet du <script src=
    // "action-registry.js"> classique ajouté dans dashboard.html.
    const emergencyDescription = await page.evaluate(
      () => window.ACTION_REGISTRY?.CLIENT_ACTIONS?.emergencyClear?.description
    );
    expect(emergencyDescription).toBe('Effacer tout immédiatement');

    await page.keyboard.press('Control+k');
    await expect(page.locator('#commandPalette')).toHaveClass(/open/);

    // Le libellé affiché pour 'emergencyClear' doit être EXACTEMENT la
    // description du registre, pas un texte codé en dur en parallèle — si
    // quelqu'un modifie la description dans action-registry.js sans toucher
    // command-palette.js, ce test doit le refléter automatiquement.
    const item = page.locator('.command-palette-item[data-action="emergencyClear"]');
    await expect(item).toContainText(emergencyDescription);

    // Une action « paramétrée » (les 3 variantes setLanguage-*) doit quand
    // même apparaître : ce sont des valeurs de paramètre, pas des entrées du
    // registre — leur label reste un texte propre à la palette, mais elles
    // ne doivent pas disparaître ni planter le rendu.
    await expect(page.locator('.command-palette-item[data-action="setLanguage-fr"]')).toContainText(
      'Changer langue FR'
    );
  });
});
