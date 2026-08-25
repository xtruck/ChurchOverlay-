// test/e2e/media-wall-hotkeys-search.spec.js — recherche instantanée +
// touches 1-9 du Mur Média (Partie 2.3, parité manuelle/clavier).
'use strict';
const { test, expect } = require('./fixtures');

const ITEMS = [
  {
    id: 'm1',
    label: 'Photo groupe jeunesse',
    filename: 'm1.jpg',
    mediaType: 'image',
    triggerPhrases: ['photo jeunesse'],
  },
  {
    id: 'm2',
    label: 'Vidéo intro culte',
    filename: 'm2.mp4',
    mediaType: 'video',
    triggerPhrases: ['video intro'],
  },
  {
    id: 'm3',
    label: 'Poster annonces',
    filename: 'm3.jpg',
    mediaType: 'image',
    triggerPhrases: ['annonces'],
  },
];

test.describe('Mur Média — recherche instantanée et touches 1-9', () => {
  test('la recherche filtre par nom OU phrase déclencheuse, et renumérote les touches', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();

    await page.evaluate(async (items) => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'mediaLibraryUpdated', items });
    }, ITEMS);

    const card1 = page.locator('.media-gallery-card[data-media-id="m1"]');
    const card2 = page.locator('.media-gallery-card[data-media-id="m2"]');
    const card3 = page.locator('.media-gallery-card[data-media-id="m3"]');

    // Les 3 tuiles visibles au départ -> numérotées 1, 2, 3.
    await expect(card1.locator('.media-gallery-hotkey')).toHaveText('1');
    await expect(card2.locator('.media-gallery-hotkey')).toHaveText('2');
    await expect(card3.locator('.media-gallery-hotkey')).toHaveText('3');

    // Filtre sur une phrase déclencheuse (pas le nom) -> ne garde que m2.
    await page.locator('#mediaWallSearchInput').fill('video intro');
    await expect(card1).toBeHidden();
    await expect(card2).toBeVisible();
    await expect(card3).toBeHidden();
    // Renuméroté : seule tuile visible -> hotkey "1", pas "2".
    await expect(card2.locator('.media-gallery-hotkey')).toHaveText('1');

    // Filtre vidé -> tout redevient visible.
    await page.locator('#mediaWallSearchInput').fill('');
    await expect(card1).toBeVisible();
    await expect(card2).toBeVisible();
    await expect(card3).toBeVisible();
  });

  test('la touche 1 déclenche la première tuile visible, jamais pendant une saisie', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();

    await page.evaluate(async (items) => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'mediaLibraryUpdated', items });
    }, ITEMS);

    // Intercepte l'envoi WS pour vérifier QUEL média la touche 1 déclenche,
    // sans dépendre d'un vrai aller-retour serveur.
    await page.evaluate(() => {
      window.__sentActions = [];
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          window.__sentActions.push(JSON.parse(data));
        } catch (_) {}
        return originalSend.call(this, data);
      };
    });

    // Pendant une saisie : la touche 1 doit taper "1", pas déclencher un média.
    await page.locator('#mediaWallSearchInput').click();
    await page.keyboard.press('1');
    await expect(page.locator('#mediaWallSearchInput')).toHaveValue('1');
    let sent = await page.evaluate(() => window.__sentActions);
    expect(sent.some((a) => a.action === 'triggerMediaItem')).toBe(false);

    // Hors saisie : la touche 1 déclenche bien la première tuile visible (m1).
    await page.locator('#mediaWallSearchInput').fill('');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('1');
    sent = await page.evaluate(() => window.__sentActions);
    const trigger = sent.find((a) => a.action === 'triggerMediaItem');
    expect(trigger).toBeTruthy();
    expect(trigger.id).toBe('m1');
  });
});
