/**
 * dashboard/features/command-palette.js — Palette de commandes Ctrl+K
 * Recherche floue parmi toutes les actions disponibles, exécution en 1 clic ou Enter.
 */
(function () {
  const COMMANDS = [
    { label: 'Afficher un verset', action: 'showVerse', category: 'Affichage', shortcut: '' },
    { label: 'Masquer le verset', action: 'hideVerse', category: 'Affichage', shortcut: '' },
    {
      label: 'Masquer le média',
      action: 'hideMedia',
      category: 'Affichage',
      shortcut: 'Ctrl+Alt+Maj+M',
    },
    {
      label: 'Masquer la scène',
      action: 'hideScene',
      category: 'Affichage',
      shortcut: 'Ctrl+Alt+Maj+S',
    },
    {
      label: "Effacement d'urgence",
      action: 'emergencyClear',
      category: 'Urgence',
      shortcut: 'Ctrl+Alt+Maj+C',
    },
    {
      label: 'Masquer le verset overlay',
      action: 'hideVerse',
      category: 'Urgence',
      shortcut: 'Ctrl+Alt+aj+H',
    },
    { label: 'Mettre en pause', action: 'pauseTimer', category: 'Timer', shortcut: '' },
    { label: 'Reprendre', action: 'resumeTimer', category: 'Timer', shortcut: '' },
    { label: 'Étendre la durée', action: 'extendTime', category: 'Timer', shortcut: '' },
    {
      label: 'Vérification pré-culte',
      action: 'preServiceCheck',
      category: 'Système',
      shortcut: '',
    },
    {
      label: 'Basculer haute intensité',
      action: 'setHighContrast',
      category: 'Accessibilité',
      shortcut: '',
    },
    { label: 'Sous-titres ON/OFF', action: 'setCaptions', category: 'Accessibilité', shortcut: '' },
    {
      label: 'Sous-titres traduits',
      action: 'setTranslatedCaptions',
      category: 'Accessibilité',
      shortcut: '',
    },
    { label: 'Motif de test', action: 'setTestPattern', category: 'Affichage', shortcut: '' },
    { label: 'Motif de fond', action: 'setBackgroundPattern', category: 'Affichage', shortcut: '' },
    { label: 'Changer langue FR', action: 'setLanguage-fr', category: 'Langue', shortcut: '' },
    { label: 'Changer langue EN', action: 'setLanguage-en', category: 'Langue', shortcut: '' },
    { label: 'Bilingue FR+EN', action: 'setLanguage-both', category: 'Langue', shortcut: '' },
    { label: 'Rechercher dans la Bible', action: 'searchBible', category: 'Bible', shortcut: '' },
    { label: 'Mode lecture', action: 'startReading', category: 'Mode lecture', shortcut: '' },
    {
      label: 'Arrêter mode lecture',
      action: 'stopReading',
      category: 'Mode lecture',
      shortcut: '',
    },
    { label: 'Stats session', action: 'getSessionStats', category: 'Système', shortcut: '' },
    { label: 'Résumé IA du sermon', action: 'getLiveSummary', category: 'IA', shortcut: '' },
    { label: 'Thème du sermon', action: 'getSermonTheme', category: 'IA', shortcut: '' },
    { label: 'Envoyer message scène', action: 'sendStageMessage', category: 'Scène', shortcut: '' },
    {
      label: 'Effacer message scène',
      action: 'clearStageMessage',
      category: 'Scène',
      shortcut: '',
    },
    { label: 'Exporter temps forts', action: 'exportHighlights', category: 'Export', shortcut: '' },
    { label: 'Médiathèque', action: 'getMediaLibrary', category: 'Média', shortcut: '' },
    { label: 'Studio de scènes', action: 'getSceneLibrary', category: 'Scènes', shortcut: '' },
    { label: 'Bibliothèque chants', action: 'getSongLibrary', category: 'Chants', shortcut: '' },
    { label: 'État réseau', action: 'getNetworkStatus', category: 'Système', shortcut: '' },
    { label: 'Recap post-culte', action: 'getPostServiceRecap', category: 'IA', shortcut: '' },
  ];

  let overlay = null;
  let input = null;
  let listEl = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'commandPalette';
    overlay.className = 'command-palette-overlay';
    overlay.innerHTML = `
      <div class="command-palette">
        <input type="text" class="command-palette-input" placeholder="Tapez une commande…" autocomplete="off" />
        <div class="command-palette-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    input = overlay.querySelector('.command-palette-input');
    listEl = overlay.querySelector('.command-palette-list');

    input.addEventListener('input', () => filterCommands(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') {
        const active = listEl.querySelector('.command-palette-item.active');
        if (active) executeCommand(active.dataset.action);
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  function filterCommands(query) {
    const q = query
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const items = listEl.querySelectorAll('.command-palette-item');
    items.forEach((item) => {
      const text = item.dataset.label + ' ' + item.dataset.category;
      const match =
        !q ||
        fuzzyMatch(
          q,
          text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
        );
      item.style.display = match ? '' : 'none';
    });
    // Activer le premier visible
    const first = listEl.querySelector('.command-palette-item:not([style*="display: none"])');
    items.forEach((i) => i.classList.remove('active'));
    if (first) first.classList.add('active');
  }

  function fuzzyMatch(query, text) {
    let qi = 0;
    for (let ti = 0; ti < text.length && qi < query.length; ti++) {
      if (text[ti] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  function moveSelection(delta) {
    const items = Array.from(
      listEl.querySelectorAll('.command-palette-item:not([style*="display: none"])')
    );
    if (!items.length) return;
    const current = listEl.querySelector('.command-palette-item.active');
    let idx = items.indexOf(current);
    items.forEach((i) => i.classList.remove('active'));
    idx = (idx + delta + items.length) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  }

  function executeCommand(action) {
    close();
    if (action.startsWith('setLanguage-')) {
      const lang = action.split('-')[1];
      send({ action: 'setLanguage', language: lang });
      return;
    }
    // Actions courtes : exécuter directement
    const shortActions = {
      hideVerse: () => send({ action: 'hideVerse' }),
      emergencyClear: () => {
        if (typeof window.emergencyClear === 'function') window.emergencyClear();
      },
      pauseTimer: () => {
        if (typeof window.pauseTimer === 'function') window.pauseTimer();
      },
      resumeTimer: () => {
        if (typeof window.resumeTimer === 'function') window.resumeTimer();
      },
      extendTime: () => send({ action: 'extendTime' }),
      setHighContrast: () => send({ action: 'setHighContrast', enabled: true }),
      setCaptions: () => send({ action: 'setCaptions', enabled: true }),
      setTranslatedCaptions: () => send({ action: 'setTranslatedCaptions', enabled: true }),
      setTestPattern: () => send({ action: 'setTestPattern', enabled: true }),
      setBackgroundPattern: () => send({ action: 'setBackgroundPattern', enabled: true }),
      hideMedia: () => send({ action: 'hideMedia' }),
      hideScene: () => send({ action: 'hideScene' }),
      startReading: () => {
        if (typeof window.startReadingMode === 'function') window.startReadingMode();
      },
      stopReading: () => {
        if (typeof window.stopReadingMode === 'function') window.stopReadingMode();
      },
    };
    if (shortActions[action]) {
      shortActions[action]();
      return;
    }
    // Actions nécessitant un payload : déclencher un flux UI existant
    const uiTriggers = {
      showVerse: () => {
        if (typeof window.showManualVerse === 'function') window.showManualVerse();
      },
      searchBible: () => {
        if (typeof window.showManualVerse === 'function') window.showManualVerse();
      },
      preServiceCheck: () => send({ action: 'preServiceCheck' }),
      getSessionStats: () => send({ action: 'getSessionStats' }),
      getLiveSummary: () => send({ action: 'getLiveSummary' }),
      getSermonTheme: () => send({ action: 'getSermonTheme' }),
      sendStageMessage: () => {
        if (typeof window.showStageMessagePrompt === 'function') window.showStageMessagePrompt();
      },
      clearStageMessage: () => send({ action: 'clearStageMessage' }),
      exportHighlights: () => send({ action: 'exportHighlights' }),
      getMediaLibrary: () => send({ action: 'getMediaLibrary' }),
      getSceneLibrary: () => send({ action: 'getSceneLibrary' }),
      getSongLibrary: () => send({ action: 'getSongLibrary' }),
      getNetworkStatus: () => send({ action: 'getNetworkStatus' }),
      getPostServiceRecap: () => send({ action: 'getPostServiceRecap' }),
    };
    if (uiTriggers[action]) uiTriggers[action]();
  }

  function send(msg) {
    try {
      const ws = window._ws || (window.state && window.state.ws);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch (_) {
      /* ignore */
    }
  }

  function open() {
    if (!overlay) createOverlay();
    overlay.classList.add('open');
    input.value = '';
    filterCommands('');
    setTimeout(() => input.focus(), 50);
  }

  function close() {
    if (overlay) overlay.classList.remove('open');
  }

  // Rendu de la liste
  function renderList() {
    if (!listEl) return;
    let html = '';
    let lastCategory = '';
    COMMANDS.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
    COMMANDS.forEach((cmd) => {
      if (cmd.category !== lastCategory) {
        html += `<div class="command-palette-category">${cmd.category}</div>`;
        lastCategory = cmd.category;
      }
      html += `<div class="command-palette-item" data-action="${cmd.action}" data-label="${cmd.label}" data-category="${cmd.category}">
        <span>${cmd.label}</span>
        ${cmd.shortcut ? `<kbd>${cmd.shortcut}</kbd>` : ''}
      </div>`;
    });
    listEl.innerHTML = html;
  }

  // Raccourci clavier global
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (overlay && overlay.classList.contains('open')) {
        close();
      } else {
        open();
      }
    }
  });

  // Initialisation DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (overlay) renderList();
    });
  } else {
    // DOM already loaded — create and render
    createOverlay();
    renderList();
  }

  // Expose for debugging
  window._commandPaletteOpen = open;
  window._commandPaletteClose = close;
})();
