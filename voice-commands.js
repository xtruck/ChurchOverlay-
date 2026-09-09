/**
 * ============================================================================
 * voice-commands.js — Hands-Free Voice Control for ChurchOverlay
 * ============================================================================
 * Allows pastors/operators to control the overlay by speaking commands.
 *
 * Commands detected BEFORE verse detection, so they don't interfere with
 * normal transcription flow.
 *
 * Integration: Add to server.js pipeline, call before detectBilingual().
 * ============================================================================
 */

'use strict';

// AJOUT (chantier overlay/commandes vocales — saut direct de verset) : même
// moteur de conversion "nombre en toutes lettres -> chiffres" que
// detector.js/detector-en.js pour les références bibliques (voir
// number-words.js) — réutilisé tel quel, pas réimplémenté.
const { numberWordsToDigits } = require('./number-words');

const COMMANDS = [
  // --- SHOW / HIDE ---
  {
    id: 'showVerse',
    patterns: [
      /(?:montre|affiche|display|show).+?(?:le\s+)?verset\s+(\w+)\s+(\d+)(?::|\s|verset\s+)(\d+)/i,
      /(?:montre|affiche|display|show).+?(\w+)\s+(\d+)(?::|\s|verset\s+)(\d+)/i,
    ],
    extract: (match) => ({
      action: 'showVerse',
      reference: {
        book: match[1].toLowerCase(),
        chapter: parseInt(match[2]),
        verseStart: parseInt(match[3]),
      },
    }),
    keywords: ['montre', 'affiche', 'display', 'show'],
  },
  {
    id: 'hideOverlay',
    patterns: [
      // CORRECTIF (support bilingue FR/EN) : detectCommand() normalise le
      // texte reçu (NFD + suppression des marques diacritiques
      // combinantes, voir plus bas) AVANT de tester ces motifs — un
      // caractère accentué écrit en dur dans un motif (ex. "écran",
      // "enlève") ne peut donc JAMAIS matcher, quelle que soit la phrase
      // prononcée : le texte normalisé ne contient plus d'accents. Ce
      // correctif remplace chaque littéral accentué de ce fichier par sa
      // forme sans accent (aucune perte de sens, gain réel de matching —
      // la forme accentée était du code mort depuis l'origine). "verse"
      // (anglais) ajouté à la liste d'ancrage, absente jusqu'ici : "hide
      // the verse" ne matchait aucun des deux motifs.
      /(?:cache|masque|hide|retire|enleve).*(?:overlay|verset|verse|texte|ecran)/i,
      /(?:efface|clear|clean).*(?:ecran|screen)/i,
    ],
    extract: () => ({ action: 'hideVerse' }),
    keywords: ['cache', 'masque', 'hide', 'retire', 'enleve', 'efface', 'clear', 'clean'],
  },

  // --- RECALL LAST VERSE ---
  // AJOUT (demande initiale, section 9 — jamais construite jusqu'ici) :
  // permet à un prédicateur de redemander l'affichage du DERNIER verset
  // pertinent sans le reciter, ex. après avoir enchaîné sur autre chose.
  // Volontairement distinct de showVerse (qui exige une référence explicite
  // dans la phrase) : ici aucune référence n'est demandée, donc le handler
  // côté server.js doit puiser dans lastDetectedVerse/verseHistory.
  {
    id: 'recallLastVerse',
    patterns: [
      /(?:ramene|reviens|remets|reaffiche)[- ]?(?:moi|nous)?.{0,15}(?:sur\s+|au\s+|le\s+)?verset/i,
      /affiche[- ]?(?:le\s+)?(?:encore|a\s+nouveau|de\s+nouveau)/i,
      /(?:remontre|montre[- ]?(?:moi|nous)?\s+encore).{0,10}verset/i,
      // AJOUT (support bilingue FR/EN) : équivalents anglais — "go back"/
      // "bring it back" exigent le mot "verse" pour éviter de matcher un
      // "go back" narratif quelconque dans un sermon ("let's go back to
      // what Paul said").
      /(?:go\s+back|bring\s+it\s+back|come\s+back)\s+(?:to\s+)?(?:the\s+)?verse/i,
      /show\s+(?:it|the\s+verse)\s+again/i,
    ],
    extract: () => ({ action: 'recallLastVerse' }),
    keywords: [
      'ramene',
      'reviens',
      'remets',
      'reaffiche',
      'remontre',
      'montre',
      'affiche',
      'back',
      'again',
      'show',
    ],
  },

  // --- REPEAT (dernière diffusion, verset OU chant OU média — voir
  // sessionState.getLastBroadcast()/handleVoiceCommand > case 'repeat'
  // dans server.js). Distinct de recallLastVerse ci-dessus, qui ne
  // reprend QUE le dernier verset et re-résout sa référence, indifférent
  // à un média affiché depuis. ---
  // CORRECTIF-style discipline (voir nextChapter/nextVerse/emergencyClear
  // plus haut) : "repeat"/"répète" seuls sont des mots bien trop courants
  // dans un sermon ("Repeat after me...", "je répète ce point important")
  // pour être détectés n'importe où dans la phrase — ancrés en DÉBUT ET
  // FIN d'énoncé (avec un mot de remplissage optionnel seulement), pas
  // une sous-chaîne libre.
  {
    id: 'repeat',
    patterns: [
      /^\s*(?:répète|repete)\s*(?:ca|ceci|encore)?\s*[.!]?\s*$/i,
      /^\s*repeat\s*(?:that|this|it)?\s*[.!]?\s*$/i,
    ],
    extract: () => ({ action: 'repeat' }),
    keywords: ['repete', 'repeat'],
  },

  // --- READING MODE ---
  // CORRECTIF : nextChapter est désormais vérifié AVANT nextVerse, et les
  // motifs génériques /(?:next|suivant)/i et /(?:previous|précédent)/i ont
  // été retirés. Deux problèmes réels avec l'ancien code :
  //  1. "chapitre suivant" matchait le motif générique de nextVerse (placé
  //     avant nextChapter dans la liste, donc gagnant), donc la commande
  //     vocale "chapitre suivant" ne changeait jamais de chapitre.
  //  2. Ces motifs bruts (juste "suivant"/"next"/"previous"/"précédent")
  //     matchent N'IMPORTE QUELLE phrase du sermon contenant ce mot — ex.
  //     "le point suivant de mon message", "previous experience taught
  //     us..." — ce qui interceptait silencieusement le segment AVANT la
  //     détection de verset (voir processTranscript : un match ici court-
  //     circuite tout le reste). Un sermon normal aurait perdu des
  //     versets entiers sans qu'aucune erreur ne soit visible.
  {
    id: 'nextChapter',
    patterns: [
      /(?:chapitre)\s+suivant/i,
      /(?:passe|avance)\s+(?:au\s+)?chapitre\s+suivant/i,
      /next\s+chapter/i,
    ],
    extract: () => ({ action: 'nextChapter' }),
    keywords: ['chapitre', 'chapter', 'suivant', 'next', 'passe', 'avance'],
  },
  // AJOUT (support bilingue FR/EN, cahier des charges section 2/3) :
  // n'existait dans aucune langue jusqu'ici. Même discipline anti-faux-
  // positif que nextChapter/nextVerse ci-dessus — "chapitre" explicite
  // requis, jamais juste "précédent"/"previous" seuls.
  {
    id: 'previousChapter',
    patterns: [
      /(?:chapitre)\s+(?:precedent|precedant|d'avant)/i,
      /(?:retourne|reviens)\s+(?:au\s+)?chapitre\s+(?:precedent|d'avant)/i,
      /previous\s+chapter/i,
    ],
    extract: () => ({ action: 'previousChapter' }),
    keywords: [
      'chapitre',
      'chapter',
      'precedent',
      'precedant',
      'avant',
      'retourne',
      'reviens',
      'previous',
    ],
  },
  {
    id: 'nextVerse',
    patterns: [
      /(?:verset|passage)\s+suivant/i,
      /(?:passe|avance)\s+(?:au\s+)?(?:verset|passage)\s+suivant/i,
      /next\s+verse/i,
    ],
    extract: () => ({ action: 'nextVerse' }),
    keywords: ['verset', 'verse', 'passage', 'suivant', 'next', 'passe', 'avance'],
  },
  {
    id: 'previousVerse',
    patterns: [
      /(?:verset|passage)\s+(?:precedent|precedant|d'avant)/i,
      /(?:retourne|reviens)\s+(?:au\s+)?(?:verset|passage)\s+(?:precedent|d'avant)/i,
      /previous\s+verse/i,
    ],
    extract: () => ({ action: 'previousVerse' }),
    keywords: [
      'verset',
      'verse',
      'passage',
      'precedent',
      'precedant',
      'avant',
      'retourne',
      'reviens',
      'previous',
    ],
  },
  // AJOUT (chantier overlay/commandes vocales — saut direct de verset) :
  // "va au verset X"/"saute au verset X"/"passe au verset X" (+ parité EN,
  // même discipline que le reste de ce fichier). DISTINCT de nextVerse/
  // previousVerse ci-dessus (avance relative de ±1) : ici, X est un numéro
  // ABSOLU dans le chapitre en cours. Garde-fou : lookahead négatif sur
  // "suivant"/"precedent"/"next"/"previous" juste après "verset"/"verse"
  // pour ne JAMAIS intercepter "passe au verset suivant" (qui doit rester
  // nextVerse ci-dessus) même si l'ordre des motifs dans COMMANDS changeait
  // un jour — pas seulement parce que ce motif est déclaré après.
  // Chiffres ET nombres en toutes lettres acceptés (numberWordsToDigits,
  // voir number-words.js — même moteur que detector.js/detector-en.js pour
  // les références bibliques) ; le texte capturé peut contenir des mots
  // superflus après le nombre (fin de phrase sans ponctuation) — sans
  // conséquence, parseInt() ne lit que les chiffres de tête.
  {
    id: 'jumpToVerse',
    patterns: [
      /(?:va|saute|passe)\s+au\s+verset\s+(?!suivant|precedent|precedant\b)((?:[\w'-]+\s*){1,5})/i,
      /(?:go|jump|skip)\s+to\s+verse\s+(?!next|previous\b)((?:[\w'-]+\s*){1,5})/i,
    ],
    extract: (match) => {
      const raw = match[1].trim();
      const withDigits = /^\d+$/.test(raw)
        ? raw
        : numberWordsToDigits(numberWordsToDigits(raw, 'fr'), 'en');
      const verseNumber = parseInt(withDigits, 10);
      return { action: 'jumpToVerse', verseNumber };
    },
    keywords: ['va', 'saute', 'passe', 'verset', 'go', 'jump', 'skip', 'verse'],
  },

  // --- THEME ---
  // CORRECTIF (Chantier C, mission autonome — parité FR/EN) : le motif
  // "switch/change" n'acceptait que des prépositions françaises (en/au/
  // vers), et l'ordre mot-couleur-avant-nom ("dark theme", naturel en
  // anglais) n'était couvert par aucun motif (seul l'ordre français
  // "thème sombre" l'était). Ajout de "to" comme préposition ET d'un motif
  // dédié à l'ordre anglais. Voir test/test-voice-commands.js (parité
  // exhaustive) qui a mis ce trou en évidence.
  {
    id: 'themeDark',
    patterns: [
      /(?:thème|theme|style)\s+(?:sombre|dark|noir|black)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers|to)\s+(?:thème\s+|the\s+)?(?:sombre|dark)/i,
      /(?:switch|change)\s+to\s+(?:the\s+)?(?:dark|black)\s+(?:theme|style)/i,
    ],
    extract: () => ({ action: 'setTheme', theme: 'dark' }),
    keywords: ['sombre', 'dark', 'noir', 'black', 'theme', 'style', 'passe', 'switch', 'change'],
  },
  {
    id: 'themeLight',
    patterns: [
      /(?:thème|theme|style)\s+(?:clair|light|blanc|white)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers|to)\s+(?:thème\s+|the\s+)?(?:clair|light)/i,
      /(?:switch|change)\s+to\s+(?:the\s+)?(?:light|white)\s+(?:theme|style)/i,
    ],
    extract: () => ({ action: 'setTheme', theme: 'light' }),
    keywords: ['clair', 'light', 'blanc', 'white', 'theme', 'style', 'passe', 'switch', 'change'],
  },
  {
    id: 'themeGold',
    patterns: [
      /(?:thème|theme|style)\s+(?:or|gold|dore|golden)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers|to)\s+(?:thème\s+|the\s+)?(?:or|gold)/i,
      /(?:switch|change)\s+to\s+(?:the\s+)?(?:gold|golden)\s+(?:theme|style)/i,
    ],
    extract: () => ({ action: 'setTheme', theme: 'gold' }),
    keywords: ['or', 'gold', 'dore', 'golden', 'theme', 'style', 'passe', 'switch', 'change'],
  },

  // --- LANGUAGE ---
  {
    id: 'langFrench',
    patterns: [
      /(?:langue|language|affiche)\s+(?:francais|fr|french)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers|to)\s+(?:francais|fr|french)/i,
    ],
    extract: () => ({ action: 'setLanguage', language: 'fr' }),
    keywords: [
      'francais',
      'french',
      'fr',
      'langue',
      'language',
      'affiche',
      'passe',
      'switch',
      'change',
    ],
  },
  {
    id: 'langEnglish',
    patterns: [
      /(?:langue|language|affiche)\s+(?:anglais|en|english)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers|to)\s+(?:anglais|en|english)/i,
    ],
    extract: () => ({ action: 'setLanguage', language: 'en' }),
    keywords: [
      'anglais',
      'english',
      'en',
      'langue',
      'language',
      'affiche',
      'passe',
      'switch',
      'change',
    ],
  },
  {
    id: 'langBoth',
    patterns: [
      /(?:langue|language|affiche)\s+(?:les\s+deux|both|bilingue|bilingual)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers|to)\s+(?:mode\s+)?(?:bilingue|bilingual)/i,
    ],
    extract: () => ({ action: 'setLanguage', language: 'both' }),
    keywords: [
      'bilingue',
      'bilingual',
      'both',
      'deux',
      'langue',
      'language',
      'affiche',
      'passe',
      'switch',
      'change',
    ],
  },

  // --- ASR LANGUAGE (langue de TRANSCRIPTION — ce que le moteur doit
  // décoder — jamais la langue d'AFFICHAGE ci-dessus, voir cahier des
  // charges bilingue section 13). Verbe impératif "écoute"/"listen"
  // délibérément distinct des verbes "affiche"/"langue"/"passe" utilisés
  // par langFrench/langEnglish/langBoth ci-dessus, pour qu'aucune phrase
  // ne puisse déclencher les deux familles de commandes à la fois. ---
  {
    id: 'listenInFrench',
    patterns: [
      /(?:ecoute|reconnais)(?:[- ]?(?:moi|nous))?\s+(?:le\s+)?(?:en\s+)?francais/i,
      /listen\s+in\s+french/i,
      /recognize\s+french/i,
    ],
    extract: () => ({ action: 'setTranscriptionLanguage', language: 'fr' }),
    keywords: ['ecoute', 'reconnais', 'listen', 'recognize', 'francais', 'french'],
  },
  {
    id: 'listenInEnglish',
    patterns: [
      /(?:ecoute|reconnais)(?:[- ]?(?:moi|nous))?\s+(?:le\s+|l['’])?(?:en\s+)?anglais/i,
      /listen\s+in\s+english/i,
      /recognize\s+english/i,
    ],
    extract: () => ({ action: 'setTranscriptionLanguage', language: 'en' }),
    keywords: ['ecoute', 'reconnais', 'listen', 'recognize', 'anglais', 'english'],
  },
  // AJOUT (Chantier 5 — bilingue) : nova-3 supporte `language=multi`
  // (code-switching en cours de flux, une seule connexion — voir
  // deepgram-streaming.js/deepgram-wrapper.js). Mesuré sur un cas réel du
  // corpus (H1, changement de langue fr->en en pleine phrase) : passe de
  // "jamais affiché" à correctement affiché (fallback chapitre), sans
  // dégradation observée sur du français pur dans le même test — mais sur
  // un échantillon trop petit pour en faire un défaut universel imposé à
  // tous (voir décision explicite : un défaut mono-langue reste plus sûr
  // pour un culte qui ne mélange jamais les langues, "multi" doit être un
  // choix de l'opérateur, pas une valeur imposée). Exposé ici comme un
  // TROISIÈME choix explicite, au même niveau que fr/en, jamais activé
  // sans que l'opérateur le déclenche lui-même.
  {
    id: 'listenInBilingual',
    patterns: [
      /(?:ecoute|reconnais)(?:[- ]?(?:moi|nous))?\s+(?:le\s+|en\s+)?(?:mode\s+)?bilingue/i,
      /listen\s+in\s+bilingual(?:\s+mode)?/i,
      /recognize\s+bilingual/i,
    ],
    extract: () => ({ action: 'setTranscriptionLanguage', language: 'multi' }),
    keywords: ['ecoute', 'reconnais', 'listen', 'recognize', 'bilingue', 'bilingual'],
  },

  // --- TRANSLATION ---
  {
    id: 'translationSegond',
    patterns: [
      /(?:traduction|version|bible|translation)\s+(?:segond|louis\s+segond)/i,
      /(?:passe|switch|change)\s+(?:en|à|vers|sur|to|over\s+to)\s+(?:la\s+|the\s+)?(?:segond|louis\s+segond)/i,
    ],
    // CORRECTIF (Chantier C, mission autonome — parité FR/EN) : "switch to
    // segond"/"change to segond" ne matchaient jamais (prépositions
    // en/à/vers/sur toutes françaises, aucune anglaise) — seule la forme
    // "bible/version segond" fonctionnait déjà en anglais, par coïncidence
    // de vocabulaire partagé. Même asymétrie que translationDarby
    // ci-dessous. Voir test/test-voice-commands.js pour le test de parité
    // exhaustif qui a mis ce trou en évidence.
    extract: () => ({ action: 'setTranslation', language: 'fr', code: 'lsg' }),
    keywords: [
      'segond',
      'traduction',
      'version',
      'bible',
      'translation',
      'passe',
      'switch',
      'change',
    ],
  },
  {
    id: 'translationDarby',
    patterns: [
      /(?:traduction|version|bible|translation)\s+(?:darby)/i,
      /(?:passe|switch|change)\s+(?:en|à|vers|sur|to|over\s+to)\s+(?:la\s+|the\s+)?darby/i,
    ],
    extract: () => ({ action: 'setTranslation', language: 'fr', code: 'darby' }),
    keywords: [
      'darby',
      'traduction',
      'version',
      'bible',
      'translation',
      'passe',
      'switch',
      'change',
    ],
  },

  // AJOUT (audit — changement de traduction à la voix, ANGLAIS) : les trois
  // entrées ci-dessus ne couvraient que le français (Segond/Darby). Un
  // pasteur prêchant en anglais n'avait aucun moyen vocal de basculer entre
  // KJV/WEB/ASV (les trois traductions déjà servies par bible-lookup-with-
  // api.js — voir AVAILABLE_TRANSLATIONS.en) alors que handleVoiceCommand
  // (server.js, case 'setTranslation') gère déjà ces deux langues
  // indifféremment. Même discipline que translationSegond/translationDarby :
  // toujours exiger "translation/version/bible X" ou "switch to X", jamais
  // le mot seul — "web" en particulier serait un faux positif désastreux
  // sans ce garde-fou (n'importe quelle phrase mentionnant "the web").
  // CORRECTIF (Chantier C, mission autonome — parité FR/EN) : l'ancre
  // n'acceptait que "translation" (anglais), jamais "traduction" (français)
  // — un locuteur français ne pouvait pas dire "traduction KJV" alors que
  // translationSegond/Darby acceptent symétriquement "traduction"/
  // "translation". Voir test/test-voice-commands.js (parité exhaustive).
  {
    id: 'translationKJV',
    patterns: [
      /(?:translation|traduction|version|bible)\s+(?:the\s+)?(?:king\s+james(?:\s+version)?|kjv)/i,
      /(?:switch|change|move)\s+(?:to|over\s+to)\s+(?:the\s+)?(?:king\s+james(?:\s+version)?|kjv)/i,
    ],
    extract: () => ({ action: 'setTranslation', language: 'en', code: 'kjv' }),
    keywords: [
      'kjv',
      'king',
      'james',
      'traduction',
      'version',
      'bible',
      'translation',
      'switch',
      'change',
      'move',
    ],
  },
  {
    id: 'translationWEB',
    patterns: [
      /(?:translation|traduction|version|bible)\s+(?:the\s+)?(?:world\s+english\s+bible|web)\b/i,
      /(?:switch|change|move)\s+(?:to|over\s+to)\s+(?:the\s+)?(?:world\s+english\s+bible|web\s+translation|web\s+bible)/i,
    ],
    extract: () => ({ action: 'setTranslation', language: 'en', code: 'web' }),
    keywords: [
      'web',
      'world',
      'english',
      'traduction',
      'version',
      'bible',
      'translation',
      'switch',
      'change',
      'move',
    ],
  },
  {
    id: 'translationASV',
    patterns: [
      /(?:translation|traduction|version|bible)\s+(?:the\s+)?(?:american\s+standard(?:\s+version)?|asv)/i,
      /(?:switch|change|move)\s+(?:to|over\s+to)\s+(?:the\s+)?(?:american\s+standard(?:\s+version)?|asv)/i,
    ],
    extract: () => ({ action: 'setTranslation', language: 'en', code: 'asv' }),
    keywords: [
      'asv',
      'american',
      'standard',
      'traduction',
      'version',
      'bible',
      'translation',
      'switch',
      'change',
      'move',
    ],
  },

  // --- TIMER ---
  {
    id: 'extendTime',
    patterns: [
      /(?:etends|prolonge|extend|add|ajoute)\s+(?:le\s+)?(?:temps|time|duree)\s+(?:de\s+)?(\d+)\s*(?:minutes?|min|secondes?|sec|s)?/i,
      // AJOUT (support bilingue FR/EN) : le motif ci-dessus exige "de" (ou
      // rien) entre le nom et le nombre — ne matchait donc pas la tournure
      // anglaise naturelle "extend the timer BY 5 minutes"/"add 5 minutes
      // to the timer". "timer" gardé comme mot-ancre obligatoire (même
      // discipline anti-faux-positif que pauseTimer/resumeTimer plus bas).
      /(?:extend|add)\s+(?:the\s+)?timer\s+(?:by\s+)?(\d+)\s*(?:minutes?|min|seconds?|sec|s)?/i,
      /add\s+(\d+)\s*(?:minutes?|min|seconds?|sec|s)\s+(?:to\s+)?(?:the\s+)?timer/i,
    ],
    extract: (match) => {
      const amount = parseInt(match[1], 10);
      const unit = match[0].match(/(?:minute|min)/i) ? 60000 : 5000; // default 5s if no unit
      return { action: 'extendTime', extraMs: amount * unit };
    },
    keywords: ['etends', 'prolonge', 'extend', 'add', 'ajoute', 'temps', 'time', 'duree', 'timer'],
  },
  // AJOUT (audit bilingue FR/EN) : "pause"/"continue"/"resume" sont déjà
  // des mots anglais valides dans les motifs ci-dessous (coïncidence utile,
  // pas conçu à l'origine pour l'anglais) — "pause the timer"/"resume the
  // timer" fonctionnent donc déjà tels quels, aucun nouveau motif requis.
  // Vérifié : "pause"/"continue"/"resume" seuls, sans "timer"/"chrono"
  // etc. après, ne matchent PAS (mot-ancre obligatoire via le `.*` suivi
  // du groupe temps|timer|chrono|décompte) — donc pas de faux positif sur
  // "let's continue in verse 5" ou "Jesus resumed his journey".
  {
    id: 'pauseTimer',
    patterns: [
      /(?:pause|mets\s+en\s+pause|arrete\s+temporairement).*(?:temps|timer|chrono|decompte)/i,
    ],
    extract: () => ({ action: 'pauseTimer' }),
    keywords: ['pause', 'mets', 'arrete', 'temporairement', 'temps', 'timer', 'chrono', 'decompte'],
  },
  {
    id: 'resumeTimer',
    patterns: [/(?:reprends|continue|resume|redemarre).*(?:temps|timer|chrono|decompte)/i],
    extract: () => ({ action: 'resumeTimer' }),
    keywords: [
      'reprends',
      'resume',
      'continue',
      'redemarre',
      'temps',
      'timer',
      'chrono',
      'decompte',
    ],
  },

  // --- EMERGENCY ---
  {
    id: 'emergencyClear',
    // CORRECTIF : "urgence"/"panic" seuls étaient trop génériques (ex. un
    // prédicateur disant "en cas d'urgence, Dieu répond" effaçait tout
    // l'overlay). On exige désormais une expression de commande complète.
    patterns: [
      /(?:effacement|arret)\s+d['’]urgence/i,
      /emergency\s+clear/i,
      /clear\s+all/i,
      /tout\s+effacer/i,
    ],
    extract: () => ({ action: 'emergencyClear' }),
    keywords: ['urgence', 'emergency', 'effacement', 'effacer', 'arret', 'clear', 'all', 'tout'],
  },
];

// AJOUT (Axe 3 — sécurisation des commandes vocales, Option A) : réutilise
// TEL QUEL (aucune réimplémentation) le moteur de distance d'édition déjà
// écrit pour les noms de livres bibliques (levenshtein.js) — voir aussi
// voice-trigger-matcher.js, qui l'utilise déjà pour détecter les collisions
// phonétiques ENTRE phrases déclencheuses (média/chants). Ici, il sert un
// usage voisin mais distinct : mesurer la proximité phonétique d'UN
// FRAGMENT transcrit envers UN mot-clé de référence connu, à la volée sur
// chaque commande détectée.
const { levenshteinDistance } = require('./levenshtein');

/**
 * Normalise texte/mot-clé pour la comparaison — mêmes règles que le
 * normalize() interne de detectCommand() plus bas (minuscules, accents NFD
 * retirés), factorisé ici pour être réutilisé par le score de confiance ET
 * la phrase d'activation.
 * @param {string} value
 * @returns {string}
 */
function normalizeCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .trim();
}

/**
 * Score de similarité [0, 1] entre deux chaînes déjà normalisées, dérivé de
 * la distance de Levenshtein — 1 = identiques, 0 = aucune lettre commune
 * (proportionnellement à la longueur). Deux chaînes vides sont considérées
 * identiques (1), pas une erreur de division par zéro.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarityScore(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// Seuil de confiance strict demandé par le cahier des charges (Axe 3,
// Option A) : en-dessous de 80%, une commande est jugée trop ambiguë pour
// être exécutée — mieux vaut un vrai déclenchement raté (le prédicateur
// répète/reformule) qu'un faux positif en pleine prédication.
const COMMAND_CONFIDENCE_THRESHOLD = 0.8;
const WAKE_WORD_CONFIDENCE_THRESHOLD = 0.8;
// Nombre de mots du début de l'énoncé essayés comme candidats à la phrase
// d'activation — au-delà, la commande utile qui suit serait de toute façon
// hors de portée d'une phrase d'activation de 1-2 mots ("overlay",
// "church overlay").
const WAKE_WORD_MAX_WINDOW = 3;

/**
 * Confiance [0, 1] qu'un texte transcrit corresponde réellement à une
 * commande, en comparant chaque mot du fragment capturé (`matchedText`, le
 * `match[0]` d'un motif regex déjà satisfait) au meilleur mot-clé connu de
 * cette commande (`cmd.keywords`, voir COMMANDS ci-dessus — dérivés
 * directement du vocabulaire déjà présent dans les motifs de la commande).
 *
 * CHOIX D'ARCHITECTURE : les motifs regex existants restent la première
 * ligne de défense (alternance EXACTE de mots-clés connus, déjà très
 * stricte — voir tout l'historique de correctifs anti-faux-positif dans ce
 * fichier). Un mot du texte capturé qui correspond LITTÉRALEMENT à un
 * mot-clé (le cas normal : le regex n'a pu matcher QUE parce qu'un mot-clé
 * littéral était présent) obtient donc mécaniquement une confiance de 1.0 —
 * ce filet de sécurité ne rejette jamais une commande aujourd'hui valide.
 * Il devient actif dès qu'un chemin de détection plus permissif (tolérance
 * orthographique sur un mot-clé, correction IA en amont qui a pu déformer
 * le texte, etc.) produit un match dont aucun mot ne ressemble vraiment à
 * l'intention attendue — exactement le filet demandé par le cahier des
 * charges ("distance de Levenshtein... si trop élevée, rejette").
 * @param {string} matchedText
 * @param {string[]} keywords
 * @returns {number}
 */
function computeCommandConfidence(matchedText, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return 1; // pas de mots-clés déclarés : rien à évaluer, jamais un motif de rejet
  // CORRECTIF (trouvé en testant ce chantier — "Ramène-moi sur le verset")
  // : découper seulement sur les espaces laissait "ramene-moi" comme UN
  // seul token — comparé à "ramene" (mot-clé), la distance incluait tout
  // le "-moi" en trop, faisant chuter la confiance sous le seuil pour une
  // commande pourtant parfaitement valide (le connecteur `[- ]?` du motif
  // regex traite déjà explicitement le tiret comme un séparateur). Découpe
  // maintenant aussi sur le tiret, cohérent avec le motif lui-même.
  const words = normalizeCommandText(matchedText)
    .split(/[\s-]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 0;

  let best = 0;
  for (const word of words) {
    for (const keyword of keywords) {
      const score = similarityScore(word, normalizeCommandText(keyword));
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Vérifie si le DÉBUT du texte transcrit (déjà normalisé) correspond à
 * l'une des phrases d'activation acceptées, avec tolérance phonétique
 * (Levenshtein) — l'ASR transcrit rarement "ChurchOverlay" prononcé à voix
 * haute lettre pour lettre ; "Church Overlay" (deux mots), "Church over
 * lay", ou une légère déformation doivent toujours activer, tant que le
 * résultat reste raisonnablement proche.
 *
 * Compare le mot-clé (espaces retirés, ex. "churchoverlay") à des fenêtres
 * de 1 à WAKE_WORD_MAX_WINDOW mots en tête d'énoncé, elles aussi
 * concaténées SANS espace avant comparaison — une activation prononcée en
 * un seul mot ("overlay") ou éclatée en plusieurs par l'ASR ("church over
 * lay") doivent toutes deux pouvoir matcher la même référence compacte.
 * @param {string} normalizedText - déjà passé par normalizeCommandText()
 * @param {string[]} wakeWords
 * @returns {{matched: boolean, confidence: number, consumedWords: number}}
 */
function matchesWakeWord(normalizedText, wakeWords) {
  const words = normalizedText.split(/\s+/).filter((w) => w.length > 0);
  let best = { matched: false, confidence: 0, consumedWords: 0 };
  if (words.length === 0 || !Array.isArray(wakeWords)) return best;

  for (const raw of wakeWords) {
    const wakeWordCompact = normalizeCommandText(raw).replace(/\s+/g, '');
    if (!wakeWordCompact) continue;
    const maxWindow = Math.min(WAKE_WORD_MAX_WINDOW, words.length);
    for (let windowSize = 1; windowSize <= maxWindow; windowSize++) {
      const candidate = words.slice(0, windowSize).join('');
      const score = similarityScore(candidate, wakeWordCompact);
      if (score > best.confidence) {
        best = {
          matched: score >= WAKE_WORD_CONFIDENCE_THRESHOLD,
          confidence: score,
          consumedWords: windowSize,
        };
      }
    }
  }
  return best;
}

/**
 * Detect voice commands in transcript text.
 * Returns command object or null.
 * @param {string} text
 * @param {Object} [options]
 * @param {boolean} [options.wakeWordEnabled] - AJOUT (Axe 3) : si true,
 *   toute commande dont le texte ne commence pas par une phrase
 *   d'activation connue (options.wakeWords) est ignorée. `false` par
 *   défaut — comportement HISTORIQUE inchangé pour tout appelant existant
 *   qui ne passe pas ce second argument (voir server.js, seul appelant
 *   avant ce chantier).
 * @param {string[]} [options.wakeWords] - phrases d'activation acceptées ;
 *   ignoré si wakeWordEnabled est false. Voir
 *   session-state.js#DEFAULT_VOICE_COMMAND_WAKE_WORDS pour le défaut réel
 *   utilisé par server.js.
 * @returns {{action: string, confidence: number, [key: string]: *}|null}
 */
function detectCommand(text, options = {}) {
  const { wakeWordEnabled = false, wakeWords = [] } = options;
  // CORRECTIF (audit round 6) : le regex `/\u0300-\u036f/g` (sans crochets)
  // ne supprimait en réalité AUCUN accent — un tiret hors classe de
  // caractères est un caractère littéral, donc cette expression cherchait
  // la séquence littérale improbable "\u0300-\u036f" au lieu de la plage de
  // marques diacritiques combinantes. Résultat : "Ramène" décomposé en NFD
  // restait "rame" + accent combinant + "ne" au lieu de "ramene", faisant
  // échouer silencieusement tout motif écrit sans accent (et inversement).
  let normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // AJOUT (Axe 3 \u2014 phrase d'activation) : porte franchie AVANT toute
  // tentative de d\u00e9tection de commande \u2014 un texte qui ne commence pas par
  // la phrase d'activation (avec tol\u00e9rance phon\u00e9tique, voir
  // matchesWakeWord()) n'est m\u00eame pas test\u00e9 contre COMMANDS, exactement
  // comme s'il ne contenait aucune commande.
  if (wakeWordEnabled) {
    const wake = matchesWakeWord(normalized, wakeWords);
    if (!wake.matched) return null;
    // Retire la phrase d'activation consomm\u00e9e AVANT de tester les motifs :
    // certains (ex. 'repeat') sont ANCR\u00c9S en d\u00e9but d'\u00e9nonc\u00e9 (`^...$`) \u2014 la
    // laisser dans le texte les emp\u00eacherait de matcher m\u00eame une fois
    // l'activation reconnue.
    const words = normalized.split(/\s+/).filter((w) => w.length > 0);
    normalized = words.slice(wake.consumedWords).join(' ');
  }

  for (const cmd of COMMANDS) {
    for (const pattern of cmd.patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;

      // AJOUT (Axe 3 \u2014 s\u00e9curisation phon\u00e9tique) : voir computeCommandConfidence()
      // ci-dessus. Une commande sous le seuil est trait\u00e9e comme un motif
      // NON satisfait \u2014 on continue d'essayer les autres motifs/commandes
      // plut\u00f4t que d'abandonner detectCommand() enti\u00e8rement pour ce texte.
      const confidence = computeCommandConfidence(match[0], cmd.keywords);
      if (confidence < COMMAND_CONFIDENCE_THRESHOLD) {
        console.log(
          `[voice-command] Commande vocale ambigu\u00eb ignor\u00e9e (confiance ${Math.round(confidence * 100)}%, ` +
            `seuil ${Math.round(COMMAND_CONFIDENCE_THRESHOLD * 100)}%) : "${cmd.id}" depuis "${text.substring(0, 60)}..."`
        );
        continue;
      }

      const result = cmd.extract(match);
      console.log(
        `[voice-command] Detected "${cmd.id}" (confiance ${Math.round(confidence * 100)}%) from: "${text.substring(0, 60)}..."`
      );
      return { ...result, confidence };
    }
  }
  return null;
}

/**
 * Get list of all available commands (for documentation/UI)
 */
function getAvailableCommands() {
  return COMMANDS.map((c) => ({
    id: c.id,
    description: c.patterns.map((p) => p.toString()).join(' | '),
  }));
}

module.exports = {
  detectCommand,
  getAvailableCommands,
  COMMANDS,
  // AJOUT (Axe 3 — sécurisation des commandes vocales) : exposées pour
  // tests unitaires directs et réutilisation éventuelle ailleurs.
  matchesWakeWord,
  computeCommandConfidence,
  normalizeCommandText,
  COMMAND_CONFIDENCE_THRESHOLD,
  WAKE_WORD_CONFIDENCE_THRESHOLD,
};
