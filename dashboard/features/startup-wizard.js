/**
 * dashboard/features/startup-wizard.js — Assistant de démarrage
 * S'affiche automatiquement au premier lancement ou sur demande (Ctrl+Shift+S).
 * Vérifie les clés API, le micro, et guide l'opérateur dans la config initiale.
 */
(function () {
  let overlay = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'startupWizard';
    overlay.className = 'startup-wizard-overlay';
    overlay.innerHTML = `
      <div class="startup-wizard">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <h2 style="margin:0;font-size:1.1rem;color:var(--text-main);">Assistant de Démarrage</h2>
          <button class="btn btn-secondary" onclick="closeStartupWizard()" style="padding:0.25rem 0.5rem;font-size:0.75rem;">✕ Fermer</button>
        </div>
        <div id="wizardSteps" style="display:flex;flex-direction:column;gap:1rem;">
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon" id="wizardApiIcon">⏳</span>
              <span class="wizard-step-title">1. Clés API</span>
            </div>
            <div class="wizard-step-body">
              Vérifiez que les clés Deepgram et/ou Groq sont configurées dans config/features.json.
              <div id="wizardApiStatus" class="wizard-status" style="margin-top:0.5rem;">Vérification en cours…</div>
            </div>
          </div>
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon" id="wizardMicIcon">🎤</span>
              <span class="wizard-step-title">2. Microphone</span>
            </div>
            <div class="wizard-step-body">
              Sélectionnez le microphone dans Réglages → Système. La bande d'écoute en haut de DIRECT confirme que le micro fonctionne.
              <div id="wizardMicStatus" class="wizard-status" style="margin-top:0.5rem;">Vérification en cours…</div>
            </div>
          </div>
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon">📺</span>
              <span class="wizard-step-title">3. OBS Studio</span>
            </div>
            <div class="wizard-step-body">
              Ajoutez une Source Navigateur dans OBS avec le lien ci-dessous (copiez-le depuis RÉGIE → Overlay).
              <div style="margin-top:0.5rem;padding:0.5rem;background:var(--bg-input);border-radius:6px;font-family:var(--font-mono);font-size:0.75rem;word-break:break-all;" id="wizardObsUrl">Chargement…</div>
            </div>
          </div>
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon">✅</span>
              <span class="wizard-step-title">4. Vérification pré-culte</span>
            </div>
            <div class="wizard-step-body">
              Avant chaque culte, cliquez sur "Vérification pré-culte" dans RÉGIE → Système pour tester la connexion API et le pipeline audio.
            </div>
          </div>
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:0.5rem;justify-content:flex-end;">
          <button class="btn btn-primary" onclick="closeStartupWizard()">Compris !</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeStartupWizard(); });
  }

  function checkStatus() {
    // Check API
    const apiStatus = document.getElementById('wizardApiStatus');
    const apiIcon = document.getElementById('wizardApiIcon');
    try {
      const ws = window._ws || (window.state && window.state.ws);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'preServiceCheck' }));
        if (apiStatus) apiStatus.textContent = 'Vérification envoyée — regardez les résultats dans RÉGIE.';
        if (apiIcon) apiIcon.textContent = '🔍';
      } else {
        if (apiStatus) apiStatus.textContent = '⚠️ Non connecté au serveur.';
        if (apiIcon) apiIcon.textContent = '⚠️';
      }
    } catch (_) {
      if (apiStatus) apiStatus.textContent = '⚠️ Impossible de vérifier.';
    }

    // Check mic
    const micStatus = document.getElementById('wizardMicStatus');
    const micIcon = document.getElementById('wizardMicIcon');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      if (micStatus) micStatus.textContent = '✅ API micro disponible. Vérifiez la sélection dans Réglages.';
      if (micIcon) micIcon.textContent = '✅';
    } else {
      if (micStatus) micStatus.textContent = '⚠️ API micro non disponible (vérifiez le navigateur).';
      if (micIcon) micIcon.textContent = '⚠️';
    }

    // OBS URL
    const obsUrl = document.getElementById('wizardObsUrl');
    if (obsUrl) {
      const urlInput = document.getElementById('overlayUrlInput');
      obsUrl.textContent = urlInput ? urlInput.value : 'Ouvrez RÉGIE → Overlay pour copier le lien.';
    }
  }

  function open() {
    if (!overlay) createOverlay();
    overlay.classList.add('open');
    checkStatus();
  }

  function close() {
    if (overlay) overlay.classList.remove('open');
  }

  window.closeStartupWizard = close;

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      if (overlay && overlay.classList.contains('open')) close();
      else open();
    }
  });

  // Show on first visit (localStorage flag)
  try {
    if (!localStorage.getItem('churchoverlay_wizard_seen')) {
      setTimeout(open, 1500);
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    }
  } catch (_) { /* ignore */ }

  window.openStartupWizard = open;
})();
