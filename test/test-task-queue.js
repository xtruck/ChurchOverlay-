/**
 * ============================================================================
 *  test-task-queue.js — Tests pour task-queue.js
 * ----------------------------------------------------------------------------
 *  Couvre l'ordre FIFO, la capacité bornée, la récupération après échec
 *  d'une tâche, les statistiques, et drain()/shutdown().
 * ============================================================================
 */

'use strict';
const assert = require('assert');
const { createTaskQueue } = require('../task-queue');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Test task-queue.js ===\n');

  // Test 1: ordre FIFO avec concurrency=1
  console.log('[TEST] Test 1: ordre FIFO...');
  {
    const queue = createTaskQueue({ concurrency: 1 });
    const order = [];
    const results = await Promise.all([
      queue.enqueue(async () => {
        await sleep(20);
        order.push(1);
        return 'a';
      }),
      queue.enqueue(async () => {
        order.push(2);
        return 'b';
      }),
      queue.enqueue(async () => {
        order.push(3);
        return 'c';
      }),
    ]);
    assert.deepStrictEqual(order, [1, 2, 3], "les tâches doivent s'exécuter dans l'ordre FIFO");
    assert.deepStrictEqual(
      results,
      ['a', 'b', 'c'],
      'chaque enqueue() doit résoudre avec sa propre valeur'
    );
  }
  console.log('[TEST] ✓ ordre FIFO respecté');

  // Test 2: capacité bornée — enqueue() rejette au-delà de maxPending
  console.log('[TEST] Test 2: capacité bornée...');
  {
    const queue = createTaskQueue({ concurrency: 1, maxPending: 2 });
    // La première tâche démarre immédiatement (activeCount=1), donc ne
    // compte pas dans "pending" — on en ajoute 2 de plus pour remplir la
    // file, puis une 4e qui doit être refusée.
    const blocker = queue.enqueue(() => sleep(50));
    queue.enqueue(() => sleep(10)).catch(() => {});
    queue.enqueue(() => sleep(10)).catch(() => {});
    await assert.rejects(
      queue.enqueue(() => sleep(10)),
      /file pleine/,
      'une 4e tâche doit être rejetée avec une erreur claire quand la file est pleine'
    );
    await blocker;
    await queue.drain();
  }
  console.log('[TEST] ✓ file pleine rejette proprement, message clair');

  // Test 3: une tâche qui échoue ne bloque pas la file, ni les suivantes
  console.log('[TEST] Test 3: récupération après échec...');
  {
    const queue = createTaskQueue({ concurrency: 1 });
    const failing = queue.enqueue(() => {
      throw new Error('échec volontaire');
    });
    const after = queue.enqueue(() => 'toujours vivante');
    await assert.rejects(
      failing,
      /échec volontaire/,
      "l'appelant de la tâche en échec doit voir l'erreur"
    );
    assert.strictEqual(
      await after,
      'toujours vivante',
      "la tâche suivante doit quand même s'exécuter"
    );
  }
  console.log('[TEST] ✓ un échec ne casse pas la file, les tâches suivantes tournent normalement');

  // Test 4: statistiques (active/pending/completed/failed)
  console.log('[TEST] Test 4: statistiques...');
  {
    const queue = createTaskQueue({ concurrency: 1 });
    const p1 = queue.enqueue(() => sleep(30));
    const p2 = queue.enqueue(() => sleep(10));
    await sleep(5);
    const midStats = queue.getStats();
    assert.strictEqual(midStats.active, 1, 'une tâche doit être active pendant son exécution');
    assert.strictEqual(
      midStats.pending,
      1,
      'la 2e tâche doit être en attente pendant que la 1re tourne'
    );
    await Promise.all([p1, p2]);
    const p3 = queue.enqueue(() => {
      throw new Error('x');
    });
    await p3.catch(() => {});
    const finalStats = queue.getStats();
    assert.strictEqual(finalStats.active, 0, 'aucune tâche active une fois tout terminé');
    assert.strictEqual(finalStats.pending, 0, 'aucune tâche en attente une fois tout terminé');
    assert.strictEqual(finalStats.completed, 2, 'les 2 tâches réussies doivent être comptées');
    assert.strictEqual(finalStats.failed, 1, 'la tâche en échec doit être comptée séparément');
  }
  console.log('[TEST] ✓ statistiques exactes (active/pending/completed/failed)');

  // Test 5: drain() attend les tâches en cours ET en attente
  console.log('[TEST] Test 5: drain()...');
  {
    const queue = createTaskQueue({ concurrency: 1 });
    let secondDone = false;
    queue.enqueue(() => sleep(20));
    queue.enqueue(async () => {
      await sleep(20);
      secondDone = true;
    });
    await queue.drain();
    assert.strictEqual(
      secondDone,
      true,
      'drain() doit attendre aussi les tâches encore en attente, pas juste la 1re active'
    );
    // drain() sur une file déjà vide résout immédiatement, sans jamais bloquer.
    await queue.drain();
  }
  console.log('[TEST] ✓ drain() attend bien toutes les tâches actives et en attente');

  // Test 6: shutdown() refuse les nouvelles tâches puis vide la file
  console.log('[TEST] Test 6: shutdown()...');
  {
    const queue = createTaskQueue({ concurrency: 1 });
    let ran = false;
    queue.enqueue(async () => {
      await sleep(15);
      ran = true;
    });
    const shutdownPromise = queue.shutdown();
    await assert.rejects(
      queue.enqueue(() => 'trop tard'),
      /fermée/,
      'enqueue() doit être refusé après shutdown()'
    );
    await shutdownPromise;
    assert.strictEqual(
      ran,
      true,
      'la tâche déjà active au moment du shutdown() doit quand même se terminer'
    );
  }
  console.log(
    '[TEST] ✓ shutdown() refuse les nouvelles tâches et vide proprement la file existante'
  );

  // Test 7: la mécanique interne (Promise.resolve().then(job.run).then(...)
  // .finally(...)) ne doit jamais générer de rejection non gérée EN PLUS de
  // celle que l'appelant gère déjà via la promesse rendue par enqueue() —
  // plusieurs tâches en échec d'affilée, toutes catchées côté appelant.
  console.log('[TEST] Test 7: pas de rejection non gérée par la mécanique interne...');
  {
    let sawUnhandled = false;
    const onUnhandled = () => {
      sawUnhandled = true;
    };
    process.on('unhandledRejection', onUnhandled);
    const queue = createTaskQueue({ concurrency: 2 });
    const results = await Promise.allSettled([
      queue.enqueue(() => {
        throw new Error('échec 1');
      }),
      queue.enqueue(() => Promise.reject(new Error('échec 2'))),
      queue.enqueue(() => 'ok'),
    ]);
    await sleep(20);
    process.off('unhandledRejection', onUnhandled);
    assert.strictEqual(results[0].status, 'rejected', 'la 1re tâche doit rejeter côté appelant');
    assert.strictEqual(results[1].status, 'rejected', 'la 2e tâche doit rejeter côté appelant');
    assert.strictEqual(results[2].status, 'fulfilled', 'la 3e tâche doit réussir normalement');
    assert.strictEqual(
      sawUnhandled,
      false,
      "la mécanique interne de task-queue.js ne doit jamais générer sa PROPRE rejection non gérée en plus de celle que l'appelant traite déjà"
    );
  }
  console.log('[TEST] ✓ aucune rejection non gérée générée par la mécanique interne de la file');

  console.log('\n=== Tests terminés ===');
  console.log('[TEST] ✓ Tous les tests de task-queue sont passés');
}

main().catch((err) => {
  console.error('[TEST] ✗ Échec:', err.message);
  process.exitCode = 1;
});
