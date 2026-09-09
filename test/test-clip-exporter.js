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

function getResolution(filePath) {
  const res = spawnSync(ffmpegPath, ['-i', filePath], { encoding: 'utf8' });
  const match = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(res.stderr || '');
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
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

  // --- buildVideoFilters()/buildFfmpegArgs()/escapeSubtitlesPath() : purs,
  // testables sans lancer ffmpeg (durcissement Social Clip Machine) -------
  check(
    'buildVideoFilters: 16:9 sans sous-titres -> aucun filtre',
    clipExporter.buildVideoFilters({ aspectRatio: '16:9' }).length === 0
  );
  check(
    'buildVideoFilters: 9:16 -> un filtre crop centré, pair, protégé par min()',
    clipExporter.buildVideoFilters({ aspectRatio: '9:16' }).length === 1 &&
      /^crop=w='trunc\(min\(iw\\,ih\*9\/16\)\/2\)\*2'/.test(
        clipExporter.buildVideoFilters({ aspectRatio: '9:16' })[0]
      )
  );
  check(
    'escapeSubtitlesPath: backslashes -> slashes, ":" du lecteur échappé par DEUX backslashes',
    clipExporter.escapeSubtitlesPath('C:\\Users\\test\\clip.srt') === 'C\\\\:/Users/test/clip.srt'
  );
  {
    const filters = clipExporter.buildVideoFilters({ subtitlesPath: 'C:\\tmp\\x.srt' });
    check(
      'buildVideoFilters: sous-titres -> filtre subtitles avec chemin échappé + force_style',
      filters.length === 1 &&
        filters[0].startsWith('subtitles=filename=C\\\\:/tmp/x.srt:force_style=\'') &&
        filters[0].includes('FontName=')
    );
  }
  {
    const filters = clipExporter.buildVideoFilters({ aspectRatio: '9:16', subtitlesPath: 'x.srt' });
    check(
      'buildVideoFilters: crop + sous-titres combinés -> 2 filtres, crop en premier',
      filters.length === 2 && filters[0].startsWith('crop=') && filters[1].startsWith('subtitles=')
    );
  }
  check(
    'buildFfmpegArgs: 16:9 sans sous-titres -> pas de -vf',
    !clipExporter
      .buildFfmpegArgs({ sourcePath: 'in.mp4', outputPath: 'out.mp4', startSec: 0, durationSec: 20 })
      .includes('-vf')
  );
  {
    const args = clipExporter.buildFfmpegArgs({
      sourcePath: 'in.mp4',
      outputPath: 'out.mp4',
      startSec: 5,
      durationSec: 20,
      aspectRatio: '9:16',
    });
    const vfIndex = args.indexOf('-vf');
    check(
      'buildFfmpegArgs: 9:16 -> -vf présent avec le filtre crop en valeur',
      vfIndex !== -1 && args[vfIndex + 1].startsWith('crop=')
    );
    check('buildFfmpegArgs: -ss/-i/-t reflètent les paramètres', args.includes('-ss') && args[args.indexOf('-ss') + 1] === '5' && args[args.indexOf('-i') + 1] === 'in.mp4' && args[args.indexOf('-t') + 1] === '20');
    check('buildFfmpegArgs: le fichier de sortie reste le dernier argument', args[args.length - 1] === 'out.mp4');
  }

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

  // --- Recadrage 9:16 : vérifié avec un VRAI ffmpeg + résolution réelle
  // sondée en sortie (pas supposée) — source 320x240 (4:3, ratio 1.33) -----
  {
    const r = await clipExporter.exportClips(sourcePath, outputDir, [entries[0]], start, {
      clipDurationSec: 15,
      aspectRatio: '9:16',
    });
    check('exportClips aspectRatio=9:16 : ok=true (aucune erreur ffmpeg)', r.ok === true);
    const res = getResolution(path.join(outputDir, r.clips[0].file));
    // largeur attendue : trunc(min(320, 240*9/16=135)/2)*2 = 134 ; hauteur inchangée (240)
    check(
      `aspectRatio=9:16 : hauteur pleine conservée (obtenu: ${JSON.stringify(res)})`,
      res !== null && res.height === 240
    );
    check(
      `aspectRatio=9:16 : largeur recadrée à 9:16 de la hauteur, arrondie paire (obtenu: ${JSON.stringify(res)})`,
      res !== null && res.width === 134
    );
  }

  // --- Incrustation de sous-titres (SRT burn-in) : segments STT factices,
  // fenêtrés + rebasés sur le début du clip par srt-export.js, brûlés par un
  // VRAI ffmpeg (libass) — on vérifie que ça ne casse ni la réussite de
  // l'export ni la durée exacte de l'extrait. -----------------------------
  {
    const transcriptSegments = [
      { text: 'Car Dieu a tant aimé le monde', started_at: start + 2000, ended_at: start + 3500 },
      { text: "qu'il a donné son fils unique", started_at: start + 4000, ended_at: start + 5500 },
      // Hors fenêtre du clip ci-dessous (démarre à +2s, dure 15s -> fenêtre [2s,17s]) :
      { text: 'Bien après ce clip', started_at: start + 25000, ended_at: start + 26000 },
    ];
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('churchoverlay-clip-srt-'));

    const r = await clipExporter.exportClips(sourcePath, outputDir, [entries[0]], start, {
      clipDurationSec: 15,
      transcriptSegments,
    });
    check('exportClips avec sous-titres : ok=true (libass accepte le burn-in)', r.ok === true);
    const dur = getDurationSec(path.join(outputDir, r.clips[0].file));
    check(
      `exportClips avec sous-titres : durée toujours exacte malgré le filtre supplémentaire (obtenu: ${dur}s)`,
      dur !== null && Math.abs(dur - 15) < 0.5
    );

    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('churchoverlay-clip-srt-'));
    check(
      'exportClips avec sous-titres : le .srt temporaire est bien supprimé après usage (pas de fuite dans %TEMP%)',
      tmpAfter.length === tmpBefore.length
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
