'use strict';
/**
 * ============================================================================
 *  live-tests/deepgram-live-test.js — validation EN CONDITIONS RÉELLES
 * ----------------------------------------------------------------------------
 *  Chemin exercé, avec une VRAIE connexion réseau à Deepgram (nécessite
 *  DEEPGRAM_API_KEY dans .env — voir dotenv-loader.js) :
 *
 *    Micro (simulé par un vrai WAV français)
 *      -> Silero VAD (vrai modèle ONNX, VAD_PROVIDER=auto)
 *      -> audio-capture.js (code de production, feedPcmChunk())
 *      -> deepgram-streaming.js (code de production, vraie WebSocket)
 *      -> detector-compat.js (code de production, vraie détection)
 *      -> transcription-corrector.js (correctFast, code de production)
 *      -> session-state.js (isDuplicateReference, code de production)
 *      -> bible-lookup-with-api.js (vrai appel réseau à l'API Bible)
 *
 *  ISOLÉ du pipeline de production (comme poc-qwen3-asr/) : aucun fichier de
 *  production n'est modifié pour ce test, seuls des modules déjà exportés
 *  sont require()'d exactement comme server.js le fait.
 *
 *  NON COUVERT ICI : OBS (aucune instance OBS Studio/obs-websocket
 *  disponible dans cet environnement de test) — voir le rapport livré.
 *  Le repli Deepgram -> pipeline segment/Groq est déjà couvert par
 *  test/test-audio-capture-deepgram-streaming.js (WebSocket simulée,
 *  déterministe) — pas reproduit ici.
 *
 *  USAGE : node live-tests/deepgram-live-test.js
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')], (p) =>
  console.log(`[live-test] .env chargé depuis ${p}`)
);

if (!process.env.DEEPGRAM_API_KEY) {
  console.error('REAL SERVICE TEST BLOCKED — DEEPGRAM_API_KEY NOT CONFIGURED');
  process.exit(2);
}
console.log(
  `[live-test] DEEPGRAM_API_KEY chargée (${process.env.DEEPGRAM_API_KEY.slice(0, 4)}... — ${process.env.DEEPGRAM_API_KEY.length} caractères, jamais affichée en entier).`
);

// Opt-in explicite streaming, comme un vrai déploiement le ferait.
process.env.ASR_PROVIDER = 'deepgram';
// VAD_PROVIDER NON forcé : reste 'auto' -> Silero, comportement par défaut réel (§10).

const audioCapture = require('../audio-capture');
const detector = require('../detector-compat');
const { correctFast } = require('../transcription-corrector');
const sessionState = require('../session-state');
const bibleLookup = require('../bible-lookup-with-api');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataStart = buf.indexOf('data') + 8;
  return buf.subarray(dataStart);
}

const TESTS = [
  {
    id: 'A',
    file: 'testA_16k.wav',
    text: 'Jean chapitre trois verset seize.',
    expectScripture: true,
  },
  {
    id: 'B',
    file: 'testB_16k.wav',
    text: 'Premier Corinthiens chapitre treize verset quatre.',
    expectScripture: true,
  },
  {
    id: 'C',
    file: 'testC_16k.wav',
    text: 'Nous allons lire dans Jean, chapitre trois, verset seize.',
    expectScripture: true,
  },
  {
    id: 'D',
    file: 'testD_16k.wav',
    text: 'Bonjour à tous, nous allons commencer le culte.',
    expectScripture: false,
  },
];

function refKeyOf(ref) {
  if (!ref) return null;
  return `${ref.book}:${ref.chapter}:${ref.verseStart || ''}`;
}

async function main() {
  const results = [];
  let current = null;
  let unexpectedSegments = 0;

  audioCapture.on({
    onAudioSegment: () => {
      // Ne devrait JAMAIS se déclencher tant que le streaming Deepgram tient —
      // ça signalerait un repli silencieux vers le pipeline WAV classique.
      unexpectedSegments++;
      console.warn('[live-test] ⚠ onAudioSegment déclenché — repli WAV inattendu pendant ce test');
    },
    onPartialTranscript: (text, meta) => {
      if (!current) return;
      const now = Date.now();
      if (!current.firstPartialAt) current.firstPartialAt = now;
      current.partials.push({ text, at: now, confidence: meta.confidence });
      let fastMatch = null;
      try {
        fastMatch = detector.detectExact(text);
      } catch (_e) {
        /* fragment encore incomplet — normal */
      }
      if (fastMatch && fastMatch.confidence === 'high' && !current.firstUsefulPartialAt) {
        current.firstUsefulPartialAt = now;
        current.firstUsefulPartialText = text;
        current.firstUsefulRef = fastMatch;
      }
      console.log(`  [partial +${((now - current.startedAt) / 1000).toFixed(2)}s] "${text}"`);
    },
    onFinalTranscript: (text, meta, tracker) => {
      if (!current) return;
      current.finalAt = Date.now();
      current.finalText = text;
      current.finalConfidence = meta.confidence;
      current.tracker = tracker;
      console.log(
        `  [FINAL   +${((current.finalAt - current.startedAt) / 1000).toFixed(2)}s] "${text}"`
      );
    },
    onAsrFallback: (info) => {
      console.warn('[live-test] ⚠ onAsrFallback:', info.reason);
      if (current) current.fallback = info.reason;
    },
    onSegmentSkipped: () => {},
    onError: (err) => console.error('[live-test] onError:', err.message),
  });

  // AJOUT (suite au diagnostic live-tests/diagnose-raw-messages.js) : une
  // session streaming CONTINUE ne produit PAS de 'final' fiable sur la
  // seule base du silence — voir le rapport livré, "speech_final"/"is_final"
  // ne sont arrivés, dans ce test réel, qu'en réponse explicite à
  // CloseStream (session.finish(), voir stopRecording() dans
  // audio-capture.js), jamais spontanément après plusieurs secondes de
  // silence numérique pur avec endpointing=500. Une session FRAÎCHE par
  // énoncé (start/stop autour de chaque test) donne donc les résultats les
  // plus propres pour CETTE mesure, au prix de ne plus représenter une
  // session continue de culte — les deux limites sont documentées dans le
  // rapport, pas cachées.
  for (const test of TESTS) {
    console.log(`\n=== Test ${test.id}: "${test.text}" ===`);
    current = { id: test.id, startedAt: Date.now(), partials: [] };

    console.log(
      '[live-test] Démarrage de la capture (ASR_PROVIDER=deepgram, VAD_PROVIDER=auto)...'
    );
    await audioCapture.startBrowserCapture();
    const opened = await waitFor(() => audioCapture.isDeepgramStreamingActive(), 6000);
    console.log(
      `[live-test] Session Deepgram active: ${opened} | VAD actif: ${audioCapture.getVadProvider()} | ASR provider: ${audioCapture.getAsrProvider()}`
    );
    if (!opened) {
      console.error(
        'REAL SERVICE TEST BLOCKED — connexion Deepgram non établie (voir logs ci-dessus).'
      );
      await audioCapture.stopRecording();
      process.exit(3);
    }

    const pcm = readWavPcm(path.join(__dirname, 'samples', test.file));

    // Pacing temps réel : trames de 20ms (640 octets à 16kHz mono 16-bit) —
    // même granularité qu'un vrai flux micro, pour un comportement VAD/
    // endpointing représentatif.
    const FRAME_BYTES = 640;
    for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
      audioCapture.feedPcmChunk(pcm.subarray(offset, offset + FRAME_BYTES));
      await sleep(20);
    }
    // ~1s de silence numérique avant l'arrêt — laisse Silero/le VAD interne
    // de Deepgram voir la fin de la phrase avant que CloseStream ne soit
    // envoyé par stopRecording() ci-dessous.
    const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < 50; i++) {
      audioCapture.feedPcmChunk(SILENCE_FRAME);
      await sleep(20);
    }

    // Ferme CETTE session (CloseStream + attente du dernier 'final', voir
    // le correctif de finish() dans deepgram-streaming.js) avant de passer
    // à l'énoncé suivant — clé pour obtenir un 'final' propre par énoncé.
    await audioCapture.stopRecording();
    await waitFor(() => !!current.finalText, 3000);

    results.push({ ...current, expected: test });
    await sleep(300);
  }

  // ---------------------------------------------------------------------
  // Post-traitement : détection biblique sur le FINAL (comme server.js,
  // correctFast() puis detectBilingual()), vérification dédoublonnage
  // réelle, et un vrai lookup Bible pour au moins une référence détectée.
  // ---------------------------------------------------------------------
  console.log('\n\n================ RÉSULTATS ================\n');
  let anyBibleLookupDone = false;
  for (const r of results) {
    const rawFinal = r.finalText || '';
    const corrected = rawFinal ? correctFast(rawFinal) : '';
    let finalRef = null;
    try {
      finalRef = corrected ? detector.detectBilingual(corrected) : null;
    } catch (_e) {
      /* pas de référence exploitable */
    }
    r.correctedFinal = corrected;
    r.finalRef = finalRef;
    r.finalRefKey = refKeyOf(finalRef);

    console.log(`--- Test ${r.id} ---`);
    console.log(`Attendu (texte prononcé)         : "${r.expected.text}"`);
    console.log(
      `Deepgram — 1er partial            : ${r.partials[0] ? '"' + r.partials[0].text + '"' : 'AUCUN'}`
    );
    console.log(`Deepgram — nombre de partials      : ${r.partials.length}`);
    console.log(
      `Deepgram — FINAL                   : ${r.finalText ? '"' + r.finalText + '"' : 'AUCUN REÇU'}`
    );
    console.log(
      `Référence détectée (sur le final)  : ${finalRef ? refKeyOf(finalRef) + ` (${finalRef.confidence})` : 'AUCUNE'}`
    );
    console.log(
      `Résultat scripture                 : ${
        r.expected.expectScripture
          ? finalRef
            ? 'PASS'
            : 'FAIL (référence attendue, non détectée)'
          : !finalRef
            ? 'PASS (aucune référence, comme attendu)'
            : 'FAIL (fausse détection sur phrase sans référence)'
      }`
    );
    if (r.tracker) {
      const summary = r.tracker.summary();
      console.log(
        `Latence (marques réelles)          : ${JSON.stringify(summary.deltas)} | total=${summary.totalMs}ms`
      );
    }
    if (r.firstUsefulPartialAt) {
      console.log(
        `1ère détection UTILE sur un partial : +${((r.firstUsefulPartialAt - r.startedAt) / 1000).toFixed(2)}s ("${r.firstUsefulPartialText}" -> ${refKeyOf(r.firstUsefulRef)})`
      );
    } else {
      console.log(
        '1ère détection UTILE sur un partial : aucune (référence identifiée seulement au FINAL, ou jamais)'
      );
    }
    console.log('');

    // Vrai lookup Bible pour la première référence bien détectée (§ Bible lookup réel).
    if (finalRef && !anyBibleLookupDone) {
      anyBibleLookupDone = true;
      const bibleStart = Date.now();
      try {
        const verse = await bibleLookup.getVerseMultilang(finalRef, 'fr');
        r.bibleLookupMs = Date.now() - bibleStart;
        r.bibleVerseText = verse && verse.text ? verse.text.slice(0, 120) : null;
        console.log(`[Bible lookup RÉEL] ${r.bibleLookupMs}ms -> "${r.bibleVerseText}"`);
      } catch (err) {
        r.bibleLookupMs = Date.now() - bibleStart;
        r.bibleLookupError = err.message;
        console.log(`[Bible lookup RÉEL] échec après ${r.bibleLookupMs}ms : ${err.message}`);
      }
    }
  }

  // --- Dédoublonnage réel (session-state.js), à partir de vraies clés de référence détectées ---
  console.log('\n--- Vérification dédoublonnage (session-state.js, vraies clés) ---');
  const withRef = results.filter((r) => r.finalRefKey);
  if (withRef.length > 0) {
    const first = withRef[0];
    const now1 = Date.now();
    const beforeRecord = sessionState.isDuplicateReference(first.finalRefKey, now1);
    console.log(
      `isDuplicateReference("${first.finalRefKey}") avant tout enregistrement : ${beforeRecord} (attendu: false, sauf collision avec un test précédent de cette même exécution)`
    );
    sessionState.recordShownReference(first.finalRefKey, now1);
    const now2 = now1 + 1000;
    const afterRecord = sessionState.isDuplicateReference(first.finalRefKey, now2);
    console.log(
      `isDuplicateReference("${first.finalRefKey}") 1s après enregistrement       : ${afterRecord} (attendu: true — même énoncé répété serait supprimé)`
    );
    if (withRef.length > 1) {
      const second = withRef.find((r) => r.finalRefKey !== first.finalRefKey);
      if (second) {
        const differentOk = !sessionState.isDuplicateReference(second.finalRefKey, now2);
        console.log(
          `isDuplicateReference("${second.finalRefKey}") (référence DIFFÉRENTE)       : ${!differentOk ? 'true (BUG — ne devrait pas être un doublon)' : 'false (attendu — référence différente, jamais supprimée)'}`
        );
      }
    }
  } else {
    console.log('Aucune référence détectée dans cette exécution — dédoublonnage non vérifiable.');
  }

  console.log(
    `\nSegments WAV inattendus pendant le streaming : ${unexpectedSegments} (attendu: 0)`
  );

  fs.writeFileSync(
    path.join(__dirname, 'last-run-results.json'),
    JSON.stringify(results, null, 2).replace(process.env.DEEPGRAM_API_KEY, '[REDACTED]'),
    'utf8'
  );
  console.log('\n[live-test] Résultats détaillés écrits dans live-tests/last-run-results.json');

  process.exit(0);
}

main().catch((err) => {
  console.error('[live-test] ÉCHEC INATTENDU:', err.message);
  console.error(err.stack);
  process.exit(1);
});
