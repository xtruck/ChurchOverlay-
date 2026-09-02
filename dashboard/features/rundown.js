/**
 * dashboard/features/rundown.js — feuille de route (rundown/cue-list,
 * chantier 4.3).
 *
 * Distinct de verse-queue.js (file d'attente de VERSETS seulement, locale
 * au navigateur, perdue au rechargement) : ici, mixte (verset/média/scène)
 * et PERSISTÉ côté serveur (rundown-store.js) — préparé à l'avance, survit
 * à un rechargement du tableau de bord et reste synchronisé entre plusieurs
 * postes opérateur. Les repères média/scène s'ajoutent depuis leurs propres
 * galeries (media-library.js/scene-studio.js, bouton "➕ Feuille de route"),
 * les repères verset s'ajoutent directement depuis la carte ci-dessous —
 * même style d'ajout que verse-queue.js#addToQueue.
 *
 * Réutilise délibérément les classes .queue-item/.queue-icon-btn déjà
 * stylées pour verse-queue.js — même nature d'UI (liste ordonnée de repères
 * qu'on ajoute/retire/déclenche un par un), pas de nouveau système visuel.
 */
import { ws } from '../state.js';
import { showToast, escapeHtmlDashboard, confirmDialog } from '../utils.js';
import { checkCueReadiness, READINESS_LABELS } from './next-cue-confidence.js';
// AJOUT (Cue Cards) : getArmedCueId() ci-dessous a besoin de savoir quel
// repère est armé — import circulaire avec airlock-preview.js (qui importe
// déjà getRundownCues/triggerRundownCue d'ici), sans risque, voir le
// commentaire d'en-tête de getArmedCueId() dans airlock-preview.js.
import { getArmedCueId } from './airlock-preview.js';

let rundownCues = [];
let rundownActiveIndex = -1;
// AJOUT (Timeline-Based Service Flow — brief produit, priorité #5) : cueId ->
// epoch ms de déclenchement réel pendant ce culte (voir cueTimeline dans
// server.js — cet objet EST sa forme sérialisée, reçue telle quelle dans
// rundownUpdated/rundownActiveCue).
let cueTimeline = {};

// AJOUT (Airlock Preview — voir airlock-preview.js) : même raisonnement que
// getMediaLibraryItems()/getSceneStudioItems() — armRundownCue() a besoin du
// repère COMPLET (mediaId/sceneId/reference selon le type, jamais transmis à
// onclick="armRundownCue('id')" lui-même) pour construire son aperçu.
export function getRundownCues() {
  return rundownCues;
}

// AJOUT (Focus Mode — voir focus-mode.js) : même raisonnement — "quel est le
// prochain repère" (activeIndex + 1) ne peut se répondre depuis l'extérieur
// sans exposer aussi le pointeur, jusqu'ici privé à ce module.
export function getRundownActiveIndex() {
  return rundownActiveIndex;
}

const CUE_TYPE_ICON = { verse: '📖', media: '📷', scene: '🎬' };

export function addVerseToRundown() {
  const input = document.getElementById('rundownRefInput');
  const reference = input ? input.value.trim() : '';
  if (!reference) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible d’ajouter à la feuille de route.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'addRundownCue', type: 'verse', label: reference, reference }));
  if (input) input.value = '';
}

/**
 * AJOUT (câblage des écouteurs, cf. dashboard/event-bindings.js) : le
 * panneau studio a son propre champ de saisie (#ppRundownInput), alors
 * qu'addVerseToRundown() ci-dessus lit #rundownRefInput (le champ de la
 * carte "Feuille de culte" historique). Cette passerelle recopie la valeur
 * de l'un vers l'autre avant de déclencher l'ajout — logique qui vivait
 * jusqu'ici en clair dans un attribut onclick de dashboard.html, donc
 * ni testable ni relisible. Comportement identique à l'octet près, y
 * compris le vidage inconditionnel du champ studio même quand la
 * référence était vide (addVerseToRundown ressort alors sans rien faire).
 */
export function addVerseToRundownFromStudio() {
  const studioInput = document.getElementById('ppRundownInput');
  const legacyInput = document.getElementById('rundownRefInput');
  if (!studioInput || !legacyInput) return;
  legacyInput.value = studioInput.value;
  addVerseToRundown();
  studioInput.value = '';
}

/**
 * Appelée depuis media-library.js/scene-studio.js (bouton "➕ Feuille de
 * route" de chaque élément de galerie) — un seul point d'entrée générique
 * pour les deux types, plutôt qu'une fonction dupliquée par type.
 * @param {'media'|'scene'} type
 * @param {string} id
 * @param {string} label
 */
export function addToRundown(type, id, label) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur — impossible d’ajouter à la feuille de route.', 'error');
    return;
  }
  const payload = { action: 'addRundownCue', type, label };
  if (type === 'media') payload.mediaId = id;
  else payload.sceneId = id;
  ws.send(JSON.stringify(payload));
  showToast(`« ${label} » ajouté à la feuille de route.`, 'success');
}

export function removeRundownCue(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'removeRundownCue', id }));
}

export function moveRundownCue(id, direction) {
  const idx = rundownCues.findIndex((c) => c.id === id);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= rundownCues.length) return;
  const reordered = rundownCues.map((c) => c.id);
  [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action: 'reorderRundownCues', orderedIds: reordered }));
}

export function triggerRundownCue(id) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'triggerRundownCue', id }));
}

// AJOUT (Timeline-Based Service Flow) : minutesInput vient d'un <input
// type="number"> (voir renderRundown()) — vide/0/négatif retire
// l'estimation plutôt que de rejeter la saisie, pour qu'effacer le champ
// soit le geste naturel pour "je ne sais plus", cohérent avec
// rundown-store.js#updateCueDuration qui traite explicitement null comme un
// retrait valide, pas une erreur.
export function setCueDuration(id, minutesInput) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  const minutes = parseFloat(minutesInput);
  const expectedDurationMs =
    Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : null;
  ws.send(JSON.stringify({ action: 'setRundownCueDuration', id, expectedDurationMs }));
}

export function nextRundownCue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Non connecté au serveur.', 'error');
    return;
  }
  ws.send(JSON.stringify({ action: 'nextRundownCue' }));
}

export async function clearRundown() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (rundownCues.length === 0) return;
  const ok = await confirmDialog(
    'Vider toute la feuille de route ? Cette action est irréversible.',
    {
      danger: true,
    }
  );
  if (!ok) return;
  ws.send(JSON.stringify({ action: 'clearRundown' }));
}

/**
 * Message rundownActiveCue — contrairement à rundownUpdated, ne transporte
 * pas la liste complète des repères (juste id/index du repère qui vient
 * d'être déclenché). renderRundown() garde déjà rundownCues à jour (aucune
 * mutation de la LISTE elle-même par triggerRundownCue/nextRundownCue côté
 * serveur, seul le pointeur "actif" change) — on se contente donc de mettre
 * ce pointeur à jour et de redessiner, sans aller rechercher la liste.
 */
export function applyRundownActiveCue(message) {
  rundownActiveIndex = typeof message.index === 'number' ? message.index : -1;
  if (message.cueTimeline && typeof message.cueTimeline === 'object') {
    cueTimeline = message.cueTimeline;
  }
  renderRundown({ cues: rundownCues, activeIndex: rundownActiveIndex, cueTimeline });
}

// AJOUT (Timeline-Based Service Flow) : "5 min", ou "1h 05" au-delà d'une
// heure — jamais de décimales (une estimation à la minute près est déjà
// plus précise que ce qu'un opérateur peut réellement saisir/tenir).
function formatDurationMinutes(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}`;
}

/**
 * Retard/avance accumulé par les segments déjà TERMINÉS (indices
 * [0, rundownActiveIndex[), comparés à leur durée estimée cumulée — pas une
 * horloge qui tourne en continu pendant le segment en cours (voir en-tête de
 * fichier) : recalculé à chaque transition, pas chaque seconde. Un segment en
 * cours qui dépasse largement son budget reste visible à l'œil nu par
 * l'opérateur qui le pilote ; ce chiffre répond à une question différente et
 * complémentaire : "les segments déjà passés ont-ils, en cumulé, pris plus
 * ou moins de temps que prévu ?"
 * @returns {{state:string, delayMs?:number}}
 */
function computeScheduleStatus() {
  if (rundownCues.length === 0 || rundownActiveIndex < 0) return { state: 'not-started' };
  const firstStartedAt = cueTimeline[rundownCues[0].id];
  if (!firstStartedAt) return { state: 'not-started' };
  if (rundownActiveIndex === 0) return { state: 'first-segment' };

  let totalExpectedMs = 0;
  for (let i = 0; i < rundownActiveIndex; i++) {
    const d = rundownCues[i].expectedDurationMs;
    if (typeof d !== 'number') return { state: 'incomplete-estimates' };
    totalExpectedMs += d;
  }
  const currentStartedAt = cueTimeline[rundownCues[rundownActiveIndex].id];
  if (!currentStartedAt) return { state: 'not-started' };
  const actualElapsedMs = currentStartedAt - firstStartedAt;
  return { state: 'ok', delayMs: actualElapsedMs - totalExpectedMs };
}

// AJOUT (Cue Cards — idée créative, brief produit) : statut opérationnel
// grossier d'un repère — En direct/Armé/Diffusé. Volontairement PAS
// Prêt/À vérifier/Bloqué (déjà couvert par .cue-readiness-badge, voir
// next-cue-confidence.js) : `null` ici laisse ce badge existant parler seul
// pour un repère qui n'est encore dans aucun de ces trois états. "Diffusé"
// se base sur cueTimeline (pas sur i < rundownActiveIndex) pour rester
// correct même après un réordonnancement de la feuille de route — voir
// server.js#cueTimeline, jamais réinitialisé par un simple réordonnancement.
function computeCueStatus(cue, i) {
  if (i === rundownActiveIndex) return { key: 'live', icon: '●', text: 'En direct' };
  if (cueTimeline[cue.id]) return { key: 'played', icon: '✓', text: 'Diffusé' };
  if (getArmedCueId() === cue.id) return { key: 'armed', icon: '⏏', text: 'Armé' };
  return null;
}

function cueStatusChipHtml(cue, i) {
  const status = computeCueStatus(cue, i);
  const cls = status ? ` cue-status-${status.key}` : '';
  const content = status ? escapeHtmlDashboard(`${status.icon} ${status.text}`) : '';
  return `<span class="cue-status-chip${cls}" id="cueStatus-${cue.id}">${content}</span>`;
}

// AJOUT (Cue Cards) : appelé depuis airlock-preview.js après un armement/
// désarmement — ce changement d'état est purement local à ce module-là,
// aucune diffusion serveur ne redessine donc la feuille de route toute
// seule. Met à jour uniquement le chip de chaque repère (pas de
// re-déclenchement des vérifications réseau de refreshCueReadinessBadges,
// inutile ici et source de scintillement pour un simple armement).
export function refreshCueStatusChips() {
  rundownCues.forEach((cue, i) => {
    const el = document.getElementById(`cueStatus-${cue.id}`);
    if (!el) return;
    const status = computeCueStatus(cue, i);
    el.className = status ? `cue-status-chip cue-status-${status.key}` : 'cue-status-chip';
    el.textContent = status ? `${status.icon} ${status.text}` : '';
  });
}

const SCHEDULE_STATUS_TOLERANCE_MS = 60000; // ±1 min : "à l'heure", pas un faux positif au moindre écart

// AJOUT (Service Heartbeat — idée créative, brief produit) : pastille animée
// dans #rundownHeartbeatDot (voir dashboard.html), pilotée par le MÊME état
// que le texte de #rundownScheduleStatus ci-dessous — jamais un second calcul
// qui pourrait diverger. `key` correspond à une classe rundown-heartbeat-<key>
// (voir dashboard.css).
function setHeartbeatDot(key) {
  const dot = document.getElementById('rundownHeartbeatDot');
  if (dot) dot.className = `rundown-heartbeat-dot rundown-heartbeat-${key}`;
}

function renderScheduleStatus() {
  const el = document.getElementById('rundownScheduleStatus');
  if (!el) return;
  const status = computeScheduleStatus();
  switch (status.state) {
    case 'not-started':
      el.textContent = '';
      el.className = 'rundown-schedule-status';
      setHeartbeatDot('waiting');
      return;
    case 'first-segment':
      el.textContent = 'Culte démarré — retard/avance visible après le 2ᵉ repère.';
      el.className = 'rundown-schedule-status rundown-schedule-neutral';
      setHeartbeatDot('running');
      return;
    case 'incomplete-estimates':
      el.textContent =
        'Retard/avance non calculable — durée estimée manquante sur un repère déjà passé.';
      el.className = 'rundown-schedule-status rundown-schedule-neutral';
      setHeartbeatDot('running');
      return;
    case 'ok': {
      const { delayMs } = status;
      if (Math.abs(delayMs) < SCHEDULE_STATUS_TOLERANCE_MS) {
        el.textContent = 'Culte à l’heure.';
        el.className = 'rundown-schedule-status rundown-schedule-ontime';
        setHeartbeatDot('ontime');
      } else if (delayMs > 0) {
        el.textContent = `Culte ${formatDurationMinutes(delayMs)} en retard.`;
        el.className = 'rundown-schedule-status rundown-schedule-late';
        setHeartbeatDot('behind');
      } else {
        el.textContent = `Culte ${formatDurationMinutes(-delayMs)} en avance.`;
        el.className = 'rundown-schedule-status rundown-schedule-early';
        setHeartbeatDot('ahead');
      }
      return;
    }
  }
}

export function renderRundown(message) {
  rundownCues = Array.isArray(message.cues) ? message.cues : [];
  rundownActiveIndex = typeof message.activeIndex === 'number' ? message.activeIndex : -1;
  if (message.cueTimeline && typeof message.cueTimeline === 'object') {
    cueTimeline = message.cueTimeline;
  }

  const countEl = document.getElementById('rundownCount');
  if (countEl) countEl.textContent = rundownCues.length;
  const list = document.getElementById('rundownList');
  if (!list) return;

  renderScheduleStatus();

  if (rundownCues.length === 0) {
    list.innerHTML =
      '<div class="empty-state-note">Feuille de route vide. Ajoutez une référence ci-dessus, ou depuis la Médiathèque/le Studio de scènes.</div>';
    return;
  }

  list.innerHTML = rundownCues
    .map((cue, i) => {
      const isActive = i === rundownActiveIndex;
      const checking = READINESS_LABELS.checking;
      const durationMinutes =
        typeof cue.expectedDurationMs === 'number'
          ? Math.round(cue.expectedDurationMs / 60000)
          : '';

      // AJOUT (Timeline-Based Service Flow) : durée RÉELLE affichée seulement
      // pour un segment déjà terminé — a un horaire de départ ET un repère
      // suivant qui, lui aussi, a démarré (sinon "terminé" n'a pas de sens :
      // le dernier repère de la liste, une fois déclenché, ne "finit" jamais
      // au sens de cette mesure). Comparée à l'estimation pour l'écart
      // (+/-), seulement si une estimation existait.
      let actualBadge = '';
      const startedAt = cueTimeline[cue.id];
      const nextCue = rundownCues[i + 1];
      const nextStartedAt = nextCue ? cueTimeline[nextCue.id] : null;
      if (startedAt && nextStartedAt) {
        const actualMs = nextStartedAt - startedAt;
        let deltaText = '';
        if (typeof cue.expectedDurationMs === 'number') {
          const deltaMs = actualMs - cue.expectedDurationMs;
          const deltaMin = Math.round(deltaMs / 60000);
          if (deltaMin !== 0) deltaText = ` (${deltaMin > 0 ? '+' : ''}${deltaMin} min)`;
        }
        actualBadge = `<span class="queue-item-actual-duration" title="Durée réelle">${formatDurationMinutes(actualMs)}${deltaText}</span>`;
      }

      return `
                <div class="queue-item${isActive ? ' is-active-rundown-cue' : ''}">
                    <span class="queue-item-position">${i + 1}</span>
                    <span
                      class="cue-readiness-badge ${checking.className}"
                      id="cueReadiness-${cue.id}"
                      title="Vérification en cours…"
                      >${checking.icon}</span
                    >
                    ${cueStatusChipHtml(cue, i)}
                    <span class="queue-item-ref" title="${escapeHtmlDashboard(cue.label)}">${CUE_TYPE_ICON[cue.type] || ''} ${escapeHtmlDashboard(cue.label)}</span>
                    <input
                      type="number"
                      class="queue-item-duration-input"
                      min="0"
                      step="1"
                      placeholder="min"
                      title="Durée estimée (minutes) — vide = aucune estimation"
                      value="${durationMinutes}"
                      onchange="setCueDuration('${cue.id}', this.value)"
                    />
                    ${actualBadge}
                    <div class="queue-item-actions">
                        <button class="queue-icon-btn" onclick="moveRundownCue('${cue.id}', -1)" title="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button class="queue-icon-btn" onclick="moveRundownCue('${cue.id}', 1)" title="Descendre" ${i === rundownCues.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="queue-icon-btn" onclick="armRundownCue('${cue.id}')" title="Armer dans le sas de diffusion (aperçu avant direct)">⏏</button>
                        <button class="queue-icon-btn queue-send" onclick="triggerRundownCue('${cue.id}')" title="Déclencher maintenant, sans passer par le sas">▶</button>
                        <button class="queue-icon-btn queue-remove" onclick="removeRundownCue('${cue.id}')" title="Retirer">✕</button>
                    </div>
                </div>
            `;
    })
    .join('');

  refreshCueReadinessBadges(rundownCues);
}

// AJOUT (Next Cue Confidence) : les vérifications sont asynchrones (sondes
// réseau/police/rendu hors-écran, voir next-cue-confidence.js) — la liste
// s'affiche donc d'abord avec un badge "…", chaque badge est ensuite corrigé
// en place une fois son résultat connu. Une reconnexion/réordonnancement
// pendant que des vérifications sont en vol est sans risque : chaque callback
// ne touche que SON PROPRE élément `#cueReadiness-<id>` (getElementById
// renvoie null silencieusement si la liste a été redessinée entre-temps).
function refreshCueReadinessBadges(cues) {
  for (const cue of cues) {
    checkCueReadiness(cue)
      .then((result) => applyCueReadinessBadge(cue.id, result))
      .catch(() => {
        /* une vérification en échec ne doit jamais casser le reste de la liste */
      });
  }
}

function applyCueReadinessBadge(cueId, result) {
  const badge = document.getElementById(`cueReadiness-${cueId}`);
  if (!badge) return;
  const meta = READINESS_LABELS[result.status] || READINESS_LABELS.checking;
  badge.className = `cue-readiness-badge ${meta.className}`;
  badge.textContent = meta.icon;
  const problems = result.checks.filter((c) => !c.ok).map((c) => c.message);
  badge.title = problems.length ? `${meta.text} — ${problems.join(' · ')}` : meta.text;
}

window.addVerseToRundown = addVerseToRundown;
window.addVerseToRundownFromStudio = addVerseToRundownFromStudio;
window.addToRundown = addToRundown;
window.setCueDuration = setCueDuration;
window.removeRundownCue = removeRundownCue;
window.moveRundownCue = moveRundownCue;
window.triggerRundownCue = triggerRundownCue;
window.nextRundownCue = nextRundownCue;
window.clearRundown = clearRundown;
