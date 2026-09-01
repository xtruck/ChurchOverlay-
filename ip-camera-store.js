/**
 * ============================================================================
 * ip-camera-store.js — Caméras IP (téléphones utilisés comme caméras)
 * ----------------------------------------------------------------------------
 * AJOUT (demande explicite — plusieurs téléphones utilisés comme caméras
 * multi-angles pour la diffusion, chacun exposé via une app gratuite type
 * "IP Webcam" (Android) donnant une URL de flux MJPEG sur le réseau local,
 * ex. http://192.168.1.50:8080/video). Contrairement à camera-capture.js
 * (webcams/caméras virtuelles détectées via navigator.mediaDevices), il n'y
 * a ici AUCUN "périphérique" au sens du navigateur — juste une URL réseau
 * qu'un <img> peut afficher directement (MJPEG = multipart/x-mixed-replace,
 * nativement supporté par Chromium, aucune librairie ni décodage vidéo
 * ajouté). Ce module ne stocke donc que des paires {libellé, URL} — pas de
 * fichier à copier, contrairement à media-library.js.
 *
 * Même discipline que media-library.js/song-library.js : petit index JSON
 * local dans userData, aucun appel API externe, aucune dépendance.
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./persistence/atomic-json-store');
const crypto = require('crypto');

// Quelques téléphones utilisés en régie, pas un parc de caméras IP — large
// marge au-delà des "trois ou quatre" mentionnés, sans être sans limite.
const MAX_ITEMS = 8;

let indexPath = null;

/**
 * @param {string} dir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(dir) {
  indexPath = path.join(dir, 'ip-cameras.json');
}

function readIndex() {
  if (!indexPath || !fs.existsSync(indexPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[ip-camera-store] Lecture impossible, index ignoré:', e.message);
    return [];
  }
}

function writeIndex(items) {
  if (!indexPath) return;
  writeJsonAtomic(indexPath, items);
}

/**
 * @returns {Array<Object>}
 */
function listItems() {
  return readIndex();
}

// Volontairement permissif (http OU https, un hôte quelconque sur le réseau
// local — IP ou nom mDNS type "telephone.local") : on valide juste la FORME
// d'une URL, pas son accessibilité réelle (voir le contrôle en ligne/hors
// ligne côté dashboard.js, qui teste le chargement du flux directement).
const URL_PATTERN = /^https?:\/\/.+/i;

/**
 * Ajoute une caméra IP (téléphone).
 * @param {Object} data
 * @param {string} data.label - nom affiché (ex. "Téléphone scène")
 * @param {string} data.url - URL du flux MJPEG (ex. http://192.168.1.50:8080/video)
 * @param {(evicted: Object) => void} [onEvict] - CORRECTIF (fuite de ressources) :
 *   dépasser MAX_ITEMS tronquait silencieusement la liste — pour une caméra IP
 *   tierce, sans conséquence (juste une entrée en moins) ; pour un téléphone
 *   jumelé par QR (voir server.js, POST /phone-camera-pair), l'appareil
 *   continuait d'envoyer des images pour une entrée devenue fantôme, et son
 *   état de jumelage (phone-camera-pairing.js) n'était jamais nettoyé. Ce
 *   callback optionnel (rétrocompatible — les appels existants sans lui
 *   continuent de fonctionner à l'identique) laisse l'appelant réagir à
 *   CHAQUE élément évincé, quelle qu'en soit la nature.
 * @returns {Object} l'élément ajouté
 */
function addItem(data, onEvict) {
  if (!indexPath) throw new Error('ip-camera-store: setUserDataDir() non appelé');
  const url = typeof data?.url === 'string' ? data.url.trim() : '';
  if (!URL_PATTERN.test(url)) {
    throw new Error('URL invalide — doit commencer par http:// ou https://');
  }

  const label = (data?.label || '').trim().slice(0, 100) || 'Téléphone';
  const item = {
    id: crypto.randomUUID(),
    label,
    url: url.slice(0, 500),
    addedAt: new Date().toISOString(),
  };

  const items = readIndex();
  items.unshift(item);
  if (items.length > MAX_ITEMS) {
    const evicted = items.slice(MAX_ITEMS);
    items.length = MAX_ITEMS;
    if (typeof onEvict === 'function') {
      for (const evictedItem of evicted) onEvict(evictedItem);
    }
  }
  writeIndex(items);
  return item;
}

/**
 * @param {string} id
 * @returns {boolean} true si un élément a bien été supprimé
 */
function deleteItem(id) {
  const items = readIndex();
  const idx = items.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  items.splice(idx, 1);
  writeIndex(items);
  return true;
}

module.exports = {
  setUserDataDir,
  listItems,
  addItem,
  deleteItem,
  // Exposé pour tests unitaires (test-ip-camera-store.js).
  MAX_ITEMS,
};
