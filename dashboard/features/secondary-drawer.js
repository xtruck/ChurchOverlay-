/**
 * dashboard/features/secondary-drawer.js — tiroir d'outils secondaires
 * (redesign IA — étape 5). Panneau latéral rétractable regroupant les
 * outils occasionnels identifiés par DASHBOARD-IA-REDESIGN-PROPOSAL.md (ni
 * Operator-essential, ni Parameters/config) — reachable depuis Opérateur
 * ET Paramètres via #secondaryDrawerToggle, plutôt qu'une destination de
 * navigation séparée. Un seul outil affiché à la fois (onglets internes),
 * pas dockview (voir la décision 3 du signoff — porte ouverte pour plus
 * tard si le besoin de plusieurs outils côte à côte apparaît).
 *
 * Toutes les cartes déplacées ici conservent leurs ids/fonctions JS
 * d'origine intactes — seul leur emplacement dans le DOM change, jamais
 * leur comportement (mêmes registerAction/data-action déjà câblés
 * ailleurs, résolus par délégation globale quel que soit l'endroit du
 * document où l'élément se trouve).
 */
import { registerAction } from '../action-delegator.js';

const drawer = document.getElementById('secondaryDrawer');
const toggleBtn = document.getElementById('secondaryDrawerToggle');

function openDrawer() {
  if (!drawer) return;
  drawer.classList.remove('is-hidden');
  drawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  if (!drawer) return;
  drawer.classList.add('is-hidden');
  drawer.setAttribute('aria-hidden', 'true');
}

if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    if (!drawer) return;
    if (drawer.classList.contains('is-hidden')) openDrawer();
    else closeDrawer();
  });
}

registerAction('secondary-drawer', 'close', () => closeDrawer());

// AJOUT : Échap ferme le tiroir, comme la palette de commandes — jamais si
// une saisie est en cours ailleurs dans le tiroir (un champ texte doit
// pouvoir utiliser Échap pour son propre usage sans fermer tout le panneau
// par-dessus).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!drawer || drawer.classList.contains('is-hidden')) return;
  closeDrawer();
});

// Onglets internes : un seul outil visible à la fois (voir en-tête).
const tabs = document.querySelectorAll('.secondary-drawer-tab');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    document
      .querySelectorAll('.secondary-drawer-pane')
      .forEach((p) => p.classList.remove('active'));

    tab.classList.add('active');
    const target = document.querySelector(
      `.secondary-drawer-pane[data-drawer-pane="${tab.dataset.drawerTab}"]`
    );
    if (target) target.classList.add('active');
  });
});
