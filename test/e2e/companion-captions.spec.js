// test/e2e/companion-captions.spec.js — couvre le chantier 4.4 (sous-titres
// en direct sur companion.html, page QR "second écran" pour l'assemblée).
// /api/captions n'a pas de chemin WS pour injecter un texte de sous-titre
// directement (updateLiveCaption() dans server.js n'est appelé que par le
// vrai pipeline ASR, jamais mocké dans la suite e2e) — ce test couvre donc
// ce qu'on peut réellement observer dans un vrai navigateur : la page
// charge sans erreur JS, le bandeau reste invisible par défaut, et reste
// invisible même une fois les sous-titres activés côté opérateur tant
// qu'aucun texte n'est encore arrivé (pas de fausse apparition vide).
'use strict';
const { test, expect } = require('./fixtures');
const WebSocket = require('ws');

function connectRaw(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test.describe('Sous-titres en direct sur companion.html', () => {
  test("le bandeau reste masqué par défaut et tant qu'aucun texte n'est arrivé", async ({
    page,
  }) => {
    const port = process.env.PORT || 8770;
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto('/companion');
    await expect(page.locator('#captionBar')).not.toHaveClass(/visible/);

    const raw = await connectRaw(port);
    raw.send(JSON.stringify({ action: 'setCaptions', enabled: true }));

    // Le bandeau reste masqué : /api/captions renvoie enabled=true mais
    // text=null (aucun segment ASR simulé dans cette suite) -- la page ne
    // doit jamais afficher un bandeau vide.
    await page.waitForTimeout(4200); // laisse au moins un cycle de sondage (4000ms) s'exécuter
    await expect(page.locator('#captionBar')).not.toHaveClass(/visible/);

    raw.send(JSON.stringify({ action: 'setCaptions', enabled: false }));
    raw.close();

    expect(
      consoleErrors,
      `aucune erreur JS pendant le chargement/sondage : ${consoleErrors.join('; ')}`
    ).toEqual([]);
  });
});
