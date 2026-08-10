// test/e2e/hero-live-state.spec.js — couvre le lot 6 du redesign visuel
// (carte verset en direct qui reflète réellement l'état "à l'écran ou
// pas"), resté sans couverture automatisée jusqu'ici. Une connexion WS
// brute (même serveur de test que la page) simule un autre client
// envoyant showVerse/hideVerse — server.js diffuse à tous les clients
// connectés, y compris la page Playwright, exactement comme un second
// opérateur ou l'overlay le ferait.
'use strict';
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');

function connectRaw(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test.describe('Carte verset en direct — état .is-live', () => {
  test('affiche le halo "en direct" seulement pendant qu’un verset est réellement affiché', async ({
    page,
  }) => {
    const port = process.env.PORT || 8770;
    await page.goto('/');

    const heroCard = page.locator('#verseDisplay');
    await expect(heroCard).not.toHaveClass(/is-live/);

    const raw = await connectRaw(port);
    raw.send(
      JSON.stringify({
        action: 'showVerse',
        reference: 'Jean 3:16',
        text: "Car Dieu a tant aimé le monde qu'il a donné son Fils unique.",
      })
    );

    await expect(heroCard).toHaveClass(/is-live/);
    await expect(page.locator('#verseReference')).toContainText('Jean 3:16');

    raw.send(JSON.stringify({ action: 'hideVerse' }));
    await expect(heroCard).not.toHaveClass(/is-live/);

    raw.close();
  });
});
