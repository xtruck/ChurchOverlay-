// test/e2e/action-delegator.spec.js — délégation d'événements pour le
// contenu rendu dynamiquement (voir dashboard/action-delegator.js). Preuve
// de concept sur media-library.js (chantier "délégation dynamique") :
// aucun autre test e2e n'exerçait un VRAI clic sur un élément
// `[data-action]` (media-wall-*.spec.js injecte l'état via handleMessage()
// mais ne clique la tuile que via le clavier, jamais la souris) — ce
// fichier ferme ce trou pour la mécanique elle-même : clic réel -> bon
// gestionnaire résolu par `target:action` -> bon message WS envoyé avec le
// bon `data-id`. Interception au niveau WebSocket.prototype.send (pas un
// import de state.js) pour rester valable quelle que soit l'encapsulation
// interne du module — capte tout envoi, y compris ceux déjà en vol au
// moment du patch.
'use strict';
const { test, expect } = require('./fixtures');

const ITEM = {
  id: 'delegator-test-1',
  label: 'Média test délégation',
  filename: 'delegator-test-1.jpg',
  mediaType: 'image',
  triggerPhrases: [],
  fileMissing: false,
  isDefault: false,
  includeInLoop: false,
};

async function seedOneMediaItem(page) {
  await page.evaluate(async (item) => {
    const { handleMessage } = await import('/dashboard/ws-dispatch.js');
    handleMessage({ action: 'mediaLibraryUpdated', items: [item] });
  }, ITEM);
}

async function captureSentActions(page) {
  await page.evaluate(() => {
    window.__sentActions = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        window.__sentActions.push(JSON.parse(data));
      } catch (_) {
        // message non-JSON (ne devrait jamais arriver ici) : ignoré, pas
        // pertinent pour ce test.
      }
      return originalSend.call(this, data);
    };
  });
}

test.describe('Délégation d’événements dynamiques (action-delegator.js, PoC media-library.js)', () => {
  test('un clic réel sur [data-action="delete"] envoie deleteMediaItem avec le bon id', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();
    await captureSentActions(page);
    await seedOneMediaItem(page);

    const card = page.locator(`.media-gallery-card:has([data-id="${ITEM.id}"])`).first();
    await card.locator('[data-action="delete"][data-target="media"]').click();

    const sent = await page.evaluate(() => window.__sentActions);
    const deleteMsg = sent.find((m) => m.action === 'deleteMediaItem');
    expect(deleteMsg, JSON.stringify(sent)).toBeTruthy();
    expect(deleteMsg.id).toBe(ITEM.id);
  });

  test('un clic réel sur [data-action="trigger"] envoie triggerMediaItem avec le bon id', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();
    await captureSentActions(page);
    await seedOneMediaItem(page);

    const card = page.locator(`.media-gallery-card:has([data-id="${ITEM.id}"])`).first();
    await card.locator('[data-action="trigger"][data-target="media"]').click();

    const sent = await page.evaluate(() => window.__sentActions);
    const triggerMsg = sent.find((m) => m.action === 'triggerMediaItem');
    expect(triggerMsg, JSON.stringify(sent)).toBeTruthy();
    expect(triggerMsg.id).toBe(ITEM.id);
  });

  test('un clic réel sur [data-action="toggle-default"] envoie setDefaultMediaItem, data-is-default lu correctement', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();
    await captureSentActions(page);
    await seedOneMediaItem(page); // isDefault: false -> data-is-default="false"

    const card = page.locator(`.media-gallery-card:has([data-id="${ITEM.id}"])`).first();
    const toggleBtn = card.locator('[data-action="toggle-default"][data-target="media"]');
    await expect(toggleBtn).toHaveAttribute('data-is-default', 'false');
    await toggleBtn.click();

    const sent = await page.evaluate(() => window.__sentActions);
    const setDefaultMsg = sent.find((m) => m.action === 'setDefaultMediaItem');
    expect(setDefaultMsg, JSON.stringify(sent)).toBeTruthy();
    // isCurrentlyDefault=false -> setDefaultMediaItem envoie l'id (pas null)
    // pour LE DÉFINIR comme poster principal — voir media-library.js.
    expect(setDefaultMsg.id).toBe(ITEM.id);
  });

  test('un data-action sans gestionnaire enregistré échoue bruyamment (console.error), pas silencieusement', async ({
    page,
  }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await page.evaluate(() => {
      const probe = document.createElement('button');
      probe.id = 'delegatorProbeBtn';
      probe.dataset.action = 'does-not-exist';
      probe.dataset.target = 'nothing';
      document.body.appendChild(probe);
    });
    await page.locator('#delegatorProbeBtn').click();

    expect(consoleErrors.some((m) => m.includes('[action-delegator] no handler'))).toBe(true);
  });
});
