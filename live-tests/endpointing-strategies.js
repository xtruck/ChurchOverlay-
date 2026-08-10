'use strict';
/**
 * ============================================================================
 *  live-tests/endpointing-strategies.js — comparaison RÉELLE de stratégies de
 *  détection de fin d'énoncé côté Deepgram, contre le vrai service.
 * ----------------------------------------------------------------------------
 *  N'utilise PAS deepgram-streaming.js (volontairement — on ne veut pas
 *  modifier la config de production pendant l'expérimentation, voir §1/§4 du
 *  cahier des charges). Construit ses propres URLs de test avec le module
 *  `ws` directement, même en-tête d'authentification.
 *
 *  Stratégies testées, sur le MÊME échantillon audio (silence pur en fin de
 *  phrase, pour isoler la détection de fin de parole du bruit ambiant) :
 *    A. Configuration actuelle de production (endpointing=500 seul)
 *    B. endpointing seul, mais silence prolongé (jusqu'à 10s) — pour savoir
 *       si ça finit PAR arriver, ou si ça n'arrive vraiment jamais
 *    C. utterance_end_ms=1000 + vad_events=true (recommandation officielle
 *       Deepgram, voir developers.deepgram.com/docs/utterance-end) — ET on
 *       écoute explicitement le message 'UtteranceEnd', que
 *       deepgram-streaming.js ignore actuellement (type !== 'Results')
 *    D. vad_events=true seul — observation des évènements SpeechStarted
 *
 *  USAGE : node live-tests/endpointing-strategies.js
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { loadDotEnvInto } = require('../dotenv-loader');
loadDotEnvInto(process.env, [path.join(__dirname, '..', '.env')], () => {});

if (!process.env.DEEPGRAM_API_KEY) {
  console.error('REAL SERVICE TEST BLOCKED — DEEPGRAM_API_KEY NOT CONFIGURED');
  process.exit(2);
}

const { buildDeepgramKeywords } = require('../bible-keyterms');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataStart = buf.indexOf('data') + 8;
  return buf.subarray(dataStart);
}

function buildUrl(extraParams) {
  const keywordsQuery = buildDeepgramKeywords()
    .map((kw) => `keywords=${encodeURIComponent(kw)}`)
    .join('&');
  const base = [
    'model=nova-2',
    'language=fr',
    'punctuate=true',
    'smart_format=true',
    'interim_results=true',
    'encoding=linear16',
    'sample_rate=16000',
    'channels=1',
    keywordsQuery,
  ];
  return `wss://api.deepgram.com/v1/listen?${[...base, ...extraParams].filter(Boolean).join('&')}`;
}

/**
 * Ouvre une connexion, envoie l'audio d'un fichier + N secondes de silence
 * numérique, et journalise chaque message brut avec un horodatage relatif.
 * @param {string} label
 * @param {string[]} extraParams
 * @param {number} silenceSeconds
 */
async function runStrategy(label, extraParams, silenceSeconds) {
  console.log(`\n========== Stratégie ${label} ==========`);
  console.log(`Paramètres additionnels : ${extraParams.join('&') || '(aucun)'}`);
  const url = buildUrl(extraParams);

  const events = [];
  const t0 = Date.now();
  let speechFinalAt = null;
  let utteranceEndAt = null;
  let speechStartedAt = null;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log(`  [+${Date.now() - t0}ms] connexion ouverte`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_e) {
      return;
    }
    const t = Date.now() - t0;
    if (msg.type === 'Results') {
      const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
      if (!transcript) return;
      events.push({
        t,
        type: 'Results',
        is_final: msg.is_final,
        speech_final: msg.speech_final,
        transcript,
      });
      console.log(
        `  [+${t}ms] Results is_final=${msg.is_final} speech_final=${msg.speech_final} "${transcript}"`
      );
      if (msg.speech_final && speechFinalAt === null) speechFinalAt = t;
    } else if (msg.type === 'UtteranceEnd') {
      events.push({ t, type: 'UtteranceEnd', last_word_end: msg.last_word_end });
      console.log(`  [+${t}ms] UtteranceEnd (last_word_end=${msg.last_word_end})`);
      if (utteranceEndAt === null) utteranceEndAt = t;
    } else if (msg.type === 'SpeechStarted') {
      events.push({ t, type: 'SpeechStarted' });
      console.log(`  [+${t}ms] SpeechStarted`);
      if (speechStartedAt === null) speechStartedAt = t;
    } else {
      console.log(`  [+${t}ms] ${msg.type} (ignoré par ce diagnostic)`);
    }
  });

  const pcm = readWavPcm(path.join(__dirname, 'samples', 'testA_16k.wav'));
  const FRAME_BYTES = 640;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    ws.send(pcm.subarray(offset, offset + FRAME_BYTES));
    await sleep(20);
  }
  console.log(
    `  [+${Date.now() - t0}ms] audio terminé ("Jean chapitre trois verset seize."), début du silence...`
  );
  const SILENCE = Buffer.alloc(FRAME_BYTES);
  const silenceFrames = Math.round((silenceSeconds * 1000) / 20);
  for (let i = 0; i < silenceFrames; i++) {
    ws.send(SILENCE);
    await sleep(20);
  }
  console.log(`  [+${Date.now() - t0}ms] fin des ${silenceSeconds}s de silence envoyées`);

  ws.close();
  await sleep(300);

  return {
    label,
    speechFinalAtMs: speechFinalAt,
    utteranceEndAtMs: utteranceEndAt,
    speechStartedAtMs: speechStartedAt,
    events,
  };
}

async function main() {
  const only = process.argv[2] || null; // ex. "C" pour ne relancer qu'une seule stratégie
  const results = [];

  if (!only || only === 'A')
    results.push(
      await runStrategy('A (production actuelle : endpointing=500)', ['endpointing=500'], 4)
    );
  if (!only || only === 'B')
    results.push(
      await runStrategy(
        'B (endpointing=500, silence prolongé 10s — arrive-t-il JAMAIS ?)',
        ['endpointing=500'],
        10
      )
    );
  if (!only || only === 'C')
    results.push(
      await runStrategy(
        'C (utterance_end_ms=1000 + vad_events=true, recommandation officielle Deepgram, silence 10s pour comparaison équitable avec B)',
        ['endpointing=500', 'utterance_end_ms=1000', 'vad_events=true'],
        10
      )
    );
  if (!only || only === 'D')
    results.push(
      await runStrategy(
        'D (vad_events=true seul, sans endpointing ni utterance_end_ms)',
        ['vad_events=true'],
        4
      )
    );

  console.log('\n\n================ RÉSUMÉ ================\n');
  for (const r of results) {
    console.log(`Stratégie ${r.label}`);
    console.log(
      `  speech_final=true reçu à : ${r.speechFinalAtMs !== null ? '+' + r.speechFinalAtMs + 'ms' : 'JAMAIS'}`
    );
    console.log(
      `  UtteranceEnd reçu à       : ${r.utteranceEndAtMs !== null ? '+' + r.utteranceEndAtMs + 'ms' : 'JAMAIS'}`
    );
    console.log(
      `  SpeechStarted reçu à      : ${r.speechStartedAtMs !== null ? '+' + r.speechStartedAtMs + 'ms' : 'JAMAIS'}`
    );
    console.log('');
  }

  fs.writeFileSync(
    path.join(__dirname, 'endpointing-strategies-results.json'),
    JSON.stringify(results, null, 2).replace(
      new RegExp(process.env.DEEPGRAM_API_KEY, 'g'),
      '[REDACTED]'
    ),
    'utf8'
  );
  console.log(
    '[endpointing-strategies] Résultats détaillés écrits dans live-tests/endpointing-strategies-results.json'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[endpointing-strategies] ÉCHEC:', err.message);
  console.error(err.stack);
  process.exit(1);
});
