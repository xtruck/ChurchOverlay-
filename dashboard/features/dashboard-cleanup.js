/**
 * dashboard/features/dashboard-cleanup.js — Mode Direct/Configuration
 * (chantier nettoyage dashboard, divulgation progressive).
 *
 * "Mode Direct (Régie)" masque, PARTOUT dans le tableau de bord (quel que
 * soit l'onglet ouvert), les panneaux non essentiels pendant le culte —
 * caméras IP, intégrations (OBS/ProPresenter/Planning Center), réglages
 * système, import/composition de scène — pour ne garder que ce qui compte
 * en plein direct : la carte du Verset Live, la barre Program/Preview +
 * Tally du studio de scènes (voir scene-studio.js), et la jauge de
 * confiance vocale (voir confidence-pip.js). "Mode Configuration" est
 * l'état complet historique, inchangé.
 *
 * Implémentation VOLONTAIREMENT une simple classe CSS sur <body>
 * (body.mode-direct, voir dashboard.css#.mode-direct-hide) plutôt qu'un
 * démontage/remontage du DOM : rien n'est jamais détruit, un panneau masqué
 * reste pleinement fonctionnel dès qu'on repasse en Configuration — et la
 * palette de commandes (Ctrl/Cmd+K) reste toujours capable d'agir sur
 * N'IMPORTE QUELLE action, y compris celles des panneaux masqués (elle
 * parle aux actions WS directement, jamais au DOM d'un panneau).
 */
import { registerAction } from '../action-delegator.js';

const STORAGE_KEY = 'churchoverlay_dashboard_mode';
const DEFAULT_MODE = 'config';

function applyMode(mode) {
  document.body.classList.toggle('mode-direct', mode === 'direct');
  document.querySelectorAll('.direct-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

export function setDashboardMode(mode) {
  const resolved = mode === 'direct' ? 'direct' : 'config';
  applyMode(resolved);
  try {
    localStorage.setItem(STORAGE_KEY, resolved);
  } catch (_e) {
    /* stockage indisponible (navigation privée) : le mode reste appliqué
       pour cette session, juste pas mémorisé au prochain chargement */
  }
}

registerAction('dashboard-cleanup', 'set-dashboard-mode', (el, data) =>
  setDashboardMode(data.mode)
);

// Appliqué dès le chargement du module — AVANT toute donnée serveur, ce
// choix est purement local au poste (voir en-tête de fichier), aucune
// dépendance à la connexion WS.
(function restoreDashboardMode() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch (_e) {
    /* repli sur le défaut ci-dessous */
  }
  applyMode(saved === 'direct' ? 'direct' : DEFAULT_MODE);
})();

// ---------------------------------------------------------------------------
// AJOUT (chantier nettoyage dashboard — panneaux secondaires repliables) :
// un seul écouteur délégué, même discipline que action-delegator.js (posé
// une fois, couvre toute carte .accordion-card présente OU créée plus
// tard) — mais un axe DIFFÉRENT ([data-action] cible une ACTION précise,
// .accordion-header bascule un état d'AFFICHAGE purement local, jamais une
// action WS) : volontairement pas dans action-delegator.js lui-même, pour
// ne pas mélanger les deux concepts.
// ---------------------------------------------------------------------------
document.addEventListener('click', (event) => {
  const header = event.target.closest('.accordion-header');
  if (!header) return;
  const card = header.closest('.accordion-card');
  if (card) card.classList.toggle('collapsed');
});
