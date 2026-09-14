// test/e2e/perf-budget.spec.js — garde-fou perf du tableau de bord (passe
// perf, Phase 3 : "perf-utils... pour repérer une régression dans une
// future PR"). Voir dashboard/perf-utils.js pour les mesures elles-mêmes ;
// ce test se contente de les appeler dans un vrai navigateur et d'affirmer
// un budget, à la manière de test/e2e/media-wall-load.spec.js (log +
// assertion de seuil avec marge machine CI).
//
// Les seuils ci-dessous ne sortent pas d'un cahier des charges chiffré
// (contrairement au <300ms du Mur Média) : ils viennent d'une mesure réelle
// sur ce dashboard — ~1650 noeuds DOM, systématiquement.
//
// CONSTAT (mesuré en écrivant ce test, PAS encore expliqué) : le temps de
// chargement (Navigation Timing loadEventEnd) mesure ~8-9s de façon répétée,
// aussi bien en lancement isolé qu'au sein de toute la suite e2e (serveur
// donc déjà "chaud", webServer.reuseExistingServer) — ce n'est PAS un
// artefact de démarrage à froid du serveur (hypothèse initiale, infirmée par
// la mesure). dashboard.html pèse ~176 Ko avec de nombreux <script> classiques
// (dashboard/features/*.js) chargés séquentiellement — cause probable mais
// non confirmée. Digne d'une passe dédiée (hors périmètre de cette passe
// perf-ci, qui portait sur le pipeline audio/STT/overlay, pas le tableau de
// bord) ; le seuil ci-dessous documente donc le NIVEAU ACTUEL mesuré plutôt
// qu'un objectif — assez haut pour ne pas faire échouer ce test sur un
// comportement déjà là, assez bas pour repérer une régression future qui
// l'aggraverait encore.
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Budget perf du tableau de bord', () => {
  test('chargement page + nombre de noeuds DOM restent dans un budget raisonnable', async ({
    page,
  }) => {
    await page.goto('/');
    // Laisse le temps aux widgets post-chargement (perf-pill, etc.) de
    // s'initialiser avant de compter les noeuds — un compte pris trop tôt
    // sous-estimerait le DOM stabilisé.
    await page.waitForTimeout(500);

    const snapshot = await page.evaluate(async () => {
      const { snapshotPerf, formatPerfSnapshot } = await import('/dashboard/perf-utils.js');
      const result = await snapshotPerf();
      return { ...result, formatted: formatPerfSnapshot(result) };
    });

    console.log(snapshot.formatted);

    expect(snapshot.domNodeCount).toBeGreaterThan(0);
    // Budget large et documenté ci-dessus — voir l'en-tête de fichier.
    expect(snapshot.domNodeCount).toBeLessThan(6000);
    if (snapshot.pageLoadMs != null) {
      expect(snapshot.pageLoadMs).toBeLessThan(12000);
    }
  });
});
