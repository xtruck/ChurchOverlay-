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

    // AJOUT (audit — repères manquants relevés en ajoutant Airlock Preview/
    // Focus Mode à la palette) : trois entrées purement côté tableau de
    // bord (aucune action WS propre) doivent apparaître avec LEUR PROPRE
    // catégorie (categoryOverride), pas retomber dans "Système" faute d'une
    // entrée dans action-registry.js à traduire.
    await expect(
      page.locator('.command-palette-item[data-action="toggleFocusMode"]')
    ).toContainText('Mode focus');
    const focusModeCategory = await page
      .locator('.command-palette-item[data-action="toggleFocusMode"]')
      .getAttribute('data-category');
    expect(focusModeCategory).toBe('Affichage');

    const airlockCategory = await page
      .locator('.command-palette-item[data-action="disarmAirlock"]')
      .getAttribute('data-category');
    expect(airlockCategory).toBe('Média');

    // "Suivant" existait déjà côté feuille de route (bouton "▶") mais
    // n'avait jamais été ajouté à la palette — vérifie que le libellé vient
    // bien du registre (nextRundownCue y est déjà décrit), pas une valeur
    // de repli.
    await expect(page.locator('.command-palette-item[data-action="nextRundownCue"]')).toContainText(
      'Déclencher le repère suivant'
    );

    // AJOUT : au-delà du rendu, vérifie que cliquer l'exécute VRAIMENT —
    // toggleFocusMode() est un pur appel côté tableau de bord (pas de
    // message WS à intercepter), donc l'effet observable est la surcouche
    // #focusModeOverlay qui devient active.
    await page.locator('.command-palette-item[data-action="toggleFocusMode"]').click();
    await expect(page.locator('#focusModeOverlay')).toHaveClass(/active/);
    // Nettoyage : referme le mode focus pour ne pas laisser la page dans un
    // état surprenant pour un test suivant qui réutiliserait cette session.
    await page.locator('#focusModeExitBtn').click();
    await expect(page.locator('#focusModeOverlay')).not.toHaveClass(/active/);
  });
});
