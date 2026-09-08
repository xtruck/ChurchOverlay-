/**
 * dashboard/action-delegator.js — délégation d'événements pour le contenu
 * RENDU DYNAMIQUEMENT (listes/galeries régénérées à chaque diffusion
 * serveur : médiathèque, mur média, studio de scènes, feuille de route...).
 *
 * Distinct d'event-bindings.js (câblage des boutons STATIQUES de
 * dashboard.html, un id fixe par bouton, jamais recréé) : une carte de
 * médiathèque n'a pas d'id de document fixe — un nouvel élément est créé à
 * chaque re-rendu de la liste. Un écouteur individuel par élément forcerait
 * soit une fuite d'écouteurs (jamais retirés à la suppression/au
 * re-rendu), soit un re-câblage manuel après chaque innerHTML. Un seul
 * écouteur ici, posé une fois pour toute la durée de vie de la page,
 * couvre n'importe quel élément `[data-action]` déjà présent OU créé plus
 * tard, sans jamais avoir à le re-poser.
 *
 * Convention de balisage : `<button data-action="delete" data-target="media"
 * data-id="123">`. `target` identifie le DOMAINE (le module propriétaire
 * de l'action, ex. "media", "media-group", "scene"), `action` le verbe
 * (ex. "delete", "trigger") — la paire clé le handler enregistré via
 * registerAction() ci-dessous. Tout autre `data-*` porté par l'élément
 * (ex. `data-label`, `data-is-default`) est transmis tel quel au handler
 * via `el.dataset`, pour les actions qui ont besoin de plus qu'un simple id.
 *
 * Chaque module propriétaire (media-library.js, etc.) importe
 * `registerAction` et enregistre ses propres handlers à son évaluation —
 * ce fichier ne connaît jamais les modules qui l'utilisent (aucune arête
 * d'import dans ce sens), seulement la table `target:action -> handler`
 * qu'ils remplissent.
 */
const registry = new Map();

export function registerAction(target, action, handler) {
  registry.set(`${target}:${action}`, handler);
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const { action, target } = el.dataset;
  const handler = registry.get(`${target}:${action}`);
  if (!handler) {
    console.error(`[action-delegator] no handler for ${target}:${action}`);
    return;
  }
  handler(el, el.dataset);
});
