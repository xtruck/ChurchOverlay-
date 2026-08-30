/**
 * ============================================================================
 *  perf-monitor.js — Lightweight CPU / RAM reporter (main process only)
 * ----------------------------------------------------------------------------
 *  CHANGELOG v0.2.0 (new file)
 *    Introduced to expose live CPU % and RSS (MB) to the dashboard so users
 *    can *see* the drop after enabling cloud-only mode / ASAR — no more
 *    guessing whether the app is heavy, and no more relying on Task Manager
 *    to notice a memory leak in a >2h culte session.
 *
 *  RÔLE :
 *    - Échantillonne process.cpuUsage() et process.memoryUsage() du process
 *      principal Electron (main.js) à un intervalle configurable (défaut 2s).
 *    - Calcule un % CPU normalisé (delta CPU / delta wall time / cpuCount).
 *    - Expose getStats() qui retourne { cpuPercent, rssMB, heapUsedMB,
 *      externalMB, uptimeSec, worker } — utilisé par l'IPC handler
 *      `get-perf-stats`. `worker` (AJOUT mémoire — polish) est le dernier
 *      échantillon process.memoryUsage() poussé par le worker server.js
 *      (voir setWorkerStats() / main.js), `null` si absent.
 *
 *  DESIGN :
 *    - Zéro dépendance (uniquement `os` et `process` built-in).
 *    - Aucun buffer, aucune fuite : on ne garde que le dernier échantillon.
 *    - L'échantillonnage tourne sur un setInterval unref()é : ne bloque
 *      jamais l'arrêt propre de l'application.
 * ============================================================================
 */

'use strict';

const os = require('os');

const CPU_COUNT = Math.max(1, os.cpus().length);

let lastCpu = process.cpuUsage();
let lastHrTime = process.hrtime.bigint();
let lastStats = {
  cpuPercent: 0,
  rssMB: 0,
  heapUsedMB: 0,
  externalMB: 0,
  uptimeSec: 0,
};
let timer = null;

// AJOUT (mémoire — polish) : le worker server.js (le pipeline audio/ASR/
// Bible réel, voir main.js > startServer) s'échantillonne lui-même et
// pousse son process.memoryUsage() via parentPort — reçu ici en dernier
// stade et fusionné dans getStats(). `null` tant qu'aucun échantillon n'est
// arrivé (worker pas encore démarré, ou hors mode worker en test/dev).
let workerStats = null;

function setWorkerStats(stats) {
  workerStats = stats;
}

function sample() {
  const nowCpu = process.cpuUsage();
  const nowHr = process.hrtime.bigint();

  const cpuDeltaMicros = nowCpu.user - lastCpu.user + (nowCpu.system - lastCpu.system);
  const wallDeltaMicros = Number(nowHr - lastHrTime) / 1000; // ns → µs

  lastCpu = nowCpu;
  lastHrTime = nowHr;

  const cpuPercent =
    wallDeltaMicros > 0
      ? Math.min(100 * CPU_COUNT, (cpuDeltaMicros / wallDeltaMicros) * 100) / CPU_COUNT
      : 0;

  const mem = process.memoryUsage();
  lastStats = {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    externalMB: Math.round((mem.external / 1024 / 1024) * 10) / 10,
    uptimeSec: Math.round(process.uptime()),
  };
}

function start(intervalMs = 2000) {
  if (timer) return;
  // Prime the baseline so the first getStats() call after start() has data.
  lastCpu = process.cpuUsage();
  lastHrTime = process.hrtime.bigint();
  timer = setInterval(sample, intervalMs);
  timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getStats() {
  return { ...lastStats, worker: workerStats };
}

module.exports = { start, stop, getStats, setWorkerStats };
