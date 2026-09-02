/**
 * dashboard/features/confidence-rail.js — "Confidence Rail" (idée créative,
 * brief produit) : un bandeau discret et TOUJOURS visible qui répond, d'une
 * seule phrase, à la question qu'un opérateur se pose en continu — "est-ce
 * sûr d'aller en direct maintenant ?" — plutôt que de le laisser inspecter
 * chaque panneau (feuille de route, connexion, pipeline) pour le savoir.
 *
 * Distinct de status-strip.js (bandeau permanent lui aussi, mais qui couvre
 * l'INFRA — micro/clés API/réseau caméra) : ce bandeau-ci couvre le
 * SERVICE — la diffusion en cours et le prochain repère. Complémentaire,
 * jamais dupliqué.
 *
 * Purement une couche d'agrégation en LECTURE : ne recalcule aucun signal,
 * chaque source reste propriétaire de son état —
 * - Connexion : `ws` (state.js), lu à chaque tick, jamais un second état.
 * - Pipeline : isPipelineAlertActive() (pipeline-health.js).
 * - Prochain repère : getRundownCues()/getRundownActiveIndex() (rundown.js)
 *   + checkCueReadiness() (next-cue-confidence.js, priorité #1) — jamais une
 *   seconde logique de vérification.
 * - Diffusion en cours : getCurrentLive() (airlock-preview.js).
 *
 * Rafraîchi par un intervalle bas-débit (voir tick() plus bas), même
 * raisonnement que focus-mode.js : un bandeau d'ambiance regardé en
 * permanence n'a pas besoin d'une latence sous la seconde, et éviter de
 * brancher ce module sur chaque diffusion WS individuelle (rundownUpdated,
 * showVerse/showMedia/showScene...) épargne autant de points de couplage
 * supplémentaires dans ws-dispatch.js pour un gain invisible à l'œil.
 */
import { ws } from '../state.js';
import { getRundownCues, getRundownActiveIndex } from './rundown.js';
import { checkCueReadiness } from './next-cue-confidence.js';
import { isPipelineAlertActive } from './pipeline-health.js';
import { getCurrentLive } from './airlock-preview.js';

const TICK_MS = 1500;

// AJOUT : cache la vérification du prochain repère par son id — évite de
// relancer les sondes réseau/police de checkCueReadiness() (potentiellement
// coûteuses) à chaque tick pour un repère qui n'a pas changé, même
// raisonnement que refreshCueReadinessBadges() dans rundown.js.
let cachedNextCue = null; // { cueId, result: null|object }

function firstProblemMessage(result) {
  const problem = result.checks.find((c) => !c.ok);
  return problem ? problem.message : '';
}

function computeMessage() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { key: 'error', text: 'Connexion instable — reconnexion en cours.' };
  }
  if (isPipelineAlertActive()) {
    return {
      key: 'error',
      text: 'Le pipeline a rencontré un problème — voir la bannière ci-dessous.',
    };
  }

  const live = getCurrentLive();
  const cues = getRundownCues();
  const nextCue = cues[getRundownActiveIndex() + 1];

  if (nextCue && cachedNextCue && cachedNextCue.cueId === nextCue.id && cachedNextCue.result) {
    const { status } = cachedNextCue.result;
    if (status === 'blocked') {
      return {
        key: 'error',
        text: `Repère suivant bloqué : ${firstProblemMessage(cachedNextCue.result)}`,
      };
    }
    if (status === 'attention') {
      return {
        key: 'warn',
        text: `Repère suivant à vérifier : ${firstProblemMessage(cachedNextCue.result)}`,
      };
    }
  } else if (nextCue) {
    return { key: 'neutral', text: 'Vérification du repère suivant…' };
  }

  if (live && nextCue) return { key: 'ok', text: 'Sortie en direct — repère suivant prêt.' };
  if (live) return { key: 'ok', text: 'Sortie en direct.' };
  if (nextCue) return { key: 'ok', text: 'Repère suivant prêt — sûr d’aller en direct.' };
  return { key: 'ok', text: 'Sûr d’aller en direct.' };
}

function render() {
  const el = document.getElementById('confidenceRail');
  if (!el) return;
  const msg = computeMessage();
  el.textContent = msg.text;
  el.className = `confidence-rail confidence-rail-${msg.key}`;
}

async function refreshNextCueReadiness() {
  const cues = getRundownCues();
  const nextCue = cues[getRundownActiveIndex() + 1];
  if (!nextCue) {
    cachedNextCue = null;
    return;
  }
  if (cachedNextCue && cachedNextCue.cueId === nextCue.id) return; // déjà en cache/en vol
  cachedNextCue = { cueId: nextCue.id, result: null };
  try {
    const result = await checkCueReadiness(nextCue);
    // Le repère suivant a pu changer pendant la vérification (async) —
    // n'applique le résultat que s'il s'agit toujours du même.
    if (cachedNextCue && cachedNextCue.cueId === nextCue.id) {
      cachedNextCue.result = result;
      render();
    }
  } catch {
    /* une vérification en échec ne doit jamais casser le bandeau */
  }
}

let tickTimer = null;

function tick() {
  render();
  refreshNextCueReadiness();
}

export function startConfidenceRail() {
  if (tickTimer) return;
  tick();
  tickTimer = setInterval(tick, TICK_MS);
}

startConfidenceRail();
