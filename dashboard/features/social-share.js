/**
 * dashboard/features/social-share.js — "Smart Bible Overlay Builder" (brief
 * produit, priorité #8), volet "version réseaux sociaux".
 *
 * Audit avant construction (voir le commit) : la plupart de ce que demande
 * le brief produit pour ce point existait déjà ailleurs dans l'app —
 * texte/référence du verset (la fonctionnalité centrale de l'app),
 * traductions multiples (secondaryTranslationSelect/bilingue FR+EN),
 * version "plein écran" (l'affichage overlay par défaut), fond assorti au
 * thème/à l'ambiance en cours (moods + config/themes/*.json). La seule
 * pièce sans AUCUNE infrastructure existante était une version exportable
 * pour les réseaux sociaux — ce module ne construit donc QUE ça.
 *
 * Portée V1 volontairement limitée à UN format carré (1080×1080 — le plus
 * polyvalent : Instagram/Facebook/X l'acceptent tous sans recadrage
 * imposé). Pas de format "story" vertical séparé, pas d'habillage de marque
 * (logo/organisation) : dupliquer toute la logique de mise en page pour un
 * second format, ou intégrer dashboard-branding-store.js ici, sont des
 * chantiers à part entière plutôt que des détails de ce module — l'église
 * reste libre d'ajouter son propre habillage après coup dans un outil
 * dédié, cette image est un point de départ propre, pas un produit fini.
 *
 * Rendu 100% côté client (Canvas 2D) — le verset actuellement affiché
 * (state.currentVerse) est déjà en mémoire, aucun aller-retour serveur
 * n'est nécessaire pour cette fonctionnalité.
 */
import { state } from '../state.js';
import { showToast } from '../utils.js';

const CANVAS_SIZE = 1080;
// AJOUT : mêmes couleurs de marque que overlay.html ("verrière nocturne" —
// voir --overlay-bg/--overlay-accent dans son commentaire d'en-tête) plutôt
// qu'une palette inventée pour cette seule image — la cohérence visuelle
// entre ce qui est projeté et ce qui est partagé fait partie de la valeur.
const BG_GRADIENT_STOPS = ['#0b0c10', '#101218', '#14151c'];
const ACCENT_COLOR = '#ff8a3d';
const TEXT_COLOR = '#e8eaf0';

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// AJOUT : réduit la taille de police jusqu'à ce que le texte tienne dans la
// hauteur disponible (un verset long à taille fixe déborderait du cadre) —
// s'arrête à une taille plancher plutôt que de rapetisser indéfiniment un
// verset extrêmement long jusqu'à l'illisible.
function fitTextSize(ctx, text, maxWidth, maxHeight, startSize, minSize, lineHeightRatio) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `500 ${size}px 'Merriweather', Georgia, serif`;
    const lines = wrapText(ctx, text, maxWidth);
    const totalHeight = lines.length * size * lineHeightRatio;
    if (totalHeight <= maxHeight) return { size, lines };
    size -= 4;
  }
  ctx.font = `500 ${minSize}px 'Merriweather', Georgia, serif`;
  return { size: minSize, lines: wrapText(ctx, text, maxWidth) };
}

function renderVerseCanvas(reference, text) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d');

  // Fond — dégradé diagonal, même identité visuelle que l'overlay.
  const gradient = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  gradient.addColorStop(0, BG_GRADIENT_STOPS[0]);
  gradient.addColorStop(0.55, BG_GRADIENT_STOPS[1]);
  gradient.addColorStop(1, BG_GRADIENT_STOPS[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Fin trait doré horizontal, écho du ::before de .verse-card sur l'overlay.
  const lineGradient = ctx.createLinearGradient(CANVAS_SIZE * 0.2, 0, CANVAS_SIZE * 0.8, 0);
  lineGradient.addColorStop(0, 'transparent');
  lineGradient.addColorStop(0.5, ACCENT_COLOR);
  lineGradient.addColorStop(1, 'transparent');
  ctx.fillStyle = lineGradient;
  ctx.fillRect(CANVAS_SIZE * 0.2, 90, CANVAS_SIZE * 0.6, 3);

  const marginX = 110;
  const maxWidth = CANVAS_SIZE - marginX * 2;

  // Référence — petite, majuscule, couleur accent, centrée.
  ctx.font = "700 34px 'IBM Plex Sans', 'Segoe UI', sans-serif";
  ctx.fillStyle = ACCENT_COLOR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(reference.toUpperCase(), CANVAS_SIZE / 2, 190);

  // Corps du verset — centré verticalement dans l'espace restant, taille
  // auto-ajustée pour tenir sans déborder.
  const availableTop = 260;
  const availableBottom = CANVAS_SIZE - 140;
  const { size, lines } = fitTextSize(
    ctx,
    text,
    maxWidth,
    availableBottom - availableTop,
    64,
    28,
    1.35
  );
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `500 ${size}px 'Merriweather', Georgia, serif`;
  const lineHeight = size * 1.35;
  const totalHeight = lines.length * lineHeight;
  let y = availableTop + (availableBottom - availableTop - totalHeight) / 2 + size;
  for (const line of lines) {
    ctx.fillText(line, CANVAS_SIZE / 2, y);
    y += lineHeight;
  }

  return canvas;
}

// AJOUT : retire les diacritiques après décomposition NFD par comparaison de
// point de code numérique (0x0300-0x036f = plage Unicode des diacritiques
// combinants) plutôt qu'une regex ̀-ͯ — un éditeur/terminal peut
// afficher/manipuler cette plage-là comme des caractères combinants réels
// au lieu du texte d'échappement littéral, ce qui casse silencieusement le
// motif ; la comparaison numérique n'a pas ce risque.
function stripDiacritics(str) {
  return Array.from(str)
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('');
}

function sanitizeFilename(reference) {
  return (
    stripDiacritics(reference.normalize('NFD'))
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'verset'
  );
}

export function exportVerseAsImage() {
  const verse = state.currentVerse;
  if (!verse || !verse.reference || !verse.text) {
    showToast('Aucun verset affiché à partager pour le moment.', 'error');
    return;
  }

  const canvas = renderVerseCanvas(verse.reference, verse.text);
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast("Échec de la génération de l'image.", 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizeFilename(verse.reference)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // AJOUT : révoqué après un court délai plutôt qu'immédiatement — certains
    // navigateurs/Electron traitent le clic de téléchargement de façon
    // asynchrone, révoquer trop tôt casserait le téléchargement lui-même.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('Image du verset téléchargée.', 'success');
  }, 'image/png');
}

window.exportVerseAsImage = exportVerseAsImage;
