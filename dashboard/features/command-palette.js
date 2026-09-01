/**
 * dashboard/features/command-palette.js — Palette de commandes Ctrl+K
 * Recherche floue parmi toutes les actions disponibles, exécution en 1 clic ou Enter.
 *
 * AJOUT (Partie 2.4 — un seul vocabulaire pour la voix et le manuel) :
 * label/catégorie ne sont plus dupliqués à la main ici — ils viennent de
 * action-registry.js (window.ACTION_REGISTRY, chargé en <script> classique
 * par dashboard.html avant ce module, voir son commentaire). Seule la LISTE
 * des actions présentes dans la palette reste choisie ici (executeCommand()
 * ci-dessous ne sait exécuter qu'un sous-ensemble curé des ~90 actions du
 * registre — la plupart exigent un payload/formulaire qu'aucune génération
 * automatique ne peut deviner), avec un raccourci clavier optionnel quand un
 * vrai raccourci global existe (voir main.js, globalShortcut.register).
 */
(function () {
  // Traduction catégorie (clé technique du registre) -> libellé affiché.
  // Volontairement plus courte que les catégories du registre : le registre
  // distingue des usages internes (ex. sendStageMessage/exportHighlights/
  // getNetworkStatus sont tous 'infra') qu'un opérateur regroupe mentalement
  // sous "Système".
  const CATEGORY_LABELS = {
    display: 'Affichage',
    media: 'Média',
    scenes: 'Scènes',
    emergency: 'Urgence',
    timer: 'Timer',
    ai: 'IA',
    accessibility: 'Accessibilité',
    theme: 'Thème',
    language: 'Langue',
    bible: 'Bible',
    reading: 'Mode lecture',
    infra: 'Système',
    songs: 'Chants',
  };

  // Liste curée : quelles actions du registre apparaissent dans la palette,
  // avec leur raccourci clavier réel s'il en existe un (voir main.js,
  // CommandOrControl+Alt+Shift+{C,H,M,S}). `labelOverride`/`categoryOverride`
  // uniquement pour les 3 entrées setLanguage-* ci-dessous : ce sont trois
  // valeurs de PARAMÈTRE de la même action 'setLanguage', que le registre ne
  // peut pas connaître (il décrit l'action, pas ses valeurs possibles).
  const PALETTE_ACTIONS = [
    { action: 'showVerse' },
    { action: 'hideVerse', shortcut: 'Ctrl+Alt+Maj+H' },
    { action: 'hideMedia', shortcut: 'Ctrl+Alt+Maj+M' },
    { action: 'hideScene', shortcut: 'Ctrl+Alt+Maj+S' },
    { action: 'emergencyClear', shortcut: 'Ctrl+Alt+Maj+C' },
    { action: 'pauseTimer' },
    { action: 'resumeTimer' },
    { action: 'extendTime' },
    { action: 'preServiceCheck' },
    { action: 'setHighContrast' },
    { action: 'setCaptions' },
    { action: 'setTranslatedCaptions' },
    { action: 'setTestPattern' },
    { action: 'setBackgroundPattern' },
    { action: 'setLanguage-fr', registryAction: 'setLanguage', labelOverride: 'Changer langue FR' },
    { action: 'setLanguage-en', registryAction: 'setLanguage', labelOverride: 'Changer langue EN' },
    {
      action: 'setLanguage-both',
      registryAction: 'setLanguage',
      labelOverride: 'Bilingue FR+EN',
    },
    { action: 'searchBible' },
    { action: 'startReading' },
    { action: 'stopReading' },
    { action: 'getSessionStats' },
    { action: 'getLiveSummary' },
    { action: 'getSermonTheme' },
    { action: 'sendStageMessage' },
    { action: 'clearStageMessage' },
    { action: 'exportHighlights' },
    { action: 'getMediaLibrary' },
    { action: 'getSceneLibrary' },
    { action: 'getSongLibrary' },
    { action: 'getNetworkStatus' },
    { action: 'getPostServiceRecap' },
  ];

  // Construit la liste réellement rendue en résolvant label/catégorie
  // depuis le registre — fait une seule fois au chargement, pas à chaque
  // frappe dans filterCommands().
  function buildCommands() {
    const registry = window.ACTION_REGISTRY;
    const clientActions = (registry && registry.CLIENT_ACTIONS) || {};
    if (!registry) {
      console.warn(
        '[command-palette] window.ACTION_REGISTRY absent — labels de repli utilisés (voir action-registry.js et son <script> dans dashboard.html).'
      );
    }
    return PALETTE_ACTIONS.map((entry) => {
      const registryAction = entry.registryAction || entry.action;
      const meta = clientActions[registryAction];
      const category = (meta && CATEGORY_LABELS[meta.category]) || 'Système';
      const label = entry.labelOverride || (meta && meta.description) || entry.action;
      return { label, action: entry.action, category, shortcut: entry.shortcut || '' };
    });
  }

  const COMMANDS = buildCommands();

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
      // CORRECTIF (audit Phase 1F — actions mortes) : appelait
      // window.emergencyClear(), une fonction qui n'a jamais existé nulle
      // part dans le tableau de bord (aucun `window.emergencyClear = ...`) —
      // ce raccourci ne faisait donc littéralement rien. Le vrai "Master
      // Clear" est ppClearAll() (propresenter-studio.js, exposé en
      // window.ppClearAll, déjà utilisé par ses propres raccourcis F1-F4).
      emergencyClear: () => {
        if (typeof window.ppClearAll === 'function') window.ppClearAll();
      },
      pauseTimer: () => {
        if (typeof window.pauseTimer === 'function') window.pauseTimer();
      },
      resumeTimer: () => {
        if (typeof window.resumeTimer === 'function') window.resumeTimer();
      },
      // CORRECTIF (audit Phase 1F — actions mortes) : envoyait
      // { action: 'extendTime' } SANS extraMs — server.js n'avait de toute
      // façon aucun handler pour cette action reçue en direct (voir
      // server.js, corrigé dans le même audit), et même une fois corrigé
      // là-bas, extraMs manquant l'aurait rejeté. Cette entrée de palette
      // est une action rapide sans formulaire (comme tous ses voisins
      // ci-dessus) : 5 minutes par défaut, une durée de prolongation de
      // service courante et facile à redéclencher si besoin de plus.
      extendTime: () => send({ action: 'extendTime', extraMs: 5 * 60 * 1000 }),
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
