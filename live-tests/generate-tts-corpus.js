'use strict';
/**
 * ============================================================================
 *  live-tests/generate-tts-corpus.js — synthèse TTS du corpus complet (45 items)
 * ----------------------------------------------------------------------------
 *  Compense l'absence d'enregistrements utilisateur (CORPUS-SCRIPT.md) pour
 *  débloquer le benchmark complet : synthétise les 45 énoncés de corpus.csv
 *  avec les voix SAPI Windows (Hortense fr-FR / Zira en-US), les assemble en
 *  12 blocs WAV mono/16kHz/16-bit dans live-tests/samples/, et remplit les
 *  colonnes source_file/start_ms/end_ms de corpus.csv.
 *
 *  Timing préservé comme demandé par CORPUS-SCRIPT.md :
 *    - bloc 5 (F1/F2)  : écart < 5s   (rafale — teste minFlushIntervalMs)
 *    - bloc 6 (G1/G2)  : écart ~10s   (doublon — teste DEDUP_MS)
 *    - autres blocs    : pause 2-3s
 *
 *  USAGE :
 *    node live-tests/generate-tts-corpus.js
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SAMPLES_DIR = path.join(__dirname, 'samples');
const WORK_DIR = path.join(SAMPLES_DIR, 'tts-synth');
const PS_SCRIPT = path.join(__dirname, '_tts-synthesize.ps1');
const CORPUS_PATH = path.join(__dirname, 'corpus.csv');

const VOICE_FR = 'Microsoft Hortense Desktop';
const VOICE_EN = 'Microsoft Zira Desktop';

const SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Énoncé à synthétiser par id — le texte dit à voix haute. Les items
// "noyés" (I1/I2) sont découpés en [réf + préfixe, suffixe] pour positionner
// end_ms sur la fin de la référence (le banc apparié par horodatage).
// ---------------------------------------------------------------------------
const UTTERANCES = {
  A1: { voice: VOICE_FR, parts: ['Jean trois seize'] },
  A2: { voice: VOICE_FR, parts: ['Jean chapitre trois verset seize'] },
  A3: { voice: VOICE_FR, parts: ['Jean trois seize'] },
  A4: { voice: VOICE_FR, parts: ['Saint Jean trois seize'] },
  A5: { voice: VOICE_FR, parts: ["L'Évangile selon Jean, chapitre trois, verset seize"] },
  B1: { voice: VOICE_EN, parts: ['John three sixteen'] },
  B2: { voice: VOICE_EN, parts: ['The gospel of John, chapter three, verse sixteen'] },
  C1: { voice: VOICE_FR, parts: ['Premier Corinthiens chapitre treize verset quatre'] },
  C2: { voice: VOICE_FR, parts: ['Deuxième Timothée chapitre trois verset seize'] },
  C3: { voice: VOICE_FR, parts: ['Première Jean chapitre quatre verset huit'] },
  D1: { voice: VOICE_FR, parts: ['Habacuc chapitre deux verset quatre'] },
  D2: { voice: VOICE_FR, parts: ['Ecclésiaste chapitre trois verset un'] },
  D3: { voice: VOICE_FR, parts: ['Philémon verset six'] },
  D4: { voice: VOICE_FR, parts: ['Aggée chapitre un verset cinq'] },
  D5: { voice: VOICE_FR, parts: ['Sophonie chapitre trois verset dix-sept'] },
  D6: { voice: VOICE_FR, parts: ['Apocalypse chapitre vingt et un verset quatre'] },
  D7: { voice: VOICE_FR, parts: ['Deutéronome chapitre six verset cinq'] },
  E1: { voice: VOICE_FR, parts: ['Psaume cent dix-neuf verset cent cinq'] },
  E2: { voice: VOICE_FR, parts: ['Nombres chapitre six verset vingt-quatre'] },
  E3: { voice: VOICE_FR, parts: ['Genèse chapitre un verset un'] },
  F1: { voice: VOICE_FR, parts: ['Romains chapitre huit verset vingt-huit'] },
  F2: { voice: VOICE_FR, parts: ['Romains chapitre douze verset deux'] },
  G1: { voice: VOICE_FR, parts: ['Jean chapitre quatorze verset six'] },
  G2: { voice: VOICE_FR, parts: ['Jean chapitre quatorze verset six'] },
  H1: { voice: VOICE_FR, parts: ['Comme il est écrit in the book of Romans, chapter eight'] },
  H2: { voice: VOICE_EN, parts: ['Let us turn to Matthieu chapitre cinq'] },
  I1: {
    voice: VOICE_FR,
    parts: [
      'Alors que nous traversons des moments difficiles, je pense à ce que dit Philippiens quatre treize',
      'qui nous encourage à tenir bon',
    ],
  },
  I2: {
    voice: VOICE_EN,
    parts: [
      'In these uncertain times, remember what Isaiah forty one ten',
      'tells us about not being afraid',
    ],
  },
  J1: {
    voice: VOICE_FR,
    parts: ["Car Dieu a tant aimé le monde qu'il a donné son Fils unique"],
  },
  J2: { voice: VOICE_FR, parts: ["L'Éternel est mon berger, je ne manquerai de rien"] },
  J3: { voice: VOICE_EN, parts: ['For God so loved the world that he gave his only Son'] },
  K1: { voice: VOICE_FR, parts: ['Marc chapitre seize verset quinze'] },
  K2: { voice: VOICE_FR, parts: ['Luc chapitre deux verset onze'] },
  K3: { voice: VOICE_FR, parts: ['Actes chapitre deux verset trente-huit'] },
  K4: { voice: VOICE_FR, parts: ['Éphésiens chapitre deux verset huit'] },
  K5: { voice: VOICE_FR, parts: ['Ésaïe chapitre cinquante-trois verset cinq'] },
  L1: { voice: VOICE_FR, parts: ["Bonjour à tous, merci d'être venus ce matin"] },
  L2: { voice: VOICE_FR, parts: ["N'oubliez pas la collecte spéciale prévue ce dimanche"] },
  L3: { voice: VOICE_EN, parts: ["Let's stand together and worship the Lord"] },
  M1: { voice: VOICE_FR, parts: ['Répétez après moi : Dieu est amour'] },
  M2: { voice: VOICE_FR, parts: ['Nous allons répéter ce chant une fois de plus'] },
  N1: { voice: VOICE_FR, parts: ['Néhémie chapitre huit verset dix'] },
  N2: { voice: VOICE_FR, parts: ['Osée chapitre six verset six'] },
  N3: { voice: VOICE_FR, parts: ['Colossiens chapitre trois verset vingt-trois'] },
  N4: { voice: VOICE_FR, parts: ['Jacques chapitre un verset cinq'] },
};

// Ordre exact de corpus.csv pour la lecture des lignes.
const ALL_IDS = [
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'B1',
  'B2',
  'C1',
  'C2',
  'C3',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'E1',
  'E2',
  'E3',
  'F1',
  'F2',
  'G1',
  'G2',
  'H1',
  'H2',
  'I1',
  'I2',
  'J1',
  'J2',
  'J3',
  'K1',
  'K2',
  'K3',
  'K4',
  'K5',
  'L1',
  'L2',
  'L3',
  'M1',
  'M2',
  'N1',
  'N2',
  'N3',
  'N4',
];

// Blocs — mêmes groupes que CORPUS-SCRIPT.md, écart inter-énoncés en ms.
const BLOCKS = [
  { file: 'bloc1.wav', gapMs: 2500, ids: ['A1', 'A2', 'A3', 'A4', 'A5', 'C1', 'C2', 'C3'] },
  { file: 'bloc2.wav', gapMs: 2500, ids: ['B1', 'B2'] },
  {
    file: 'bloc3.wav',
    gapMs: 2500,
    ids: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'N1', 'N2', 'N3', 'N4'],
  },
  { file: 'bloc4.wav', gapMs: 2500, ids: ['E1', 'E2', 'E3'] },
  { file: 'bloc5.wav', gapMs: 3000, ids: ['F1', 'F2'] },
  { file: 'bloc6.wav', gapMs: 10000, ids: ['G1', 'G2'] },
  { file: 'bloc7.wav', gapMs: 2500, ids: ['H1', 'H2'] },
  { file: 'bloc8.wav', gapMs: 2500, ids: ['I1', 'I2'] },
  { file: 'bloc9.wav', gapMs: 2500, ids: ['J1', 'J2', 'J3'] },
  { file: 'bloc10.wav', gapMs: 2500, ids: ['K1', 'K2', 'K3', 'K4', 'K5'] },
  { file: 'bloc11.wav', gapMs: 2500, ids: ['L1', 'L2', 'L3'] },
  { file: 'bloc12.wav', gapMs: 2500, ids: ['M1', 'M2'] },
];

const interPartGapMs = 120;
const endMarginMs = 400;
const leadingSilenceMs = 200;

function synthesizePart(voice, text, outWav) {
  const txtFile = outWav.replace(/\.wav$/i, '.txt');
  fs.writeFileSync(txtFile, text, 'utf8');
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PS_SCRIPT,
      '-Voice',
      voice,
      '-TextFile',
      txtFile,
      '-OutFile',
      outWav,
    ],
    { stdio: 'pipe' }
  );
}

function readPcm16(filePath) {
  const buf = fs.readFileSync(filePath);
  const dataStart = buf.indexOf('data') + 8;
  return buf.subarray(dataStart);
}

function silenceMs(ms) {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
}

function writeWav16(pcm, outPath) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
}

// ---------------------------------------------------------------------------
// CSV RFC4180 minimal (mêmes conventions que corpus-bench.js)
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

function toCsvField(value) {
  const s = String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
fs.mkdirSync(WORK_DIR, { recursive: true });

const raw = fs.readFileSync(CORPUS_PATH, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
const header = parseCsvLine(lines[0]);
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const values = parseCsvLine(lines[i]);
  const row = {};
  header.forEach((key, idx) => (row[key] = values[idx] !== undefined ? values[idx] : ''));
  rows.push(row);
}
if (rows.length !== ALL_IDS.length) {
  console.error(
    `[generate-tts] ATTENTION : corpus.csv contient ${rows.length} lignes, ALL_IDS en attend ${ALL_IDS.length}.`
  );
}

const idToStartEnd = {};
const idToDuration = {};

for (const block of BLOCKS) {
  const chunks = [];
  let cursorMs = leadingSilenceMs;
  chunks.push(silenceMs(leadingSilenceMs));

  for (const id of block.ids) {
    const spec = UTTERANCES[id];
    if (!spec) {
      console.error(`[generate-tts] id ${id} inconnu dans UTTERANCES — ignoré.`);
      continue;
    }
    const partWavs = spec.parts.map((text, idx) => {
      const wav = path.join(WORK_DIR, `${id}_p${idx + 1}.wav`);
      synthesizePart(spec.voice, text, wav);
      return readPcm16(wav);
    });

    let uttSamples;
    if (partWavs.length === 1) {
      uttSamples = partWavs[0];
    } else {
      const gap = silenceMs(interPartGapMs);
      const merged = [partWavs[0]];
      for (let i = 1; i < partWavs.length; i++) {
        merged.push(gap, partWavs[i]);
      }
      uttSamples = Buffer.concat(merged);
    }

    const uttStartMs = cursorMs;
    const uttDurationMs = Math.round((uttSamples.length / 2 / SAMPLE_RATE) * 1000);
    const refEndMs =
      partWavs.length > 1
        ? Math.round((partWavs[0].length / 2 / SAMPLE_RATE) * 1000 + interPartGapMs + endMarginMs)
        : uttDurationMs;

    idToStartEnd[id] = { startMs: uttStartMs, endMs: uttStartMs + refEndMs };
    idToDuration[id] = uttDurationMs;

    chunks.push(uttSamples);
    chunks.push(silenceMs(block.gapMs));
    cursorMs = uttStartMs + uttDurationMs + block.gapMs;
  }

  const pcm = Buffer.concat(chunks);
  writeWav16(pcm, path.join(SAMPLES_DIR, block.file));
  console.log(
    `[generate-tts] ${block.file} : ${block.ids.length} énoncés, ${pcm.length / 2 / SAMPLE_RATE}s, ` +
      block.ids.map((id) => `${id}@${idToStartEnd[id].startMs}ms`).join(' ')
  );
}

// ---------------------------------------------------------------------------
// Remplissage corpus.csv
// ---------------------------------------------------------------------------
const BLOCK_FILE_BY_ID = {};
for (const block of BLOCKS) {
  for (const id of block.ids) {
    BLOCK_FILE_BY_ID[id] = block.file.replace(/^bloc(\d+)\.wav$/, '$1');
  }
}

for (const row of rows) {
  const se = idToStartEnd[row.id];
  if (se) {
    row.source_file = `bloc${BLOCK_FILE_BY_ID[row.id]}.wav`;
    row.start_ms = String(se.startMs);
    row.end_ms = String(se.endMs);
  }
}

const outLines = [header.map((h) => toCsvField(h)).join(',')];
for (const row of rows) {
  outLines.push(header.map((h) => toCsvField(row[h])).join(','));
}
fs.writeFileSync(CORPUS_PATH, outLines.join('\n') + '\n', 'utf8');
console.log(`[generate-tts] corpus.csv mis à jour (${rows.length} lignes).`);
