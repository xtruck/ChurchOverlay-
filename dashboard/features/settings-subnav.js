/**
 * dashboard/features/settings-subnav.js — sous-navigation par catégorie
 * pour l'onglet "Réglages" (voir .settings-subnav dans dashboard.html,
 * juste avant la première carte de <section id="controls">).
 *
 * L'onglet "Réglages" regroupe 5 <section> (controls/analysis/settings/
 * overlay/studio) affichées ensemble par showSectionsFor() (state.js) —
 * ce fichier ne touche PAS ce mécanisme, il ajoute un second niveau de
 * filtre purement visuel à l'intérieur : chaque carte porte un attribut
 * data-group="..." (posé directement dans le HTML), ce script
 * affiche/masque .card[data-group] et .overlay-preview-card[data-group]
 * selon le bouton cliqué. "Tout" (état par défaut au chargement) affiche
 * tout, comme avant l'ajout de cette barre.
 */
(function initSettingsSubnav() {
  const nav = document.querySelector('.settings-subnav');
  if (!nav) return;

  const buttons = Array.from(nav.querySelectorAll('.subnav-btn'));
  const cards = Array.from(
    document.querySelectorAll(
      '#controls .card[data-group], #analysis .card[data-group], #settings .card[data-group], #overlay .overlay-preview-card[data-group], #studio .card[data-group]'
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
