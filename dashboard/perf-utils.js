/**
 * dashboard/perf-utils.js — petit utilitaire de mesure perf pour le tableau
 * de bord (passe perf, Phase 3 : "given how much has been added recently —
 * scene studio, clip exporter, agent IA MCP, Q&A prédication — ceci est pour
 * repérer une régression dans une future PR, pas un correctif ponctuel").
 *
 * Trois mesures, volontairement sans dépendance :
 *   - getPageLoadMs()   : Navigation Timing (temps de chargement de la page).
 *   - getDomNodeCount() : nombre total de noeuds DOM (repère grossier mais
 *                         utile — une fuite de composants qui ne se
 *                         détruisent jamais fait grimper ce chiffre au fil
 *                         des navigations, même sans fuite mémoire JS
 *                         classique).
 *   - snapshotPerf()    : les deux ci-dessus + CPU%/RAM du process principal
 *                         (voir perf-monitor.js, déjà exposé via
 *                         window.churchOverlay.getPerfStats() — voir
 *                         dashboard/features/perf-pill.js pour le précédent
 *                         d'utilisation de ce pont IPC).
 *
 * Voir test/e2e/perf-budget.spec.js pour l'usage concret (assertions de
 * seuil, à la manière de test/e2e/media-wall-load.spec.js).
 */

export function getPageLoadMs() {
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav && nav.loadEventEnd > 0) {
    return Math.round(nav.loadEventEnd - nav.startTime);
  }
  return null;
}

export function getDomNodeCount() {
  return document.getElementsByTagName('*').length;
}

/**
 * @returns {Promise<{pageLoadMs: number|null, domNodeCount: number, cpuPercent: number|null, rssMB: number|null}>}
 */
export async function snapshotPerf() {
  const snapshot = {
    pageLoadMs: getPageLoadMs(),
    domNodeCount: getDomNodeCount(),
    cpuPercent: null,
    rssMB: null,
  };
  // Absent en mode "serveur seul" navigateur (window.churchOverlay n'existe
  // qu'à l'intérieur de l'app Electron, via preload.js) — snapshot partiel
  // dans ce cas, jamais une erreur qui casserait l'appelant.
  if (window.churchOverlay && window.churchOverlay.getPerfStats) {
    try {
      const stats = await window.churchOverlay.getPerfStats();
      if (stats) {
        snapshot.cpuPercent = typeof stats.cpuPercent === 'number' ? stats.cpuPercent : null;
        snapshot.rssMB = typeof stats.rssMB === 'number' ? stats.rssMB : null;
      }
    } catch (_) {
      /* ignore — snapshot partiel plutôt qu'une erreur */
    }
  }
  return snapshot;
}

export function formatPerfSnapshot(snapshot) {
  const parts = [`noeuds DOM: ${snapshot.domNodeCount}`];
  if (snapshot.pageLoadMs != null) parts.push(`chargement page: ${snapshot.pageLoadMs}ms`);
  if (snapshot.cpuPercent != null) parts.push(`CPU: ${snapshot.cpuPercent}%`);
  if (snapshot.rssMB != null) parts.push(`RAM: ${snapshot.rssMB} Mo`);
  return `[perf-utils] ${parts.join(' · ')}`;
}
