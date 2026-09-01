/**
 * ============================================================================
 *  task-queue.js — File de tâches bornée, hors du chemin chaud WS
 * ----------------------------------------------------------------------------
 *  AJOUT (modularisation backend — perf) : import PPTX, exports de service,
 *  génération de clips et autres opérations coûteuses en I/O/CPU tournaient
 *  jusqu'ici directement dans le handler `ws.on('message', ...)` — le
 *  pipeline audio/transcription (voir latency-tracker.js, cible sub-3s) et
 *  toute autre action WS restaient bloqués pendant leur exécution. Ce module
 *  est délibérément indépendant de tout serveur HTTP/WebSocket : il ne
 *  connaît que des fonctions asynchrones à exécuter, en file, une par une
 *  par défaut.
 *
 *  Concurrence 1 par défaut (pas un pool de workers) : ces tâches sont déjà
 *  peu fréquentes (import PowerPoint, export de culte...) et souvent
 *  elles-mêmes I/O-bound plutôt que CPU-bound sur le thread JS — le but est
 *  de les sortir du chemin WS synchrone, pas de les paralléliser entre
 *  elles. `concurrency` reste configurable si un futur appelant en a
 *  vraiment besoin.
 * ============================================================================
 */
'use strict';

/**
 * @param {Object} [options]
 * @param {number} [options.concurrency=1] - tâches exécutées en parallèle
 * @param {number} [options.maxPending=50] - taille max de la file d'attente
 *   (tâches ni actives ni terminées) ; enqueue() rejette au-delà
 * @returns {{enqueue: Function, getStats: Function, drain: Function, shutdown: Function}}
 */
function createTaskQueue(options = {}) {
  const concurrency = options.concurrency || 1;
  const maxPending = options.maxPending || 50;

  const pending = []; // { run, resolve, reject }
  let activeCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let shuttingDown = false;
  let drainWaiters = [];

  function maybeNotifyDrained() {
    if (activeCount === 0 && pending.length === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function runNext() {
    if (activeCount >= concurrency) return;
    const job = pending.shift();
    if (!job) {
      maybeNotifyDrained();
      return;
    }

    activeCount++;
    // AJOUT : Promise.resolve().then(...) plutôt qu'un await direct — une
    // tâche qui lève de façon SYNCHRONE (avant son premier await) doit être
    // rattrapée exactement comme une rejection asynchrone, jamais remonter
    // en exception non gérée sur la pile de runNext() elle-même.
    Promise.resolve()
      .then(job.run)
      .then(
        (result) => {
          completedCount++;
          job.resolve(result);
        },
        (err) => {
          failedCount++;
          job.reject(err);
        }
      )
      .finally(() => {
        activeCount--;
        runNext();
      });
  }

  /**
   * Ajoute une tâche à la file. `run` est appelée avec zéro argument quand
   * son tour vient (FIFO) ; sa valeur de retour (ou son erreur) résout (ou
   * rejette) la promesse rendue ici. Une tâche qui échoue n'arrête jamais la
   * file — les tâches suivantes s'exécutent normalement.
   *
   * @param {() => (Promise<*>|*)} run
   * @returns {Promise<*>}
   */
  function enqueue(run) {
    if (shuttingDown) {
      return Promise.reject(
        new Error('task-queue: file fermée (shutdown en cours), tâche refusée')
      );
    }
    if (pending.length >= maxPending) {
      return Promise.reject(
        new Error(`task-queue: file pleine (${pending.length}/${maxPending}), tâche refusée`)
      );
    }
    return new Promise((resolve, reject) => {
      pending.push({ run, resolve, reject });
      runNext();
    });
  }

  function getStats() {
    return {
      active: activeCount,
      pending: pending.length,
      completed: completedCount,
      failed: failedCount,
    };
  }

  /**
   * Résout une fois que toutes les tâches actives ET en attente au moment de
   * l'appel se sont terminées (succès ou échec) — n'empêche pas de nouvelles
   * tâches d'être ajoutées après (contrairement à shutdown()).
   * @returns {Promise<void>}
   */
  function drain() {
    if (activeCount === 0 && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      drainWaiters.push(resolve);
    });
  }

  /**
   * Refuse toute nouvelle tâche (enqueue() rejette immédiatement) puis
   * attend que les tâches déjà actives/en attente se terminent — utilisé à
   * l'arrêt du worker server.js pour ne pas couper un import/export en
   * plein milieu.
   * @returns {Promise<void>}
   */
  function shutdown() {
    shuttingDown = true;
    return drain();
  }

  return { enqueue, getStats, drain, shutdown };
}

module.exports = { createTaskQueue };
