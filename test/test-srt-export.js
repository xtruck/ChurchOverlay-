'use strict';
/**
 * Tests unitaires — srt-export.js (module pur, aucun ffmpeg/disque impliqué
 * ici ; la vérification "un vrai ffmpeg accepte le .srt produit" vit dans
 * test-clip-exporter.js, contre un vrai binaire).
 */

const srtExport = require('../srt-export');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name, detail !== undefined ? '— ' + detail : '');
    failed++;
  }
}

// --- formatSrtTimestamp() -------------------------------------------------
check('formatSrtTimestamp(0) -> 00:00:00,000', srtExport.formatSrtTimestamp(0) === '00:00:00,000');
check(
  'formatSrtTimestamp(3723456) -> 01:02:03,456',
  srtExport.formatSrtTimestamp(3_723_456) === '01:02:03,456'
);
check(
  'formatSrtTimestamp(négatif) -> clampé à 0',
  srtExport.formatSrtTimestamp(-500) === '00:00:00,000'
);

// --- buildSrt() : cas de base ---------------------------------------------
{
  const start = 1_000_000;
  const segments = [
    { text: 'Bonjour à tous', started_at: start + 1000, ended_at: start + 2000 },
    { text: 'Bienvenue à ce culte', started_at: start + 10000, ended_at: start + 11500 },
  ];
  const srt = srtExport.buildSrt(segments, start);
  check('buildSrt: retourne un contenu non vide pour 2 segments valides', srt.length > 0, srt);
  check('buildSrt: index 1 et 2 présents', srt.startsWith('1\n') && srt.includes('\n2\n'));
  check('buildSrt: horodatage du premier segment = 00:00:01,000', srt.includes('00:00:01,000 -->'));
  check('buildSrt: texte du premier segment présent', srt.includes('Bonjour à tous'));
  check('buildSrt: texte du second segment présent', srt.includes('Bienvenue à ce culte'));
}

// --- buildSrt() : entrée vide/invalide ------------------------------------
check('buildSrt([], start) -> chaîne vide', srtExport.buildSrt([], 1000) === '');
check('buildSrt(segments, 0) -> chaîne vide (sessionStartedAt falsy)', srtExport.buildSrt([{ text: 'x', started_at: 5 }], 0) === '');
check('buildSrt(null, start) -> chaîne vide', srtExport.buildSrt(null, 1000) === '');
check(
  'buildSrt: segment sans texte/started_at ignoré, pas de crash',
  srtExport.buildSrt([{ started_at: 1000 }, { text: '' , started_at: 1000 }], 500) === ''
);

// --- buildSrt() : tri chronologique, même si les segments arrivent
// désordonnés (ex. re-livraison réseau, ordre d'insertion DB non garanti) --
{
  const start = 500_000;
  const segments = [
    { text: 'Deuxième', started_at: start + 5000, ended_at: start + 5500 },
    { text: 'Premier', started_at: start + 1000, ended_at: start + 1500 },
  ];
  const srt = srtExport.buildSrt(segments, start);
  const firstBlockIndex = srt.indexOf('Premier');
  const secondBlockIndex = srt.indexOf('Deuxième');
  check(
    'buildSrt: segments triés chronologiquement quel que soit leur ordre d’entrée',
    firstBlockIndex !== -1 && secondBlockIndex !== -1 && firstBlockIndex < secondBlockIndex
  );
}

// --- buildSrt() : offset négatif (segment avant le début du culte) ignoré -
{
  const start = 10_000;
  const segments = [
    { text: 'Avant le début (bruit de fond capté trop tôt)', started_at: 5000, ended_at: 6000 },
    { text: 'Après le début', started_at: 12000, ended_at: 13000 },
  ];
  const srt = srtExport.buildSrt(segments, start);
  check('buildSrt: segment antérieur au début du culte exclu', !srt.includes('Avant le début'));
  check('buildSrt: segment postérieur conservé', srt.includes('Après le début'));
}

// --- buildSrt() : aucun chevauchement entre sous-titres consécutifs, dans
// le cas normal où l'écart entre deux énoncés dépasse le plancher de
// lisibilité (voir le test suivant pour le cas limite où le plancher
// l'emporte délibérément) --------------------------------------------------
{
  const start = 500_000;
  const segments = [
    { text: 'Un', started_at: start + 1000, ended_at: start + 1300 },
    { text: 'Deux', started_at: start + 4000, ended_at: start + 4300 },
  ];
  const srt = srtExport.buildSrt(segments, start);
  const timeLines = srt.split('\n').filter((l) => l.includes('-->'));
  const [, end1] = timeLines[0].split(' --> ');
  const [start2] = timeLines[1].split(' --> ');
  check(
    'buildSrt: le premier sous-titre ne dépasse pas le début du second (pas de chevauchement)',
    end1 <= start2,
    `${end1} vs ${start2}`
  );
}

// --- buildSrt() : cas limite documenté — deux énoncés très rapprochés
// (< MIN_SUBTITLE_DURATION_MS d'écart) : le plancher de lisibilité l'emporte
// DÉLIBÉRÉMENT sur la règle "pas de chevauchement" (voir le commentaire de
// buildSrt()) — les deux sous-titres restent bien produits, sans crash. ----
{
  const start = 500_000;
  const segments = [
    { text: 'Un', started_at: start + 1000, ended_at: start + 1200 },
    { text: 'Deux', started_at: start + 1300, ended_at: start + 1500 }, // arrive vite après "Un"
  ];
  const srt = srtExport.buildSrt(segments, start);
  check(
    'buildSrt: cas limite rapproché -> les 2 sous-titres sont quand même produits (pas perdus)',
    srt.includes('Un') && srt.includes('Deux')
  );
}

// --- buildSrt() : plancher de lisibilité (MIN_SUBTITLE_DURATION_MS) -------
{
  const start = 500_000;
  // ended_at très proche de started_at (STT quasi instantané) -> doit quand
  // même rester affiché au moins MIN_SUBTITLE_DURATION_MS.
  const segments = [{ text: 'Amen', started_at: start + 1000, ended_at: start + 1010 }];
  const srt = srtExport.buildSrt(segments, start);
  const [tsStart, tsEnd] = srt
    .split('\n')
    .find((l) => l.includes('-->'))
    .split(' --> ');
  const toMs = (ts) => {
    const [, h, m, s, ms] = /(\d+):(\d+):(\d+),(\d+)/.exec(ts);
    return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
  };
  check(
    `buildSrt: durée plancher respectée (obtenu ${toMs(tsEnd) - toMs(tsStart)}ms, attendu >= ${srtExport.MIN_SUBTITLE_DURATION_MS}ms)`,
    toMs(tsEnd) - toMs(tsStart) >= srtExport.MIN_SUBTITLE_DURATION_MS
  );
}

// --- buildSrt() : plafond de durée (MAX_SUBTITLE_DURATION_MS) -------------
{
  const start = 500_000;
  // Pas de segment suivant, ended_at très tardif (silence long après le mot,
  // ou chemin non instrumenté) -> ne doit pas s'afficher indéfiniment.
  const segments = [{ text: 'Silence long après ce mot', started_at: start + 1000, ended_at: start + 21000 }];
  const srt = srtExport.buildSrt(segments, start);
  const [tsStart, tsEnd] = srt
    .split('\n')
    .find((l) => l.includes('-->'))
    .split(' --> ');
  const toMs = (ts) => {
    const [, h, m, s, ms] = /(\d+):(\d+):(\d+),(\d+)/.exec(ts);
    return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
  };
  check(
    `buildSrt: durée plafonnée (obtenu ${toMs(tsEnd) - toMs(tsStart)}ms, attendu <= ${srtExport.MAX_SUBTITLE_DURATION_MS}ms)`,
    toMs(tsEnd) - toMs(tsStart) <= srtExport.MAX_SUBTITLE_DURATION_MS
  );
}

// --- buildSrt() : fenêtrage + rebasage pour un extrait (clip-exporter.js) -
{
  // Culte de test : segments à +2s, +4s (dans la fenêtre du clip) et +25s
  // (hors fenêtre). Clip qui démarre à +2s et dure 15s -> fenêtre [2s,17s].
  const start = 100_000;
  const segments = [
    { text: 'Dans la fenêtre - début', started_at: start + 2000, ended_at: start + 3000 },
    { text: 'Dans la fenêtre - suite', started_at: start + 4000, ended_at: start + 5000 },
    { text: 'Hors fenêtre - trop tard', started_at: start + 25000, ended_at: start + 26000 },
    { text: 'Hors fenêtre - trop tôt', started_at: start - 5000, ended_at: start - 4000 },
  ];
  const srt = srtExport.buildSrt(segments, start, {
    windowStartMs: 2000,
    windowEndMs: 2000 + 15000,
  });
  check('buildSrt fenêtré: segment dans la fenêtre conservé (début)', srt.includes('Dans la fenêtre - début'));
  check('buildSrt fenêtré: segment dans la fenêtre conservé (suite)', srt.includes('Dans la fenêtre - suite'));
  check('buildSrt fenêtré: segment après la fenêtre exclu', !srt.includes('Hors fenêtre - trop tard'));
  check('buildSrt fenêtré: segment avant le début du culte exclu', !srt.includes('Hors fenêtre - trop tôt'));
  // REBASAGE : le premier segment de la fenêtre (à +2s du culte, donc +0s de
  // la fenêtre) doit apparaître à 00:00:00 dans le .srt du CLIP, pas 00:00:02.
  check(
    'buildSrt fenêtré: timestamps REBASÉS sur le début du clip (0 = début de la fenêtre)',
    srt.startsWith('1\n00:00:00,000 -->')
  );
}

console.log(`\n=== Résultat srt-export : ${passed}/${passed + failed} ===`);
if (failed > 0) process.exit(1);
