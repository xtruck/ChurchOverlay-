'use strict';
/**
 * Tests unitaires pour dotenv-loader.js — CORRECTIF CRITIQUE : l'app
 * Electron réelle (main.js) ne chargeait jamais .env dans process.env,
 * donc tout réglage placé dans .env (MIC_SILENCE_THRESHOLD, PORT...)
 * était silencieusement ignoré par l'app packagée alors qu'il
 * fonctionnait dans les tests (lancés via --env-file-if-exists).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseEnvContent, loadDotEnvInto } = require('../dotenv-loader');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-dotenv-test-'));
}

// --- Test 1 : parseEnvContent() analyse correctement clés/valeurs, commentaires, lignes vides ---
{
  const target = {};
  parseEnvContent(
    ['# commentaire', 'MIC_SILENCE_THRESHOLD=0', 'PORT=9999', '', 'FOO=bar=baz'].join('\n'),
    target
  );
  assert(target.MIC_SILENCE_THRESHOLD === '0', 'MIC_SILENCE_THRESHOLD=0 correctement lu');
  assert(target.PORT === '9999', 'PORT=9999 correctement lu');
  assert(target.FOO === 'bar=baz', "une valeur contenant '=' n'est pas tronquée");
  assert(!('#' in target), 'les lignes de commentaire sont ignorées');
}

// --- Test 2 : parseEnvContent() retire les guillemets simples/doubles ---
{
  const target = {};
  parseEnvContent(['GROQ_API_KEY="gsk_test123"', "OTHER='val'"].join('\n'), target);
  assert(target.GROQ_API_KEY === 'gsk_test123', 'guillemets doubles retirés');
  assert(target.OTHER === 'val', 'guillemets simples retirés');
}

// --- Test 3 : parseEnvContent() ne remplace JAMAIS une clé déjà présente ---
// (une vraie variable d'environnement système doit rester prioritaire)
{
  const target = { PORT: '1234' };
  parseEnvContent('PORT=9999', target);
  assert(
    target.PORT === '1234',
    "une variable déjà présente dans l'environnement n'est jamais écrasée par .env"
  );
}

// --- Test 4 : loadDotEnvInto() charge le premier fichier trouvé parmi plusieurs candidats ---
{
  const tmpDir = makeTmpDir();
  const missingPath = path.join(tmpDir, 'does-not-exist', '.env');
  const realPath = path.join(tmpDir, '.env');
  fs.writeFileSync(realPath, 'MIC_SILENCE_THRESHOLD=0.005\n');

  const target = {};
  let loadedFrom = null;
  const result = loadDotEnvInto(target, [missingPath, realPath], (p) => {
    loadedFrom = p;
  });

  assert(result === realPath, 'loadDotEnvInto() retourne le chemin du fichier réellement chargé');
  assert(loadedFrom === realPath, 'le callback onLoaded reçoit le bon chemin');
  assert(
    target.MIC_SILENCE_THRESHOLD === '0.005',
    'la valeur du fichier trouvé est bien chargée dans targetEnv'
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test 5 : loadDotEnvInto() retourne null si aucun candidat n'existe (jamais d'exception) ---
{
  const tmpDir = makeTmpDir();
  const target = {};
  let threw = false;
  let result;
  try {
    result = loadDotEnvInto(target, [
      path.join(tmpDir, 'a', '.env'),
      path.join(tmpDir, 'b', '.env'),
    ]);
  } catch (_err) {
    threw = true;
  }
  assert(!threw, "loadDotEnvInto() ne lève jamais d'exception si aucun .env n'existe");
  assert(result === null, 'loadDotEnvInto() retourne null si aucun candidat trouvé');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Test 6 : loadDotEnvInto() ne fusionne pas plusieurs fichiers — seul le premier trouvé compte ---
{
  const tmpDir = makeTmpDir();
  const firstPath = path.join(tmpDir, 'first.env');
  const secondPath = path.join(tmpDir, 'second.env');
  fs.writeFileSync(firstPath, 'ONLY_IN_FIRST=yes\n');
  fs.writeFileSync(secondPath, 'ONLY_IN_SECOND=yes\n');

  const target = {};
  loadDotEnvInto(target, [firstPath, secondPath]);
  assert(target.ONLY_IN_FIRST === 'yes', 'le premier fichier trouvé est bien chargé');
  assert(
    target.ONLY_IN_SECOND === undefined,
    'le second fichier candidat est ignoré une fois le premier trouvé (pas de fusion)'
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n=== Tous les tests dotenv-loader sont passés ===');
