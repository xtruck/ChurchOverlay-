'use strict';

/**
 * voice-command-ws-handlers.js — Handlers WS de la sécurisation des
 * commandes vocales (Axe 3, Option A).
 *
 * Trois réglages/actions distincts, chacun sa propre action WS (même
 * granularité que setHighContrast/setCaptionsEnabled dans
 * accessibility-ws-handlers.js, un réglage = une action) :
 *   - setVoiceCommandWakeWord : active/désactive la phrase d'activation
 *     (wake word) requise avant toute commande vocale, et permet de
 *     personnaliser la liste de phrases acceptées.
 *   - setVoiceCommandSupervision : active/désactive le mode "Supervised
 *     Autonomy" — une commande détectée est alors proposée à l'opérateur
 *     plutôt qu'exécutée directement (voir server.js#queuePendingVoiceAction).
 *   - approveVoiceAction : valide l'action vocale actuellement en attente
 *     (voir sessionState.getPendingVoiceAction()) et l'exécute réellement.
 *
 * Convention de handler : `async (ws, sanitized, requestId, sendError) => {}`
 * — voir media-ws-handlers.js pour le détail de la convention et le
 * mécanisme CATEGORY_HANDLERS dans server.js.
 *
 * @param {object} ctx
 * @param {object} ctx.sessionState
 * @param {(command: object, originalText: string) => Promise<void>} ctx.handleVoiceCommand
 *   - exécute réellement une commande vocale (diffusion WS, mutation
 *   d'état...) — reste défini dans server.js, mêmes dépendances propres
 *   que le reste du dispatch de commandes vocales.
 * @param {() => void} ctx.cancelPendingVoiceActionTimer - annule le
 *   minuteur d'expiration (5s) en vol côté server.js, pour qu'une action
 *   approuvée ne soit jamais ensuite signalée comme expirée.
 * @param {(obj: object, opts?: object) => void} ctx.broadcast
 * @param {(msg: string) => void} ctx.log
 * @returns {Map<string, (ws: object, sanitized: object, requestId: string|null, sendError: (error: string) => void) => Promise<void>>}
 */
function createHandlers(ctx) {
  const { sessionState, handleVoiceCommand, cancelPendingVoiceActionTimer, broadcast, log } = ctx;

  const handlers = new Map();

  handlers.set('setVoiceCommandWakeWord', async (ws, sanitized) => {
    sessionState.setVoiceCommandWakeWordEnabled(!!sanitized.enabled);
    // AJOUT : la liste de phrases n'est mise à jour QUE si explicitement
    // fournie — un simple bascule ON/OFF depuis le dashboard (sans toucher
    // la liste) ne doit jamais réinitialiser un choix de phrases déjà fait
    // par l'opérateur. setVoiceCommandWakeWords() retombe déjà sur
    // DEFAULT_VOICE_COMMAND_WAKE_WORDS pour une liste vide/invalide (voir
    // session-state.js), donc envoyer explicitement [] reste un choix
    // possible et sûr (jamais de désactivation silencieuse totale).
    if (Array.isArray(sanitized.words)) {
      sessionState.setVoiceCommandWakeWords(sanitized.words);
    }
    broadcast(
      {
        action: 'voiceCommandWakeWordChanged',
        enabled: sessionState.getVoiceCommandWakeWordEnabled(),
        words: sessionState.getVoiceCommandWakeWords(),
      },
      { operatorOnly: true }
    );
    log(
      `Phrase d'activation des commandes vocales : ${sessionState.getVoiceCommandWakeWordEnabled() ? 'activée' : 'désactivée'}`
    );
  });

  handlers.set('setVoiceCommandSupervision', async (ws, sanitized) => {
    sessionState.setVoiceCommandSupervisionEnabled(!!sanitized.enabled);
    broadcast(
      {
        action: 'voiceCommandSupervisionChanged',
        enabled: sessionState.getVoiceCommandSupervisionEnabled(),
      },
      { operatorOnly: true }
    );
    log(
      `Validation opérateur des commandes vocales ("Supervised Autonomy") : ${sessionState.getVoiceCommandSupervisionEnabled() ? 'activée' : 'désactivée'}`
    );
  });

  handlers.set('approveVoiceAction', async (ws, sanitized, requestId, sendError) => {
    const pending = sessionState.getPendingVoiceAction();
    if (!pending || pending.id !== sanitized.id) {
      // AJOUT : cas normal, pas une erreur applicative — l'opérateur a pu
      // cliquer juste après l'expiration (course bénigne, voir
      // PENDING_VOICE_ACTION_TIMEOUT_MS dans server.js), ou une commande
      // plus récente a déjà remplacé celle-ci. sendError() reste utilisé
      // (déjà supporté par la convention, voir showVerse) pour que
      // l'opérateur voie POURQUOI son clic n'a rien fait, plutôt qu'un
      // silence qui ressemblerait à un bug.
      sendError('Commande vocale en attente introuvable ou déjà expirée.');
      return;
    }
    cancelPendingVoiceActionTimer();
    sessionState.clearPendingVoiceAction();
    broadcast({ action: 'pendingVoiceActionApproved', id: pending.id }, { operatorOnly: true });
    log(`Commande vocale approuvée par l'opérateur : ${pending.command.action} (id ${pending.id})`);
    await handleVoiceCommand(pending.command, pending.originalText);
  });

  return handlers;
}

module.exports = { createHandlers };
