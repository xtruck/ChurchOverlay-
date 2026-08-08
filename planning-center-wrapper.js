'use strict';
/**
 * planning-center-wrapper.js — Ordre du culte depuis Planning Center Services
 *
 * ENTIÈREMENT OPTIONNEL, même principe que obs-controller.js/
 * propresenter-controller.js : features.broadcast.planningCenter.enabled
 * reste à false tant que l'opérateur ne configure pas ses identifiants ici.
 *
 * Lecture seule pour cette version : récupère et affiche l'ordre du culte
 * (titres/horodatage des éléments d'un plan) comme pense-bête pour
 * l'opérateur — PAS de mise en correspondance automatique avec la
 * médiathèque/bibliothèque de chants/file de versets. Les éléments d'un
 * plan Planning Center sont de nature trop variée (chant, en-tête, média,
 * texte libre...) pour être mappés à l'aveugle sur une action précise sans
 * risquer de déclencher la mauvaise chose en plein culte — resterait une
 * fonctionnalité à part entière, hors du cadre de ce lot.
 *
 * -----------------------------------------------------------------------
 * API (recherchée avant implémentation, pas devinée) — api.planningcenteronline.com/docs :
 *   Authentification : HTTP Basic avec app_id:secret (jeton d'accès
 *   personnel — pas de flux OAuth avec serveur de redirection nécessaire).
 *   Base : https://api.planningcenteronline.com/services/v2
 *   - GET /service_types
 *   - GET /service_types/{id}/plans
 *   - GET /service_types/{id}/plans/{plan_id}/items
 *   Format JSON:API standard : { data: [{ id, type, attributes: {...} }] }
 */

const BASE_URL = 'https://api.planningcenteronline.com/services/v2';
const MAX_SERVICE_TYPES_SCANNED = 5; // borne le nombre d'appels API pour "trouver le bon plan"

function getSafeStorage() {
  return require('electron').safeStorage;
}
const featuresStore = require('./features-store');

function resolveSecret(cfg) {
  if (cfg.secretEncrypted) {
    const safeStorage = getSafeStorage();
    if (!safeStorage.isEncryptionAvailable()) {
      console.error(
        '[planning-center] Chiffrement système indisponible : impossible de lire le secret.'
      );
      return '';
    }
    try {
      return safeStorage.decryptString(Buffer.from(cfg.secretEncrypted, 'base64'));
    } catch (e) {
      console.error('[planning-center] Échec du déchiffrement du secret:', e.message);
      return '';
    }
  }
  return cfg.secret || '';
}

async function apiGet(path, appId, secret) {
  const auth = Buffer.from(`${appId}:${secret}`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Planning Center a répondu ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Récupère l'ordre du culte le plus pertinent (le plan le plus proche
 * d'aujourd'hui, parmi les premiers types de service du compte) et renvoie
 * ses éléments. Best-effort : un type de service dont la lecture échoue est
 * simplement ignoré plutôt que de faire échouer tout l'appel.
 * @returns {Promise<{ok: boolean, planTitle?: string, planDate?: string, items?: Array, error?: string}>}
 */
async function getUpcomingPlanItems() {
  const cfg = (featuresStore.readFeatures().broadcast || {}).planningCenter || {};
  if (!cfg.enabled) return { ok: false, error: 'Planning Center désactivé dans la configuration' };
  if (!cfg.appId) return { ok: false, error: 'Application ID manquant' };
  const secret = resolveSecret(cfg);
  if (!secret) return { ok: false, error: 'Secret manquant' };

  let serviceTypes;
  try {
    const res = await apiGet('/service_types', cfg.appId, secret);
    serviceTypes = (res.data || []).slice(0, MAX_SERVICE_TYPES_SCANNED);
  } catch (e) {
    return { ok: false, error: 'Identifiants invalides ou API inaccessible : ' + e.message };
  }
  if (serviceTypes.length === 0) {
    return { ok: false, error: 'Aucun type de service trouvé sur ce compte Planning Center' };
  }

  // Rassemble les plans de chaque type de service scanné, en tolérant les
  // échecs individuels (permissions différentes selon le type de service).
  const candidatePlans = [];
  for (const st of serviceTypes) {
    try {
      const res = await apiGet(`/service_types/${st.id}/plans`, cfg.appId, secret);
      for (const plan of res.data || []) {
        const dateStr = plan.attributes && (plan.attributes.sort_date || plan.attributes.dates);
        candidatePlans.push({
          serviceTypeId: st.id,
          plan,
          date: dateStr ? new Date(dateStr) : null,
        });
      }
    } catch (_e) {
      // Type de service illisible (permissions...) : ignoré, on continue les autres.
    }
  }
  if (candidatePlans.length === 0) {
    return { ok: false, error: 'Aucun culte planifié trouvé (vérifiez les permissions du jeton)' };
  }

  // Le plan dont la date est la plus proche d'aujourd'hui (avant ou après) —
  // heuristique simple pour "le culte qui m'intéresse probablement là,
  // maintenant", sans dépendre d'un paramètre de filtre/tri d'API précis.
  const now = Date.now();
  candidatePlans.sort((a, b) => {
    const da = a.date ? Math.abs(a.date.getTime() - now) : Infinity;
    const db = b.date ? Math.abs(b.date.getTime() - now) : Infinity;
    return da - db;
  });
  const best = candidatePlans[0];

  let itemsRes;
  try {
    itemsRes = await apiGet(
      `/service_types/${best.serviceTypeId}/plans/${best.plan.id}/items`,
      cfg.appId,
      secret
    );
  } catch (e) {
    return { ok: false, error: 'Lecture des éléments du plan impossible : ' + e.message };
  }

  const items = (itemsRes.data || []).map((item) => ({
    id: item.id,
    title: (item.attributes && item.attributes.title) || '(sans titre)',
    itemType: (item.attributes && item.attributes.item_type) || 'item',
    sequence: item.attributes ? item.attributes.sequence : null,
  }));

  return {
    ok: true,
    planTitle: (best.plan.attributes && best.plan.attributes.title) || best.plan.id,
    planDate: best.date ? best.date.toISOString() : null,
    items,
  };
}

module.exports = { getUpcomingPlanItems };
