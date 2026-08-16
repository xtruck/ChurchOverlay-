/**
 * dashboard/features/status-strip.js — bandeau d'état permanent, TOUJOURS
 * visible (pas seulement quand quelque chose casse — voir pipeline-health.js
 * pour les bannières d'alerte, qui restent inchangées et complémentaires).
 *
 * Recommandation "control room" (régie broadcast) : un opérateur doit
 * pouvoir confirmer d'un coup d'œil que tout va bien, pas seulement être
 * alerté quand ça ne va plus. Purement une couche d'AFFICHAGE — ne
 * recalcule aucun signal lui-même, chaque item est mis à jour depuis
 * l'endroit qui possède déjà cette logique (voir setStatusStripItem() plus
 * bas, appelée depuis verse-session-display.js/api-settings.js/
 * network-settings.js/ip-cameras.js) : un seul endroit par signal reste la
 * source de vérité.
 */
import { state } from '../state.js';

const LEVEL_LABEL = {
  ok: 'OK',
  warn: 'Attention',
  off: 'Inactif',
  error: 'Problème',
};

/**
 * @param {'Micro'|'Api'|'Network'} key
 * @param {'ok'|'warn'|'off'|'error'} level
 * @param {string} detail - texte court affiché à côté du point de couleur
 */
export function setStatusStripItem(key, level, detail) {
  const dot = document.getElementById(`statusStrip${key}Dot`);
  const text = document.getElementById(`statusStrip${key}Text`);
  if (dot) {
    dot.className = 'status-strip-dot status-strip-dot--' + level;
    dot.title = LEVEL_LABEL[level] || level;
  }
  if (text) text.textContent = detail;
}

// AJOUT : le pictogramme "Réseau caméra" combine deux signaux distincts
// (jumelage QR prêt + caméras IP réellement configurées) pour éviter une
// fausse alerte permanente chez une église qui n'utilise pas de caméra
// téléphone du tout — un point d'avertissement allumé en continu pour une
// fonctionnalité jamais utilisée finirait ignoré comme tout le reste
// ("fatigue d'alarme"), l'inverse du but d'un bandeau "tout va bien".
export function updateNetworkStatusStrip() {
  if (state.qrCameraReady) {
    setStatusStripItem('Network', 'ok', 'Prêt');
    return;
  }
  if (state.ipCameraCount > 0) {
    // Au moins une caméra IP est configurée mais le jumelage QR n'est pas
    // joignable : un vrai problème pour cette église-là, pas un bruit de fond.
    setStatusStripItem('Network', 'warn', 'Indisponible');
    return;
  }
  setStatusStripItem('Network', 'off', 'Non utilisé');
}
