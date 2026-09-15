/**
 * dashboard/features/training-mode.js — Mode formation
 * Active des guides contextuels et tooltips d'aide pour les nouveaux opérateurs.
 * Toggle accessible via Ctrl+Shift+T ou le bouton dans les réglages.
 */
import { registerAction } from '../action-delegator.js';

(function () {
  let active = false;

  // CORRECTIF (redesign IA — étape 3, fusion Studio Pro / Direct Classique) :
  // #overview/#controls/#transcript ont disparu (fusionnés dans
  // #propresenter-live) — getElementById(step.section) y renvoyait null pour
  // 3 des 5 étapes (aucun crash, juste plus aucun encadré affiché, une
  // régression silencieuse). Repointé vers un élément réel et toujours
  // présent, spécifique à l'action décrite dans chaque étape, plutôt qu'une
  // section entière désormais introuvable.
  const GUIDE_STEPS = [
    {
      section: 'listeningBar',
      title: '1. Bienvenue !',
      text: "Commencez par vérifier que la bande d'écoute montre un niveau audio actif (point vert). Si le point est gris, vérifiez le micro.",
    },
    {
      section: 'showManualVerseBtn',
      title: '2. Afficher un verset',
      text: 'Cliquez sur "Afficher un Verset" ou tapez une référence dans la barre de recherche. Le verset apparaît sur l\'écran de l\'église.',
    },
    {
      section: 'transcriptFeed',
      title: '3. Transcription auto',
      text: 'Le pasteur parle → le texte apparaît ici → le système détecte automatiquement les références bibliques.',
    },
    {
      section: 'media-wall',
      title: '4. Médias',
      text: 'Le Mur Média (juste ici, dans Opérateur) permet de préparer et déclencher des photos/vidéos pendant le culte.',
    },
    {
      section: 'toggleBlackScreenBtn',
      title: '5. Urgence',
      text: 'Utilisez "Écran Noir" pour une coupure immédiate, ou "Arrêt d\'Urgence" pour masquer le verset.',
    },
  ];

  let guideIndex = 0;
  let tooltipEl = null;
  let guideBar = null;

  function createTooltip() {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'training-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);
  }

  function hideTip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function createGuideBar() {
    guideBar = document.createElement('div');
    guideBar.className = 'training-guide-bar';
    guideBar.innerHTML = `
      <div class="training-guide-content">
        <span class="training-guide-step"></span>
        <span class="training-guide-text"></span>
      </div>
      <div class="training-guide-actions">
        <button class="btn btn-secondary training-guide-btn" data-action="prev" data-target="training-guide">◀ Préc</button>
        <button class="btn btn-primary training-guide-btn" data-action="next" data-target="training-guide">Suiv ▶</button>
        <button class="btn btn-secondary training-guide-btn" data-action="close" data-target="training-guide">✕ Fermer</button>
      </div>
    `;
    document.body.appendChild(guideBar);
  }

  function showGuideStep() {
    if (!guideBar || guideIndex >= GUIDE_STEPS.length) {
      deactivate();
      return;
    }
    const step = GUIDE_STEPS[guideIndex];
    guideBar.querySelector('.training-guide-step').textContent = step.title;
    guideBar.querySelector('.training-guide-text').textContent = step.text;
    // Highlight section
    document.querySelectorAll('.section').forEach((s) => (s.style.outline = 'none'));
    const target = document.getElementById(step.section);
    if (target && target.style.display !== 'none') {
      target.style.outline = '2px solid #3b82f6';
      target.style.outlineOffset = '4px';
      target.style.borderRadius = '8px';
    }
  }

  function activate() {
    active = true;
    if (!tooltipEl) createTooltip();
    if (!guideBar) createGuideBar();
    guideIndex = 0;
    guideBar.style.display = 'flex';
    showGuideStep();
    document.body.classList.add('training-mode');
    try {
      const ws = window._ws || (window.state && window.state.ws);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'trainingModeChanged', enabled: true }));
      }
    } catch (_) {
      /* ignore */
    }
  }

  function deactivate() {
    active = false;
    hideTip();
    if (guideBar) guideBar.style.display = 'none';
    document.querySelectorAll('.section').forEach((s) => {
      s.style.outline = 'none';
    });
    document.body.classList.remove('training-mode');
    try {
      const ws = window._ws || (window.state && window.state.ws);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'trainingModeChanged', enabled: false }));
      }
    } catch (_) {
      /* ignore */
    }
  }

  function trainingNext() {
    if (guideIndex < GUIDE_STEPS.length - 1) {
      guideIndex++;
      showGuideStep();
    } else {
      deactivate();
    }
  }
  function trainingPrev() {
    if (guideIndex > 0) {
      guideIndex--;
      showGuideStep();
    }
  }
  // AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les 3
  // boutons de la barre de guidage passent désormais par data-action/
  // data-target — jamais exposées sur window (elles ne l'étaient que pour
  // les onclick inline ci-dessus, retirés).
  registerAction('training-guide', 'next', trainingNext);
  registerAction('training-guide', 'prev', trainingPrev);
  registerAction('training-guide', 'close', deactivate);

  window.toggleTrainingMode = function () {
    if (active) deactivate();
    else activate();
  };

  // Ctrl+Shift+T shortcut
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'T') {
      e.preventDefault();
      window.toggleTrainingMode();
    }
  });
})();
