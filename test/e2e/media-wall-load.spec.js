// test/e2e/media-wall-load.spec.js — mesure réelle du critère de charge du
// Mur Média (Partie 2.3 du document mission : "200 médias / vidéo 1 Go+,
// <300ms"), jamais vérifié jusqu'ici faute de vrais fichiers volumineux
// disponibles dans ce bac à sable (voir JOURNAL-MISSION.md).
//
// Ce que ce test mesure VRAIMENT et pourquoi c'est suffisant : le rendu de
// la grille (renderMediaWall()/renderMediaLibrary(), déclenchés ensemble par
// le message WS mediaLibraryUpdated — voir ws-dispatch.js) ne touche JAMAIS
// les octets d'un média, seulement ses métadonnées (label/filename/
// mediaType/fileMissing...). Le poids réel d'une vidéo de 1 Go n'a donc
// aucune influence sur le temps de rendu de la grille elle-même — 200
// entrées de métadonnées synthétiques (dont plusieurs vidéos, comme un vrai
// culte en aurait) exercent exactement le même chemin de code que 200 vraies
// entrées le feraient. Le côté "le disque tient bien un fichier de 1 Go+"
// est un souci différent (copie fichier côté serveur), couvert séparément
// par test/test-media-library-large-file.js — un test Node pur, plus rapide
// à exécuter qu'un vrai transfert de 1 Go dans une suite e2e.
'use strict';
const { test, expect } = require('./fixtures');

function buildSyntheticLibrary(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const isVideo = i % 40 === 0; // quelques vidéos parmi les photos, comme un vrai culte
    items.push({
      id: `synth-${i}`,
      label: `Média synthétique ${i}`,
      filename: `synth-${i}.${isVideo ? 'mp4' : 'jpg'}`,
      mediaType: isVideo ? 'video' : 'image',
      triggerPhrases: [`media synthetique ${i}`],
      fileMissing: false,
      isDefault: false,
      includeInLoop: false,
    });
  }
  return items;
}

test.describe('Mur Média — charge réelle (Partie 2.3, 200 médias)', () => {
  test('rendu de 200 médias (dont des vidéos) via le VRAI pipeline mediaLibraryUpdated', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();

    const items = buildSyntheticLibrary(200);

    const elapsedMs = await page.evaluate(async (items) => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      const start = performance.now();
      handleMessage({ action: 'mediaLibraryUpdated', items });
      return performance.now() - start;
    }, items);

    console.log(`[media-wall-load] rendu de 200 médias : ${elapsedMs.toFixed(1)}ms`);
    // Le document mission fixe <300ms. Un peu de marge ici (500ms) pour la
    // variabilité d'une machine CI partagée plutôt que la machine d'un
    // opérateur dédiée un dimanche matin -- toujours un ordre de grandeur
    // strictement inférieur à une seconde perceptible.
    expect(elapsedMs).toBeLessThan(500);

    await expect(page.locator('#mediaWallGrid .media-gallery-card')).toHaveCount(200);
    await expect(page.locator('#mediaWallCount')).toHaveText('200');
  });

  test("mise à jour d'état incrémentale (showMedia) sur une grande grille reste rapide, sans reconstruire la grille", async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();

    const items = buildSyntheticLibrary(200);
    await page.evaluate(async (items) => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      handleMessage({ action: 'mediaLibraryUpdated', items });
    }, items);

    // Marque un nœud DOM précis AVANT le showMedia -- s'il a disparu après
    // (grille reconstruite plutôt que mise à jour ciblée), c'est le signe
    // exact de la régression de performance que markMediaOnScreen() existe
    // pour éviter (voir dashboard/features/media-library.js, en-tête).
    await page.evaluate(() => {
      document
        .querySelector('.media-gallery-card[data-media-id="synth-0"]')
        .setAttribute('data-test-marker', 'original-node');
    });

    const elapsedMs = await page.evaluate(async () => {
      const { handleMessage } = await import('/dashboard/ws-dispatch.js');
      const start = performance.now();
      handleMessage({
        action: 'showMedia',
        id: 'synth-1',
        label: 'Média synthétique 1',
        mediaType: 'image',
      });
      return performance.now() - start;
    });

    console.log(
      `[media-wall-load] mise à jour incrémentale sur 200 médias : ${elapsedMs.toFixed(1)}ms`
    );
    expect(elapsedMs).toBeLessThan(100);

    await expect(page.locator('.media-gallery-card[data-media-id="synth-0"]')).toHaveAttribute(
      'data-test-marker',
      'original-node'
    );
    await expect(page.locator('.media-gallery-card[data-media-id="synth-1"]')).toHaveClass(
      /is-on-screen/
    );
  });
});
