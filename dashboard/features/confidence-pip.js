/**
 * dashboard/features/confidence-pip.js — jauge de confiance vocale +
 * mini-historique en sparkline (chantier innovation v1.0, Pilier 1 :
 * "conteneur d'aperçu PIP réactif... mini-courbe sparkline affichant
 * l'historique de confiance vocale").
 *
 * Le marquage HTML (#confidenceMeterFill/#confidenceMeterLabel/
 * #confidenceSparkline) existait déjà dans dashboard.html sans aucune
 * source de données branchée — ce module consomme les scores de confiance
 * DÉJÀ diffusés par server.js (transcript/transcriptPartial) plutôt que
 * d'en calculer un nouveau : aucun coût API/CPU supplémentaire.
 *
 * Le statut connecté/déconnecté du mini-indicateur (#pipelineMiniDot/
 * #pipelineMiniText) est couvert séparément — voir la classe "status" sur
 * .mini-pipeline-row dans dashboard.html, déjà ciblée par
 * verse-session-display.js#updateStatus().
 */

const MAX_SPARKLINE_POINTS = 30;
let confidenceHistory = [];

/**
 * @param {number} confidence - dans [0, 1]
 * @returns {'good'|'warn'|'bad'} même palette que dashboard/dashboard.css
 *   (.band-good/.band-warn/.band-bad) — mêmes seuils que le mode
 *   d'autonomie (session-state.js#CONFIDENCE_AUTO_THRESHOLD/
 *   CONFIDENCE_SUPERVISED_THRESHOLD), pour rester cohérent avec ce que
 *   l'opérateur voit déjà ailleurs sur le tableau de bord.
 */
function bandFor(confidence) {
  if (confidence >= 0.9) return 'good';
  if (confidence >= 0.7) return 'warn';
  return 'bad';
}

function setBandClass(el, band) {
  if (!el) return;
  el.classList.remove('band-good', 'band-warn', 'band-bad');
  el.classList.add(`band-${band}`);
}

/**
 * Enregistre un nouvel échantillon de confiance et redessine la jauge/le
 * sparkline. Silencieux (aucun rendu) pour une confiance absente/invalide —
 * un fournisseur qui n'en calcule pas ne doit jamais afficher un faux 0%.
 * @param {number} confidence
 */
export function recordConfidenceSample(confidence) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return;
  const clamped = Math.max(0, Math.min(1, confidence));
  confidenceHistory.push(clamped);
  if (confidenceHistory.length > MAX_SPARKLINE_POINTS) confidenceHistory.shift();
  renderConfidenceMeter();
}

function renderConfidenceMeter() {
  if (confidenceHistory.length === 0) return;
  const latest = confidenceHistory[confidenceHistory.length - 1];
  const pct = Math.round(latest * 100);
  const band = bandFor(latest);

  const fill = document.getElementById('confidenceMeterFill');
  if (fill) {
    fill.style.width = pct + '%';
    setBandClass(fill, band);
  }
  const label = document.getElementById('confidenceMeterLabel');
  if (label) {
    label.textContent = pct + '%';
    setBandClass(label, band);
  }
  renderSparkline(band);
}

// AJOUT (namespace SVG — un polyline créé via innerHTML/document.createElement
// classique reste du HTML, jamais un vrai élément SVG rendu par le
// navigateur) : createElementNS() est requis ici, contrairement au reste du
// tableau de bord qui ne manipule que du HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';

function renderSparkline(latestBand) {
  const svg = document.getElementById('confidenceSparkline');
  if (!svg) return;
  const viewBox = (svg.getAttribute('viewBox') || '0 0 200 40').split(' ').map(Number);
  const w = viewBox[2] || 200;
  const h = viewBox[3] || 40;
  const n = confidenceHistory.length;

  const points = confidenceHistory
    .map((c, i) => {
      const x = n <= 1 ? w : (i / (n - 1)) * w;
      const y = h - c * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // Un seul <polyline>, recréé/mis à jour à chaque échantillon (jamais
  // innerHTML : voir la garde SVG_NS ci-dessus).
  let line = svg.querySelector('.sparkline-line');
  if (!line) {
    line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('class', 'sparkline-line');
    svg.appendChild(line);
  }
  line.setAttribute('points', points);
  line.setAttribute('class', `sparkline-line band-${latestBand}`);
}

export function clearConfidenceHistory() {
  confidenceHistory = [];
  const svg = document.getElementById('confidenceSparkline');
  const line = svg && svg.querySelector('.sparkline-line');
  if (line) line.remove();
  const fill = document.getElementById('confidenceMeterFill');
  if (fill) fill.style.width = '0%';
  const label = document.getElementById('confidenceMeterLabel');
  if (label) label.textContent = '—';
}
