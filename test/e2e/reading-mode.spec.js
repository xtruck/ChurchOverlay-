// test/e2e/reading-mode.spec.js — couvre le panneau mode lecture
// (dashboard/features/reading-mode.js), resté sans couverture
// automatisée jusqu'ici malgré le fait que la moitié de ses actions WS
// (nextReadingVerse/previousReadingVerse) modifie server.js's routage de
// sécurité (OPERATOR_ACTIONS) — voir test/test-reading-mode-ws-actions.js
// pour la couverture backend de ce point précis ; ce spec couvre le
// panneau lui-même (visibilité des boutons, affichage réel du verset).
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Panneau mode lecture', () => {
  test('Démarrer/Suivant/Précédent/Arrêter pilotent réellement le mode lecture', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();

    const startBtn = page.locator('#readingModeStartBtn');
    const stopBtn = page.locator('#readingModeStopBtn');
    const advanceRow = page.locator('#readingModeAdvanceRow');
    const badge = page.locator('#readingModeBadge');
    const position = page.locator('#readingModePosition');

    // État initial : seul le bouton Démarrer est visible.
    await expect(startBtn).toBeVisible();
    await expect(stopBtn).toBeHidden();
    await expect(advanceRow).toBeHidden();
    await expect(position).toBeHidden();

    await page.locator('#readingModeInput').fill('Jean 3:1');
    await startBtn.click();

    await expect(badge).toBeVisible();
    await expect(startBtn).toBeHidden();
    await expect(stopBtn).toBeVisible();
    await expect(advanceRow).toBeVisible();
    await expect(page.locator('#verseDisplay')).toHaveClass(/is-live/);
    await expect(page.locator('#verseReference')).toContainText('Jean 3:1');
    // Position de lecture diffusée par le serveur (readingModePos) : le
    // chapitre ET la progression sont affichés dans la carte.
    await expect(position).toBeVisible();
    await expect(position).toContainText('Jean 3');
    await expect(position).toContainText('verset 1/');

    await page.locator('#readingModeAdvanceRow').getByText('Suivant').click();
    await expect(page.locator('#verseReference')).toContainText('Jean 3:2');
    await expect(position).toContainText('verset 2/');

    await page.locator('#readingModeAdvanceRow').getByText('Précédent').click();
    await expect(page.locator('#verseReference')).toContainText('Jean 3:1');
    await expect(position).toContainText('verset 1/');

    await stopBtn.click();
    await expect(startBtn).toBeVisible();
    await expect(stopBtn).toBeHidden();
    await expect(advanceRow).toBeHidden();
    await expect(badge).toBeHidden();
    await expect(position).toBeHidden();
  });
});
