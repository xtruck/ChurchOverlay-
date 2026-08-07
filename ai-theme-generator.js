/**
 * ============================================================================
 * ai-theme-generator.js — Dynamic Theme Generation for ChurchOverlay
 * ============================================================================
 * Generates CSS themes based on sermon content, verse text, or mood.
 * 
 * Two modes:
 *   1. RULE-BASED: Maps keywords to predefined color palettes (instant, offline)
 *   2. AI-POWERED: Uses Groq LLM to generate custom themes (requires API)
 * 
 * Integration: Call when verse is detected, apply result to overlay via
 * broadcast({ action: 'applyTheme', ...theme }).
 * ============================================================================
 */

'use strict';

// -----------------------------------------------------------------------
// Predefined mood-based themes (rule-based, works offline)
// -----------------------------------------------------------------------
const MOOD_THEMES = {
  // Joy / Celebration
  joy: {
    name: 'Joie',
    backgroundGradient: 'linear-gradient(135deg, #FFD700 0%, #FFA500 50%, #FF6347 100%)',
    textColor: '#FFFFFF',
    accentColor: '#FFD700',
    fontFamily: '"Playfair Display", Georgia, serif',
    animationStyle: 'fade-in-up',
    particleColor: '#FFD700',
    glowColor: 'rgba(255, 215, 0, 0.3)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
    shadowColor: 'rgba(255, 140, 0, 0.4)',
  },

  // Peace / Calm
  peace: {
    name: 'Paix',
    backgroundGradient: 'linear-gradient(135deg, #E0F7FA 0%, #B2EBF2 50%, #80DEEA 100%)',
    textColor: '#006064',
    accentColor: '#00ACC1',
    fontFamily: '"Lora", "Times New Roman", serif',
    animationStyle: 'gentle-fade',
    particleColor: '#B2EBF2',
    glowColor: 'rgba(0, 172, 193, 0.2)',
    borderColor: 'rgba(0, 150, 136, 0.2)',
    shadowColor: 'rgba(0, 131, 143, 0.3)',
  },

  // Repentance / Serious
  repentance: {
    name: 'Repentance',
    backgroundGradient: 'linear-gradient(135deg, #2C3E50 0%, #4A235A 50%, #1B2631 100%)',
    textColor: '#E8DAEF',
    accentColor: '#9B59B6',
    fontFamily: '"Cinzel", Georgia, serif',
    animationStyle: 'solemn-fade',
    particleColor: '#9B59B6',
    glowColor: 'rgba(155, 89, 182, 0.2)',
    borderColor: 'rgba(155, 89, 182, 0.3)',
    shadowColor: 'rgba(0, 0, 0, 0.6)',
  },

  // Love / Grace
  love: {
    name: 'Amour',
    backgroundGradient: 'linear-gradient(135deg, #FFEBEE 0%, #F8BBD0 50%, #F48FB1 100%)',
    textColor: '#880E4F',
    accentColor: '#E91E63',
    fontFamily: '"Great Vibes", cursive',
    animationStyle: 'heart-fade',
    particleColor: '#F48FB1',
    glowColor: 'rgba(233, 30, 99, 0.2)',
    borderColor: 'rgba(233, 30, 99, 0.2)',
    shadowColor: 'rgba(136, 14, 79, 0.3)',
  },

  // Faith / Trust
  faith: {
    name: 'Foi',
    backgroundGradient: 'linear-gradient(135deg, #FFF3E0 0%, #FFE0B2 50%, #FFCC80 100%)',
    textColor: '#E65100',
    accentColor: '#FF9800',
    fontFamily: '"Merriweather", Georgia, serif',
    animationStyle: 'rise-up',
    particleColor: '#FFB74D',
    glowColor: 'rgba(255, 152, 0, 0.2)',
    borderColor: 'rgba(255, 152, 0, 0.2)',
    shadowColor: 'rgba(230, 81, 0, 0.3)',
  },

  // Hope / Future
  hope: {
    name: 'Espoir',
    backgroundGradient: 'linear-gradient(135deg, #E8F5E9 0%, #C8E6C9 50%, #A5D6A7 100%)',
    textColor: '#1B5E20',
    accentColor: '#4CAF50',
    fontFamily: '"Open Sans", sans-serif',
    animationStyle: 'bloom',
    particleColor: '#81C784',
    glowColor: 'rgba(76, 175, 80, 0.2)',
    borderColor: 'rgba(76, 175, 80, 0.2)',
    shadowColor: 'rgba(27, 94, 32, 0.3)',
  },

  // Holy Spirit / Power
  spirit: {
    name: 'Esprit Saint',
    backgroundGradient: 'linear-gradient(135deg, #F3E5F5 0%, #E1BEE7 50%, #CE93D8 100%)',
    textColor: '#4A148C',
    accentColor: '#9C27B0',
    fontFamily: '"Cinzel Decorative", serif',
    animationStyle: 'spirit-wind',
    particleColor: '#BA68C8',
    glowColor: 'rgba(156, 39, 176, 0.3)',
    borderColor: 'rgba(156, 39, 176, 0.3)',
    shadowColor: 'rgba(74, 20, 140, 0.4)',
  },

  // Cross / Sacrifice
  sacrifice: {
    name: 'Sacrifice',
    backgroundGradient: 'linear-gradient(135deg, #3E2723 0%, #5D4037 50%, #4E342E 100%)',
    textColor: '#EFEBE9',
    accentColor: '#8D6E63',
    fontFamily: '"Cinzel", Georgia, serif',
    animationStyle: 'solemn-fade',
    particleColor: '#A1887F',
    glowColor: 'rgba(141, 110, 99, 0.2)',
    borderColor: 'rgba(141, 110, 99, 0.3)',
    shadowColor: 'rgba(0, 0, 0, 0.5)',
  },

  // Default / Neutral
  default: {
    name: 'Défaut',
    backgroundGradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    textColor: '#FFFFFF',
    accentColor: '#e94560',
    fontFamily: '"Playfair Display", Georgia, serif',
    animationStyle: 'fade-in-up',
    particleColor: '#e94560',
    glowColor: 'rgba(233, 69, 96, 0.3)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    shadowColor: 'rgba(0, 0, 0, 0.5)',
  },

  // ---------------------------------------------------------------------
  // AJOUT (audit — "ambiances" par phase de culte, gratuit/léger). Les 8
  // moods ci-dessus réagissent au CONTENU émotionnel d'un verset (joie,
  // paix...). Ceux-ci réagissent à la PHASE DU CULTE elle-même (prière,
  // louange, communion, silence) — même mécanisme (mots-clés, aucun appel
  // API), mais un signal plus intentionnel : quand un pasteur dit "prions
  // ensemble", ce n'est pas un sujet émotionnel, c'est une instruction. Ces
  // 4 clés correspondent exactement à design.ambientModes dans
  // config/features.json (["preaching","prayer","worship","silence",
  // "communion"]) — une liste déjà présente mais jamais construite ; le 5e
  // état ("preaching") est simplement le mood "default" ci-dessus, donc pas
  // dupliqué ici. Couleurs ancrées dans la tradition liturgique occidentale
  // (violet = pénitence, blanc/or = joie, rouge = passion/sang, vert =
  // temps ordinaire — codifiées après le Concile de Trente, 1570) plutôt
  // qu'inventées : voir le commentaire de chaque entrée.
  // ---------------------------------------------------------------------
  prayer: {
    name: 'Prière',
    // Pas une des 6 couleurs liturgiques officielles — inspiré des veillées
    // à la bougie (tradition Taizé et vigiles de prière) : obscurité douce,
    // lueur chaude et basse, aucune agitation visuelle. Volontairement le
    // mood le plus SOMBRE et le plus IMMOBILE du système après "silence".
    backgroundGradient: 'linear-gradient(135deg, #0d0b1a 0%, #1a1428 50%, #2b1f1a 100%)',
    textColor: '#F0E6D2',
    accentColor: '#C9A15A',
    fontFamily: '"Cormorant Garamond", Georgia, serif',
    animationStyle: 'gentle-fade',
    particleColor: '#C9A15A',
    glowColor: 'rgba(201, 161, 90, 0.15)',
    borderColor: 'rgba(201, 161, 90, 0.15)',
    shadowColor: 'rgba(0, 0, 0, 0.7)',
  },
  worship: {
    name: 'Louange',
    // Blanc/or : couleur liturgique de la joie (Noël, Pâques, Pentecôte —
    // voir liturgical colours). Distinct de "joy" ci-dessus par une
    // animation plus vive ("rise-up", déjà utilisée par "faith") — pensé
    // pour un moment de chant/louange debout, pas juste un verset joyeux.
    backgroundGradient: 'linear-gradient(135deg, #FFF8E1 0%, #FFE082 50%, #FFB300 100%)',
    textColor: '#4A3300',
    accentColor: '#FF6F00',
    fontFamily: '"Playfair Display", Georgia, serif',
    animationStyle: 'rise-up',
    particleColor: '#FFD54A',
    glowColor: 'rgba(255, 179, 0, 0.35)',
    borderColor: 'rgba(255, 255, 255, 0.3)',
    shadowColor: 'rgba(255, 111, 0, 0.3)',
  },
  communion: {
    name: 'Communion',
    // Rouge liturgique (Passion/sang du Christ) + ivoire (pureté du
    // sacrement) — le pain et la coupe. Note d'audit : "sacrifice" plus
    // haut utilise du brun, pas un vrai rouge liturgique ; ce mood corrige
    // cet écart pour le moment le plus solennel du culte.
    backgroundGradient: 'linear-gradient(135deg, #F5F0E8 0%, #6B1420 60%, #3D0C12 100%)',
    textColor: '#F5F0E8',
    accentColor: '#C9A15A',
    fontFamily: '"Cinzel", Georgia, serif',
    animationStyle: 'solemn-fade',
    particleColor: '#8B1A2B',
    glowColor: 'rgba(139, 26, 43, 0.25)',
    borderColor: 'rgba(201, 161, 90, 0.25)',
    shadowColor: 'rgba(0, 0, 0, 0.6)',
  },
  silence: {
    name: 'Silence',
    // Le mood le plus discret du système, délibérément : quasi-noir, texte
    // atténué, aucune particule visible (couleur transparente) — pensé pour
    // un temps de recueillement silencieux où l'écran ne doit RIEN
    // réclamer à l'attention de l'assemblée.
    backgroundGradient: 'linear-gradient(135deg, #050505 0%, #0a0a0c 100%)',
    textColor: '#8A8A8A',
    accentColor: '#4A4A4A',
    fontFamily: '"Playfair Display", Georgia, serif',
    animationStyle: 'gentle-fade',
    particleColor: 'transparent',
    glowColor: 'transparent',
    borderColor: 'rgba(255, 255, 255, 0.05)',
    shadowColor: 'rgba(0, 0, 0, 0.8)',
  },
};

// -----------------------------------------------------------------------
// Keyword → mood mapping
// -----------------------------------------------------------------------
const MOOD_KEYWORDS = {
  // CORRECTIF (audit — ambiances par phase de culte) : "louange"/"chantez"/
  // "sing" retirés d'ici, déplacés vers "worship" ci-dessous — un signal de
  // phase de culte ("levons-nous pour chanter") est plus précis qu'un
  // simple mot-clé émotionnel, et les deux se disputaient le même mot.
  joy: ['joie', 'joy', 'rejouis', 'alléluia', 'alleluia', 'hallelujah', 'gloire', 'célébrer', 'celebrate', 'fête', 'fete', 'triomphe', 'victoire', 'victory', 'exulte'],
  // CORRECTIF : "silence"/"quiet" retirés d'ici, déplacés vers "silence"
  // ci-dessous, pour la même raison.
  peace: ['paix', 'peace', 'calme', 'calm', 'tranquille', 'repos', 'rest', 'sérénité', 'serenity', 'refuge', 'abri', 'shelter'],
  repentance: ['repentance', 'repentir', 'péché', 'peche', 'sin', 'jugement', 'judgment', 'sérieux', 'serious', 'grave', 'somber', 'sombre', 'ténèbres', 'darkness', 'deuil', 'mourning'],
  love: ['amour', 'love', 'charité', 'charity', 'grâce', 'grace', 'miséricorde', 'mercy', 'compassion', 'tendresse', 'tenderness', 'bienveillance', 'kindness'],
  faith: ['foi', 'faith', 'confiance', 'trust', 'croire', 'believe', 'croyance', 'conviction', 'assurance', 'ferme', 'steadfast'],
  hope: ['espoir', 'hope', 'avenir', 'future', 'attendre', 'wait', 'patience', 'patient', 'promesse', 'promise', 'renouveau', 'renewal', 'restauration', 'restoration'],
  spirit: ['esprit saint', 'holy spirit', 'pentecôte', 'pentecost', 'feu', 'fire', 'vent', 'wind', 'puissance', 'power', 'onction', 'anointing', 'miracle', 'gloire', 'glory'],
  sacrifice: ['croix', 'cross', 'sacrifice', 'sang', 'blood', 'agonie', 'agony', 'passion', 'crucifié', 'crucified', 'rédemption', 'redemption', 'expiation', 'atonement'],

  // --- AJOUT (audit — phase de culte, bilingue FR/EN) : phrases que dit
  // RÉELLEMENT un pasteur/animateur pour signaler un changement de moment
  // (pas des mots isolés — évite tout faux positif avec le vocabulaire
  // émotionnel ci-dessus). ---
  // NB : normalize() ci-dessous (dans detectMood) retire les accents du
  // texte transcrit avant comparaison — ces mots-clés doivent donc être
  // écrits SANS accent pour matcher réellement (ex. "priere", pas
  // "prière"), même règle déjà suivie par "peche"/"peche" plus haut dans
  // le fichier.
  prayer: [
    'prions', 'prions ensemble', 'inclinons la tete', 'inclinons nos tetes',
    'seigneur nous te prions', 'esprit de priere', 'let us pray', 'lets pray',
    'bow your heads', 'bow our heads', 'in a spirit of prayer', 'time of prayer',
    'moment de priere', 'temps de priere',
  ],
  worship: [
    'louange', 'louons', 'chantez', 'chantons', 'levons nos mains', 'adorons',
    'temps de louange', 'moment de louange', 'sing', 'let us worship', 'lets worship',
    'lift your hands', 'time of worship', 'moment of worship', 'praise and worship',
  ],
  communion: [
    'sainte cene', 'la communion', 'prenons la communion', 'le pain et la coupe',
    'le corps et le sang', 'holy communion', "the lord's supper", 'lords supper',
    'the bread and the cup', 'body and blood', 'take communion',
  ],
  silence: [
    'moment de silence', 'temps de silence', 'silence devant dieu', 'recueillons-nous',
    'recueillement', 'a moment of silence', 'time of silence', 'quiet before the lord',
    'let us be still', 'lets be still', 'be still',
  ],
};

// -----------------------------------------------------------------------
// Detect mood from text
// -----------------------------------------------------------------------
function detectMood(text) {
  // CORRECTIF (audit \u2014 m\u00eame bug que detectCommand() dans voice-commands.js,
  // jamais appliqu\u00e9 ici) : `/\u0300-\u036f/g` SANS crochets est une classe
  // de caract\u00e8res invalide \u2014 un tiret hors `[...]` est un caract\u00e8re
  // litt\u00e9ral, donc cette expression cherchait la s\u00e9quence improbable
  // "U+0300, -, U+036F" au lieu de la PLAGE des marques diacritiques
  // combinantes. R\u00e9sultat r\u00e9el : le d\u00e9-accentuage NFD ne retirait jamais
  // aucun accent, pour aucun des 8 moods d'origine \u2014 un texte transcrit
  // avec des accents corrects ("pri\u00e8re", "c\u00e8ne"...) ne matchait donc que
  // les mots-cl\u00e9s eux-m\u00eames accentu\u00e9s (rares dans MOOD_KEYWORDS, qui
  // privil\u00e9gie d\u00e9j\u00e0 la forme sans accent). Avec les crochets, la plage
  // fonctionne enfin comme document\u00e9.
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const scores = {};

  for (const [mood, keywords] of Object.entries(MOOD_KEYWORDS)) {
    scores[mood] = keywords.filter(kw => normalized.includes(kw)).length;
  }

  const bestMood = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])[0];

  return bestMood ? bestMood[0] : 'default';
}

// -----------------------------------------------------------------------
// AI-Powered Theme Generation (requires Groq)
// -----------------------------------------------------------------------
async function generateAITheme(verseText, sermonContext, groqWrapper) {
  if (!groqWrapper) return null;

  try {
    const prompt = `Generate a CSS theme for a church Bible verse overlay.

Verse text: "${verseText}"
Sermon context: "${sermonContext || 'None'}"

Respond ONLY with valid JSON:
{
  "name": "Theme name in French",
  "backgroundGradient": "CSS linear-gradient",
  "textColor": "#hex color",
  "accentColor": "#hex color", 
  "fontFamily": "CSS font stack",
  "animationStyle": "fade-in-up|gentle-fade|solemn-fade|heart-fade|rise-up|bloom|spirit-wind",
  "particleColor": "#hex color",
  "glowColor": "rgba() color",
  "borderColor": "rgba() color",
  "shadowColor": "rgba() color",
  "mood": "joy|peace|repentance|love|faith|hope|spirit|sacrifice|default"
}

Rules:
- Colors must have excellent contrast (WCAG AA)
- Background gradient should be subtle and elegant
- Font should be readable at distance (serif for tradition, sans-serif for modern)
- Animation should match the emotional tone
- Use French for the name field`;

    const response = await groqWrapper.chatCompletion(prompt, {
      model: 'llama-3.1-8b-instant',
      temperature: 0.3,
      max_tokens: 300,
    });

    const text = response.text || response;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const theme = JSON.parse(jsonMatch[0]);
    theme.source = 'ai';
    return theme;
  } catch (err) {
    console.warn('[theme-generator] AI theme generation failed:', err.message);
    return null;
  }
}

// -----------------------------------------------------------------------
// Main Theme Generator Class
// -----------------------------------------------------------------------
class AIThemeGenerator {
  constructor(groqWrapper) {
    this.groq = groqWrapper;
    this.currentMood = 'default';
    this.aiEnabled = !!groqWrapper;
  }

  /**
   * Generate theme from verse text
   * @param {string} verseText - The verse content
   * @param {string} sermonContext - Recent sermon transcript
   * @param {string} mode - 'auto' | 'rule' | 'ai'
   */
  async generate(verseText, sermonContext = '', mode = 'auto') {
    // Rule-based detection (always works)
    const mood = detectMood(verseText + ' ' + sermonContext);
    this.currentMood = mood;

    // If AI mode requested and available
    if ((mode === 'ai' || mode === 'auto') && this.aiEnabled && mood !== 'default') {
      const aiTheme = await generateAITheme(verseText, sermonContext, this.groq);
      if (aiTheme) {
        console.log(`[theme] AI theme generated: "${aiTheme.name}" (${aiTheme.mood})`);
        return aiTheme;
      }
    }

    // Fallback to rule-based
    const theme = MOOD_THEMES[mood] || MOOD_THEMES.default;
    theme.source = 'rule';
    return theme;
  }

  /**
   * Get a specific theme by mood name (used for manual/voice-triggered selection).
   * Falls back to the default theme if the mood is unknown.
   * @param {string} mood
   */
  getTheme(mood) {
    return MOOD_THEMES[mood] || MOOD_THEMES.default;
  }

  /**
   * List all available mood keys with their display names
   * (used to populate the dashboard theme-mood picker).
   */
  getMoods() {
    return Object.entries(MOOD_THEMES).map(([key, theme]) => ({
      id: key,
      name: theme.name,
    }));
  }

  /**
   * Convert a theme object into the flat CSS-variable payload expected
   * by overlay.html (mirrors theme-loader.js themeToCss shape so the
   * overlay can apply either a saved theme or an AI-generated one the
   * same way).
   * @param {object} theme
   */
  themeToCss(theme) {
    if (!theme) theme = MOOD_THEMES.default;
    return {
      themeName: theme.name,
      backgroundGradient: theme.backgroundGradient,
      textColor: theme.textColor,
      accentColor: theme.accentColor,
      fontFamily: theme.fontFamily,
      animationStyle: theme.animationStyle,
      particleColor: theme.particleColor,
      glowColor: theme.glowColor,
      borderColor: theme.borderColor,
      shadowColor: theme.shadowColor,
      mood: this.currentMood,
      source: theme.source || 'rule',
    };
  }
}

module.exports = { AIThemeGenerator, MOOD_THEMES, detectMood };
