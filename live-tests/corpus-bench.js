'use strict';
/**
 * ============================================================================
 *  live-tests/corpus-bench.js — banc de mesure comparatif batch vs streaming
 * ----------------------------------------------------------------------------
 *  Rejoue un corpus d'énoncés réels (voir corpus.csv, CORPUS-SCRIPT.md) à
 *  travers le VRAI pipeline de production (server.js réel, audio-capture.js
 *  réel, vraies clés GROQ_API_KEY/DEEPGRAM_API_KEY — voir .env), et produit
 *  DEUX métriques séparées, jamais fusionnées :
 *    1. latence p50/p95 (uniquement sur les énoncés correctement affichés)
 *    2. taux de première tentative (énoncés affichés / énoncés attendant
 *       une référence), avec ventilation par catégorie (corpus.csv#category)
 *  — la précision est un problème DISTINCT de la latence (voir le petit
 *  échantillon déjà mesuré dans last-run-results.json, qui a montré les deux
 *  en même temps sur seulement 4 énoncés) ; ce banc les distingue toujours.
 *
 *  CHOIX D'ARCHITECTURE — pas de callback audioCapture.on() dans ce fichier :
 *  audioCapture.on() FUSIONNE ses callbacks par clé (voir audio-capture.js,
 *  `STATE.callbacks = { ...STATE.callbacks, ...callbacks }`), donc un second
 *  appel ici ÉCRASERAIT les callbacks réels déjà posés par server.js#startPipeline()
 *  (onAudioSegment -> transcribeWithRetry -> processTranscript, le SEUL
 *  chemin qui applique réellement détection + dédoublonnage + seuil de
 *  confiance + lookup Bible) — le pipeline réel ne tournerait alors plus du
 *  tout. Ce banc se contente donc de pousser du PCM (feedPcmChunk, la même
 *  API que n'importe quel appelant) et d'OBSERVER le résultat en tant que
 *  VRAI client WebSocket (comme un overlay.html ou un tableau de bord réel),
 *  exactement ce qu'un opérateur verrait.
 *
 *  DEUX SIGNAUX DISTINCTS observés par énoncé, precisément pour distinguer
 *  "l'ASR a bien transcrit la référence" de "le pipeline l'a réellement
 *  affichée" (le cas doublon_10s, voir corpus.csv, teste exactement cette
 *  différence — DEDUP_MS peut avaler une occurrence légitime en silence) :
 *    - textDetected : detector.detectBilingual()/detectExact() ré-exécuté
 *      ICI sur le texte brut diffusé ('transcript'/'transcriptPartial') —
 *      indépendant de tout rejet serveur (confiance, dédoublonnage).
 *    - shown : un 'showVerse' réellement diffusé, avec la référence attendue
 *      (reference re-parsée via detector.parseReference(), même fonction que
 *      server.js utilise lui-même pour le déclenchement manuel — garantit
     que le parsing du banc suit exactement la sémantique serveur).
 *
 *  USAGE :
 *    node live-tests/corpus-bench.js [--corpus=chemin/vers/corpus.csv] [--provider=auto|deepgram|both]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')], (p) =>
  console.log(`[corpus-bench] .env chargé depuis ${p}`)
);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
const CORPUS_PATH = path.resolve(argValue('corpus', path.join(__dirname, 'corpus.csv')));
const PROVIDER_ARG = argValue('provider', 'both'); // 'auto' | 'deepgram' | 'both'
const PROVIDERS_TO_RUN = PROVIDER_ARG === 'both' ? ['auto', 'deepgram'] : [PROVIDER_ARG];

if (!process.env.GROQ_API_KEY && PROVIDERS_TO_RUN.includes('auto')) {
  console.error('GROQ_API_KEY absent — nécessaire pour le chemin batch (auto). Voir .env.example.');
  process.exit(2);
}
if (!process.env.DEEPGRAM_API_KEY && PROVIDERS_TO_RUN.includes('deepgram')) {
  console.error('DEEPGRAM_API_KEY absent — nécessaire pour le chemin streaming (deepgram).');
  process.exit(2);
}

process.env.PORT = process.env.PORT || '8780';
require('../server.js');
const audioCapture = require('../audio-capture');
const detector = require('../detector-compat');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - start >= timeoutMs) return resolve(predicate());
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// CSV — parseur minimal RFC4180 (guillemets doubles, virgules internes) :
// suffisant pour corpus.csv (jamais de retour à la ligne dans un champ),
// pas besoin d'une dépendance externe pour ça.
// ---------------------------------------------------------------------------
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function loadCorpus(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    header.forEach((key, idx) => (row[key] = values[idx] !== undefined ? values[idx] : ''));
    rows.push({
      id: row.id,
      category: row.category,
      language: row.language,
      sourceFile: row.source_file,
      startMs: row.start_ms ? Number(row.start_ms) : null,
      endMs: row.end_ms ? Number(row.end_ms) : null,
      expectedText: row.expected_text,
      expectsScripture: row.expects_scripture === 'true',
      expectedBook: row.expected_book || null,
      expectedChapter: row.expected_chapter ? Number(row.expected_chapter) : null,
      expectedVerseStart: row.expected_verse_start ? Number(row.expected_verse_start) : null,
      expectedVerseEnd: row.expected_verse_end ? Number(row.expected_verse_end) : null,
      notes: row.notes,
    });
  }
  return rows;
}

function refKeyOf(book, chapter, verseStart) {
  if (!book) return null;
  return `${book}:${chapter || ''}:${verseStart || ''}`;
}

// ---------------------------------------------------------------------------
// WAV — lecture PCM brute (même convention que live-tests/deepgram-live-test.js
// et resample.js : en-tête RIFF/WAVE standard, 'data' repéré par sa balise).
// Valide le format plutôt que de le supposer — un corpus fourni par
// l'utilisateur n'est pas garanti 16kHz/mono/16-bit comme les échantillons
// existants.
// ---------------------------------------------------------------------------
function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataStart = buf.indexOf('data') + 8;
  const pcm = buf.subarray(dataStart);
  if (numChannels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
    console.warn(
      `[corpus-bench] ⚠ ${path.basename(filePath)} n'est pas mono/16kHz/16-bit ` +
        `(détecté : ${numChannels}ch, ${sampleRate}Hz, ${bitsPerSample}bit) — ` +
        `voir live-tests/resample.js pour convertir avant de relancer ce banc.`
    );
  }
  return { pcm, numChannels, sampleRate, bitsPerSample };
}

// ---------------------------------------------------------------------------
// Perentiles — méthode "nearest rank", triviale et suffisante pour ce volume
// d'échantillons (quelques dizaines, pas des milliers).
// ---------------------------------------------------------------------------
function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Rejoue UN fichier source (tous ses énoncés, dans l'ordre, avec les vrais
// écarts de temps préservés — essentiel pour rafale_5s/doublon_10s) sur le
// provider demandé, et retourne les évènements WS observés avec horodatage
// mur (wall clock) pour appariement ultérieur avec le corpus.
// ---------------------------------------------------------------------------
async function replayFile(sourceFile, provider, ws) {
  const filePath = path.join(__dirname, 'samples', sourceFile);
  const { pcm } = readWav(filePath);

  if (provider === 'auto') {
    delete process.env.ASR_PROVIDER;
  } else {
    process.env.ASR_PROVIDER = provider;
  }

  const events = [];
  const onMessage = (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }
    if (
      msg.action === 'transcript' ||
      msg.action === 'transcriptPartial' ||
      msg.action === 'candidateVerse' ||
      msg.action === 'verseBuffered' ||
      msg.action === 'showVerse' ||
      msg.action === 'transcriptRejected'
    ) {
      events.push({ at: Date.now(), msg });
    }
  };
  ws.on('message', onMessage);

  await audioCapture.startBrowserCapture();
  if (provider === 'deepgram') {
    const opened = await waitFor(() => audioCapture.isDeepgramStreamingActive(), 6000);
    if (!opened) {
      console.error(`[corpus-bench] ⚠ session Deepgram non établie pour ${sourceFile} — ignoré.`);
      ws.off('message', onMessage);
      await audioCapture.stopRecording();
      return { feedTimes: null, events: [] };
    }
  }

  const sessionStartWallClock = Date.now();

  // CORRECTIF (Chantier 0.2 — audit benchmark) : le "replay temps réel" de ce
  // banc est en réalité ~1,5-1,8x plus LENT que le temps réel sur Windows
  // (granularité du timer : un `await sleep(20)` prend ~31,5ms). L'ancien
  // modèle `expectedWallClock = sessionStart + endMs` supposait un rythme
  // strictement temps réel → pour un énoncé à endMs=24s (début de fichier),
  // la dérive atteignait ~13,7s, soit BIEN AU-DELÀ de la fenêtre [+8000ms] :
  // les événements réels (transcript/showVerse) tombaient HORS fenêtre et
  // l'énoncé était compté "jamais détecté" à tort. On échantillonne donc le
  // moment réel d'alimentation de chaque tranche d'audio et on calibre
  // l'horodatage attendu de chaque énoncé par INTERPOLATION : le banc devient
  // indépendant du rythme réel du replay.
  const FEED_SAMPLE_EVERY = 10; // toutes les ~200ms d'audio
  // La clé est l'OFFSET AUDIO EN MS dans le fichier (32 octets/ms à 16kHz
  // mono 16-bit) — même unité que start_ms/end_ms du corpus.csv.
  const BYTES_PER_MS = 32;
  const feedTimes = [[0, sessionStartWallClock]];
  let lastSampleOffset = 0;

  // Trames de 20ms (640 octets à 16kHz mono 16-bit) — même granularité qu'un
  // vrai flux micro, essentielle pour un comportement VAD/endpointing
  // représentatif (voir deepgram-live-test.js, même convention).
  const FRAME_BYTES = 640;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    audioCapture.feedPcmChunk(pcm.subarray(offset, offset + FRAME_BYTES));
    if (offset - lastSampleOffset >= FRAME_BYTES * FEED_SAMPLE_EVERY) {
      feedTimes.push([offset / BYTES_PER_MS, Date.now()]);
      lastSampleOffset = offset;
    }
    await sleep(20);
  }
  feedTimes.push([pcm.length / BYTES_PER_MS, Date.now()]);
  // ~1.2s de silence numérique en fin de fichier — laisse le VAD (local ou
  // Silero) voir la fin de la dernière phrase avant l'arrêt.
  const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < 60; i++) {
    audioCapture.feedPcmChunk(SILENCE_FRAME);
    await sleep(20);
  }

  await audioCapture.stopRecording();
  // Grace period : laisse arriver un dernier 'final'/'showVerse' encore en vol.
  await sleep(2000);
  ws.off('message', onMessage);

  return { sessionStartWallClock, feedTimes, events };
}

// ---------------------------------------------------------------------------
// Calibre l'horodatage mur attendu d'un offset audio (ms dans le fichier) sur
// le RYTHME RÉEL d'alimentation (voir CORRECTIF dans replayFile) : le replay
// est ~1,5-1,8x plus lent que le temps réel → `sessionStart + offsetMs` serait
// faux de plusieurs secondes pour les énoncés tardifs du fichier.
// ---------------------------------------------------------------------------
function interpolateFeedTime(feedTimes, offsetMs) {
  if (feedTimes.length === 0) return null;
  let prev = feedTimes[0];
  for (let i = 1; i < feedTimes.length; i++) {
    const cur = feedTimes[i];
    if (cur[0] >= offsetMs) {
      const span = cur[0] - prev[0];
      if (span <= 0) return cur[1];
      const frac = (offsetMs - prev[0]) / span;
      return prev[1] + (cur[1] - prev[1]) * frac;
    }
    prev = cur;
  }
  return prev[1];
}

// ---------------------------------------------------------------------------
// Apparie les évènements observés aux lignes du corpus pour CE fichier.
// Traité dans l'ordre chronologique du corpus pour que deux occurrences de
// la MÊME référence (cas doublon_10s) ne se volent pas mutuellement leur
// évènement — chaque évènement n'est réclamé qu'une seule fois.
// ---------------------------------------------------------------------------
function matchRowsToEvents(rows, feedTimes, events) {
  const claimedText = new Set();
  const claimedShown = new Set();
  const claimedCandidate = new Set();
  const claimedBuffered = new Set();
  const results = [];

  // Chaîne mesurée par énoncé (CHANTIER 0.2 — audit + complétude) :
  //   partialLatencyMs   : premier transcriptPartial contenant la référence
  //   finalLatencyMs     : premier transcript (final) contenant la référence
  //   candidateLatencyMs : premier candidateVerse diffusé pour la référence
  //   biblePreloadLatencyMs : premier verseBuffered (texte Bible préchargé)
  //   shownLatencyMs     : premier showVerse attribuable (uniquement si shown)
  // Un timestamp NÉGATIF est légitime ici : l'affichage spéculatif / le
  // streaming peuvent diffuser AVANT la fin de l'audio de l'énoncé
  // (horodatage attendu = fin de l'énoncé). Ce qui n'a PAS de sens, c'est un
  // min négatif sur les seuls énoncés affichés DÉFINITIVEMENT — depuis la
  // correction Étape 4 (fenêtre bornée), ça ne peut plus arriver (vérifié :
  // le seul -584 présent dans les résultats commités est une ligne NON
  // affichée dont shownLatencyMs était rempli par erreur — corrigé ici en ne
  // renseignant shownLatencyMs que si shown === true).
  function withinWindow(ev, expectedWallClock, windowEnd) {
    return ev.at >= expectedWallClock - 1500 && ev.at <= windowEnd;
  }

  for (const row of rows) {
    const expectedRefKey = refKeyOf(row.expectedBook, row.expectedChapter, row.expectedVerseStart);
    const expectedWallClock = interpolateFeedTime(feedTimes, row.endMs || 0);
    const windowEnd = expectedWallClock + 8000;

    let textDetected = false;
    let partialLatencyMs = null;
    let finalLatencyMs = null;
    let candidateLatencyMs = null;
    let biblePreloadLatencyMs = null;
    let shown = false;
    let shownLatencyMs = null;
    let finalShownCorrect = false;
    let falsePositive = false;

    if (expectedRefKey) {
      // --- partial puis final (transcripts contenant la référence attendue) ---
      let partialClaimed = false;
      let finalClaimed = false;
      for (const ev of events) {
        if (claimedText.has(ev) || !withinWindow(ev, expectedWallClock, windowEnd)) continue;
        if (ev.msg.action !== 'transcript' && ev.msg.action !== 'transcriptPartial') continue;
        let ref;
        try {
          ref = detector.detectBilingual(ev.msg.text) || detector.detectExact(ev.msg.text);
        } catch (_e) {
          continue;
        }
        if (!ref) continue;
        if (refKeyOf(ref.book, ref.chapter, ref.verseStart) !== expectedRefKey) continue;
        textDetected = true;
        if (ev.msg.action === 'transcriptPartial' && partialLatencyMs === null) {
          partialLatencyMs = ev.at - expectedWallClock;
          claimedText.add(ev);
          partialClaimed = true;
        }
        if (ev.msg.action === 'transcript' && finalLatencyMs === null) {
          finalLatencyMs = ev.at - expectedWallClock;
          claimedText.add(ev);
          finalClaimed = true;
        }
        if (partialClaimed && finalClaimed) break;
      }

      // --- candidateVerse (détection spéculative diffusée au tableau de bord) ---
      for (const ev of events) {
        if (claimedCandidate.has(ev) || !withinWindow(ev, expectedWallClock, windowEnd)) continue;
        if (ev.msg.action !== 'candidateVerse') continue;
        const ref = ev.msg.reference;
        if (!ref || !ref.book || !ref.verseStart) continue;
        if (refKeyOf(ref.book, ref.chapter, ref.verseStart) === expectedRefKey) {
          candidateLatencyMs = ev.at - expectedWallClock;
          claimedCandidate.add(ev);
          break;
        }
      }

      // --- verseBuffered (texte Bible réellement préchargé en mémoire) ---
      for (const ev of events) {
        if (claimedBuffered.has(ev) || !withinWindow(ev, expectedWallClock, windowEnd)) continue;
        if (ev.msg.action !== 'verseBuffered') continue;
        const ref = ev.msg.reference;
        if (!ref || !ref.book) continue;
        if (refKeyOf(ref.book, ref.chapter, ref.verseStart) === expectedRefKey) {
          biblePreloadLatencyMs = ev.at - expectedWallClock;
          claimedBuffered.add(ev);
          break;
        }
      }

      // --- showVerse (affichage réel) ---
      // CORRECTIF (Chantier 0.2 — audit benchmark) : un showVerse N'est
      // attribuable à cet énoncé que s'il arrive APRÈS le signal de détection
      // propre de l'énoncé (candidate ou final). Sans cette borne, le
      // showVerse TARDIF d'un énoncé PRÉCÉDENT portant la MÊME référence
      // (ex. A1 "Jean 3.16" dont l'affichage met ~4,5s, pour A2 "Jean
      // chapitre 3 verset 16" 5,5s plus loin) retombait dans la fenêtre de
      // l'énoncé suivant et produisait un shownLatencyMs NÉGATIF mensonger
      // (min=-1060ms mesuré). L'affichage spéculatif avant la fin de l'audio
      // reste possible et LÉGITIME — mais uniquement après le candidateVerse
      // de CET énoncé, ce que cette borne préserve exactement.
      const signalAt =
        candidateLatencyMs !== null
          ? expectedWallClock + candidateLatencyMs
          : finalLatencyMs !== null
            ? expectedWallClock + finalLatencyMs
            : null;
      const shownCandidates = [];
      for (const ev of events) {
        if (claimedShown.has(ev) || !withinWindow(ev, expectedWallClock, windowEnd)) continue;
        if (ev.msg.action !== 'showVerse') continue;
        if (signalAt !== null && ev.at < signalAt) continue;
        let ref;
        try {
          ref = detector.parseReference(ev.msg.reference);
        } catch (_e) {
          continue;
        }
        if (!ref) continue;
        shownCandidates.push({ ev, key: refKeyOf(ref.book, ref.chapter, ref.verseStart) });
      }
      if (shownCandidates.length > 0) {
        shown = shownCandidates.some((c) => c.key === expectedRefKey);
        const last = shownCandidates[shownCandidates.length - 1];
        finalShownCorrect = last.key === expectedRefKey;
        if (shown) {
          shownLatencyMs = shownCandidates[0].ev.at - expectedWallClock;
        }
        claimedShown.add(last.ev);
      }
    } else {
      // expects_scripture=false : succès = AUCUN showVerse attribuable
      // n'est arrivé dans la fenêtre de cet énoncé (faux positif sinon).
      falsePositive = events.some(
        (ev) =>
          !claimedShown.has(ev) &&
          ev.msg.action === 'showVerse' &&
          ev.at >= expectedWallClock - 1500 &&
          ev.at <= windowEnd
      );
      if (falsePositive) {
        const ev = events.find(
          (e) =>
            !claimedShown.has(e) &&
            e.msg.action === 'showVerse' &&
            e.at >= expectedWallClock - 1500 &&
            e.at <= windowEnd
        );
        if (ev) claimedShown.add(ev);
      }
    }

    results.push({
      row,
      textDetected,
      partialLatencyMs,
      finalLatencyMs,
      candidateLatencyMs,
      biblePreloadLatencyMs,
      shown,
      shownLatencyMs,
      finalShownCorrect,
      falsePositive,
      confirmToDisplayMs:
        shown && typeof shownLatencyMs === 'number' && typeof finalLatencyMs === 'number'
          ? shownLatencyMs - finalLatencyMs
          : null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
function printAndBuildSummary(providerLabel, allResults) {
  console.log(`\n\n================ ${providerLabel} ================\n`);

  const expectingRef = allResults.filter((r) => r.row.expectsScripture);
  const negatives = allResults.filter((r) => !r.row.expectsScripture);

  const shownCount = expectingRef.filter((r) => r.shown).length;
  const finalCorrectCount = expectingRef.filter((r) => r.finalShownCorrect).length;
  const overwrittenCount = expectingRef.filter((r) => r.shown && !r.finalShownCorrect).length;
  const textOnlyCount = expectingRef.filter((r) => r.textDetected && !r.shown).length;
  const missedCount = expectingRef.filter((r) => !r.textDetected).length;
  const falsePositives = negatives.filter((r) => r.falsePositive).length;

  const firstAttemptRate = expectingRef.length > 0 ? finalCorrectCount / expectingRef.length : null;

  const latencies = expectingRef
    .filter((r) => r.shown && typeof r.shownLatencyMs === 'number')
    .map((r) => r.shownLatencyMs)
    .sort((a, b) => a - b);

  function chainValues(field) {
    return expectingRef
      .filter((r) => typeof r[field] === 'number')
      .map((r) => r[field])
      .sort((a, b) => a - b);
  }
  function latLine(label, values) {
    if (values.length === 0) return `  ${label} : — (aucun)`;
    const neg = values.filter((v) => v < 0).length;
    return (
      `  ${label} : p50=${percentile(values, 50)}ms  p75=${percentile(values, 75)}ms  ` +
      `p90=${percentile(values, 90)}ms  p95=${percentile(values, 95)}ms  ` +
      `min=${values[0]}ms  max=${values[values.length - 1]}ms` +
      (neg > 0 ? `  (${neg} négatif(s) : arrivée avant la fin de l'audio — spéculatif/streaming, légitime)` : '')
    );
  }

  console.log(
    `Taux de première tentative : ${finalCorrectCount}/${expectingRef.length}` +
      (firstAttemptRate !== null ? ` (${(firstAttemptRate * 100).toFixed(1)}%)` : '')
  );
  if (overwrittenCount > 0) {
    console.log(
      `  ⚠ dont affiché PUIS ÉCRASÉ par un mauvais verset (état final erroné) : ${overwrittenCount}`
    );
  }
  console.log(
    `  dont détecté par le texte mais JAMAIS affiché (dédoublonnage/confiance/repli silencieux) : ${textOnlyCount}`
  );
  console.log(`  dont jamais détecté du tout (échec ASR/regex) : ${missedCount}`);
  console.log(
    `Faux positifs (référence affichée alors qu'aucune n'était attendue) : ${falsePositives}/${negatives.length}`
  );
  if (latencies.length > 0) {
    console.log(
      `Latence affichage (sur les ${latencies.length} énoncés réellement affichés) — ` +
        `p50=${percentile(latencies, 50)}ms  p75=${percentile(latencies, 75)}ms  ` +
        `p90=${percentile(latencies, 90)}ms  p95=${percentile(latencies, 95)}ms  ` +
        `min=${latencies[0]}ms  max=${latencies[latencies.length - 1]}ms`
    );
  } else {
    console.log('Latence affichage : aucun énoncé affiché, pas de percentile calculable.');
  }

  console.log('\n--- Chaîne de latence (horodatage attendu = fin de l’énoncé, négatif = avant la fin) ---');
  console.log(latLine('Speech → partial (réf. détectée)', chainValues('partialLatencyMs')));
  console.log(latLine('Speech → candidateVerse', chainValues('candidateLatencyMs')));
  console.log(latLine('Speech → final', chainValues('finalLatencyMs')));
  console.log(latLine('Speech → affichage (showVerse)', chainValues('shownLatencyMs')));
  console.log(
    latLine(
      'Final → affichage (coût pipeline après le final, Bible préchauffée ou non)',
      chainValues('confirmToDisplayMs')
    )
  );

  console.log('\n--- Par catégorie ---');
  const categories = [...new Set(allResults.map((r) => r.row.category))];
  for (const cat of categories) {
    const catExpecting = expectingRef.filter((r) => r.row.category === cat);
    const catNegatives = negatives.filter((r) => r.row.category === cat);
    if (catExpecting.length > 0) {
      const catShown = catExpecting.filter((r) => r.shown).length;
      console.log(`  ${cat} : ${catShown}/${catExpecting.length} affichés`);
    }
    if (catNegatives.length > 0) {
      const catFp = catNegatives.filter((r) => r.falsePositive).length;
      console.log(`  ${cat} : ${catFp}/${catNegatives.length} faux positifs`);
    }
  }

  console.log('\n--- Détail doublon_10s (diagnostic DEDUP_MS) ---');
  for (const r of allResults.filter((r) => r.row.category === 'doublon_10s')) {
    console.log(
      `  ${r.row.id} (${r.row.expectedText}) : textDetected=${r.textDetected} shown=${r.shown}` +
        (r.textDetected && !r.shown
          ? '  <-- détecté mais jamais affiché : signe de suppression par dédoublonnage'
          : '')
    );
  }

  console.log('\n--- Lignes en échec ---');
  for (const r of allResults) {
    if (r.row.expectsScripture && !r.shown) {
      console.log(`  ❌ ${r.row.id} [${r.row.category}] "${r.row.expectedText}"`);
    }
    if (r.row.expectsScripture && r.shown && !r.finalShownCorrect) {
      console.log(
        `  ⚠ ${r.row.id} [${r.row.category}] "${r.row.expectedText}" : bon verset affiché mais ÉCRASÉ ensuite`
      );
    }
    if (!r.row.expectsScripture && r.falsePositive) {
      console.log(`  ❌ ${r.row.id} [${r.row.category}] faux positif : "${r.row.expectedText}"`);
    }
  }

  return {
    provider: providerLabel,
    total: allResults.length,
    expectingReference: expectingRef.length,
    shown: shownCount,
    finalCorrect: finalCorrectCount,
    overwrittenFinalState: overwrittenCount,
    textDetectedNotShown: textOnlyCount,
    neverDetected: missedCount,
    firstAttemptRate,
    falsePositives,
    negativesTotal: negatives.length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP75Ms: percentile(latencies, 75),
    latencyP90Ms: percentile(latencies, 90),
    latencyP95Ms: percentile(latencies, 95),
    latencyMinMs: latencies[0] ?? null,
    latencyMaxMs: latencies[latencies.length - 1] ?? null,
    chain: {
      partial: chainValues('partialLatencyMs').map((v) => v),
      candidate: chainValues('candidateLatencyMs').map((v) => v),
      biblePreload: chainValues('biblePreloadLatencyMs').map((v) => v),
      final: chainValues('finalLatencyMs').map((v) => v),
      display: chainValues('shownLatencyMs').map((v) => v),
      confirmToDisplay: chainValues('confirmToDisplayMs').map((v) => v),
    },
    byCategory: categories.map((cat) => {
      const catExpecting = expectingRef.filter((r) => r.row.category === cat);
      const catNegatives = negatives.filter((r) => r.row.category === cat);
      return {
        category: cat,
        shown: catExpecting.filter((r) => r.shown).length,
        expecting: catExpecting.length,
        falsePositives: catNegatives.filter((r) => r.falsePositive).length,
        negatives: catNegatives.length,
      };
    }),
    details: allResults.map((r) => ({
      id: r.row.id,
      category: r.row.category,
      expectedText: r.row.expectedText,
      textDetected: r.textDetected,
      partialLatencyMs: r.partialLatencyMs,
      finalLatencyMs: r.finalLatencyMs,
      candidateLatencyMs: r.candidateLatencyMs,
      biblePreloadLatencyMs: r.biblePreloadLatencyMs,
      shown: r.shown,
      finalShownCorrect: r.finalShownCorrect,
      shownLatencyMs: r.shownLatencyMs,
      confirmToDisplayMs: r.confirmToDisplayMs,
      falsePositive: r.falsePositive,
    })),
  };
}

(async () => {
  await sleep(400);

  // CORRECTIF (trouvé en exécutant ce banc en conditions réelles) :
  // server.js#startPipeline() démarre lui-même une capture au boot
  // (audioCapture.startBrowserCapture(), voir server.js) avec l'ASR_PROVIDER
  // présent dans l'environnement à CE moment-là (ici, .env — qui peut très
  // bien contenir un réglage laissé d'une session de test précédente,
  // indépendant de ce que ce banc veut mesurer). Sans cet arrêt explicite,
  // le premier appel à startBrowserCapture() de replayFile() échouait
  // silencieusement ("Enregistrement déjà en cours") et rejouait CE fichier
  // contre la session déjà active (mauvais provider, jamais celui demandé
  // par --provider).
  await audioCapture.stopRecording();
  await sleep(500);

  const rows = loadCorpus(CORPUS_PATH);
  const usableRows = rows.filter((r) => r.sourceFile);
  if (usableRows.length === 0) {
    console.error(
      `[corpus-bench] Aucune ligne de "${CORPUS_PATH}" n'a de source_file renseigné — ` +
        'rien à rejouer. Voir CORPUS-SCRIPT.md pour compléter le corpus, ou lancer avec ' +
        '--corpus=live-tests/corpus-smoketest.csv pour valider ce banc sur les échantillons déjà présents.'
    );
    process.exit(2);
  }

  const bySourceFile = new Map();
  for (const row of usableRows) {
    if (!bySourceFile.has(row.sourceFile)) bySourceFile.set(row.sourceFile, []);
    bySourceFile.get(row.sourceFile).push(row);
  }
  for (const [, fileRows] of bySourceFile) {
    fileRows.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  }

  const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const allSummaries = [];

  for (const provider of PROVIDERS_TO_RUN) {
    console.log(
      `\n\n########## Chemin : ${provider === 'auto' ? 'batch (auto)' : 'streaming (deepgram)'} ##########`
    );
    const allResults = [];
    for (const [sourceFile, fileRows] of bySourceFile) {
      console.log(`\n--- Fichier : ${sourceFile} (${fileRows.length} énoncé(s)) ---`);
      const { feedTimes, events } = await replayFile(sourceFile, provider, ws);
      if (feedTimes === null) continue;
      const matched = matchRowsToEvents(fileRows, feedTimes, events);
      allResults.push(...matched);
      await sleep(300);
    }
    const summary = printAndBuildSummary(
      provider === 'auto' ? 'BATCH (auto)' : 'STREAMING (deepgram)',
      allResults
    );
    allSummaries.push(summary);
  }

  ws.close();

  if (allSummaries.length === 2) {
    console.log('\n\n================ COMPARATIF ================\n');
    const [a, b] = allSummaries;
    console.log(
      `Taux de première tentative — ${a.provider} : ${(a.firstAttemptRate * 100).toFixed(1)}%  vs  ${b.provider} : ${(b.firstAttemptRate * 100).toFixed(1)}%`
    );
    console.log(
      `Latence p50 — ${a.provider} : ${a.latencyP50Ms}ms  vs  ${b.provider} : ${b.latencyP50Ms}ms`
    );
    console.log(
      `Latence p95 — ${a.provider} : ${a.latencyP95Ms}ms  vs  ${b.provider} : ${b.latencyP95Ms}ms`
    );
  }

  const outPath = path.join(__dirname, 'corpus-bench-results.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { corpus: CORPUS_PATH, ranAt: new Date().toISOString(), summaries: allSummaries },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\n[corpus-bench] Résultats écrits dans ${outPath}`);

  process.exit(0);
})().catch((err) => {
  console.error('[corpus-bench] ÉCHEC INATTENDU:', err.message);
  console.error(err.stack);
  process.exit(1);
});
