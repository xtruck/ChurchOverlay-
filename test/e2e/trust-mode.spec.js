// test/e2e/trust-mode.spec.js — Mode confiance (Partie 2 : auto/semi-auto/
// manuel). Le pipeline de détection réel (server.js > processTranscript) est
// déjà couvert en profondeur par test/integration-trust-mode.js (vrai
// server.js, mocks réseau/micro) — ce test-ci couvre uniquement ce qui est
// spécifique au NAVIGATEUR : la bascule de mode (round-trip WS réel, même
// technique que toggle-confirmation.spec.js), le bandeau de confirmation
// (injecté via handleMessage(), même technique que candidate-verse.spec.js
// puisque le serveur ne peut pas être piloté pour émettre une détection à la
// demande depuis un test e2e), et surtout le garde-fou de la barre d'espace :
// elle ne doit JAMAIS être interceptée pendant une saisie ailleurs (recherche
// biblique, palette Ctrl+K...).
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Mode confiance', () => {
  test('cliquer un mode le rend actif (round-trip serveur réel)', async ({ page }) => {
    await page.goto('/');

    const autoBtn = page.locator('.trust-mode-btn[data-trust-mode="auto"]');
    const semiAutoBtn = page.locator('.trust-mode-btn[data-trust-mode="semi-auto"]');
    await expect(autoBtn).toHaveClass(/active/);
    await expect(semiAutoBtn).not.toHaveClass(/active/);

    await semiAutoBtn.click();
    await expect(semiAutoBtn).toHaveClass(/active/, { timeout: 5000 });
    await expect(autoBtn).not.toHaveClass(/active/);

    // Restaure 'auto' pour ne pas laisser un état de mode qui fuiterait sur
    // un autre test lancé contre le même serveur e2e.
    await autoBtn.click();
    await expect(autoBtn).toHaveClass(/active/, { timeout: 5000 });
  });

  test('bandeau de confirmation : apparaît sur pendingVerseConfirmation, disparaît sur pendingVerseDismissed/showVerse', async ({
    page,
  }) => {
    await page.goto('/');
    const banner = page.locator('#pendingVerseBanner');
    await expect(banner).toBeHidden();

    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'pendingVerseConfirmation',
        reference: 'Jean 3:16',
        textPreview: 'Car Dieu a tant aimé le monde...',
        trustMode: 'semi-auto',
      });
    });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Jean 3:16');

    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'pendingVerseDismissed', reference: 'Jean 3:16' });
    });
    await expect(banner).toBeHidden();

    // Un vrai showVerse (confirmation acceptée, ou mode auto) efface aussi
    // le bandeau s'il était visible.
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'pendingVerseConfirmation',
        reference: 'Jean 3:17',
        textPreview: 'Car Dieu n’a pas envoyé son Fils...',
        trustMode: 'semi-auto',
      });
    });
    await expect(banner).toBeVisible();
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'showVerse', reference: 'Jean 3:17', text: '...' });
    });
    await expect(banner).toBeHidden();
  });

  test("la barre d'espace ne doit jamais être interceptée pendant une saisie (recherche/palette)", async ({
    page,
  }) => {
    await page.goto('/');

    // Bandeau visible : si le garde-fou "contexte de saisie" échouait, la
    // frappe Espace ci-dessous serait avalée par confirmPendingVerse() au
    // lieu de taper un espace dans le champ.
    await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({
        action: 'pendingVerseConfirmation',
        reference: 'Jean 3:16',
        textPreview: '...',
        trustMode: 'semi-auto',
      });
    });
    await expect(page.locator('#pendingVerseBanner')).toBeVisible();

    await page.keyboard.press('Control+k');
    const paletteInput = page.locator('.command-palette-input');
    await expect(paletteInput).toBeVisible();
    await paletteInput.type('mot cle');

    // Si la barre d'espace avait été interceptée globalement, le caractère
    // espace manquerait dans le champ (ou le bandeau aurait disparu suite à
    // un confirmPendingVerse() déclenché par erreur).
    await expect(paletteInput).toHaveValue('mot cle');
    await expect(page.locator('#pendingVerseBanner')).toBeVisible();
  });
});
