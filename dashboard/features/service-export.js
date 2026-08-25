/**
 * dashboard/features/service-export.js — export ET import du service
 * portable (Partie 7.1.2 — voir service-export.js/service-import.js côté
 * serveur pour la portée assumée et la protection zip slip). Même pattern
 * que scene-studio.js#importPptxSlides : sélecteur natif côté main.js,
 * traitement réel côté worker server.js.
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

// AJOUT (Partie 7.1.2 — import du service portable) : même pattern que
// exportServicePortable ci-dessus.
export async function importServicePortable() {
  if (!window.churchOverlay || !window.churchOverlay.pickImportZipPath) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Non connecté au serveur — impossible d'importer.", 'error');
    return;
  }
  try {
    const sourcePath = await window.churchOverlay.pickImportZipPath();
    if (!sourcePath) return; // sélection annulée par l'opérateur
    showToast('Import en cours…', 'info');
    ws.send(JSON.stringify({ action: 'importService', sourcePath }));
  } catch (err) {
    showToast(
      'Échec de la sélection du fichier : ' + (err && err.message ? err.message : err),
      'error'
    );
  }
}

// AJOUT : réponse à importServicePortable ci-dessus — voir ws-dispatch.js
// (case 'serviceImportResult').
export function handleServiceImportResult(result) {
  if (!result) return;
  const parts = [];
  if (result.mediaImported) parts.push(`${result.mediaImported} média(s)`);
  if (result.scenesImported) parts.push(`${result.scenesImported} scène(s)`);
  if (result.songsImported) parts.push(`${result.songsImported} chant(s)`);
  if (result.cuesImported) parts.push(`${result.cuesImported} repère(s)`);
  const summary = parts.length > 0 ? parts.join(', ') : 'rien à importer';
  const skippedTotal =
    (result.mediaSkipped || 0) +
    (result.scenesSkipped || 0) +
    (result.songsSkipped || 0) +
    (result.cuesSkipped || 0);
  const skippedNote = skippedTotal > 0 ? ` (${skippedTotal} élément(s) sauté(s))` : '';
  showToast(`Import terminé : ${summary}${skippedNote}.`, 'success');
}

window.exportServicePortable = exportServicePortable;
window.importServicePortable = importServicePortable;
