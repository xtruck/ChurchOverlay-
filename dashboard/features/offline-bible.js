/**
 * dashboard/features/offline-bible.js — statut du cache biblique
 * hors-ligne (cahier des charges — Point 1B). Statut téléchargé une
 * seule fois à la connexion ; si un téléchargement est en cours, on
 * repasse par-dessus toutes les 5s jusqu'à ce qu'il se termine.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { ws } from '../state.js';

/* ======================================================================
   Base biblique hors-ligne (cahier des charges — Point 1B). Statut
   téléchargé une seule fois à la connexion ; si un téléchargement est en
   cours, on repasse par-dessus toutes les 5s jusqu'à ce qu'il se termine,
   pour afficher une progression qui avance plutôt qu'un statut figé.
   ====================================================================== */
let offlineBibleStatusPollTimer = null;

export function renderOfflineBibleStatus(status) {
  const el = document.getElementById('offlineBibleStatus');
  if (!el) return;

  clearTimeout(offlineBibleStatusPollTimer);

  if (status.status === 'done') {
    el.textContent = '✅ Téléchargée';
    el.className = 'status-badge success';
  } else if (status.status === 'downloading') {
    const pct = status.total > 0 ? Math.round((status.downloaded / status.total) * 100) : 0;
    el.textContent = `⏳ Téléchargement... ${pct}%`;
    el.className = 'status-badge warning';
    offlineBibleStatusPollTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'getOfflineBibleStatus' }));
      }
    }, 5000);
  } else if (status.status === 'error') {
    el.textContent = '❌ Échec du téléchargement';
    el.className = 'status-badge error';
  } else {
    el.textContent = 'En attente';
    el.className = 'status-badge warning';
  }
}
