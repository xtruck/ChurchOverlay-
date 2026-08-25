// test/e2e/media-wall-states.spec.js — états par tuile du Mur Média
// (Partie 2.3) : "à l'écran", "déjà utilisé", "fichier manquant". Le
// serveur ne peut pas être piloté pour manquer un vrai fichier à la demande
// (voir media-library.js#listItems, fileMissing calculé sur le disque réel)
// — on injecte donc directement les messages WS via handleMessage(), même
// technique que candidate-verse.spec.js/trust-mode.spec.js.
'use strict';
const { test, expect } = require('./fixtures');

const ITEMS = [
  { id: 'm1', label: 'Photo groupe', filename: 'm1.jpg', mediaType: 'image', fileMissing: false },
  { id: 'm2', label: 'Vidéo intro', filename: 'm2.mp4', mediaType: 'video', fileMissing: false },
  { id: 'm3', label: 'Poster disparu', filename: 'm3.jpg', mediaType: 'image', fileMissing: true },
];

test.describe('Mur Média — états par tuile', () => {
  test('fichier manquant : barré, jamais cliquable', async ({ page }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();

    await page.evaluate(async (items) => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'mediaLibraryUpdated', items });
    }, ITEMS);

    const missingCard = page.locator('.media-gallery-card[data-media-id="m3"]');
    await expect(missingCard).toHaveClass(/is-missing/);
    await expect(missingCard.locator('.media-gallery-label')).toHaveCSS(
      'text-decoration-line',
      'line-through'
    );
  });

  test('à l’écran / déjà utilisé : bascule à chaque showMedia, sans reconstruire la grille', async ({
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

    await expect(card1).not.toHaveClass(/is-on-screen/);
    await expect(card1).not.toHaveClass(/is-used/);

    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'showMedia', id: 'm1', label: 'Photo groupe', mediaType: 'image' });
    });
    await expect(card1).toHaveClass(/is-on-screen/);
    await expect(card1).toHaveClass(/is-used/);

    // Un second média affiché : le premier n'est plus "à l'écran" mais
    // reste marqué "déjà utilisé" (jamais oublié pour le reste de la session).
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'showMedia', id: 'm2', label: 'Vidéo intro', mediaType: 'video' });
    });
    await expect(card1).not.toHaveClass(/is-on-screen/);
    await expect(card1).toHaveClass(/is-used/);
    await expect(card2).toHaveClass(/is-on-screen/);

    // Un verset affiché ensuite : l'overlay n'affiche qu'une seule chose à
    // la fois, donc plus aucun média n'est "à l'écran".
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'showVerse', reference: 'Jean 3:16', text: '...' });
    });
    await expect(card2).not.toHaveClass(/is-on-screen/);
    await expect(card2).toHaveClass(/is-used/);
  });
});
