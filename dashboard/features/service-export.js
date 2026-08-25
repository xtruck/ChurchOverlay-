/**
 * dashboard/features/service-export.js — export du service portable
 * (Partie 7.1.2, EXPORT uniquement — voir service-export.js côté serveur
 * pour le pourquoi de cette portée). Même pattern que
 * scene-studio.js#importPptxSlides : sélecteur natif côté main.js, écriture
 * réelle côté worker server.js.
 */
import { ws } from '../state.js';
import { showToast } from '../utils.js';

export async function exportServicePortable() {
  if (!window.churchOverlay || !window.churchOverlay.pickExportZipPath) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'exporter.", 'error');
    return;
  }
  try {
    const destPath = await window.churchOverlay.pickExportZipPath();
    if (!destPath) return; // sélection annulée par l'opérateur
    showToast('Export en cours…', 'info');
    ws.send(JSON.stringify({ action: 'exportService', destPath }));
  } catch (err) {
    showToast(
      "Échec de la sélection de l'emplacement : " + (err && err.message ? err.message : err),
      'error'
    );
  }
}

// AJOUT : réponse à exportServicePortable ci-dessus — voir ws-dispatch.js
// (case 'serviceExportResult').
export function handleServiceExportResult(result) {
  if (!result) return;
  const parts = [];
  if (result.mediaCount) parts.push(`${result.mediaCount} média(s)`);
  if (result.sceneCount) parts.push(`${result.sceneCount} scène(s)`);
  if (result.rundownCount) parts.push(`${result.rundownCount} repère(s)`);
  if (result.songCount) parts.push(`${result.songCount} chant(s)`);
  const summary = parts.length > 0 ? parts.join(', ') : 'service vide';
  const missingNote =
    result.skippedMediaCount > 0
      ? ` (${result.skippedMediaCount} média(s) introuvable(s) sur le disque, ignoré(s))`
      : '';
  showToast(`Export terminé : ${summary}${missingNote}.`, 'success');
}

window.exportServicePortable = exportServicePortable;
