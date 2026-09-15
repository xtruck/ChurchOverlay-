/**
 * dashboard/features/dashboard-cleanup.js — panneaux secondaires
 * repliables (chantier nettoyage dashboard, divulgation progressive).
 *
 * SUPPRIMÉ (redesign IA — étape 6) : ce fichier portait aussi le bascule
 * Mode Direct/Configuration (classe body.mode-direct masquant caméras IP/
 * intégrations/réglages système partout dans le tableau de bord). Devenu
 * redondant avec la scission Opérateur/Paramètres elle-même (le live-
 * essentiel et la config ne partagent plus jamais le même écran) et le
 * tiroir d'outils secondaires (étape 5) — retiré avec ses boutons "🎬
 * Direct"/"⚙️ Configuration" (dashboard.html) et ses règles CSS
 * (dashboard.css). Voir DASHBOARD-IA-REDESIGN-PROPOSAL.md, migration plan
 * étape 6.
 */

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
