// test/e2e/dashboard-branding.spec.js — couvre l'identité de marque du
// tableau de bord (voir dashboard/features/dashboard-branding.js et
// dashboard-branding-store.js), la fonctionnalité centrale du chantier
// "revente en produit clé en main" : nom d'organisation + couleur
// d'accent enregistrés depuis le panneau, appliqués immédiatement, ET
// persistés (revérifié après un rechargement complet de la page, pas
// seulement l'état en mémoire). Le choix de logo n'est PAS couvert ici —
// window.churchOverlay.pickMediaFile() est un sélecteur de fichier natif
// Electron, pas testable de façon significative dans un navigateur
// headless sans lui ; reste un contrôle manuel uniquement.
'use strict';
const { test, expect } = require('./fixtures');
const WebSocket = require('ws');

function resetDashboardBranding(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'setDashboardOrgName', organizationName: '' }));
      ws.send(JSON.stringify({ action: 'setDashboardAccentColor', accentColor: '#7c8cf5' }));
      setTimeout(() => {
        ws.close();
        resolve();
      }, 200);
    });
    ws.on('error', () => resolve());
  });
}

test.describe('Identité de marque du tableau de bord', () => {
  // AJOUT : ce test PERSISTE réellement (dashboard-branding-store.js écrit
  // sur disque) — et server.js/test/e2e/start-server.js, comme
  // test/test-ws-auth.js, n'isole pas USER_DATA_DIR pour les tests
  // (tombe sur ~/.churchoverlay par défaut, faute de workerData). Pas un
  // problème nouveau (déjà vrai avant ce fichier), mais le premier test de
  // cette suite e2e dont l'effet de bord serait visible par l'utilisateur
  // réel (le nom/couleur de SA vraie installation changerait). Remet les
  // valeurs par défaut après le test (via une connexion WS brute, même
  // motif que hero-live-state.spec.js) plutôt que d'élargir la portée de
  // ce lot à l'isolation de USER_DATA_DIR pour toute la suite de tests.
  test.afterEach(async () => {
    await resetDashboardBranding(process.env.PORT || 8770);
  });

  test('le nom et la couleur d’accent s’appliquent immédiatement et persistent après rechargement', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .locator('.sidebar .nav-item[data-sections="settings,overlay"]')
      .click();

    await expect(page.locator('#brandTitle')).toHaveText('ChurchOverlay');

    await page.locator('#dashboardOrgNameInput').fill('Grace Community Church');
    await page.getByRole('button', { name: 'Enregistrer le nom' }).click();
    await expect(page.locator('.sidebar #brandTitle')).toHaveText('Grace Community Church');

    await page.locator('#dashboardAccentColorInput').fill('#22c55e');
    await page.locator('#dashboardAccentColorInput').dispatchEvent('change');

    const primaryAfterSet = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    );
    expect(primaryAfterSet.toLowerCase()).toBe('#22c55e');

    // Persistance : un rechargement complet doit retrouver le même état via
    // le message 'init' (voir server.js > getDashboardBrandingState()),
    // pas seulement l'état en mémoire de cette page.
    await page.reload();
    await expect(page.locator('#brandTitle')).toHaveText('Grace Community Church');
    const primaryAfterReload = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    );
    expect(primaryAfterReload.toLowerCase()).toBe('#22c55e');
  });
});
