/**
 * ============================================================================
 *  integration-chapter-fallback-confidence-gate.js — le repli chapitre ne
 *  s'arme plus sur un fragment de pur charabia à confiance basse (audit)
 * ----------------------------------------------------------------------------
 *  AJOUT (audit — usage réel en direct, voir server.js#CHAPTER_FALLBACK_MIN_
 *  CONFIDENCE) : observé sur une vraie session (Groq en 429 permanent, repli
 *  Deepgram quasi systématique) — des fragments de transcription à confiance
 *  0.18-0.41 (au-dessus du seuil de REJET 0.15, mais du charabia sans rapport
 *  avec le culte) se faisaient reconnaître comme une référence "chapitre
 *  seul" par pur hasard de correspondance, armaient scheduleChapterFallback(),
 *  et finissaient AFFICHÉS À L'ÉCRAN (mode confiance 'auto') sans qu'aucune
 *  vraie parole sur ce livre n'ait jamais été prononcée.
 *
 *  Ce test utilise l'action WS 'transcript' (voir misc-ws-handlers.js),
 *  étendue dans ce même correctif avec un champ optionnel `confidence` —
 *  jusqu'ici ce chemin de test/débogage n'avait aucun moyen de simuler une
 *  transcription de mauvaise qualité pour exercer ce garde-fou.
 *
 *  Même approche que integration-chapter-fallback-delay.js : server.js
 *  tourne réellement, seuls le réseau (API biblique, Groq) et la config sont
 *  mockés.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

const FALLBACK_DELAY_MS = 300;
injectFakeModule('features-store.js', {
  setUserDataDir() {},
  readFeatures() {
    return { display: { chapterFallbackDelayMs: FALLBACK_DELAY_MS } };
  },
  writeFeatures() {},
  getWritableFile() {
    return null;
  },
});

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getChapterVersesMultilang() {
    throw new Error('non simulé dans ce test');
  },
  async getVerseMultilang(reference) {
    return {
      reference: `Jean ${reference.chapter}`,
      text: 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
      provider: 'fake',
      lang: 'fr',
      text_fr: 'TEXTE_CHAPITRE_ENTIER_VIA_REPLI',
      text_en: null,
      langMode: 'fr',
    };
  },
  buildReferenceLabel(reference) {
    return `Jean ${reference.chapter}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation() {},
  listTranslations() {
    return [];
  },
  getTranslationId() {
    return 'lsg';
  },
  getCacheSize() {
    return 0;
  },
  clearCache() {},
  getProviders() {
    return ['fake-provider'];
  },
});

injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    return { text: '', source: 'fake-groq' };
  },
});
injectFakeModule('deepgram-wrapper.js', {
  isConfigured() {
    return false;
  },
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
});
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on() {},
});

process.env.PORT = process.env.PORT || '8797'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');

const WebSocket = require('ws');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openWs() {
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  const received = [];
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch (_) {}
  });
  return { ws, received };
}

(async () => {
  let passed = 0,
    failed = 0;
  function check(name, cond, detail) {
    if (cond) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  await sleep(300);

  console.log(
    '\n=== Scénario 1 : confiance BASSE (0.2, sous MIN_VERSE_CONFIDENCE) — jamais affiché ===\n'
  );
  {
    const { ws, received } = await openWs();
    ws.send(
      JSON.stringify({ action: 'transcript', text: 'Jean chapitre 3 verset', confidence: 0.2 })
    );
    await sleep(FALLBACK_DELAY_MS + 1500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      "confiance basse : le repli chapitre NE s'affiche PAS (probable bruit)",
      !shown,
      JSON.stringify(received.map((m) => m.action))
    );
    // AJOUT (chantier finalisation v1.0 — élargissement du garde-fou, voir
    // server.js#verseDetectionAllowed) : une confiance insuffisante saute
    // désormais la détection ELLE-MÊME (plus seulement l'armement du repli
    // chapitre après coup) — aucune référence "chapitre seul" n'est donc
    // jamais reconnue ici, donc aucune candidateVerse spéculative non plus.
    // C'est un DURCISSEMENT volontaire par rapport au comportement d'avant
    // ce chantier (qui laissait passer la détection et ne bloquait que
    // l'affichage final) : du bruit à confiance basse ne doit plus laisser
    // AUCUNE trace, même spéculative, sur le tableau de bord.
    check(
      'aucune candidateVerse spéculative non plus (détection elle-même sautée, pas seulement l’affichage)',
      !received.some((m) => m.action === 'candidateVerse'),
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    '\n=== Scénario 2 : confiance HAUTE (0.9) — le repli chapitre s’affiche normalement ===\n'
  );
  {
    const { ws, received } = await openWs();
    ws.send(
      JSON.stringify({ action: 'transcript', text: 'Jean chapitre 3 verset', confidence: 0.9 })
    );
    await sleep(FALLBACK_DELAY_MS + 1500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      "confiance haute : le repli chapitre s'affiche normalement (comportement historique préservé)",
      !!shown && shown.detectedBy === 'chapter-fallback',
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    '\n=== Scénario 3 : confiance ABSENTE (comportement historique — sans le champ) — toujours affiché ===\n'
  );
  {
    const { ws, received } = await openWs();
    ws.send(JSON.stringify({ action: 'transcript', text: 'Jean chapitre 3 verset' }));
    await sleep(FALLBACK_DELAY_MS + 1500);
    const shown = received.find((m) => m.action === 'showVerse');
    check(
      'confiance inconnue (champ omis) : comportement historique intégralement préservé, toujours affiché',
      !!shown && shown.detectedBy === 'chapter-fallback',
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    '\n=== Scénario 4 : référence COMPLÈTE (pas seulement chapitre seul) à confiance basse (0.2 < 0.35) — jamais détectée ===\n'
  );
  {
    // AJOUT (chantier finalisation v1.0 — élargissement du garde-fou) :
    // contrairement aux scénarios 1-3 (texte "chapitre seul", ambigu par
    // nature), "jean chapitre 3 verset 16" est une référence COMPLÈTE
    // (livre + chapitre + verset) que detector.detectBilingual() reconnaît
    // normalement sans délai ni repli — verse server.js#verseDetectionAllowed
    // pour vérifier qu'une confiance basse coupe la détection ELLE-MÊME,
    // pas seulement le chemin "chapitre seul -> repli différé" couvert
    // ci-dessus.
    const { ws, received } = await openWs();
    ws.send(
      JSON.stringify({
        action: 'transcript',
        text: 'jean chapitre 3 verset 16',
        confidence: 0.2,
      })
    );
    await sleep(1500);
    check(
      'aucun showVerse (la référence complète elle-même n’est jamais détectée)',
      !received.some((m) => m.action === 'showVerse'),
      JSON.stringify(received.map((m) => m.action))
    );
    check(
      'aucune pendingVerseConfirmation non plus (rien à confirmer, rien n’a été détecté)',
      !received.some((m) => m.action === 'pendingVerseConfirmation'),
      JSON.stringify(received.map((m) => m.action))
    );
    ws.close();
  }

  console.log(
    `\n=== Résultat garde-fou de confiance du repli chapitre (audit) : ${passed} passés, ${failed} échoués ===`
  );
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error("Erreur fatale dans le test d'intégration:", err);
  process.exit(1);
});
