'use strict';
/**
 * Tests unitaires pour ai-theme-generator.js — AIThemeGenerator.
 * Couvre : repli sur thème par règles quand l'IA échoue, et notification
 * onError() (A.2 — visibilité des échecs IA, voir llm-utils.js).
 * Les appels LLM sont mockés — pas de vrai appel API.
 *
 * AJOUT (chantier "Prompt-to-Theme") : génération sur mesure depuis une
 * description libre (generateThemeFromPrompt/isValidGeneratedTheme) +
 * propagation WebSocket (le handler generateTheme dans
 * reading-translation-ws-handlers.js, testé ici avec un broadcast/themeLoader
 * factices — même esprit que test-sermon-qa.js : tester la vraie logique
 * métier, pas un mock qui ne prouverait rien).
 */
const assert = require('assert');
const {
  AIThemeGenerator,
  generateThemeFromPrompt,
  isValidGeneratedTheme,
  PROMPT_TO_THEME_TIMEOUT_MS,
} = require('../ai-theme-generator');
const readingTranslationWsHandlers = require('../reading-translation-ws-handlers');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log('[TEST] ✓', name);
    passed++;
  } else {
    console.error('[TEST] ✗', name);
    failed++;
  }
}

console.log('=== Tests ai-theme-generator.js ===');

// AJOUT (chantier "Prompt-to-Theme") : gabarit d'un thème structurellement
// valide, réutilisé/muté par les tests ci-dessous.
const VALID_THEME = {
  name: 'Aube de Pâques',
  backgroundGradient: 'linear-gradient(135deg, #FFF8E1 0%, #FFD54A 100%)',
  textColor: '#4A3300',
  accentColor: '#FF6F00',
  fontFamily: '"Playfair Display", Georgia, serif',
  animationStyle: 'rise-up',
  particleColor: '#FFD54A',
  glowColor: 'rgba(255, 213, 74, 0.35)',
  borderColor: 'rgba(255, 255, 255, 0.3)',
  shadowColor: 'rgba(0, 0, 0, 0.3)',
};

// --- isValidGeneratedTheme() : garde-fou structurel (item 1 — "valide
// impérativement la structure JSON") ---------------------------------------
console.log('[TEST] isValidGeneratedTheme()...');
check('thème complet et bien formé -> valide', isValidGeneratedTheme(VALID_THEME) === true);
check('null -> invalide', isValidGeneratedTheme(null) === false);
check('tableau -> invalide', isValidGeneratedTheme([1, 2, 3]) === false);
check(
  'champ manquant (accentColor) -> invalide',
  isValidGeneratedTheme({ ...VALID_THEME, accentColor: undefined }) === false
);
check(
  'couleur non-hex (textColor="mauve") -> invalide',
  isValidGeneratedTheme({ ...VALID_THEME, textColor: 'mauve' }) === false
);
check(
  'animationStyle halluciné (hors énumération) -> invalide',
  isValidGeneratedTheme({ ...VALID_THEME, animationStyle: 'sparkle-explosion' }) === false
);
check(
  'glowColor mal formé (pas du rgba()) -> invalide',
  isValidGeneratedTheme({ ...VALID_THEME, glowColor: '#FF0000' }) === false
);
check(
  'backgroundGradient sans gradient CSS -> invalide',
  isValidGeneratedTheme({ ...VALID_THEME, backgroundGradient: 'red' }) === false
);
check(
  'champ trop long (>300 caractères) -> invalide',
  isValidGeneratedTheme({ ...VALID_THEME, name: 'x'.repeat(301) }) === false
);
console.log('[TEST] ✓ isValidGeneratedTheme() rejette toute valeur hallucinée/hors format\n');

async function runAsyncTests() {
  // --- Pas de groq : repli direct sur le thème par règles ---
  const g1 = new AIThemeGenerator(null);
  const t1 = await g1.generate('Réjouissez-vous, il y a de la joie', '', 'auto');
  check('sans groq: thème par règles (source rule)', t1.source === 'rule');
  check('sans groq: aucune erreur comptée', g1.getStats().errorCount === 0);

  // --- Groq échoue en plein appel : repli sur le thème par règles, ET
  //     onError notifié (avant ce chantier, seulement un console.warn) ---
  const mockGroqError = {
    chatCompletion: async () => {
      throw new Error('Groq indisponible');
    },
  };
  const g2 = new AIThemeGenerator(mockGroqError);
  let g2ErrorMessage = null;
  g2.onError = (message) => {
    g2ErrorMessage = message;
  };
  const t2 = await g2.generate('Réjouissez-vous, il y a de la joie', '', 'auto');
  check('erreur LLM: repli sur le thème par règles', t2.source === 'rule');
  check('erreur LLM: onError notifié', g2ErrorMessage === 'Groq indisponible');
  check('erreur LLM: getStats().errorCount incrémenté', g2.getStats().errorCount === 1);
  check(
    'erreur LLM: getStats().lastError renseigné',
    g2.getStats().lastError.message === 'Groq indisponible'
  );

  // --- Groq répond correctement : thème IA utilisé, pas d'erreur comptée ---
  const mockGroqOk = {
    chatCompletion: async () => ({
      text: JSON.stringify({
        name: 'Joie éclatante',
        backgroundGradient: 'linear-gradient(red, yellow)',
        textColor: '#ffffff',
        accentColor: '#ffcc00',
        fontFamily: 'sans-serif',
        animationStyle: 'bloom',
        particleColor: '#ffcc00',
        glowColor: 'rgba(255,204,0,0.5)',
        borderColor: 'rgba(255,255,255,0.3)',
        shadowColor: 'rgba(0,0,0,0.3)',
        mood: 'joy',
      }),
      model: 'test',
      usage: {},
    }),
  };
  const g3 = new AIThemeGenerator(mockGroqOk);
  const t3 = await g3.generate('Réjouissez-vous, il y a de la joie', '', 'auto');
  check('succès LLM: thème IA utilisé (source ai)', t3.source === 'ai');
  check('succès LLM: aucune erreur comptée', g3.getStats().errorCount === 0);

  // ==========================================================================
  // AJOUT (chantier "Prompt-to-Theme") — item 1 : génération structurée
  // ==========================================================================

  // --- Génération valide d'un thème depuis une description libre ---
  console.log('[TEST] Prompt-to-Theme: génération valide...');
  let lastPromptSeen = null;
  const mockGroqValidPrompt = {
    chatCompletion: async (prompt, options) => {
      lastPromptSeen = { prompt, options };
      return { text: JSON.stringify(VALID_THEME), model: 'test', usage: {} };
    },
  };
  const gPrompt1 = new AIThemeGenerator(mockGroqValidPrompt);
  const promptTheme = await gPrompt1.generateFromPrompt('Culte de Pâques lumineux');
  check(
    'Prompt-to-Theme: thème généré avec source=ai',
    !!promptTheme && promptTheme.source === 'ai'
  );
  check('Prompt-to-Theme: le nom du thème généré est conservé', promptTheme.name === VALID_THEME.name);
  check(
    'Prompt-to-Theme: le timeout de 5s (item 2) est bien transmis à chatCompletion',
    lastPromptSeen.options.timeoutMs === PROMPT_TO_THEME_TIMEOUT_MS && PROMPT_TO_THEME_TIMEOUT_MS === 5000
  );
  check(
    'Prompt-to-Theme: la description de l’opérateur est bien interpolée dans le prompt LLM',
    lastPromptSeen.prompt.includes('Culte de Pâques lumineux')
  );
  console.log('[TEST] ✓ Génération valide correcte\n');

  // --- Récupération après un JSON syntaxiquement invalide ---
  console.log('[TEST] Prompt-to-Theme: JSON invalide -> null (pas de crash)...');
  const mockGroqBrokenJson = {
    chatCompletion: async () => ({
      text: 'Voici votre thème : { "name": "Oups"; backgroundGradient: manquant de guillemets }',
      model: 'test',
      usage: {},
    }),
  };
  const gPrompt2 = new AIThemeGenerator(mockGroqBrokenJson);
  const brokenResult = await gPrompt2.generateFromPrompt('Un thème quelconque');
  check('Prompt-to-Theme: JSON invalide -> null renvoyé (jamais une exception)', brokenResult === null);
  console.log('[TEST] ✓ JSON invalide neutralisé sans crash\n');

  // --- Récupération après un JSON valide mais structurellement invalide
  // (valeurs hallucinées) — extractJsonObject() réussirait à le parser, mais
  // isValidGeneratedTheme() doit quand même le rejeter dans son ENSEMBLE. ---
  console.log('[TEST] Prompt-to-Theme: JSON valide mais structure invalide -> null...');
  const mockGroqInvalidStructure = {
    chatCompletion: async () => ({
      text: JSON.stringify({ ...VALID_THEME, textColor: 'un joli mauve' }),
      model: 'test',
      usage: {},
    }),
  };
  const gPrompt3 = new AIThemeGenerator(mockGroqInvalidStructure);
  const invalidStructureResult = await gPrompt3.generateFromPrompt('Un thème quelconque');
  check(
    'Prompt-to-Theme: structure invalide (couleur non-hex) -> null renvoyé',
    invalidStructureResult === null
  );
  console.log('[TEST] ✓ Structure invalide neutralisée sans crash\n');

  // --- Timeout Groq (dépassement du délai) — repli identique à une erreur ---
  console.log('[TEST] Prompt-to-Theme: timeout LLM -> null...');
  const mockGroqTimeout = {
    chatCompletion: async () => {
      throw new Error('Timeout Groq Chat (5000ms)');
    },
  };
  const gPrompt4 = new AIThemeGenerator(mockGroqTimeout);
  let timeoutErrorSeen = null;
  gPrompt4.onError = (message) => {
    timeoutErrorSeen = message;
  };
  const timeoutResult = await gPrompt4.generateFromPrompt('Un thème quelconque');
  check('Prompt-to-Theme: timeout -> null renvoyé', timeoutResult === null);
  check('Prompt-to-Theme: timeout -> onError notifié', timeoutErrorSeen === 'Timeout Groq Chat (5000ms)');
  console.log('[TEST] ✓ Timeout neutralisé, observé via onError\n');

  // --- Sans IA configurée / description vide : jamais d'appel LLM ---
  console.log('[TEST] Prompt-to-Theme: garde-fous (pas de groq / description vide)...');
  const gNoAi = new AIThemeGenerator(null);
  check(
    'Prompt-to-Theme: sans groq -> null immédiatement (aucun appel)',
    (await gNoAi.generateFromPrompt('Peu importe')) === null
  );
  let neverCalled = true;
  const mockGroqShouldNotBeCalled = {
    chatCompletion: async () => {
      neverCalled = false;
      return { text: JSON.stringify(VALID_THEME), model: 'test', usage: {} };
    },
  };
  const gEmptyDesc = new AIThemeGenerator(mockGroqShouldNotBeCalled);
  const emptyDescResult = await gEmptyDesc.generateFromPrompt('   ');
  check('Prompt-to-Theme: description vide -> null', emptyDescResult === null);
  check('Prompt-to-Theme: description vide -> chatCompletion jamais appelée', neverCalled);
  console.log('[TEST] ✓ Garde-fous corrects\n');

  // ==========================================================================
  // AJOUT (chantier "Prompt-to-Theme") — item 2 + item 3 : fallback garanti
  // et propagation aux overlays via WebSocket (handler generateTheme)
  // ==========================================================================
  function makeHandlerCtx({ themeGenerator, themeLoader }) {
    const broadcasts = [];
    const wsMessages = [];
    const handlers = readingTranslationWsHandlers.createHandlers({
      sessionState: {},
      bibleLookup: {},
      detector: {},
      readingMode: {},
      themeGenerator,
      themeLoader,
      aiEnricher: null,
      sanitizeForPrompt: (text) => text,
      broadcast: (msg) => broadcasts.push(msg),
      log: () => {},
      pushHistory: () => {},
      getVerseDurationMs: () => 8000,
      readingModePosition: () => null,
      advanceReadingModeVerse: () => {},
      advanceReadingModeChapter: async () => {},
    });
    const ws = { send: (raw) => wsMessages.push(JSON.parse(raw)) };
    return { handlers, ws, broadcasts, wsMessages };
  }

  // --- Propagation : génération réussie -> applyTheme diffusé aux overlays,
  // ET la réponse à l'opérateur (themeGenerated) reflète le vrai thème. ---
  console.log('[TEST] generateTheme (WS): propagation réussie vers les overlays...');
  {
    const fakeThemeGenerator = {
      generateFromPrompt: async () => ({ ...VALID_THEME, source: 'ai' }),
      themeToCss: (theme) => ({
        background: theme.backgroundGradient,
        color: theme.textColor,
        accentColor: theme.accentColor,
        mood: 'default',
        source: theme.source,
      }),
    };
    const { handlers, ws, broadcasts, wsMessages } = makeHandlerCtx({
      themeGenerator: fakeThemeGenerator,
      themeLoader: { loadTheme: () => ({}), themeToCss: () => ({}) },
    });
    await handlers.get('generateTheme')(ws, { description: 'Culte de Pâques lumineux' });

    check('generateTheme (WS): un applyTheme est bien diffusé', broadcasts.length === 1);
    check(
      'generateTheme (WS): les couleurs générées atteignent bien le payload applyTheme',
      broadcasts[0].action === 'applyTheme' &&
        broadcasts[0].background === VALID_THEME.backgroundGradient &&
        broadcasts[0].color === VALID_THEME.textColor
    );
    check(
      'generateTheme (WS): réponse themeGenerated correcte (pas de repli)',
      wsMessages[0].action === 'themeGenerated' &&
        wsMessages[0].ok === true &&
        wsMessages[0].usedFallback === false &&
        wsMessages[0].themeName === VALID_THEME.name
    );
  }
  console.log('[TEST] ✓ Styles propagés aux overlays via applyTheme\n');

  // --- Fallback garanti : génération en échec (IA renvoie null) -> Mission
  // Control appliqué à la place, JAMAIS de rendu à moitié appliqué. ---
  console.log('[TEST] generateTheme (WS): fallback garanti sur Mission Control...');
  {
    const fakeThemeGeneratorFails = {
      generateFromPrompt: async () => null, // JSON invalide/timeout/IA désactivée...
      themeToCss: () => {
        throw new Error('ne doit jamais être appelé sur un résultat null');
      },
    };
    const fakeThemeLoader = {
      loadTheme: (id) => {
        check('generateTheme (WS): le repli demande bien le thème "mission-control"', id === 'mission-control');
        return { id: 'mission-control', name: 'Mission Control' };
      },
      themeToCss: () => ({
        variables: { '--bg': 'MISSION-CONTROL-BG', '--text': '#FFFFFF' },
      }),
    };
    const { handlers, ws, broadcasts, wsMessages } = makeHandlerCtx({
      themeGenerator: fakeThemeGeneratorFails,
      themeLoader: fakeThemeLoader,
    });
    await handlers.get('generateTheme')(ws, { description: 'Une description quelconque' });

    check(
      'generateTheme (WS): un applyTheme de secours est quand même diffusé (jamais silencieux)',
      broadcasts.length === 1 && broadcasts[0].action === 'applyTheme'
    );
    check(
      'generateTheme (WS): le payload de secours est bien celui de Mission Control',
      broadcasts[0].variables && broadcasts[0].variables['--bg'] === 'MISSION-CONTROL-BG'
    );
    check(
      'generateTheme (WS): réponse themeGenerated signale le repli (usedFallback=true)',
      wsMessages[0].action === 'themeGenerated' &&
        wsMessages[0].usedFallback === true &&
        wsMessages[0].themeName === 'Mission Control'
    );
  }
  console.log('[TEST] ✓ Fallback garanti sur Mission Control — jamais de rendu cassé\n');

  // --- Sans générateur de thème du tout (module IA absent) : repli garanti
  // quand même, pas d'exception qui remonterait au dispatcher WS. ---
  console.log('[TEST] generateTheme (WS): themeGenerator absent -> repli garanti quand même...');
  {
    const fakeThemeLoader = {
      loadTheme: () => ({ id: 'mission-control', name: 'Mission Control' }),
      themeToCss: () => ({ variables: { '--bg': 'MISSION-CONTROL-BG' } }),
    };
    const { handlers, ws, broadcasts, wsMessages } = makeHandlerCtx({
      themeGenerator: null,
      themeLoader: fakeThemeLoader,
    });
    await handlers.get('generateTheme')(ws, { description: 'Peu importe' });
    check(
      'generateTheme (WS): sans themeGenerator, le repli Mission Control est quand même diffusé',
      broadcasts.length === 1 && broadcasts[0].variables['--bg'] === 'MISSION-CONTROL-BG'
    );
    check(
      'generateTheme (WS): sans themeGenerator, la réponse signale bien le repli',
      wsMessages[0].usedFallback === true
    );
  }
  console.log('[TEST] ✓ Repli garanti même sans module IA chargé\n');
}

runAsyncTests().then(() => {
  console.log(`\n=== Résultat ai-theme-generator : ${passed}/${passed + failed} ===`);
  if (failed > 0) process.exit(1);
});
