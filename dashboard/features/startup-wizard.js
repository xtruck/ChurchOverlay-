/**
 * dashboard/features/startup-wizard.js — Assistant de démarrage
 * S'affiche automatiquement au premier lancement ou sur demande (Ctrl+Shift+S).
 * Vérifie les clés API, le micro, et guide l'opérateur dans la config initiale.
 */
import { registerAction } from '../action-delegator.js';

// AJOUT (redesign — pas d'emoji comme icône structurelle) : cet assistant
// composait ses icônes ET ses messages de statut en concaténant un emoji
// littéral (⏳/🔍/⚠️/✅/🎤/📺/⬜/🔴/🟢/🟠) directement dans une chaîne
// .textContent — remplacé par ces marquages SVG statiques (chaînes fixes,
// jamais de contenu utilisateur interpolé DANS ces constantes) assignés via
// .innerHTML. ICON_DOT est un point générique dont la couleur est fixée en
// ligne (voir CALIBRATION_VERDICTS plus bas, déjà une couleur par zone) —
// plus simple que 5 icônes de couleurs différentes pour la même forme.
const ICON_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
const ICON_HOURGLASS =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 2h12M6 22h12M6 2c0 6 12 6 12 10s-12 4-12 10M18 2c0 6-12 6-12 10s12 4 12 10"></path></svg>';
const ICON_SEARCH =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.35-4.35"></path></svg>';
const ICON_WARNING =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l10 18H2z"></path><path d="M12 10v4M12 17h.01"></path></svg>';
const ICON_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>';
const ICON_MIC =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10a7 7 0 0 0 14 0"></path><path d="M12 17v5M9 22h6"></path></svg>';
const ICON_MONITOR =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>';
function iconDot(color) {
  return `<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="${color}"></circle></svg>`;
}

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
          <button class="btn btn-secondary startup-wizard-close-btn" data-action="close" data-target="startup-wizard">${ICON_X} Fermer</button>
        </div>
        <div id="wizardSteps" style="display:flex;flex-direction:column;gap:1rem;">
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon" id="wizardApiIcon">${ICON_HOURGLASS}</span>
              <span class="wizard-step-title">1. Clés API</span>
            </div>
            <div class="wizard-step-body">
              Vérifiez que les clés Deepgram et/ou Groq sont configurées dans config/features.json.
              <div id="wizardApiStatus" class="wizard-status" style="margin-top:0.5rem;">Vérification en cours…</div>
            </div>
          </div>
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon" id="wizardMicIcon">${ICON_MIC}</span>
              <span class="wizard-step-title">2. Microphone — calibrage du niveau</span>
            </div>
            <div class="wizard-step-body">
              Sélectionnez le microphone dans Réglages → Système, puis <strong>parlez normalement</strong> (comme pendant une prédication) pendant quelques secondes en regardant la barre ci-dessous.
              <div id="wizardMicStatus" class="wizard-status" style="margin-top:0.5rem;">Vérification en cours…</div>
              <div
                style="
                  margin-top: 0.6rem;
                  height: 10px;
                  background: var(--bg-input);
                  border-radius: 5px;
                  overflow: hidden;
                "
              >
                <div
                  id="wizardMicLevelBar"
                  style="height: 100%; width: 0%; background: #6b7280; transition: width 0.15s ease, background 0.15s ease;"
                ></div>
              </div>
              <div
                id="wizardMicVerdict"
                style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-dim);"
              >
                En attente de son…
              </div>
            </div>
          </div>
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon">${ICON_MONITOR}</span>
              <span class="wizard-step-title">3. OBS Studio</span>
            </div>
            <div class="wizard-step-body">
              Ajoutez une Source Navigateur dans OBS avec le lien ci-dessous (copiez-le depuis RÉGIE → Overlay).
              <div style="margin-top:0.5rem;padding:0.5rem;background:var(--bg-input);border-radius:6px;font-family:var(--font-mono);font-size:0.75rem;word-break:break-all;" id="wizardObsUrl">Chargement…</div>
            </div>
          </div>
          <div class="wizard-step">
            <div class="wizard-step-header">
              <span class="wizard-step-icon">${ICON_CHECK}</span>
              <span class="wizard-step-title">4. Vérification pré-culte</span>
            </div>
            <div class="wizard-step-body">
              Avant chaque culte, cliquez sur "Vérification pré-culte" dans RÉGIE → Système pour tester la connexion API et le pipeline audio.
            </div>
          </div>
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:0.5rem;justify-content:flex-end;">
          <button class="btn btn-primary" data-action="close" data-target="startup-wizard">Compris !</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  function checkStatus() {
    // Check API
    const apiStatus = document.getElementById('wizardApiStatus');
    const apiIcon = document.getElementById('wizardApiIcon');
    try {
      const ws = window._ws || (window.state && window.state.ws);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'preServiceCheck' }));
        if (apiStatus)
          apiStatus.textContent = 'Vérification envoyée — regardez les résultats dans RÉGIE.';
        if (apiIcon) apiIcon.innerHTML = ICON_SEARCH;
      } else {
        if (apiStatus) apiStatus.innerHTML = `${ICON_WARNING} Non connecté au serveur.`;
        if (apiIcon) apiIcon.innerHTML = ICON_WARNING;
      }
    } catch (_) {
      if (apiStatus) apiStatus.innerHTML = `${ICON_WARNING} Impossible de vérifier.`;
    }

    // Check mic
    const micStatus = document.getElementById('wizardMicStatus');
    const micIcon = document.getElementById('wizardMicIcon');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      if (micStatus)
        micStatus.innerHTML = `${ICON_CHECK} API micro disponible. Vérifiez la sélection dans Réglages.`;
      if (micIcon) micIcon.innerHTML = ICON_CHECK;
    } else {
      if (micStatus)
        micStatus.innerHTML = `${ICON_WARNING} API micro non disponible (vérifiez le navigateur).`;
      if (micIcon) micIcon.innerHTML = ICON_WARNING;
    }

    // OBS URL
    const obsUrl = document.getElementById('wizardObsUrl');
    if (obsUrl) {
      const urlInput = document.getElementById('overlayUrlInput');
      obsUrl.textContent = urlInput
        ? urlInput.value
        : 'Ouvrez RÉGIE → Overlay pour copier le lien.';
    }
  }

  // AJOUT (A.1 — gain micro, assistant de calibrage) : verdicts actionnables
  // par zone, mêmes seuils que classifyAudioLevel() côté serveur (voir
  // audio-capture.js) — reçus ici via le broadcast 'audioDiagnostics' déjà
  // câblé pour le vumètre permanent et la bande d'écoute (aucune nouvelle
  // capture audio, on lit juste les mêmes diagnostics).
  // CORRECTIF (redesign — pas d'emoji comme icône structurelle) : chaque
  // verdict portait un emoji-couleur en dur (⬜/🔴/🟢/🟠/🔴) concaténé au
  // début du texte — remplacé par iconDot(color) au moment de l'affichage
  // (voir updateWizardMicCalibration ci-dessous), réutilisant la MÊME
  // couleur déjà définie ici plutôt qu'une redondance emoji+couleur.
  const CALIBRATION_VERDICTS = {
    silence: {
      color: '#6b7280',
      text: 'Aucun son détecté — vérifiez que le bon micro est sélectionné (Réglages → Système).',
    },
    low: {
      color: '#ef4444',
      text: 'Niveau trop faible pour une transcription fiable — augmentez le gain du micro dans les réglages Windows/macOS, ou rapprochez-vous du micro.',
    },
    good: {
      color: '#22c55e',
      text: 'Niveau correct — le micro est prêt pour le culte.',
    },
    hot: {
      color: '#f59e0b',
      text: 'Niveau fort — éloignez légèrement le micro ou baissez son gain pour éviter la saturation.',
    },
    clipping: {
      color: '#ef4444',
      text: 'Signal écrêté (déformé) — baissez le gain du micro immédiatement, la transcription sera dégradée.',
    },
  };

  /**
   * Appelée à chaque broadcast 'audioDiagnostics' (250 ms, voir
   * dashboard/ws-dispatch.js) tant que l'assistant est ouvert. Pas d'effet
   * si l'étape micro n'est pas dans le DOM (assistant fermé) ou si la
   * capture réelle n'a pas encore démarré (info absent).
   */
  function updateWizardMicCalibration(info) {
    const bar = document.getElementById('wizardMicLevelBar');
    const verdict = document.getElementById('wizardMicVerdict');
    const icon = document.getElementById('wizardMicIcon');
    if (!bar || !verdict) return; // assistant fermé ou étape pas encore rendue

    const rmsMean = (info && info.rmsMean) || 0;
    const totalFrames = (info && info.totalFrames) || 0;
    if (totalFrames === 0) {
      verdict.textContent = 'En attente de son… (parlez près du micro)';
      verdict.style.color = 'var(--text-dim)';
      return;
    }

    const pct = Math.min(100, Math.round(rmsMean * 300));
    const zone = CALIBRATION_VERDICTS[info.level] || null;
    bar.style.width = pct + '%';
    bar.style.background = zone ? zone.color : '#6b7280';
    if (zone) {
      verdict.innerHTML = `${iconDot(zone.color)} ${zone.text}`;
      verdict.style.color = zone.color;
    }
    if (icon && info.level === 'good') icon.innerHTML = ICON_CHECK;
  }

  function open() {
    if (!overlay) createOverlay();
    overlay.classList.add('open');
    checkStatus();
  }

  function close() {
    if (overlay) overlay.classList.remove('open');
  }

  // AJOUT (chantier nettoyage dashboard — purge des onclick inline) : les 2
  // boutons "Fermer"/"Compris !" passent désormais par data-action/
  // data-target — window.closeStartupWizard n'a plus d'appelant restant.
  registerAction('startup-wizard', 'close', close);
  // Appelé depuis dashboard/ws-dispatch.js à chaque 'audioDiagnostics' —
  // ce fichier expose ses points d'entrée via `window.*` plutôt que des
  // exports ES (même convention qu'openStartupWizard ci-dessous, pour
  // rester joignable depuis d'autres modules sans import direct).
  window.updateWizardMicCalibration = updateWizardMicCalibration;

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
  } catch (_) {
    /* ignore */
  }

  window.openStartupWizard = open;
})();
