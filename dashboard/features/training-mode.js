/**
 * dashboard/features/training-mode.js — Mode formation
 * Active des guides contextuels et tooltips d'aide pour les nouveaux opérateurs.
 * Toggle accessible via Ctrl+Shift+T ou le bouton dans les réglages.
 */
(function () {
  let active = false;

  const GUIDE_STEPS = [
    {
      section: 'overview',
      title: '1. Bienvenue !',
      text: "Commencez par vérifier que la bande d'écoute montre un niveau audio actif (point vert). Si le point est gris, vérifiez le micro.",
    },
    {
      section: 'controls',
      title: '2. Afficher un verset',
      text: 'Cliquez sur "Afficher un Verset" ou tapez une référence dans la barre de recherche. Le verset apparaît sur l\'écran de l\'église.',
    },
    {
      section: 'transcript',
      title: '3. Transcription auto',
      text: 'Le pasteur parle → le texte apparaît ici → le système détecte automatiquement les références bibliques.',
    },
    {
      section: 'media-wall',
      title: '4. Médias',
      text: 'Dans PRÉPARATION, le Mur Média permet de préparer et déclencher des photos/vidéos pendant le culte.',
    },
    {
      section: 'controls',
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
        <button class="btn btn-secondary" onclick="window._trainingPrev()" style="font-size:0.7rem;padding:0.25rem 0.5rem;">◀ Préc</button>
        <button class="btn btn-primary" onclick="window._trainingNext()" style="font-size:0.7rem;padding:0.25rem 0.5rem;">Suiv ▶</button>
        <button class="btn btn-secondary" onclick="window._trainingClose()" style="font-size:0.7rem;padding:0.25rem 0.5rem;">✕ Fermer</button>
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

  window._trainingNext = function () {
    if (guideIndex < GUIDE_STEPS.length - 1) {
      guideIndex++;
      showGuideStep();
    } else {
      deactivate();
    }
  };
  window._trainingPrev = function () {
    if (guideIndex > 0) {
      guideIndex--;
      showGuideStep();
    }
  };
  window._trainingClose = deactivate;

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
