// test/e2e/media-groups.spec.js — panneau Groupes de médias (Partie 2.3).
// La logique de rotation elle-même est couverte en profondeur par
// test/integration-media-groups.js (vrai server.js) — ce test-ci couvre
// uniquement le rendu/câblage NAVIGATEUR : le panneau affiche les groupes
// reçus, et le sélecteur "Groupe" de chaque média reflète bien son
// rattachement.
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Groupes de médias', () => {
  test('le panneau affiche les groupes, et le sélecteur média reflète le rattachement', async ({
    page,
  }) => {
    await page.goto('/');
    // CORRECTIF (audit e2e — stale depuis PR #259, refonte "Studio Pro") :
    // #mediaGroupsList vit dans #overview ("Direct Classique"), plus
    // l'espace actif par défaut (voir dashboard.spec.js).
    await page.locator('.sidebar .nav-item[data-sections="overview,transcript,controls"]').click();

    const groups = [
      { id: 'g1', name: 'Photos jeunesse', triggerPhrases: ['photo jeunesse'], memberIds: ['m1'] },
    ];
    const items = [
      {
        id: 'm1',
        label: 'Photo A',
        filename: 'm1.jpg',
        mediaType: 'image',
        triggerPhrases: ['photo a'],
        group: 'g1',
      },
      {
        id: 'm2',
        label: 'Photo B',
        filename: 'm2.jpg',
        mediaType: 'image',
        triggerPhrases: ['photo b'],
        group: null,
      },
    ];

    await page.evaluate(
      async ({ groups, items }) => {
        const { handleMessage } = await import('/dashboard/ws-dispatch.js');
        handleMessage({ action: 'mediaLibraryUpdated', items });
        handleMessage({ action: 'mediaGroupsUpdated', groups });
      },
      { groups, items }
    );

    await expect(page.locator('#mediaGroupsList')).toContainText('Photos jeunesse');
    await expect(page.locator('#mediaGroupsList')).toContainText('1 média');

    // Le sélecteur du média rattaché (m1) doit refléter le groupe ; celui du
    // média non rattaché (m2) doit rester sur "Aucun groupe".
    await expect(page.locator('#mediaGroup-m1')).toHaveValue('g1');
    await expect(page.locator('#mediaGroup-m2')).toHaveValue('');

    // Changer le sélecteur envoie bien la vraie action WS (interceptée, sans
    // dépendre d'un aller-retour serveur réel — couvert côté serveur par
    // integration-media-groups.js).
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
    await page.locator('#mediaGroup-m2').selectOption('g1');
    const sent = await page.evaluate(() => window.__sentActions);
    const action = sent.find((a) => a.action === 'setMediaItemGroup');
    expect(action).toBeTruthy();
    expect(action.itemId).toBe('m2');
    expect(action.groupId).toBe('g1');
  });
});
