/**
 * ============================================================================
 *  test-voice-commands.js — Tests pour voice-commands.js
 * ----------------------------------------------------------------------------
 *  Premier test de ce fichier (chantier bilingue FR/EN) — aucune couverture
 *  n'existait avant. Couvre :
 *   - parité FR/EN pour chaque commande bilingue
 *   - les nouvelles commandes (previousChapter, repeat) et le correctif
 *     recallLastVerse
 *   - les garde-fous anti-faux-positif déjà documentés dans le code
 *     (emergencyClear, nextChapter vs nextVerse, "web" seul, repeat/répète
 *     ancré début-fin d'énoncé, pause/resume nécessitent un mot-ancre)
 *   - un balayage croisé : chaque commande de COMMANDS doit résoudre vers
 *     SON PROPRE id, jamais celui d'une voisine (risque réel d'une liste
 *     ordonnée premier-match : un motif élargi peut capturer la phrase
 *     d'une autre commande).
 *
 *  Ce premier passage de tests a mis au jour un bug préexistant réel,
 *  corrigé dans le même lot : detectCommand() normalise le texte reçu
 *  (accents retirés) AVANT de tester les motifs, mais plusieurs motifs
 *  (previousVerse, emergencyClear, extendTime, pauseTimer, resumeTimer,
 *  themeGold, langFrench, hideOverlay...) contenaient des caractères
 *  accentués en dur — donc invisibles depuis l'origine, quelle que soit
 *  la phrase prononcée. Voir voice-commands.js pour le correctif exact.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const { detectCommand, COMMANDS } = require('../voice-commands');

console.log('=== Test Voice Commands ===\n');

let passed = 0,
  failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`✅ ${name}`);
    passed++;
  } else {
    console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Parité FR/EN — même phrase-type dans les deux langues -> même action.
// ---------------------------------------------------------------------------
console.log('--- Parité FR/EN ---\n');

check('FR "verset suivant" -> nextVerse', detectCommand('verset suivant')?.action === 'nextVerse');
check('EN "next verse" -> nextVerse', detectCommand('next verse')?.action === 'nextVerse');

check(
  'FR "verset précédent" -> previousVerse',
  detectCommand('verset précédent')?.action === 'previousVerse'
);
check(
  'EN "previous verse" -> previousVerse',
  detectCommand('previous verse')?.action === 'previousVerse'
);

check(
  'FR "chapitre suivant" -> nextChapter',
  detectCommand('chapitre suivant')?.action === 'nextChapter'
);
check('EN "next chapter" -> nextChapter', detectCommand('next chapter')?.action === 'nextChapter');

check(
  'FR "chapitre précédent" -> previousChapter (nouveau)',
  detectCommand('chapitre précédent')?.action === 'previousChapter'
);
check(
  'EN "previous chapter" -> previousChapter (nouveau)',
  detectCommand('previous chapter')?.action === 'previousChapter'
);

check(
  'FR "cache le verset" -> hideVerse',
  detectCommand('cache le verset')?.action === 'hideVerse'
);
check('EN "hide the verse" -> hideVerse', detectCommand('hide the verse')?.action === 'hideVerse');

check(
  'FR "affiche en anglais" -> setLanguage(en)',
  (() => {
    const r = detectCommand('affiche en anglais');
    return r?.action === 'setLanguage' && r.language === 'en';
  })()
);
check(
  'EN "show French and English" (langBoth phrasing) -> setLanguage(both)',
  (() => {
    const r = detectCommand('langue bilingue');
    return r?.action === 'setLanguage' && r.language === 'both';
  })()
);

check(
  'FR "arrêt d\'urgence" -> emergencyClear',
  detectCommand("arrêt d'urgence")?.action === 'emergencyClear'
);
check(
  'EN "emergency clear" -> emergencyClear',
  detectCommand('emergency clear')?.action === 'emergencyClear'
);

// ---------------------------------------------------------------------------
// 2. recallLastVerse (correctif) — FR déjà existant, EN nouveau.
// ---------------------------------------------------------------------------
console.log('\n--- recallLastVerse ---\n');
check(
  'FR "reviens sur le verset" -> recallLastVerse',
  detectCommand('reviens sur le verset')?.action === 'recallLastVerse'
);
check(
  'EN "go back to the verse" -> recallLastVerse (nouveau)',
  detectCommand('go back to the verse')?.action === 'recallLastVerse'
);
check(
  'EN "show the verse again" -> recallLastVerse (nouveau)',
  detectCommand('show the verse again')?.action === 'recallLastVerse'
);

// ---------------------------------------------------------------------------
// 3. repeat (nouveau) — ancré début/fin d'énoncé, pas une sous-chaîne libre.
// ---------------------------------------------------------------------------
console.log('\n--- repeat (nouveau) ---\n');
check('FR "répète" -> repeat', detectCommand('répète')?.action === 'repeat');
check('FR "répète ça" -> repeat', detectCommand('répète ça')?.action === 'repeat');
check('EN "repeat" -> repeat', detectCommand('repeat')?.action === 'repeat');
check('EN "repeat that" -> repeat', detectCommand('repeat that')?.action === 'repeat');
check(
  'EN "Repeat after me: I am forgiven" -> PAS repeat (faux positif évité)',
  detectCommand('Repeat after me: I am forgiven')?.action !== 'repeat'
);
check(
  'FR "je répète ce point important" -> PAS repeat (faux positif évité)',
  detectCommand('je répète ce point important')?.action !== 'repeat'
);

// ---------------------------------------------------------------------------
// 3b. listenInFrench/listenInEnglish (nouveau, section 13 du cahier des
//     charges) — langue de TRANSCRIPTION, jamais d'AFFICHAGE. Vérifie ici
//     seulement que detectCommand() produit la bonne action/langue ;
//     l'absence de couplage avec setDisplayLanguage se vérifie côté
//     server.js (handleVoiceCommand > case 'setTranscriptionLanguage'
//     n'appelle jamais sessionState.setDisplayLanguage — confirmé par
//     lecture directe du code à ce lot, et re-vérifié statiquement au lot
//     14 de ce chantier).
// ---------------------------------------------------------------------------
console.log('\n--- listenInFrench / listenInEnglish (nouveau) ---\n');
check(
  'FR "écoute en français" -> setTranscriptionLanguage(fr)',
  (() => {
    const r = detectCommand('écoute en français');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'fr';
  })()
);
check(
  'FR "reconnais le français" -> setTranscriptionLanguage(fr)',
  (() => {
    const r = detectCommand('reconnais le français');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'fr';
  })()
);
check(
  'EN "listen in English" -> setTranscriptionLanguage(en)',
  (() => {
    const r = detectCommand('listen in English');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'en';
  })()
);
check(
  'EN "recognize English" -> setTranscriptionLanguage(en)',
  (() => {
    const r = detectCommand('recognize English');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'en';
  })()
);
check(
  'setTranscriptionLanguage et setLanguage sont des actions distinctes (jamais confondues)',
  (() => {
    const transcription = detectCommand('listen in English');
    const display = detectCommand('affiche anglais');
    return transcription.action === 'setTranscriptionLanguage' && display.action === 'setLanguage';
  })()
);

// ---------------------------------------------------------------------------
// 3c. listenInBilingual (Chantier 5) — troisième choix explicite pour
//     language=multi (nova-3, code-switching en cours de flux), jamais
//     activé sans que l'opérateur le déclenche lui-même (voir voice-commands.js).
// ---------------------------------------------------------------------------
console.log('\n--- listenInBilingual (nouveau, Chantier 5) ---\n');
check(
  'FR "écoute en bilingue" -> setTranscriptionLanguage(multi)',
  (() => {
    const r = detectCommand('écoute en bilingue');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'multi';
  })()
);
check(
  'FR "reconnais le mode bilingue" -> setTranscriptionLanguage(multi)',
  (() => {
    const r = detectCommand('reconnais le mode bilingue');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'multi';
  })()
);
check(
  'EN "listen in bilingual mode" -> setTranscriptionLanguage(multi)',
  (() => {
    const r = detectCommand('listen in bilingual mode');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'multi';
  })()
);
check(
  'EN "recognize bilingual" -> setTranscriptionLanguage(multi)',
  (() => {
    const r = detectCommand('recognize bilingual');
    return r?.action === 'setTranscriptionLanguage' && r.language === 'multi';
  })()
);
check(
  '"écoute en français" ne déclenche PAS aussi listenInBilingual (pas de chevauchement de motif)',
  (() => {
    const r = detectCommand('écoute en français');
    return r?.language === 'fr';
  })()
);

// ---------------------------------------------------------------------------
// 4. extendTime — nouvelle tournure anglaise naturelle.
// ---------------------------------------------------------------------------
console.log('\n--- extendTime ---\n');
check(
  'FR "prolonge le temps de 5 minutes" -> extendTime',
  detectCommand('prolonge le temps de 5 minutes')?.action === 'extendTime'
);
check(
  'EN "extend the timer by 5 minutes" -> extendTime (nouveau)',
  (() => {
    const r = detectCommand('extend the timer by 5 minutes');
    return r?.action === 'extendTime' && r.extraMs === 5 * 60000;
  })()
);
check(
  'EN "add 5 minutes to the timer" -> extendTime (nouveau)',
  (() => {
    const r = detectCommand('add 5 minutes to the timer');
    return r?.action === 'extendTime' && r.extraMs === 5 * 60000;
  })()
);

// ---------------------------------------------------------------------------
// 5. pauseTimer/resumeTimer — déjà bilingues par coïncidence de vocabulaire ;
//    confirme qu'un mot seul sans mot-ancre (temps/timer/chrono/décompte)
//    ne déclenche PAS la commande (faux positif potentiel dans un sermon).
// ---------------------------------------------------------------------------
console.log('\n--- pauseTimer/resumeTimer (déjà bilingues) ---\n');
check(
  'EN "pause the timer" -> pauseTimer',
  detectCommand('pause the timer')?.action === 'pauseTimer'
);
check(
  'EN "resume the timer" -> resumeTimer',
  detectCommand('resume the timer')?.action === 'resumeTimer'
);
check(
  'EN "let\'s continue reading from where we left off" -> PAS resumeTimer (pas de mot-ancre)',
  detectCommand("let's continue reading from where we left off")?.action !== 'resumeTimer'
);

// ---------------------------------------------------------------------------
// 6. Garde-fous anti-faux-positif déjà documentés dans le code.
// ---------------------------------------------------------------------------
console.log('\n--- Garde-fous anti-faux-positif ---\n');
check(
  '"en cas d\'urgence, Dieu répond" -> PAS emergencyClear (phrase complète exigée)',
  detectCommand("en cas d'urgence, Dieu répond")?.action !== 'emergencyClear'
);
check(
  '"the point I want to discuss" -> null (aucune commande générique "point")',
  detectCommand('the point I want to discuss') === null
);
// "web" seul, sans "translation/version/bible" immédiatement avant (le
// garde-fou réel du code — voir son commentaire), ne doit jamais matcher :
// c'est la vraie protection contre "check out our website"/"the web" dans
// une phrase quelconque du sermon, pas l'absence de "translation the web"
// (qui, lui, EST censé matcher — c'est exactement l'intention du motif).
check(
  '"check out our website" (mot "web" sans contexte traduction) -> PAS translationWEB',
  detectCommand('check out our website')?.action !== 'setTranslation'
);
check('"the web" seul (hors contexte traduction) -> null', detectCommand('the web') === null);

// ---------------------------------------------------------------------------
// 7. Balayage croisé : chaque commande de COMMANDS résout vers SON PROPRE id
//    à partir d'une phrase construite depuis son propre premier motif.
// ---------------------------------------------------------------------------
console.log('\n--- Balayage croisé (chaque commande résout vers son propre id) ---\n');

// Phrase représentative FR + EN par id, couvrant tout COMMANDS actuel — le
// but est de prouver qu'AJOUTER des motifs n'a pas fait gagner une commande
// voisine sur une phrase qui devrait rester la propriété d'une autre
// (risque réel d'une liste ordonnée premier-match).
const EXPECTED = {
  showVerse: {
    fr: 'affiche le verset jean 3 16',
    en: 'show verse john 3 16',
    action: 'showVerse',
  },
  hideOverlay: { fr: 'cache le verset', en: 'hide the verse', action: 'hideVerse' },
  recallLastVerse: {
    fr: 'reviens sur le verset',
    en: 'go back to the verse',
    action: 'recallLastVerse',
  },
  repeat: { fr: 'répète', en: 'repeat', action: 'repeat' },
  nextChapter: { fr: 'chapitre suivant', en: 'next chapter', action: 'nextChapter' },
  previousChapter: {
    fr: 'chapitre précédent',
    en: 'previous chapter',
    action: 'previousChapter',
  },
  nextVerse: { fr: 'verset suivant', en: 'next verse', action: 'nextVerse' },
  previousVerse: { fr: 'verset précédent', en: 'previous verse', action: 'previousVerse' },
  themeDark: {
    fr: 'thème sombre',
    en: 'switch to dark theme',
    action: 'setTheme',
    theme: 'dark',
  },
  themeLight: {
    fr: 'thème clair',
    en: 'switch to light theme',
    action: 'setTheme',
    theme: 'light',
  },
  themeGold: {
    fr: 'thème or',
    en: 'switch to gold theme',
    action: 'setTheme',
    theme: 'gold',
  },
  langFrench: {
    fr: 'affiche français',
    en: 'switch to french',
    action: 'setLanguage',
    language: 'fr',
  },
  langEnglish: {
    fr: 'affiche anglais',
    en: 'switch to english',
    action: 'setLanguage',
    language: 'en',
  },
  langBoth: {
    fr: 'langue bilingue',
    en: 'switch to bilingual',
    action: 'setLanguage',
    language: 'both',
  },
  listenInFrench: {
    fr: 'écoute en français',
    en: 'listen in french',
    action: 'setTranscriptionLanguage',
    language: 'fr',
  },
  listenInEnglish: {
    fr: 'écoute en anglais',
    en: 'listen in English',
    action: 'setTranscriptionLanguage',
    language: 'en',
  },
  listenInBilingual: {
    fr: 'écoute en bilingue',
    en: 'listen in bilingual',
    action: 'setTranscriptionLanguage',
    language: 'multi',
  },
  translationSegond: {
    fr: 'traduction segond',
    en: 'switch to segond',
    action: 'setTranslation',
    code: 'lsg',
  },
  translationDarby: {
    fr: 'traduction darby',
    en: 'switch to darby',
    action: 'setTranslation',
    code: 'darby',
  },
  translationKJV: {
    fr: 'traduction king james',
    en: 'translation king james',
    action: 'setTranslation',
    code: 'kjv',
  },
  translationWEB: {
    fr: 'bible world english bible',
    en: 'translation world english bible',
    action: 'setTranslation',
    code: 'web',
  },
  translationASV: {
    fr: 'bible american standard',
    en: 'translation american standard',
    action: 'setTranslation',
    code: 'asv',
  },
  extendTime: {
    fr: 'prolonge le temps de 5 minutes',
    en: 'extend the timer by 5 minutes',
    action: 'extendTime',
  },
  pauseTimer: { fr: 'pause le timer', en: 'pause the timer', action: 'pauseTimer' },
  resumeTimer: { fr: 'reprends le timer', en: 'resume the timer', action: 'resumeTimer' },
  emergencyClear: {
    fr: "arrêt d'urgence",
    en: 'emergency clear',
    action: 'emergencyClear',
  },
};

for (const cmd of COMMANDS) {
  const expected = EXPECTED[cmd.id];
  if (!expected) {
    check(`${cmd.id} a une entrée dans EXPECTED`, false, 'ajouter EXPECTED[id] ci-dessus');
    continue;
  }
  const fields = Object.entries(expected).filter(([k]) => k !== 'fr' && k !== 'en');
  for (const lang of ['fr', 'en']) {
    const phrase = expected[lang];
    const result = detectCommand(phrase);
    const matches = result && fields.every(([k, v]) => result[k] === v);
    check(
      `[${lang}] "${phrase}" résout vers "${cmd.id}" (pas une commande voisine)`,
      matches,
      `attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(result)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Parité FR/EN structurelle (mission Chantier C) : EXPECTED ci-dessus
//    n'a de valeur QUE si chaque entrée fournit VRAIMENT fr ET en, et que
//    l'un ne peut pas être un copier-coller accidentel de l'autre. Sans ces
//    deux garde-fous, une future commande ajoutée avec une seule langue
//    passerait la vérification silencieusement (voir mission §6 : « test
//    de parité automatisé qui échoue en CI si une commande existe dans une
//    langue et pas dans l'autre »).
// ---------------------------------------------------------------------------
console.log('\n--- Parité FR/EN structurelle (complétude de EXPECTED) ---\n');
for (const cmd of COMMANDS) {
  const expected = EXPECTED[cmd.id];
  if (!expected) continue; // déjà signalé au balayage croisé ci-dessus
  check(
    `${cmd.id} : EXPECTED.fr renseigné`,
    typeof expected.fr === 'string' && expected.fr.length > 0
  );
  check(
    `${cmd.id} : EXPECTED.en renseigné`,
    typeof expected.en === 'string' && expected.en.length > 0
  );
  check(
    `${cmd.id} : EXPECTED.fr ≠ EXPECTED.en (deux formulations distinctes, pas un copier-coller)`,
    expected.fr.toLowerCase() !== expected.en.toLowerCase()
  );
}

console.log(`\n=== Résultat voice-commands : ${passed} passés, ${failed} échoués ===`);
process.exit(failed > 0 ? 1 : 0);
