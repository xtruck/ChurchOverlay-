/**
 * dashboard/features/confidence-mode.js — Mode confiance
 * Seuil ASR configurable + toggle d'affichage des badges de confiance.
 */
(function () {
  window.setConfidenceThreshold = function (value) {
    if (typeof value !== 'number' || value < 0 || value > 1) return;
    const rounded = Math.round(value * 100) / 100;
    document.querySelectorAll('.status-badge').forEach((badge) => {
      if (badge.closest('.transcript-item') && /^\d+%$/.test(badge.textContent.trim())) {
        // Badge de confiance dans le flux transcript — laisser visible tant que le toggle est ON
      }
    });
    // Envoyer au serveur si un WS est connecté
    try {
      const ws = window._ws || (window.state && window.state.ws);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'setConfidenceThreshold', threshold: rounded }));
      }
    } catch (_) {
      /* ignore si pas de WS */
    }
  };

  window.toggleConfidenceBadges = function (visible) {
    document.querySelectorAll('.transcript-item .status-badge').forEach((badge) => {
      if (/^\d+%$/.test(badge.textContent.trim())) {
        badge.style.display = visible ? '' : 'none';
      }
    });
    document.getElementById('listeningConfidence').style.display = visible ? '' : 'none';
  };
})();
