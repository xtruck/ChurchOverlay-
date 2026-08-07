'use strict';
/**
 * Tests unitaires pour session-store.js — persistance SQLite de
 * l'historique de session (versets affichés + erreurs de pipeline).
 *
 * Utilise un dossier temporaire dédié par test (jamais le vrai USER_DATA_DIR)
 * pour ne rien laisser derrière et ne pas interférer avec une autre run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionStore = require('../session-store');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-session-store-test-'));
}

// --- Test 1 : initialisation crée bien le fichier .db ---
{
  const tmpDir = makeTmpDir();
  sessionStore.init(tmpDir);
  assert(sessionStore.isEnabled(), 'init() active la persistance sur un dossier valide');
  const dbPath = path.join(tmpDir, 'data', 'session-history.db');
  assert(fs.existsSync(dbPath), 'le fichier session-history.db est bien créé sur disque');
  sessionStore.close();
  assert(!sessionStore.isEnabled(), 'close() désactive isEnabled()');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test 2 : recordVerseShown() puis relecture via getVerseHistorySince() ---
{
  const tmpDir = makeTmpDir();
  sessionStore.init(tmpDir);

  const now = Date.now();
  sessionStore.recordVerseShown({
    reference: 'Jean 3:16',
    text: 'Car Dieu a tellement aimé le monde...',
    detectedBy: 'regex',
    timestamp: now,
  });
  sessionStore.recordVerseShown({
    reference: 'Jean 3:17',
    text: 'Dieu en effet n’a pas envoyé son Fils...',
    detectedBy: 'regex',
    readingMode: true,
    timestamp: now + 1000,
  });

  const history = sessionStore.getVerseHistorySince(0);
  assert(history.length === 2, 'getVerseHistorySince(0) retrouve les 2 versets enregistrés');
  assert(
    history[0].reference === 'Jean 3:17',
    'le verset le plus récent (Jean 3:17) arrive en premier (ORDER BY shown_at DESC)'
  );
  assert(history[0].reading_mode === 1, 'le flag reading_mode est bien persisté à 1');
  assert(history[1].reading_mode === 0, 'le flag reading_mode par défaut est bien 0');

  const filtered = sessionStore.getVerseHistorySince(now + 500);
  assert(
    filtered.length === 1 && filtered[0].reference === 'Jean 3:17',
    'getVerseHistorySince(sinceMs) filtre correctement par date'
  );

  sessionStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test 3 : recordPipelineError() puis relecture ---
{
  const tmpDir = makeTmpDir();
  sessionStore.init(tmpDir);

  sessionStore.recordPipelineError('transcription', 'Groq timeout after 5000ms');
  sessionStore.recordPipelineError('audio', 'Microphone disconnected');

  const errors = sessionStore.getPipelineErrorsSince(0);
  assert(errors.length === 2, 'les 2 erreurs de pipeline sont bien persistées');
  assert(
    errors[0].type === 'audio' && errors[1].type === 'transcription',
    'les erreurs sont retournées les plus récentes en premier'
  );

  sessionStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test 4 : robustesse — écrire sans init() préalable ne doit jamais planter ---
{
  // Aucun sessionStore.init() ici : simule le cas où l'initialisation a
  // échoué (dossier non accessible en écriture, disque plein...).
  let threw = false;
  try {
    sessionStore.recordVerseShown({ reference: 'Test', text: 'x' });
    sessionStore.recordPipelineError('transcription', 'x');
    assert(sessionStore.getVerseHistorySince(0).length === 0, 'lecture sans DB active retourne []');
    assert(
      sessionStore.getPipelineErrorsSince(0).length === 0,
      'lecture des erreurs sans DB active retourne []'
    );
  } catch (_err) {
    threw = true;
  }
  assert(
    !threw,
    "recordVerseShown/recordPipelineError n'interrompent jamais l'appelant, même sans DB active"
  );
}

// --- Test 5 : init() est idempotent (deuxième appel ne recrée pas de connexion) ---
{
  const tmpDir = makeTmpDir();
  sessionStore.init(tmpDir);
  sessionStore.recordVerseShown({ reference: 'Jean 1:1', text: 'x', timestamp: Date.now() });
  sessionStore.init(tmpDir); // deuxième appel — ne doit pas effacer la connexion existante
  assert(sessionStore.isEnabled(), 'init() appelé deux fois reste actif (idempotent)');
  const history = sessionStore.getVerseHistorySince(0);
  assert(history.length === 1, "le deuxième appel à init() n'a pas réinitialisé/perdu les données");
  sessionStore.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test 6 : init() sur un chemin invalide ne plante pas (best-effort) ---
{
  // Un fichier existant utilisé comme s'il s'agissait d'un dossier parent :
  // mkdirSync échouera (ENOTDIR) quel que soit l'utilisateur qui exécute le
  // test (contrairement à un chemin sous /root, accessible en écriture si
  // le process tourne déjà en root — ce que fait ce conteneur de test).
  const tmpDir = makeTmpDir();
  const blockingFile = path.join(tmpDir, 'not-a-directory');
  fs.writeFileSync(blockingFile, 'x');
  const invalidUserDataDir = path.join(blockingFile, 'nested', 'churchoverlay');

  let threw = false;
  const errors = [];
  try {
    sessionStore.init(invalidUserDataDir, { onError: (msg) => errors.push(msg) });
  } catch (_err) {
    threw = true;
  }
  assert(!threw, "init() sur un chemin invalide ne lève pas d'exception (best-effort)");
  assert(!sessionStore.isEnabled(), 'isEnabled() reste false après un échec d’initialisation');
  assert(errors.length === 1, 'le callback onError est bien appelé une fois en cas d’échec');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n=== Tous les tests session-store sont passés ===');
