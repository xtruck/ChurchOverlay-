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
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

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
    console.log('\nCopiez le nom EXACT (entre guillemets, sans les guillemets) du');
    console.log('périphérique souhaité et utilisez-le comme valeur de AUDIO_DEVICE');
    console.log('(fichier .env ou champ correspondant dans le tableau de bord).');
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
