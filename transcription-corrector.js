/**
 * ============================================================================
 * transcription-corrector.js — AI Post-Processor for Biblical STT
 * ============================================================================
 * Fixes common Speech-to-Text errors on biblical names, places, and terms.
 * Works in two modes:
 *   1. FAST: Dictionary-based replacement (local, instant)
 *   2. SMART: Groq LLM correction for ambiguous cases
 *
 * BULLETPROOF: Handles missing/invalid groq wrapper gracefully.
 * ============================================================================
 */

'use strict';

// -----------------------------------------------------------------------
// Dictionary of common STT errors → correct biblical terms
// -----------------------------------------------------------------------
'use strict';

const { sanitizeForPrompt } = require('./prompt-sanitizer');
const { extractResponseText } = require('./llm-utils');

const CORRECTIONS = {
  'jean le baptiseur': 'Jean-Baptiste',
  'jean baptiseur': 'Jean-Baptiste',
  'jean baptist': 'Jean-Baptiste',
  'saint jean': 'Saint Jean',
  'saint luc': 'Saint Luc',
  'saint marc': 'Saint Marc',
  'saint matthieu': 'Saint Matthieu',
  'saint paul': 'Saint Paul',
  'saint pierre': 'Saint Pierre',
  'saint jacques': 'Saint Jacques',
  'saint andre': 'Saint André',
  'saint thomas': 'Saint Thomas',
  genese: 'Genèse',
  exode: 'Exode',
  levitique: 'Lévitique',
  nombres: 'Nombres',
  deuteronome: 'Deutéronome',
  josue: 'Josué',
  juges: 'Juges',
  ruth: 'Ruth',
  esdras: 'Esdras',
  nehemie: 'Néhémie',
  esther: 'Esther',
  job: 'Job',
  psaumes: 'Psaumes',
  psaume: 'Psaume',
  proverbes: 'Proverbes',
  ecclesiaste: 'Ecclésiaste',
  cantique: 'Cantique',
  cantiques: 'Cantique',
  esaie: 'Ésaïe',
  jeremie: 'Jérémie',
  lamentations: 'Lamentations',
  ezechiel: 'Ézéchiel',
  daniel: 'Daniel',
  osee: 'Osée',
  joel: 'Joël',
  amos: 'Amos',
  abdias: 'Abdias',
  jonas: 'Jonas',
  michee: 'Michée',
  nahum: 'Nahum',
  habacuc: 'Habacuc',
  sophonie: 'Sophonie',
  aggee: 'Aggée',
  zacharie: 'Zacharie',
  malachie: 'Malachie',
  matthieu: 'Matthieu',
  mathieu: 'Matthieu',
  marc: 'Marc',
  luc: 'Luc',
  jean: 'Jean',
  actes: 'Actes',
  romains: 'Romains',
  corinthiens: 'Corinthiens',
  galates: 'Galates',
  ephesiens: 'Éphésiens',
  philippiens: 'Philippiens',
  philipiens: 'Philippiens',
  colossiens: 'Colossiens',
  thessaloniciens: 'Thessaloniciens',
  timothee: 'Timothée',
  tite: 'Tite',
  philemon: 'Philémon',
  hebreux: 'Hébreux',
  jacques: 'Jacques',
  pierre: 'Pierre',
  jude: 'Jude',
  apocalypse: 'Apocalypse',
  moise: 'Moïse',
  abraham: 'Abraham',
  isaac: 'Isaac',
  jacob: 'Jacob',
  joseph: 'Joseph',
  david: 'David',
  salomon: 'Salomon',
  elie: 'Élie',
  elisee: 'Élisée',
  elisée: 'Élisée',
  samuel: 'Samuel',
  saul: 'Saül',
  jonathan: 'Jonathan',
  goliath: 'Goliath',
  bethsheba: 'Bethsabée',
  bethsabee: 'Bethsabée',
  marie: 'Marie',
  'marie madeleine': 'Marie Madeleine',
  lazare: 'Lazare',
  zachee: 'Zachée',
  barnabas: 'Barnabé',
  barnabe: 'Barnabé',
  silas: 'Silas',
  apollos: 'Apollos',
  judas: 'Judas',
  thomas: 'Thomas',
  philippe: 'Philippe',
  andre: 'André',
  barthelemy: 'Barthélemy',
  matthias: 'Matthias',
  simon: 'Simon',
  jesus: 'Jésus',
  christ: 'Christ',
  emmanuel: 'Emmanuel',
  messie: 'Messie',
  jerusalem: 'Jérusalem',
  nazareth: 'Nazareth',
  bethleem: 'Bethléem',
  galilee: 'Galilée',
  judee: 'Judée',
  samarie: 'Samarie',
  damas: 'Damas',
  antioche: 'Antioche',
  corinthe: 'Corinthe',
  ephese: 'Ephèse',
  philippi: 'Philippi',
  colosses: 'Colosses',
  thessalonique: 'Thessalonique',
  rome: 'Rome',
  egypte: 'Égypte',
  babylone: 'Babylone',
  ninive: 'Ninive',
  sodome: 'Sodome',
  gomorrhe: 'Gomorrhe',
  canaan: 'Canaan',
  sinai: 'Sinaï',
  temple: 'Temple',
  synagogue: 'Synagogue',
  'mont des oliviers': 'Mont des Oliviers',
  golgotha: 'Golgotha',
  calvaire: 'Calvaire',
  'jardin de gethsemane': 'Jardin de Gethsémané',
  gethsemane: 'Gethsémané',
  'mer de galilee': 'Mer de Galilée',
  'lac de tiberiade': 'Lac de Tibériade',
  jourdain: 'Jourdain',
  jordan: 'Jourdain',
  peche: 'Péché',
  peches: 'Péchés',
  redemption: 'Rédemption',
  racheter: 'Racheter',
  justification: 'Justification',
  sanctification: 'Sanctification',
  regeneration: 'Régénération',
  conversion: 'Conversion',
  repentance: 'Repentance',
  foi: 'Foi',
  grace: 'Grâce',
  salut: 'Salut',
  delivrance: 'Délivrance',
  guerison: 'Guérison',
  miracle: 'Miracle',
  benediction: 'Bénédiction',
  alliance: 'Alliance',
  covenant: 'Alliance',
  sacrifice: 'Sacrifice',
  expiation: 'Expiation',
  propitiation: 'Propitiation',
  resurrection: 'Résurrection',
  ascension: 'Ascension',
  pentecote: 'Pentecôte',
  paraclet: 'Paraclet',
  consolateur: 'Consolateur',
  'esprit saint': 'Esprit Saint',
  'saint esprit': 'Saint-Esprit',
  'pere eternel': 'Père Éternel',
  'fils unique': 'Fils Unique',
  'parole de dieu': 'Parole de Dieu',
  'parole vivante': 'Parole Vivante',
  evangile: 'Évangile',
  'bonne nouvelle': 'Bonne Nouvelle',
  'nouveau testament': 'Nouveau Testament',
  'ancien testament': 'Ancien Testament',
  'loi de moise': 'Loi de Moïse',
  'dix commandements': 'Dix Commandements',
  'sermon sur la montagne': 'Sermon sur la Montagne',
  beatitudes: 'Béatitudes',
  'fruits de l esprit': "Fruits de l'Esprit",
  'don du spirit': "Don de l'Esprit",
  'armure de dieu': 'Armure de Dieu',
  "fruits de l'esprit": "Fruits de l'Esprit",
};

// -----------------------------------------------------------------------
// FAST mode: Dictionary-based replacement
// -----------------------------------------------------------------------
function correctFast(text) {
  let result = text;
  const phrases = Object.keys(CORRECTIONS).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    // CORRECTIF (audit global) : \b à l'intérieur d'un template literal
    // (backticks) est interprété comme le caractère de contrôle backspace
    // (0x08), pas comme l'échappement regex \b (limite de mot). Le regex
    // construit ici ne contenait donc JAMAIS de frontière de mot réelle —
    // juste deux caractères backspace littéraux qu'aucune transcription ne
    // contient jamais. Résultat : ce `replace()` ne correspondait STRICTEMENT
    // JAMAIS à rien, et le mode FAST (correction par dictionnaire) de tout
    // ce module ne corrigeait absolument aucun mot, silencieusement, depuis
    // le début. Vérifié : `correctFast('jesus a parle a jean')` retournait le
    // texte totalement inchangé avant ce correctif. Il faut échapper le
    // backslash lui-même (`\\b`) pour obtenir un vrai \b dans le regex final.
    const regex = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, (match) => {
      const correction = CORRECTIONS[phrase.toLowerCase()];
      if (match === match.toUpperCase()) return correction.toUpperCase();
      if (match[0] === match[0].toUpperCase()) return correction;
      return correction.toLowerCase();
    });
  }
  return result;
}

// -----------------------------------------------------------------------
// SMART mode: Groq LLM correction
// BULLETPROOF: Returns original text if groq is unavailable
// -----------------------------------------------------------------------
async function correctSmart(text, groqWrapper) {
  // Defensive: check groq wrapper is valid
  if (!groqWrapper || typeof groqWrapper.chatCompletion !== 'function') {
    return text;
  }

  const hasBiblicalTerm =
    /\b(?:jesus|christ|dieu|seigneur|bible|evangile|apôtre|prophète|moïse|david|paul|pierre|marie|esprit|temple|église|verset|chapitre|psaume|jean|luc|marc|matthieu|romains|corinthiens|galates|ephesiens|philippiens|colossiens|hebreux|jacques|apocalypse)\b/i.test(
      text
    );
  if (!hasBiblicalTerm) return text;

  try {
    // CORRECTIF (audit sécurité — injection de prompt) : on sanitize une
    // COPIE pour le prompt uniquement (`safeText`) — `text` original reste
    // intact car il est retourné tel quel en cas d'échec/rejet plus bas
    // (fallback bulletproof : ne jamais perdre la transcription réelle).
    const safeText = sanitizeForPrompt(text);
    const prompt = `You are a biblical transcription corrector. Fix ONLY obvious biblical name/term errors in this French sermon transcript. Keep everything else identical.

Transcript: "${safeText}"

Rules:
1. Only fix clear STT errors on biblical names, places, or theological terms
2. Do NOT rephrase, summarize, or change the speaker's wording
3. Do NOT add content that wasn't transcribed
4. If unsure, leave the text unchanged
5. Output ONLY the corrected text, nothing else`;

    // CORRECTIF (2026-08-07) : llama-3.1-8b-instant décommissionné par Groq
    // le 16 août 2026 — voir groq-wrapper.js pour le détail de la migration
    // et l'impact sur les quotas gratuits (plafond partagé désormais bas).
    const response = await groqWrapper.chatCompletion(prompt, {
      model: 'openai/gpt-oss-20b',
      temperature: 0.05,
      max_tokens: Math.min(text.length + 50, 500),
    });

    const corrected = extractResponseText(response);
    const similarity = calculateSimilarity(text, corrected);
    if (similarity < 0.7) {
      console.log('[corrector] Smart correction rejected (too different):', similarity);
      return text;
    }

    if (corrected !== text) {
      console.log('[corrector] Smart correction applied');
    }
    return corrected;
  } catch (err) {
    console.warn('[corrector] Smart correction failed:', err.message);
    return text;
  }
}

function calculateSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
  return intersection.size / Math.max(wordsA.size, wordsB.size);
}

// -----------------------------------------------------------------------
// Main API
// -----------------------------------------------------------------------
class TranscriptionCorrector {
  constructor(groqWrapper) {
    this.groq = groqWrapper;
    this.stats = { fastCorrections: 0, smartCorrections: 0, skipped: 0 };
  }

  async correct(text, mode = 'auto') {
    if (!text || text.length < 3) return text;

    // Always run FAST mode (local, instant)
    let result = correctFast(text);
    if (result !== text) {
      this.stats.fastCorrections++;
    }

    // Run SMART mode only if groq is available and mode allows
    if (
      (mode === 'auto' || mode === 'smart') &&
      this.groq &&
      typeof this.groq.chatCompletion === 'function'
    ) {
      const smartResult = await correctSmart(result, this.groq);
      if (smartResult !== result) {
        this.stats.smartCorrections++;
        result = smartResult;
      }
    }

    if (result === text) {
      this.stats.skipped++;
    }

    return result;
  }

  getStats() {
    return { ...this.stats };
  }

  resetStats() {
    this.stats = { fastCorrections: 0, smartCorrections: 0, skipped: 0 };
  }
}

module.exports = { TranscriptionCorrector, CORRECTIONS, correctFast };
