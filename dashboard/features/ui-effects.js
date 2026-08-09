/**
 * dashboard/features/ui-effects.js — micro-interactions UI globales
 * (pause des animations décoratives hors focus, onde au clic sur .btn).
 * Extrait de dashboard/legacy-core.js (chantier de modularisation). Aucune
 * dépendance externe : DOM/document uniquement.
 */

// CORRECTIF PERF (audit CPU, 03/08/2026) : voir le commentaire CSS sur
// .animations-paused plus haut dans <style>. On considère la fenêtre
// "au repos" dès qu'elle est masquée (onglet caché / minimisée) OU
// qu'elle perd le focus (opérateur basculé sur OBS pendant tout le
// culte) — les deux cas sont fréquents en régie et n'ont aucune
// raison de garder des animations décoratives actives en continu.
(function setupAmbientAnimationThrottle() {
  function applyState() {
    const shouldPause = document.hidden || !document.hasFocus();
    document.body.classList.toggle('animations-paused', shouldPause);
  }
  document.addEventListener('visibilitychange', applyState);
  window.addEventListener('blur', applyState);
  window.addEventListener('focus', applyState);
  applyState();
})();

// RETIRÉ (sur demande) : l'écouteur pointermove qui pilotait le halo
// suivant le curseur sur .card/.hero-verse-card a été supprimé, en
// même temps que les règles CSS .card::after / .hero-verse-card::before
// correspondantes.

// AJOUT : onde au clic (voir .btn-ripple dans <style>). Délégué sur
// le document, ne crée un élément que sur un vrai clic, et le
// retire dès que l'animation "forwards" se termine (aucun élément
// ni timer qui s'accumule au fil d'un long culte).
(function setupButtonRipple() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.4;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  });
})();
