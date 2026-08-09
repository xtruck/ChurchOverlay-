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
