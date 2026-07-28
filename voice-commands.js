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
      reference: { book: match[1].toLowerCase(), chapter: parseInt(match[2]), verseStart: parseInt(match[3]) },
    }),
  },
  {
    id: 'hideOverlay',
    patterns: [
      /(?:cache|masque|hide|retire|enlève).*(?:overlay|verset|texte|écran)/i,
      /(?:efface|clear|clean).*(?:écran|screen)/i,
    ],
    extract: () => ({ action: 'hideVerse' }),
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
  },
  {
    id: 'nextVerse',
    patterns: [
      /(?:verset|passage)\s+suivant/i,
      /(?:passe|avance)\s+(?:au\s+)?(?:verset|passage)\s+suivant/i,
      /next\s+verse/i,
    ],
    extract: () => ({ action: 'nextVerse' }),
  },
  {
    id: 'previousVerse',
    patterns: [
      /(?:verset|passage)\s+(?:précédent|précédant|d'avant)/i,
      /(?:retourne|reviens)\s+(?:au\s+)?(?:verset|passage)\s+(?:précédent|d'avant)/i,
      /previous\s+verse/i,
    ],
    extract: () => ({ action: 'previousVerse' }),
  },

  // --- THEME ---
  {
    id: 'themeDark',
    patterns: [
      /(?:thème|theme|style)\s+(?:sombre|dark|noir|black)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers)\s+(?:thème\s+)?sombre/i,
    ],
    extract: () => ({ action: 'setTheme', theme: 'dark' }),
  },
  {
    id: 'themeLight',
    patterns: [
      /(?:thème|theme|style)\s+(?:clair|light|blanc|white)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers)\s+(?:thème\s+)?clair/i,
    ],
    extract: () => ({ action: 'setTheme', theme: 'light' }),
  },
  {
    id: 'themeGold',
    patterns: [
      /(?:thème|theme|style)\s+(?:or|gold|doré|golden)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers)\s+(?:thème\s+)?or/i,
    ],
    extract: () => ({ action: 'setTheme', theme: 'gold' }),
  },

  // --- LANGUAGE ---
  {
    id: 'langFrench',
    patterns: [
      /(?:langue|language|affiche)\s+(?:français|fr|french)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers)\s+(?:français|fr)/i,
    ],
    extract: () => ({ action: 'setLanguage', language: 'fr' }),
  },
  {
    id: 'langEnglish',
    patterns: [
      /(?:langue|language|affiche)\s+(?:anglais|en|english)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers)\s+(?:anglais|en)/i,
    ],
    extract: () => ({ action: 'setLanguage', language: 'en' }),
  },
  {
    id: 'langBoth',
    patterns: [
      /(?:langue|language|affiche)\s+(?:les\s+deux|both|bilingue|bilingual)/i,
      /(?:passe|switch|change)\s+(?:en|au|vers)\s+(?:mode\s+)?bilingue/i,
    ],
    extract: () => ({ action: 'setLanguage', language: 'both' }),
  },

  // --- TRANSLATION ---
  {
    id: 'translationSegond',
    patterns: [
      /(?:traduction|version|bible)\s+(?:segond|louis\s+segond)/i,
      /(?:passe|switch|change)\s+(?:en|à|vers|sur)\s+(?:la\s+)?(?:segond|louis\s+segond)/i,
    ],
    extract: () => ({ action: 'setTranslation', language: 'fr', code: 'lsg' }),
  },
  {
    id: 'translationDarby',
    patterns: [
      /(?:traduction|version|bible)\s+(?:darby)/i,
      /(?:passe|switch|change)\s+(?:en|à|vers|sur)\s+(?:la\s+)?darby/i,
    ],
    extract: () => ({ action: 'setTranslation', language: 'fr', code: 'darby' }),
  },

  // --- TIMER ---
  {
    id: 'extendTime',
    patterns: [
      /(?:étends|prolonge|extend|add|ajoute)\s+(?:le\s+)?(?:temps|time|durée)\s+(?:de\s+)?(\d+)\s*(?:minutes?|min|secondes?|sec|s)?/i,
    ],
    extract: (match) => {
      const amount = parseInt(match[1], 10);
      const unit = match[0].match(/(?:minute|min)/i) ? 60000 : 5000; // default 5s if no unit
      return { action: 'extendTime', extraMs: amount * unit };
    },
  },
  {
    id: 'pauseTimer',
    patterns: [
      /(?:pause|mets\s+en\s+pause|arrête\s+temporairement).*(?:temps|timer|chrono|décompte)/i,
    ],
    extract: () => ({ action: 'pauseTimer' }),
  },
  {
    id: 'resumeTimer',
    patterns: [
      /(?:reprends|continue|resume|redémarre).*(?:temps|timer|chrono|décompte)/i,
    ],
    extract: () => ({ action: 'resumeTimer' }),
  },

  // --- EMERGENCY ---
  {
    id: 'emergencyClear',
    // CORRECTIF : "urgence"/"panic" seuls étaient trop génériques (ex. un
    // prédicateur disant "en cas d'urgence, Dieu répond" effaçait tout
    // l'overlay). On exige désormais une expression de commande complète.
    patterns: [
      /(?:effacement|arrêt)\s+d['’]urgence/i,
      /emergency\s+clear/i,
      /clear\s+all/i,
      /tout\s+effacer/i,
    ],
    extract: () => ({ action: 'emergencyClear' }),
  },
];

/**
 * Detect voice commands in transcript text.
 * Returns command object or null.
 */
function detectCommand(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/\u0300-\u036f/g, '');

  for (const cmd of COMMANDS) {
    for (const pattern of cmd.patterns) {
      const match = normalized.match(pattern);
      if (match) {
        const result = cmd.extract(match);
        console.log(`[voice-command] Detected "${cmd.id}" from: "${text.substring(0, 60)}..."`);
        return result;
      }
    }
  }
  return null;
}

/**
 * Get list of all available commands (for documentation/UI)
 */
function getAvailableCommands() {
  return COMMANDS.map(c => ({
    id: c.id,
    description: c.patterns.map(p => p.toString()).join(' | '),
  }));
}

module.exports = { detectCommand, getAvailableCommands, COMMANDS };
