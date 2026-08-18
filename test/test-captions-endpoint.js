'use strict';
/**
 * Test d'intégration — GET /api/captions (chantier 4.4, companion.html).
 *
 * Portée volontairement limitée à la logique de gating de l'endpoint
 * (jamais de fuite de texte quand captions/traduction sont désactivées,
 * réponse par défaut propre, targetLang correct) — PAS un test de bout en
 * bout du pipeline ASR réel (Groq/Deepgram -> caption-translator.js ->
 * updateLiveCaption() dans server.js). Simuler ce chemin complet
 * dupliquerait l'effort déjà fourni par test-groq-health-tracking.js/
 * test-groq-fallback-race.js pour un gain marginal ici : la logique propre
 * à /api/captions est la lecture de sessionState + le gating, pas la
 * traduction elle-même (déjà testée séparément, aucun changement ici).
 */
process.env.PORT = process.env.PORT || '8775'; // distinct des autres tests
process.env.WS_HOST = '127.0.0.1';
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';

require('../server.js');

const WebSocket = require('ws');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/`);
    ws.on('open', async () => {
      await sleep(100);
      resolve(ws);
    });
  });
}

async function getCaptions() {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/api/captions`);
  return res.json();
}

(async () => {
  await sleep(300); // laisse le serveur s'initialiser complètement

  console.log('\n=== GET /api/captions ===\n');

  // --- État par défaut : tout désactivé, aucune fuite de texte ---
  const initial = await getCaptions();
  assert(initial.enabled === false, 'par défaut : captions désactivées');
  assert(initial.translationEnabled === false, 'par défaut : traduction désactivée');
  assert(initial.targetLang === null, 'par défaut : targetLang null');
  assert(initial.text === null, 'par défaut : text null (rien transcrit, ou désactivé)');
  assert(initial.translation === null, 'par défaut : translation null');
  assert(initial.timestamp === null, 'par défaut : timestamp null');

  const ws = await connect();

  // --- Activation des captions (sans traduction) ---
  ws.send(JSON.stringify({ action: 'setCaptions', enabled: true }));
  await sleep(150);
  const withCaptions = await getCaptions();
  assert(withCaptions.enabled === true, 'setCaptions(true) -> enabled=true');
  assert(
    withCaptions.translationEnabled === false,
    'traduction reste désactivée (pas touchée par setCaptions)'
  );
  assert(
    withCaptions.text === null,
    "text reste null tant qu'aucun segment n'a été transcrit (pas de texte fantôme)"
  );

  // --- Activation de la traduction avec une langue cible ---
  ws.send(JSON.stringify({ action: 'setTranslatedCaptions', enabled: true, targetLang: 'es' }));
  await sleep(150);
  const withTranslation = await getCaptions();
  assert(
    withTranslation.translationEnabled === true,
    'setTranslatedCaptions(true) -> translationEnabled=true'
  );
  assert(withTranslation.targetLang === 'es', 'targetLang reflète la langue choisie (es)');

  // --- Désactivation des captions : plus aucune fuite, même avec traduction restée active ---
  ws.send(JSON.stringify({ action: 'setCaptions', enabled: false }));
  await sleep(150);
  const disabled = await getCaptions();
  assert(disabled.enabled === false, 'setCaptions(false) -> enabled=false');
  assert(
    disabled.text === null && disabled.translation === null && disabled.timestamp === null,
    'captions désactivées : text/translation/timestamp toujours null même si un segment avait été capté plus tôt'
  );

  ws.close();
  console.log('\n=== Tous les tests /api/captions sont passés ===');
  process.exit(0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
