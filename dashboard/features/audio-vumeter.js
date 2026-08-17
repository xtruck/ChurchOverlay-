/**
 * dashboard/features/audio-vumeter.js — vumètre d'entrée micro permanent
 * pour l'Espace Régie. Affiche le niveau RMS moyen, le pic et la zone
 * (silence / trop faible / correct / fort / écrêté) en temps réel.
 *
 * A.1 — gain micro : la cause racine des erreurs de transcription est un
 * micro dont le niveau est 10-30× trop faible. Ce vumètre rend le problème
 * visible immédiatement, sans attendre que la transcription échoue.
 *
 * Trois zones colorées :
 *   - silence (gris)   : RMS < 0.005 — rien de capté
 *   - low (rouge)      : RMS < 0.015 — trop faible pour Whisper
 *   - good (vert)      : RMS 0.015–0.15 — plage optimale
 *   - hot (orange)     : RMS > 0.15 — fort, risque de saturation
 *   - clipping (rouge vif) : >0.5% d'écrêtage — signal déformé
 *
 * Conçu pour être lisible à trois mètres (WCAG AA, thème sombre régie).
 */

// Seuils de classification : doc uniquement — la classification réelle
// est dans audio-capture.js classifyAudioLevel(). Les seuils sont :
//   silence: RMS < 0.005, low: RMS < 0.015, good: RMS 0.015–0.15,
//   hot: RMS > 0.15, clipping: >0.5% d'écrêtage.

const LEVEL_LABELS = {
  unknown: { text: '—', color: '#6b7280', bg: '#1f2937' },
  silence: { text: 'Silence', color: '#6b7280', bg: '#1f2937' },
  low: { text: 'Trop faible', color: '#ef4444', bg: '#7f1d1d' },
  good: { text: 'Correct', color: '#22c55e', bg: '#14532d' },
  hot: { text: 'Fort', color: '#f59e0b', bg: '#78350f' },
  clipping: { text: 'Écrêté', color: '#ef4444', bg: '#7f1d1d' },
};

let vumeterBar = null;
let vumeterLabel = null;
let vumeterPeak = null;
let vumeterInfo = null;

/**
 * Initialise les références DOM une fois au chargement.
 */
function ensureDom() {
  if (vumeterBar) return;
  vumeterBar = document.getElementById('vumeterBar');
  vumeterLabel = document.getElementById('vumeterLabel');
  vumeterPeak = document.getElementById('vumeterPeak');
  vumeterInfo = document.getElementById('vumeterInfo');
}

/**
 * Met à jour le vumètre avec les diagnostics audio reçus du serveur.
 * @param {{ rmsMean: number, peak: number, clippingRate: number, level: string, totalFrames: number }} info
 */
export function updateAudioVumeter(info) {
  ensureDom();
  if (!vumeterBar) return;

  const level = info.level || 'unknown';
  const style = LEVEL_LABELS[level] || LEVEL_LABELS.unknown;

  // Barre de niveau : largeur proportionnelle au RMS (log scale pour better readability)
  const rmsPercent = Math.min(
    100,
    Math.max(0, (Math.log10(Math.max(info.rmsMean, 0.0001)) + 4) * 25)
  );
  vumeterBar.style.width = rmsPercent + '%';
  vumeterBar.style.backgroundColor = style.color;

  // Label de zone
  if (vumeterLabel) {
    vumeterLabel.textContent = style.text;
    vumeterLabel.style.color = style.color;
  }

  // Marqueur de pic (décalé proportionnellement)
  if (vumeterPeak) {
    const peakPercent = Math.min(
      100,
      Math.max(0, (Math.log10(Math.max(info.peak, 0.0001)) + 4) * 25)
    );
    vumeterPeak.style.left = peakPercent + '%';
    vumeterPeak.style.display = info.totalFrames > 0 ? 'block' : 'none';
  }

  // Infos textuelles
  if (vumeterInfo) {
    const rmsDb = info.rmsMean > 0 ? (20 * Math.log10(info.rmsMean)).toFixed(0) : '-∞';
    const clipPercent = (info.clippingRate * 100).toFixed(1);
    vumeterInfo.textContent = `RMS: ${rmsDb} dB · Pic: ${(info.peak * 100).toFixed(0)}% · Écrêtage: ${clipPercent}%`;
  }
}

/**
 * Réinitialise le vumètre (à l'arrêt de la capture).
 */
export function resetAudioVumeter() {
  ensureDom();
  if (vumeterBar) vumeterBar.style.width = '0%';
  if (vumeterLabel) {
    vumeterLabel.textContent = '—';
    vumeterLabel.style.color = '#6b7280';
  }
  if (vumeterPeak) vumeterPeak.style.display = 'none';
  if (vumeterInfo) vumeterInfo.textContent = '';
}
