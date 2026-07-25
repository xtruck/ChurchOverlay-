/**
 * ============================================================================
 *  dshow-parser.js — Parseur robuste de la sortie FFmpeg "-list_devices" (dshow)
 * ----------------------------------------------------------------------------
 *  BUG CORRIGÉ :
 *  Le code précédent (dans list-audio-devices.js ET main.js, en double)
 *  cherchait uniquement des lignes contenant littéralement "(audio)", par
 *  exemple :  [dshow @ 0x...] "Nom du micro" (audio)
 *
 *  Or c'est un format que seule une minorité de builds FFmpeg produit. Le
 *  format standard des builds Windows les plus utilisés (Gyan.dev, BtbN,
 *  ceux inclus par défaut dans ce projet) est un format à DEUX SECTIONS,
 *  SANS le suffixe "(audio)" sur chaque ligne :
 *
 *    [dshow @ 0x...] DirectShow video devices (some may be both video and audio devices)
 *    [dshow @ 0x...]  "Integrated Webcam"
 *    [dshow @ 0x...]     Alternative name "@device_pnp_..."
 *    [dshow @ 0x...] DirectShow audio devices
 *    [dshow @ 0x...]  "Microphone (Realtek Audio)"
 *    [dshow @ 0x...]     Alternative name "@device_cm_..."
 *
 *  Avec l'ancien code, ce format retournait TOUJOURS une liste vide de
 *  micros — même quand des micros existent bel et bien — d'où le message
 *  "Aucun microphone détecté" et un listeur qui semble "ne pas fonctionner".
 *
 *  Ce module gère les DEUX formats (section "DirectShow audio devices" +
 *  format alternatif avec suffixe "(audio)" inline sur certains builds).
 * ============================================================================
 */

/**
 * Extrait la liste des noms de périphériques audio DirectShow depuis la
 * sortie stderr de `ffmpeg -list_devices true -f dshow -i dummy`.
 * @param {string} output - Sortie stderr complète (ou partielle) de FFmpeg
 * @returns {string[]} Liste des noms de périphériques audio détectés
 */
function parseDshowAudioDevices(output) {
  const devices = [];
  const lines = String(output || '').split(/\r?\n/);
  let inAudioSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Bascule de section : "DirectShow video devices" / "DirectShow audio devices"
    if (/DirectShow video devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (/DirectShow audio devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }

    // Les lignes "Alternative name ..." ne sont jamais des noms de périphérique
    if (/Alternative name/i.test(line)) continue;

    // Format alternatif (certains builds) : nom suivi de " (audio)" inline
    const inlineMatch = line.match(/^\[dshow[^\]]*\]\s*"([^"]+)"\s*\(audio\)\s*$/i);
    if (inlineMatch) {
      devices.push(inlineMatch[1]);
      continue;
    }

    // Format standard à deux sections : tout nom entre guillemets rencontré
    // pendant qu'on est dans la section "DirectShow audio devices"
    if (inAudioSection) {
      const nameMatch = line.match(/^\[dshow[^\]]*\]\s*"([^"]+)"\s*$/);
      if (nameMatch) devices.push(nameMatch[1]);
    }
  }

  return devices;
}

module.exports = { parseDshowAudioDevices };
