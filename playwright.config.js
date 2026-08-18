// playwright.config.js — configuration des tests de fumée du tableau de
// bord (test/e2e/). Séparé de la suite `npm test` existante (backend pur,
// rapide, sans navigateur) : voir le script `test:e2e` dans package.json.
// webServer démarre test/e2e/start-server.js (server.js réel, réseau/micro
// mockés — même approche que test/test-ws-auth.js) et attend qu'il réponde
// avant de lancer le moindre test ; Playwright le termine automatiquement
// ensuite.
'use strict';

const PORT = process.env.PORT || 8770;

module.exports = {
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  // CORRECTIF (audit — 1 spec sur 12 flaky uniquement en suite complète,
  // fiable en isolation) : fullyParallel:false ne rend séquentiels que les
  // tests d'UN MÊME fichier — Playwright répartit quand même les FICHIERS
  // sur plusieurs workers par défaut. Or tous les specs partagent UN SEUL
  // vrai server.js (webServer, reuseExistingServer) et donc UN SEUL
  // ~/.churchoverlay réel (voir test/e2e/start-server.js — USER_DATA_DIR
  // n'est pas isolé pour les tests, faute de workerData ; déjà noté dans
  // dashboard-branding.spec.js). dashboard-branding.spec.js écrit/relit cet
  // état partagé (organizationName/accentColor) — exécuté en parallèle
  // d'un autre spec touchant le même serveur, l'ordre des écritures/lectures
  // devient non déterministe. workers:1 supprime la parallélisation
  // inter-fichiers, seule option sûre tant que l'isolation de
  // USER_DATA_DIR n'est pas un chantier à part (voir JOURNAL-MISSION.md).
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/e2e/start-server.js',
    // AJOUT : '/' et non '/dashboard' — dashboard.html référence ses
    // fichiers via des chemins relatifs ("dashboard/dashboard.css", etc.),
    // corrects depuis file:// (Electron) et depuis '/' (serveur.js sert
    // aussi dashboard.html à cette route), mais PAS depuis '/dashboard'
    // (sans slash final, le navigateur traite "dashboard" comme un
    // segment de répertoire et double le chemin -> 404). Personne
    // n'atteint réellement '/dashboard' dans l'app (Electron charge
    // toujours via file://) — server.js expose cette route en plus de
    // '/' mais ce n'est pas le chemin réel utilisé, donc '/' est le bon
    // choix pour ce test, pas un contournement.
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
};
