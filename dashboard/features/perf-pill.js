/**
 * dashboard/features/perf-pill.js — pastille CPU/RAM en direct (voir
 * perf-monitor.js / main.js onPerfUpdate). Absente en mode "serveur seul"
 * navigateur (window.churchOverlay n'existe pas alors).
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */

/* ============================================================================
 * Indicateur de performance (CPU/RAM) — voir perf-monitor.js
 * ----------------------------------------------------------------------------
 * AJOUT (audit perf). L'échantillonnage (perf-monitor.js) et le pont IPC
 * (main.js/preload.js, onPerfUpdate) existaient déjà côté Electron mais
 * n'étaient consommés par aucune UI — ce bloc ferme la boucle. Absent en
 * mode "serveur seul" navigateur (window.churchOverlay n'existe pas alors),
 * la pastille reste masquée dans ce cas (voir style="display:none" en HTML).
 * ============================================================================ */
(function initPerfPill() {
  const pill = document.getElementById('perfPill');
  const text = document.getElementById('perfPillText');
  const dot = document.getElementById('perfDot');
  if (!pill || !text || !dot || !window.churchOverlay || !window.churchOverlay.onPerfUpdate) return;

  pill.style.display = 'flex';
  window.churchOverlay.onPerfUpdate((stats) => {
    if (!stats) return;
    const cpu = Math.round(stats.cpuPercent || 0);
    const ram = Math.round(stats.rssMB || 0);
    text.textContent = `CPU ${cpu}% · RAM ${ram} Mo`;
    const color =
      cpu >= 70
        ? 'var(--accent-rose)'
        : cpu >= 40
          ? 'var(--accent-amber)'
          : 'var(--accent-emerald)';
    dot.style.background = color;
    dot.style.boxShadow = `0 0 8px ${color}`;
  });
})();
