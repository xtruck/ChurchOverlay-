'use strict';
/**
 * Test d'intégration — clip-exporter.js, avec un VRAI binaire ffmpeg
 * (ffmpeg-static) et une VRAIE vidéo source générée pour l'occasion — pas
 * de mock du process ffmpeg lui-même, exactement le genre de chose que ce
 * dépôt s'est fait piéger plusieurs fois cette session à supposer plutôt
 * que vérifier (voir JOURNAL-MISSION.md). C'est en lançant ce test contre
 * un vrai ffmpeg qu'un vrai bug de durée a été trouvé (-c copy produisait
 * des extraits ~5x trop longs sur une source aux keyframes espacées) —
 * corrigé dans clip-exporter.js (réencodage au lieu d'une recopie).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const clipExporter = require('../clip-exporter');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

function getDurationSec(filePath) {
  const res = spawnSync(ffmpegPath, ['-i', filePath], { encoding: 'utf8' });
  const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(res.stderr || '');
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-clip-exporter-test-'));
const sourcePath = path.join(tmpDir, 'source.mp4');
const outputDir = path.join(tmpDir, 'clips');

console.log('[test-clip-exporter] Génération de la vidéo source de test (30s)...');
const gen = spawnSync(
  ffmpegPath,
  [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=30:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=30',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    sourcePath,
  ],
  { encoding: 'utf8' }
);

(async () => {
  check('vidéo source de test générée', gen.status === 0 && fs.existsSync(sourcePath));

  // --- sanitizeFilenamePart() : accents/emoji retirés, nom de fichier sûr ---
  check(
    'sanitizeFilenamePart: accents retirés',
    clipExporter.sanitizeFilenamePart('Ésaïe 53:5') === 'esaie-53-5'
  );
  check(
    'sanitizeFilenamePart: caractères non alphanumériques -> tiret',
    clipExporter.sanitizeFilenamePart('📷 Logo église') === 'logo-eglise'
  );
  check(
    'sanitizeFilenamePart: valeur vide -> "extrait"',
    clipExporter.sanitizeFilenamePart('') === 'extrait'
  );

  // --- exportClips() : aucun temps fort -> aucun extrait, pas d'erreur ---
  {
    const result = await clipExporter.exportClips(sourcePath, outputDir, [], 1_000_000);
    check(
      'exportClips([]): ok=true, clips=[], errors=[]',
      result.ok && result.clips.length === 0 && result.errors.length === 0
    );
  }

  // --- exportClips() réel : 2 temps forts, durée dans la plage valide ---
  const start = 1_000_000;
  const entries = [
    { reference: 'Jean 3:16', shown_at: start + 2000 },
    { reference: 'Romains 8:28', shown_at: start + 15000 },
  ];
  const result = await clipExporter.exportClips(sourcePath, outputDir, entries, start, {
    clipDurationSec: 20,
  });

  check('exportClips: ok=true (aucune erreur ffmpeg)', result.ok === true);
  check('exportClips: 2 extraits produits', result.clips.length === 2);
  check(
    'exportClips: noms de fichiers reflètent offset+référence',
    result.clips[0].file === '00002s-jean-3-16.mp4' &&
      result.clips[1].file === '00015s-romains-8-28.mp4'
  );

  for (const clip of result.clips) {
    const filePath = path.join(outputDir, clip.file);
    check(`fichier réel créé sur disque : ${clip.file}`, fs.existsSync(filePath));
  }

  // --- Durée réelle des extraits (vérifiée avec ffmpeg -i, pas supposée) ---
  const dur0 = getDurationSec(path.join(outputDir, result.clips[0].file));
  check(
    `extrait 1 dure ~20s comme demandé (obtenu: ${dur0}s)`,
    dur0 !== null && Math.abs(dur0 - 20) < 0.5
  );

  // Le 2e extrait démarre à 15s dans une source de 30s : seules 15s de
  // contenu restent disponibles, même si 20s ont été demandées -- ffmpeg
  // tronque à la fin réelle de la source, comportement correct et attendu.
  const dur1 = getDurationSec(path.join(outputDir, result.clips[1].file));
  check(
    `extrait 2 tronqué à ~15s (fin de la source, obtenu: ${dur1}s)`,
    dur1 !== null && Math.abs(dur1 - 15) < 0.5
  );

  // --- Robustesse : fichier source introuvable ---
  {
    let threw = false;
    try {
      await clipExporter.exportClips('/chemin/inexistant.mp4', outputDir, entries, start);
    } catch (_err) {
      threw = true;
    }
    check('exportClips: lève une erreur claire si le fichier source est introuvable', threw);
  }

  // --- Garde-fou : borne MIN_CLIP_DURATION_SEC ---
  {
    const r = await clipExporter.exportClips(sourcePath, outputDir, [entries[0]], start, {
      clipDurationSec: 1, // sous MIN_CLIP_DURATION_SEC (15)
    });
    const dur = getDurationSec(path.join(outputDir, r.clips[0].file));
    check(
      `clipDurationSec sous le minimum est remonté à ${clipExporter.MIN_CLIP_DURATION_SEC}s (obtenu: ${dur}s)`,
      dur !== null && Math.abs(dur - clipExporter.MIN_CLIP_DURATION_SEC) < 0.5
    );
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n=== Résultat clip-exporter : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('[TEST] ÉCHEC INATTENDU:', err.message);
  console.error(err.stack);
  process.exit(1);
});
