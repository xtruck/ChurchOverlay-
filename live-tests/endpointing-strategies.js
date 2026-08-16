'use strict';
/**
 * ============================================================================
 *  live-tests/endpointing-strategies.js â€” comparaison RÃ‰ELLE de stratÃ©gies de
 *  dÃ©tection de fin d'Ã©noncÃ© cÃ´tÃ© Deepgram, contre le vrai service.
 * ----------------------------------------------------------------------------
 *  N'utilise PAS deepgram-streaming.js (volontairement â€” on ne veut pas
 *  modifier la config de production pendant l'expÃ©rimentation, voir Â§1/Â§4 du
 *  cahier des charges). Construit ses propres URLs de test avec le module
 *  `ws` directement, mÃªme en-tÃªte d'authentification.
 *
 *  StratÃ©gies testÃ©es, sur le MÃŠME Ã©chantillon audio (silence pur en fin de
 *  phrase, pour isoler la dÃ©tection de fin de parole du bruit ambiant) :
 *    A. Configuration actuelle de production (endpointing=500 seul)
 *    B. endpointing seul, mais silence prolongÃ© (jusqu'Ã  10s) â€” pour savoir
 *       si Ã§a finit PAR arriver, ou si Ã§a n'arrive vraiment jamais
 *    C. utterance_end_ms=1000 + vad_events=true (recommandation officielle
 *       Deepgram, voir developers.deepgram.com/docs/utterance-end) â€” ET on
 *       Ã©coute explicitement le message 'UtteranceEnd', que
 *       deepgram-streaming.js ignore actuellement (type !== 'Results')
 *    D. vad_events=true seul â€” observation des Ã©vÃ¨nements SpeechStarted
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
  console.error('REAL SERVICE TEST BLOCKED â€” DEEPGRAM_API_KEY NOT CONFIGURED');
  process.exit(2);
}

const { buildDeepgramKeyterms } = require('../bible-keyterms');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataStart = buf.indexOf('data') + 8;
  return buf.subarray(dataStart);
}

// CORRECTIF (Chantier 1a â€” migration nova-2 -> nova-3) : ce script construit
// sa PROPRE URL indÃ©pendamment de deepgram-streaming.js (volontairement, voir
// en-tÃªte de fichier) â€” mis Ã  jour ici pour rester cohÃ©rent avec le modÃ¨le
// et le paramÃ¨tre de boosting rÃ©ellement utilisÃ©s en production dÃ©sormais.
function buildUrl(extraParams) {
  const keytermQuery = buildDeepgramKeyterms()
    .map((kt) => `keyterm=${encodeURIComponent(kt)}`)
    .join('&');
  const base = [
    'model=nova-3',
    'language=fr',
    'punctuate=true',
    'smart_format=true',
    'interim_results=true',
    'encoding=linear16',
    'sample_rate=16000',
    'channels=1',
    keytermQuery,
  ];
  return `wss://api.deepgram.com/v1/listen?${[...base, ...extraParams].filter(Boolean).join('&')}`;
}

/**
 * Ouvre une connexion, envoie l'audio d'un fichier + N secondes de silence
 * numÃ©rique, et journalise chaque message brut avec un horodatage relatif.
 * @param {string} label
 * @param {string[]} extraParams
 * @param {number} silenceSeconds
 */
async function runStrategy(label, extraParams, silenceSeconds) {
  console.log(`\n========== StratÃ©gie ${label} ==========`);
  console.log(`ParamÃ¨tres additionnels : ${extraParams.join('&') || '(aucun)'}`);
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
      console.log(`  [+${t}ms] ${msg.type} (ignorÃ© par ce diagnostic)`);
    }
  });

  const pcm = readWavPcm(path.join(__dirname, 'samples', 'testA_16k.wav'));
  const FRAME_BYTES = 640;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    ws.send(pcm.subarray(offset, offset + FRAME_BYTES));
    await sleep(20);
  }
  console.log(
    `  [+${Date.now() - t0}ms] audio terminÃ© ("Jean chapitre trois verset seize."), dÃ©but du silence...`
  );
  const SILENCE = Buffer.alloc(FRAME_BYTES);
  const silenceFrames = Math.round((silenceSeconds * 1000) / 20);
  for (let i = 0; i < silenceFrames; i++) {
    ws.send(SILENCE);
    await sleep(20);
  }
  console.log(`  [+${Date.now() - t0}ms] fin des ${silenceSeconds}s de silence envoyÃ©es`);

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
  const only = process.argv[2] || ''; // ex. "CEFGH" pour ne relancer que certaines stratÃ©gies
  const onlySet = new Set(only.split(''));
  const want = (label) => only === '' || onlySet.has(label);
  const results = [];

  if (want('A'))
    results.push(
      await runStrategy('A (production actuelle : endpointing=500)', ['endpointing=500'], 4)
    );
  if (want('B'))
    results.push(
      await runStrategy(
        'B (endpointing=500, silence prolongÃ© 10s â€” arrive-t-il JAMAIS ?)',
        ['endpointing=500'],
        10
      )
    );
  if (want('C'))
    results.push(
      await runStrategy(
        'C (utterance_end_ms=1000 + vad_events=true, recommandation officielle Deepgram, silence 10s pour comparaison Ã©quitable avec B)',
        ['endpointing=500', 'utterance_end_ms=1000', 'vad_events=true'],
        10
      )
    );
  if (want('D'))
    results.push(
      await runStrategy(
        'D (vad_events=true seul, sans endpointing ni utterance_end_ms)',
        ['vad_events=true'],
        4
      )
    );
  // AJOUT (Chantier 1.4 â€” balayage des valeurs d'endpointing demandÃ© par la
  // mission) : mÃªme Ã©chantillon, mÃªme silence de 4s, seule la valeur
  // endpointing change. Objectif : confirmer la plage sur laquelle l'arrivÃ©e
  // du `speech_final` officiel Deepgram reste stable, et repÃ©rer la valeur
  // en dessous de laquelle l'Ã©noncÃ© risque d'Ãªtre fragmentÃ© en plusieurs
  // finals (pause naturelle entre clauses > endpointing).
  if (want('E'))
    results.push(
      await runStrategy('E (endpointing=250)', ['endpointing=250'], 4)
    );
  if (want('F'))
    results.push(
      await runStrategy('F (endpointing=350)', ['endpointing=350'], 4)
    );
  if (want('G'))
    results.push(
      await runStrategy('G (endpointing=700)', ['endpointing=700'], 4)
    );
  if (want('H'))
    results.push(
      await runStrategy('H (endpointing=1000)', ['endpointing=1000'], 4)
    );

  console.log('\n\n================ RÃ‰SUMÃ‰ ================\n');
  for (const r of results) {
    console.log(`StratÃ©gie ${r.label}`);
    console.log(
      `  speech_final=true reÃ§u Ã  : ${r.speechFinalAtMs !== null ? '+' + r.speechFinalAtMs + 'ms' : 'JAMAIS'}`
    );
    console.log(
      `  UtteranceEnd reÃ§u Ã        : ${r.utteranceEndAtMs !== null ? '+' + r.utteranceEndAtMs + 'ms' : 'JAMAIS'}`
    );
    console.log(
      `  SpeechStarted reÃ§u Ã       : ${r.speechStartedAtMs !== null ? '+' + r.speechStartedAtMs + 'ms' : 'JAMAIS'}`
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
    '[endpointing-strategies] RÃ©sultats dÃ©taillÃ©s Ã©crits dans live-tests/endpointing-strategies-results.json'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[endpointing-strategies] Ã‰CHEC:', err.message);
  console.error(err.stack);
  process.exit(1);
});
