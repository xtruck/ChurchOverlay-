'use strict';
/**
 * Test unitaire pour groq-wrapper.js — computeGroqSpeechInfo(), fonction
 * pure qui dérive { text, confidence } d'une réponse Groq verbose_json.
 *
 * Motivation : un test réel en production a produit une transcription
 * mêlant plusieurs langues, incohérente ("The air is a televisão! A chave
 * é essa lenda!") affichée comme sous-titre alors que ce n'était pas de la
 * vraie parole intelligible. Groq ne renvoyait jusqu'ici aucun signal de
 * confiance (response_format par défaut = json, pas verbose_json) — ce
 * test couvre la fonction qui comble ce vide.
 */

function assert(cond, msg) {
  if (!cond) {
    console.error('[TEST] ✗', msg);
    process.exit(1);
  }
  console.log('[TEST] ✓', msg);
}

process.env.GROQ_API_KEY = 'fake-key-for-test';
const groq = require('../groq-wrapper');

console.log('[TEST] Vérification de computeGroqSpeechInfo()...');

// Segment confiant, parole claire (ex. "Jean 3:16" bien articulé).
const confident = groq.computeGroqSpeechInfo({
  text: 'Jean 3:16',
  segments: [{ start: 0, end: 2.4, avg_logprob: -0.15, no_speech_prob: 0.02 }],
});
assert(confident.text === 'Jean 3:16', 'le texte est préservé pour un segment confiant');
assert(
  typeof confident.confidence === 'number' && confident.confidence > 0.7,
  `confiance élevée pour avg_logprob proche de 0 (obtenu: ${confident.confidence})`
);

// Segment clairement pas de la parole (silence/bruit blanc/glossolalie) :
// no_speech_prob élevé ET avg_logprob très négatif — les deux conditions
// requises pour blanchir le texte (voir le commentaire dans groq-wrapper.js
// sur pourquoi ce n'est PAS une fusion en un seul score).
const silence = groq.computeGroqSpeechInfo({
  text: 'incohérence hallucinée',
  segments: [{ start: 0, end: 3, avg_logprob: -1.8, no_speech_prob: 0.85 }],
});
assert(
  silence.text === '',
  'texte blanchi quand no_speech_prob ET avg_logprob indiquent une non-parole'
);
assert(silence.confidence === 0, 'confidence à 0 pour un segment de non-parole');

// Un avg_logprob faible SEUL (ex. nom propre biblique rare mais réel) ne
// doit PAS suffire à blanchir le texte — no_speech_prob reste bas.
const rareWordLowLogprob = groq.computeGroqSpeechInfo({
  text: 'Melchisédek',
  segments: [{ start: 0, end: 1.5, avg_logprob: -1.5, no_speech_prob: 0.1 }],
});
assert(
  rareWordLowLogprob.text === 'Melchisédek',
  'un avg_logprob faible isolé (sans no_speech_prob élevé) ne blanchit pas le texte'
);
assert(
  rareWordLowLogprob.confidence < 0.35,
  `mais la confidence reste basse, exploitable par le seuil de rejet côté server.js (obtenu: ${rareWordLowLogprob.confidence})`
);

// Un no_speech_prob élevé SEUL (segment court mais net) ne doit pas non
// plus suffire — avg_logprob reste bon.
const shortButClear = groq.computeGroqSpeechInfo({
  text: 'Amen',
  segments: [{ start: 0, end: 0.4, avg_logprob: -0.1, no_speech_prob: 0.75 }],
});
assert(
  shortButClear.text === 'Amen',
  'un no_speech_prob élevé isolé (avec avg_logprob correct) ne blanchit pas le texte'
);

// Forme de réponse inattendue (pas de segments — API modifiée, ou modèle
// qui ne les renvoie pas) : ne doit jamais lever d'exception, et ne doit
// jamais bloquer l'appelant (confidence undefined, jamais < un seuil).
const noSegments = groq.computeGroqSpeechInfo({ text: 'texte sans segments' });
assert(noSegments.text === 'texte sans segments', 'texte préservé sans segments');
assert(noSegments.confidence === undefined, 'confidence undefined sans segments (jamais bloquant)');

const malformed = groq.computeGroqSpeechInfo({});
assert(malformed.text === '', 'entrée vide gérée sans exception');
assert(malformed.confidence === undefined, 'confidence undefined sur entrée vide');

// Plusieurs segments : la moyenne pondérée par durée doit favoriser le
// segment le plus long.
const multiSegment = groq.computeGroqSpeechInfo({
  text: 'segment court puis segment long',
  segments: [
    { start: 0, end: 0.5, avg_logprob: -2.0, no_speech_prob: 0.3 }, // court, mauvais
    { start: 0.5, end: 5.5, avg_logprob: -0.1, no_speech_prob: 0.02 }, // long, bon
  ],
});
assert(
  multiSegment.confidence > 0.5,
  `le segment long/confiant (5s) doit dominer la moyenne pondérée sur le court/mauvais (0.5s) (obtenu: ${multiSegment.confidence})`
);

console.log('\n=== Tous les tests groq-speech-info sont passés ===');
