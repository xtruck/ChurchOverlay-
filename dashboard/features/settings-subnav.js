/**
 * dashboard/features/settings-subnav.js — sous-navigation par catégorie
 * pour l'onglet "Paramètres" (voir .settings-subnav dans dashboard.html,
 * à l'intérieur de <section id="settings">).
 *
 * CORRECTIF (redesign IA — étape 6) : #controls et #analysis, retirés du
 * sélecteur ci-dessous, n'existent plus (fusionnés dans #propresenter-live
 * à l'étape 3, ou déplacés dans #secondaryDrawer à l'étape 5) ; #studio ne
 * contenait déjà aucune carte avec data-group (seul le composeur de scène
 * y vit, sans cet attribut) — retiré aussi, il ne matchait jamais rien.
 * "Paramètres" (analysis a disparu, voir ci-dessus) n'affiche plus que
 * #studio/#settings/#overlay ; ce filtre ne porte donc que sur les
 * groupes réellement présents dans #settings/#overlay (systeme/diffusion/
 * cameras/integrations).
 *
 * Ce fichier ne touche pas showSectionsFor() (state.js), il ajoute un
 * second niveau de filtre purement visuel à l'intérieur de l'onglet actif :
 * chaque carte porte un attribut data-group="..." (posé directement dans
 * le HTML), ce script affiche/masque .card[data-group] et
 * .overlay-preview-card[data-group] selon le bouton cliqué. "Tout" (état
 * par défaut au chargement) affiche tout, comme avant l'ajout de cette
 * barre.
 */
(function initSettingsSubnav() {
  const nav = document.querySelector('.settings-subnav');
  if (!nav) return;

  const buttons = Array.from(nav.querySelectorAll('.subnav-btn'));
  const cards = Array.from(
    document.querySelectorAll(
      '#settings .card[data-group], #overlay .overlay-preview-card[data-group]'
    )
  );
  if (!buttons.length || !cards.length) return;

  function applyGroup(group) {
    cards.forEach((card) => {
      card.style.display = group === 'all' || card.dataset.group === group ? '' : 'none';
    });
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      applyGroup(btn.dataset.group);
    });
  });
})();
