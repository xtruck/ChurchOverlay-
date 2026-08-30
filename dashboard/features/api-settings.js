/**
 * dashboard/features/api-settings.js — panneau Clés API & Microphone.
 * Extrait de dashboard/legacy-core.js (chantier de modularisation).
 */
import { showToast, confirmDialog } from '../utils.js';
import { setStatusStripItem } from './status-strip.js';

// ---------------------------------------------------------------
// Paramètres — Clés API & Microphone
// ---------------------------------------------------------------
// window.churchOverlay n'existe que dans la fenêtre Electron (exposé
// par preload.js). Si ce fichier est ouvert directement dans un
// navigateur (mode "serveur seul"), le panneau se désactive proprement
// au lieu d'échouer silencieusement sur des appels IPC inexistants.
(function initApiSettingsPanel() {
  const els = {
    unavailable: document.getElementById('apiSettingsUnavailable'),
    form: document.getElementById('apiSettingsForm'),
    card: document.getElementById('apiSettingsCard'),
    banner: document.getElementById('setupBanner'),
    requiredBadge: document.getElementById('setupRequiredBadge'),
    micSelect: document.getElementById('settingsMicSelect'),
    micStatus: document.getElementById('settingsMicStatus'),
    btnRefreshMic: document.getElementById('settingsBtnRefreshMic'),
    groqInput: document.getElementById('settingsGroqKey'),
    groqBadge: document.getElementById('groqKeyBadge'),
    deepgramInput: document.getElementById('settingsDeepgramKey'),
    deepgramBadge: document.getElementById('deepgramKeyBadge'),
    geminiInput: document.getElementById('settingsGeminiKey'),
    geminiBadge: document.getElementById('geminiKeyBadge'),
    btnSave: document.getElementById('settingsBtnSave'),
    saveStatus: document.getElementById('settingsSaveStatus'),
    btnClearGroq: document.getElementById('settingsClearGroq'),
    btnClearDeepgram: document.getElementById('settingsClearDeepgram'),
    btnClearGemini: document.getElementById('settingsClearGemini'),
    streamingToggle: document.getElementById('streamingModeToggle'),
    streamingHint: document.getElementById('streamingModeHint'),
  };

  if (!els.form) return; // section absente de ce build, rien à faire

  if (!window.churchOverlay) {
    if (els.unavailable) els.unavailable.style.display = 'block';
    return;
  }

  function setBadge(el, configured) {
    if (!el) return;
    el.style.display = 'inline-block';
    el.textContent = configured ? '✓ Configurée' : 'Non configurée';
    el.className = 'status-badge ' + (configured ? 'success' : 'warning');
  }

  async function loadMicrophones(preselectId) {
    els.micStatus.className = 'field-hint';
    els.micStatus.textContent = '';
    els.micSelect.innerHTML = '<option value="">🔍 Recherche des microphones…</option>';
    els.btnRefreshMic.disabled = true;

    let devices;
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach((t) => t.stop());
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      devices = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Microphone (nom indisponible)' }));
    } catch (err) {
      els.btnRefreshMic.disabled = false;
      els.micSelect.innerHTML = '<option value="">❌ Accès micro refusé</option>';
      els.micStatus.className = 'field-hint';
      els.micStatus.style.color = 'var(--accent-rose)';
      const isPermissionError =
        err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      els.micStatus.textContent = isPermissionError
        ? "⚠️ Autorisation micro refusée (Windows → Confidentialité → Microphone). Cliquez sur Actualiser après avoir autorisé l'accès."
        : `⚠️ Erreur : ${err && err.message ? err.message : err}`;
      return;
    }

    els.btnRefreshMic.disabled = false;
    els.micSelect.innerHTML = '';

    if (devices.length === 0) {
      els.micSelect.innerHTML = '<option value="">❌ Aucun microphone détecté</option>';
      els.micStatus.style.color = 'var(--accent-rose)';
      els.micStatus.textContent =
        "⚠️ Vérifiez qu'un micro est branché, puis cliquez sur Actualiser.";
      return;
    }

    devices.forEach(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      els.micSelect.appendChild(opt);
    });

    if (preselectId && devices.some((d) => d.id === preselectId)) {
      els.micSelect.value = preselectId;
    }

    els.micStatus.style.color = 'var(--accent-emerald)';
    els.micStatus.textContent = `✅ ${devices.length} microphone(s) détecté(s)`;
  }

  async function refreshSettingsUi() {
    const settings = await window.churchOverlay.getSettings();
    setBadge(els.groqBadge, settings.hasGroqKey);
    setBadge(els.deepgramBadge, settings.hasDeepgramKey);
    setBadge(els.geminiBadge, settings.hasGeminiKey);
    // AJOUT (bandeau d'état permanent) : Groq est le fournisseur PRINCIPAL
    // requis (voir config-validator.js — même règle exacte : "Aucun
    // fournisseur de transcription principal n'est configuré" ne se
    // déclenche que sur GROQ_API_KEY, Deepgram n'étant qu'un repli
    // optionnel) — la pastille suit donc uniquement hasGroqKey, pas
    // needsSetup (qui couvre aussi le micro, déjà sa propre pastille).
    setStatusStripItem(
      'Api',
      settings.hasGroqKey ? 'ok' : 'warn',
      settings.hasGroqKey
        ? settings.hasDeepgramKey
          ? 'Groq + Deepgram'
          : 'Groq configurée'
        : 'Clé Groq manquante'
    );

    const needsSetup = !!settings.needsSetup;
    els.card.classList.toggle('needs-setup', needsSetup);
    els.requiredBadge.style.display = needsSetup ? 'inline-block' : 'none';
    els.banner.style.display = needsSetup ? 'flex' : 'none';

    // AJOUT (bascule streaming Deepgram) : désactivée tant qu'aucune clé
    // Deepgram n'est enregistrée — même garde-fou que main.js#startServer
    // (qui n'active ASR_PROVIDER=deepgram que si config.deepgramApiKey est
    // aussi présent), pour que l'état affiché ici ne mente jamais sur ce que
    // le pipeline fera réellement au prochain démarrage.
    if (els.streamingToggle) {
      els.streamingToggle.checked = settings.asrProvider === 'deepgram';
      els.streamingToggle.disabled = !settings.hasDeepgramKey;
      if (els.streamingHint) {
        els.streamingHint.textContent = settings.hasDeepgramKey
          ? 'Latence bien plus faible que le mode par segments (Groq).'
          : 'Nécessite une clé API Deepgram ci-dessus pour être activé.';
      }
    }

    await loadMicrophones(settings.audioDevice);

    // Au premier lancement (ou tant qu'il manque le micro/la clé
    // Groq), on ouvre directement l'onglet Paramètres pour que la
    // configuration soit visible sans action supplémentaire —
    // qu'elle soit ensuite complétée manuellement par la personne
    // ou déjà pré-remplie automatiquement par une config existante.
    if (needsSetup) {
      // CORRECTIF (audit — regroupement de navigation) : "settings" fait
      // maintenant partie d'un data-sections combiné ("Réglages"), plus
      // une valeur exacte isolée — sélecteur par sous-chaîne.
      const settingsNav = document.querySelector('.nav-item[data-sections*="settings"]');
      if (settingsNav) settingsNav.click();
    }

    return settings;
  }

  els.form.style.display = 'block';

  els.btnRefreshMic.addEventListener('click', () => loadMicrophones(els.micSelect.value));

  document.querySelectorAll('.settings-copy-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      navigator.clipboard.writeText(url).then(() => {
        const original = link.textContent;
        link.textContent = 'Lien copié ✓';
        setTimeout(() => {
          link.textContent = original;
        }, 2000);
      });
    });
  });

  document.querySelectorAll('.btn-toggle-pass').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const show = target.type === 'password';
      target.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Masquer' : 'Afficher';
    });
  });

  async function clearKey(provider, inputEl, badgeEl) {
    const label = provider === 'groq' ? 'Groq' : provider === 'deepgram' ? 'Deepgram' : 'Gemini';
    if (!(await confirmDialog(`Retirer la clé API ${label} enregistrée ?`, { danger: true })))
      return;
    try {
      await window.churchOverlay.clearApiKey(provider);
      inputEl.value = '';
      setBadge(badgeEl, false);
      showToast(`Clé ${label} retirée`, 'info');
      if (provider === 'groq') await refreshSettingsUi();
    } catch (_e) {
      showToast(`Erreur lors du retrait de la clé ${label}`, 'error');
    }
  }

  if (els.btnClearGroq) {
    els.btnClearGroq.addEventListener('click', () =>
      clearKey('groq', els.groqInput, els.groqBadge)
    );
  }
  if (els.btnClearDeepgram) {
    els.btnClearDeepgram.addEventListener('click', () =>
      clearKey('deepgram', els.deepgramInput, els.deepgramBadge)
    );
  }
  if (els.btnClearGemini) {
    els.btnClearGemini.addEventListener('click', () =>
      clearKey('gemini', els.geminiInput, els.geminiBadge)
    );
  }

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const mic = els.micSelect.value;
    if (!mic) {
      els.saveStatus.style.color = 'var(--accent-rose)';
      els.saveStatus.textContent = "⚠️ Sélectionnez un microphone avant d'enregistrer.";
      return;
    }

    els.btnSave.disabled = true;
    const originalLabel = els.btnSave.textContent;
    els.btnSave.textContent = '⏳ Enregistrement…';
    els.saveStatus.textContent = '';

    try {
      // Champs laissés vides = conserver la clé déjà enregistrée
      // (voir saveConfigAsync côté main.js) ; utiliser « Retirer
      // la clé » pour un retrait volontaire.
      await window.churchOverlay.saveSetup(
        mic,
        els.groqInput.value.trim(),
        els.deepgramInput.value.trim(),
        els.geminiInput.value.trim()
      );
      els.groqInput.value = '';
      els.deepgramInput.value = '';
      els.geminiInput.value = '';
      els.saveStatus.style.color = 'var(--accent-emerald)';
      els.saveStatus.textContent = '✅ Configuration enregistrée — pipeline (re)démarré.';
      showToast('Configuration API enregistrée', 'success');
      await refreshSettingsUi();
    } catch (err) {
      els.saveStatus.style.color = 'var(--accent-rose)';
      els.saveStatus.textContent = '❌ Erreur : ' + (err && err.message ? err.message : err);
    } finally {
      els.btnSave.disabled = false;
      els.btnSave.textContent = originalLabel;
    }
  });

  async function onStreamingModeToggle() {
    if (!els.streamingToggle) return;
    const wanted = els.streamingToggle.checked ? 'deepgram' : 'auto';
    els.streamingToggle.disabled = true;
    try {
      await window.churchOverlay.setAsrProvider(wanted);
      showToast(
        wanted === 'deepgram'
          ? 'Mode streaming activé — pipeline redémarré.'
          : 'Mode streaming désactivé — pipeline redémarré.',
        'success'
      );
    } catch (err) {
      els.streamingToggle.checked = !els.streamingToggle.checked; // annule visuellement l'échec
      showToast('Erreur : ' + (err && err.message ? err.message : err), 'error');
    } finally {
      await refreshSettingsUi();
    }
  }
  window.onStreamingModeToggle = onStreamingModeToggle;

  refreshSettingsUi();
})();
