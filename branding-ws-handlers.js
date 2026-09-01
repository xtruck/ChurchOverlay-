'use strict';

/**
 * branding-ws-handlers.js — Handlers WS de l'habillage caméra et de
 * l'identité de marque du tableau de bord (Phase 2 — modularisation du
 * dispatch WS de server.js, même chantier que media-ws-handlers.js/
 * scene-ws-handlers.js/song-ws-handlers.js/rundown-ws-handlers.js/
 * camera-ws-handlers.js).
 *
 * Deux domaines distincts regroupés dans un seul module (dépendances très
 * proches, même forme de handler) — voir dashboard-branding-store.js pour
 * la distinction entre les deux :
 *  - Habillage caméra (branding-store.js) : logo/position/taille/titre-
 *    sous-titre/visibilité affichés par branding-overlay.html, posé
 *    au-dessus du flux caméra dans OBS.
 *  - Identité de marque du tableau de bord (dashboard-branding-store.js) :
 *    nom d'organisation/couleur d'accent/logo dans la barre latérale du
 *    tableau de bord lui-même — revente en produit "clé en main".
 *
 * Extrait tel quel (comportement identique, seulement déplacé) :
 * getBranding/setBrandingLogo/clearBrandingLogo/setBrandingPosition/
 * setBrandingSize/setBrandingText/setBrandingVisible/getDashboardBranding/
 * setDashboardOrgName/setDashboardAccentColor/setDashboardLogo/
 * clearDashboardLogo.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.brandingStore
 * @param {object} ctx.dashboardBrandingStore
 * @param {object} ctx.sessionState
 * @param {(obj: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @param {() => object} ctx.getBrandingState - assemble logo/position
 *   (persistés) + titre/sous-titre/visible (session en cours) ; reste
 *   défini dans server.js
 * @param {() => object} ctx.getDashboardBrandingState
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const {
    brandingStore,
    dashboardBrandingStore,
    sessionState,
    broadcast,
    log,
    getBrandingState,
    getDashboardBrandingState,
  } = ctx;

  const handlers = new Map();

  // --- Habillage caméra (logo + titre/sous-titre, voir branding-store.js et
  // branding-overlay.html) : broadcast() à chaque changement — TOUS les
  // clients doivent voir la mise à jour, notamment branding-overlay.html
  // lui-même, posé au-dessus de la caméra dans OBS. ---
  handlers.set('getBranding', async (ws) => {
    ws.send(JSON.stringify({ action: 'brandingUpdate', branding: getBrandingState() }));
  });

  handlers.set('setBrandingLogo', async (ws, sanitized) => {
    try {
      brandingStore.setLogo(sanitized.sourcePath);
      log('Habillage caméra : logo mis à jour');
      broadcast({ action: 'brandingUpdate', branding: getBrandingState() });
    } catch (err) {
      ws.send(JSON.stringify({ action: 'error', error: 'Habillage caméra : ' + err.message }));
    }
  });

  handlers.set('clearBrandingLogo', async () => {
    brandingStore.clearLogo();
    log('Habillage caméra : logo retiré');
    broadcast({ action: 'brandingUpdate', branding: getBrandingState() });
  });

  handlers.set('setBrandingPosition', async (ws, sanitized) => {
    brandingStore.setPosition(sanitized.position);
    broadcast({ action: 'brandingUpdate', branding: getBrandingState() });
  });

  handlers.set('setBrandingSize', async (ws, sanitized) => {
    brandingStore.setSize(sanitized.size);
    broadcast({ action: 'brandingUpdate', branding: getBrandingState() });
  });

  handlers.set('setBrandingText', async (ws, sanitized) => {
    sessionState.setBrandingText(sanitized.title, sanitized.subtitle);
    broadcast({ action: 'brandingUpdate', branding: getBrandingState() });
  });

  handlers.set('setBrandingVisible', async (ws, sanitized) => {
    sessionState.setBrandingVisible(!!sanitized.visible);
    log('Habillage caméra : ' + (sanitized.visible ? 'affiché' : 'masqué'));
    broadcast({ action: 'brandingUpdate', branding: getBrandingState() });
  });

  // --- Identité de marque du tableau de bord (nom d'organisation/couleur
  // d'accent/logo dans la barre latérale — voir dashboard-branding-store.js
  // pour la distinction avec l'habillage caméra ci-dessus). Même convention
  // broadcast() : un second tableau de bord ouvert doit voir la même marque
  // que le premier. ---
  handlers.set('getDashboardBranding', async (ws) => {
    ws.send(
      JSON.stringify({ action: 'dashboardBrandingUpdate', branding: getDashboardBrandingState() })
    );
  });

  handlers.set('setDashboardOrgName', async (ws, sanitized) => {
    dashboardBrandingStore.setOrganizationName(sanitized.organizationName);
    log('Identité tableau de bord : nom d’organisation mis à jour');
    broadcast({ action: 'dashboardBrandingUpdate', branding: getDashboardBrandingState() });
  });

  handlers.set('setDashboardAccentColor', async (ws, sanitized) => {
    try {
      dashboardBrandingStore.setAccentColor(sanitized.accentColor);
      log('Identité tableau de bord : couleur d’accent mise à jour');
      broadcast({ action: 'dashboardBrandingUpdate', branding: getDashboardBrandingState() });
    } catch (err) {
      ws.send(
        JSON.stringify({ action: 'error', error: 'Identité tableau de bord : ' + err.message })
      );
    }
  });

  handlers.set('setDashboardLogo', async (ws, sanitized) => {
    try {
      dashboardBrandingStore.setLogo(sanitized.sourcePath);
      log('Identité tableau de bord : logo mis à jour');
      broadcast({ action: 'dashboardBrandingUpdate', branding: getDashboardBrandingState() });
    } catch (err) {
      ws.send(
        JSON.stringify({ action: 'error', error: 'Identité tableau de bord : ' + err.message })
      );
    }
  });

  handlers.set('clearDashboardLogo', async () => {
    dashboardBrandingStore.clearLogo();
    log('Identité tableau de bord : logo retiré');
    broadcast({ action: 'dashboardBrandingUpdate', branding: getDashboardBrandingState() });
  });

  return handlers;
}

module.exports = { createHandlers };
