// test/e2e/candidate-verse.spec.js — bandeaux candidateVerse du tableau de
// bord (dashboard/features/verse-session-display.js > showCandidateVerse,
// câblé dans dashboard/ws-dispatch.js > case 'candidateVerse').
//
// Le serveur ne peut pas être piloté pour émettre une candidateVerse à la
// demande (elle provient du pipeline audio réel) — on injecte donc les
// messages directement dans le handleMessage() du dashboard via
// page.evaluate + import dynamique. Le module ES est mis en cache par URL :
// importer '/dashboard/ws-dispatch.js' ici (résolution relative à la
// racine servie à '/') réutilise EXACTEMENT la même instance de module que
// le <script type="module"> de dashboard.html — même état, même DOM.
//
// Couvre les 3 kind + le cycle de vie : spéculative (chapitre seul Étape 5,
// et référence explicite), fuzzy (Correction automatique, bandeau distinct),
// remplacement sans empilement, effacement au showVerse réel, et l'absence
// de "[object Object]" dans le flux d'activité.
'use strict';
const { test, expect } = require('@playwright/test');

test.describe('Bandeaux candidateVerse', () => {
  test('spéculative : bandeau "Référence entendue" affiché puis effacé au showVerse réel', async ({
    page,
  }) => {
    await page.goto('/');
    const candidateNotice = page.locator('#candidateNotice');

    await expect(candidateNotice).toBeHidden();

    // Chapitre seul d'un partial local finalisé (Étape 5) — spéculative.
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'candidateVerse',
        reference: { book: 'jean', chapter: 3 },
        confidence: 'medium',
        speculative: true,
        original: 'Jean chapitre 3 verset',
      });
    });

    await expect(candidateNotice).toBeVisible();
    await expect(candidateNotice).toContainText('Jean 3');
    await expect(candidateNotice).toContainText('en attente de confirmation');

    // Le vrai showVerse arrive (confirmation) -> le bandeau est effacé.
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'showVerse',
        reference: 'Jean 3:16',
        text: 'Car Dieu a tant aimé le monde...',
      });
    });

    await expect(candidateNotice).toBeHidden();
  });

  test('une nouvelle candidate remplace la précédente (jamais empilée)', async ({ page }) => {
    await page.goto('/');
    const candidateNotice = page.locator('#candidateNotice');

    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'candidateVerse',
        reference: { book: 'jean', chapter: 3, verseStart: 16 },
        confidence: 'high',
        speculative: true,
        original: 'Jean 3:16',
      });
    });
    await expect(candidateNotice).toContainText('Jean 3:16');

    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'candidateVerse',
        reference: { book: 'romains', chapter: 8, verseStart: 28 },
        confidence: 'high',
        speculative: true,
        original: 'Romains 8:28',
      });
    });
    await expect(candidateNotice).toContainText('Romains 8:28');
    await expect(candidateNotice).not.toContainText('Jean 3:16');
  });

  test('fuzzy : bandeau "Correction automatique" distinct du spéculatif', async ({ page }) => {
    await page.goto('/');
    const candidateNotice = page.locator('#candidateNotice');
    const fuzzyNotice = page.locator('#fuzzyMatchNotice');

    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'candidateVerse',
        reference: { book: 'jean', chapter: 14 },
        original: 'chapitre quatorze',
        distance: 0.87,
      });
    });

    await expect(fuzzyNotice).toBeVisible();
    await expect(fuzzyNotice).toContainText('Correction automatique');
    await expect(fuzzyNotice).toContainText('Jean 14');
    await expect(candidateNotice).toBeHidden();
  });

  test("l'activité affiche la référence, pas '[object Object]'", async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'candidateVerse',
        reference: { book: 'jean', chapter: 3 },
        confidence: 'medium',
        speculative: true,
        original: 'Jean chapitre 3 verset',
      });
    });

    const newestActivity = page.locator('#activityFeed .activity-item').first();
    await expect(newestActivity).toContainText('Verset candidat');
    await expect(newestActivity).toContainText('Jean 3');
    await expect(newestActivity).not.toContainText('[object Object]');
  });
});
