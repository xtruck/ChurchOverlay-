'use strict';
/**
 * Test unitaire pour groq-wrapper.js — vérifie que le paramètre `prompt`
 * envoyé à l'API de transcription Groq ne dépasse jamais 896 OCTETS UTF-8.
 *
 * RÉGRESSION COUVERTE (2026-08-07, confirmée en usage réel via DevTools) :
 * Groq répondait 400 "prompt length must be 896 characters or fewer" sur
 * (quasiment) chaque segment, forçant systématiquement le repli sur
 * Deepgram — Groq ne transcrivait plus jamais rien. Cause : la limite de
 * Groq est mesurée en OCTETS UTF-8, mais l'ancien code tronquait avec
 * `.slice(-900)`, une troncature en CARACTÈRES JS (900, déjà au-dessus de
 * 896) — chaque lettre accentuée du vocabulaire biblique français (é, è,
 * à...) coûte 2 octets UTF-8 pour 1 seul caractère JS, donc le prompt réel
 * dépassait souvent 920-950+ octets une fois envoyé.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

process.env.GROQ_API_KEY = 'fake-key-for-test';

const groq = require('../groq-wrapper');

// --- Partie 1 : truncateToUtf8ByteLimit(), fonction pure ---------------

console.log('[TEST] Vérification de truncateToUtf8ByteLimit()...');

const shortText = 'texte court, rien à tronquer';
assert(
  groq.truncateToUtf8ByteLimit(shortText, groq.GROQ_PROMPT_MAX_BYTES) === shortText,
  'un texte déjà sous la limite ressort inchangé'
);

// Texte gorgé de lettres accentuées françaises (2 octets UTF-8 chacune) :
// le pire cas pour un compteur qui se tromperait de caractères vs octets.
const accentedText = 'Ézéchiel Éphésiens Deutéronome Généalogie Écclésiaste '.repeat(30);
const truncatedAccented = groq.truncateToUtf8ByteLimit(accentedText, groq.GROQ_PROMPT_MAX_BYTES);
assert(
  Buffer.byteLength(truncatedAccented, 'utf8') <= groq.GROQ_PROMPT_MAX_BYTES,
  `texte plein d'accents : ${Buffer.byteLength(truncatedAccented, 'utf8')} octets <= ${groq.GROQ_PROMPT_MAX_BYTES}`
);
assert(
  truncatedAccented.charCodeAt(0) !== 0xfffd,
  "la troncature ne coupe pas un caractère UTF-8 multi-octets en deux (pas de '�' en tête)"
);

// --- Partie 2 : bout-en-bout via transcribeFile() (fetch mocké) --------

console.log('\n[TEST] Vérification bout-en-bout via transcribeFile()...');

let capturedPrompt = null;
const originalFetch = global.fetch;
global.fetch = async (_url, options) => {
  capturedPrompt = options.body.get('prompt');
  return {
    ok: true,
    json: async () => ({ text: 'ok' }),
  };
};

const tmpFile = path.join(os.tmpdir(), `test-groq-prompt-${Date.now()}.wav`);
fs.writeFileSync(tmpFile, Buffer.from([0x52, 0x49, 0x46, 0x46])); // contenu factice, jamais lu par le fetch mocké

(async () => {
  // Sans contexte : le vocabulaire biblique statique seul (WHISPER_PROMPT)
  // pesait déjà 1051 octets avant ce correctif — devait aussi être tronqué.
  await groq.transcribeFile(tmpFile, undefined, null);
  assert(capturedPrompt !== null, 'le prompt a bien été capturé (sans contexte)');
  assert(
    Buffer.byteLength(capturedPrompt, 'utf8') <= groq.GROQ_PROMPT_MAX_BYTES,
    `prompt sans contexte : ${Buffer.byteLength(capturedPrompt, 'utf8')} octets <= ${groq.GROQ_PROMPT_MAX_BYTES}`
  );

  // Avec un contexte récent plein d'accents, comme un vrai extrait de
  // transcription de culte (le cas qui déclenchait le 400 en usage réel).
  const contextHint =
    'Ézéchiel a vu la gloire de Dieu descendre sur Jérusalem et les anges annonçaient ' +
    'la résurrection à Éphèse pendant que les apôtres priaient près du Temple sacré';
  await groq.transcribeFile(tmpFile, undefined, contextHint);
  assert(capturedPrompt !== null, 'le prompt a bien été capturé (avec contexte)');
  assert(
    Buffer.byteLength(capturedPrompt, 'utf8') <= groq.GROQ_PROMPT_MAX_BYTES,
    `prompt avec contexte accentué : ${Buffer.byteLength(capturedPrompt, 'utf8')} octets <= ${groq.GROQ_PROMPT_MAX_BYTES}`
  );
  assert(
    capturedPrompt.includes('Temple sacré'),
    'la fin du contexte récent (le plus utile au modèle) est préservée par la troncature'
  );

  fs.unlinkSync(tmpFile);
  global.fetch = originalFetch;
  console.log('\n=== Tous les tests groq-prompt-truncation sont passés ===');
})().catch((err) => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
