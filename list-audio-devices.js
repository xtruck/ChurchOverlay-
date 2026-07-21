/**
 * ============================================================================
 *  list-audio-devices.js — Liste les périphériques audio disponibles
 * ----------------------------------------------------------------------------
 *  Utilise FFmpeg pour lister tous les périphériques audio DirectShow
 *
 *  USAGE:
 *    node list-audio-devices.js
 * ============================================================================
 */

const { spawn } = require('child_process');
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

console.log('=== Liste des périphériques audio DirectShow ===\n');

const ffmpeg = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
let output = '';

ffmpeg.stderr.on('data', (data) => {
  output += data.toString();
  
  // Filtrer pour afficher uniquement les périphériques audio
  const lines = output.split('\n');
  lines.forEach(line => {
    if (line.includes('[dshow') && line.includes('audio')) {
      console.log(line.trim());
    }
  });
});

ffmpeg.on('close', (code) => {
  const lines = output.split(/\r?\n/);
  const audioLines = lines.filter((line, index) => line.includes('(audio)') ||
    (index > 0 && lines[index - 1].includes('(audio)') && line.includes('Alternative name')));
  if (audioLines.length > 0) {
    console.log('\nMicrophones détectés :\n');
    console.log(audioLines.join('\n').trim());
  } else {
    console.error('\nAucun microphone DirectShow détecté. Vérifiez les autorisations du micro dans Windows.');
    console.error('\nDiagnostic FFmpeg :\n' + (output.trim() || '(FFmpeg n’a produit aucune sortie)'));
  }
  console.log('\n=== Liste terminée ===');
  console.log('Copiez le nom du périphérique audio souhaité et utilisez-le dans audio-capture.js');
  process.exit(0);
});

ffmpeg.on('error', (err) => {
  console.error('Erreur:', err.message);
  console.error('Assurez-vous que FFmpeg est installé et dans PATH');
  process.exit(1);
});
