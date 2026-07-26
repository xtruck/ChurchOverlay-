/**
 * ============================================================================
 *  list-audio-devices.js — Liste les périphériques audio disponibles
 * ----------------------------------------------------------------------------
 *  Utilise FFmpeg pour lister tous les périphériques audio DirectShow
 *
 *  USAGE:
 *    node list-audio-devices.js
 *
 *  CORRECTIFS APPLIQUÉS :
 *  1. Le filtrage ne reposait que sur un format de sortie FFmpeg minoritaire
 *     ('"Nom" (audio)' inline), absent des builds Windows les plus courants
 *     (Gyan.dev/BtbN, ceux fournis avec ce projet). Sur ces builds, AUCUN
 *     micro n'était jamais listé, même quand ils existaient bel et bien.
 *     → On utilise maintenant dshow-parser.js, qui gère les deux formats.
 *  2. L'affichage "en direct" retraitait la sortie ENTIÈRE de FFmpeg à
 *     chaque paquet de données reçu, ce qui réaffichait des lignes déjà
 *     imprimées (doublons visibles à l'écran). On n'affiche désormais le
 *     résultat qu'une seule fois, à la fin.
 * ============================================================================
 */

const { spawn } = require('child_process');
const { parseDshowAudioDevices } = require('./dshow-parser');
const { pickBestDevice } = require('./audio-capture');
const { resolveFfmpegPath } = require('./setup-ffmpeg');
// CORRECTIF : dupliquait `process.env.FFMPEG_PATH || 'ffmpeg'` en dur,
// ignorant le binaire auto-installé dans ffmpeg/ffmpeg.exe — ce script
// (lancé en standalone via `node list-audio-devices.js`, hors app
// Electron) échouait donc à trouver FFmpeg sur un poste sans installation
// système, même quand ffmpeg/ffmpeg.exe était bel et bien présent.
const ffmpegPath = resolveFfmpegPath();

console.log('=== Liste des périphériques audio DirectShow ===\n');
console.log('Interrogation de FFmpeg en cours...\n');

const ffmpeg = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
let output = '';

ffmpeg.stderr.on('data', (data) => {
  // On accumule seulement ; l'affichage se fait une fois à la fin (close)
  // pour éviter les lignes dupliquées à l'écran.
  output += data.toString();
});

ffmpeg.on('close', () => {
  const devices = parseDshowAudioDevices(output);

  if (devices.length > 0) {
    console.log(`Microphones détectés (${devices.length}) :\n`);
    devices.forEach((name, i) => {
      console.log(`  ${i + 1}. "${name}"`);
    });

    // CORRECTIF (auto-détection) : depuis que AUDIO_DEVICE peut rester vide
    // (server.js/audio-capture.js choisissent alors automatiquement), on
    // affiche ici ce que ce choix automatique donnerait, pour que
    // l'utilisateur puisse vérifier/valider avant de lancer réellement.
    const { chosen, rejected } = pickBestDevice(devices);
    console.log('');
    if (chosen) {
      console.log(`→ Choix automatique (si AUDIO_DEVICE reste vide) : "${chosen}"`);
    } else {
      console.log('→ Choix automatique impossible : aucun candidat fiable (voir périphériques ignorés ci-dessous).');
    }
    if (rejected.length > 0) {
      console.log(`  Périphériques ignorés d'office (boucle de retour/virtuel) : ${rejected.join(', ')}`);
    }
    console.log('\nSi ce choix ne convient pas, définissez AUDIO_DEVICE dans .env avec');
    console.log('le nom EXACT (entre guillemets ci-dessus, sans les guillemets) du');
    console.log('périphérique souhaité.');
  } else {
    console.error('Aucun microphone DirectShow détecté.');
    console.error('Vérifiez que :');
    console.error('  - un micro est bien branché et autorisé dans Windows');
    console.error('    (Paramètres → Confidentialité → Microphone),');
    console.error('  - FFmpeg est bien installé et accessible ;');
    console.error('\nSortie brute de FFmpeg (pour diagnostic) :\n');
    console.error(output.trim() || '(FFmpeg n\u2019a produit aucune sortie)');
  }

  console.log('\n=== Liste terminée ===');
  process.exit(devices.length > 0 ? 0 : 1);
});

ffmpeg.on('error', (err) => {
  console.error('Erreur:', err.message);
  console.error('Assurez-vous que FFmpeg est installé et dans PATH');
  process.exit(1);
});
