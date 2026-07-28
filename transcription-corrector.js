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
  'genese': 'Genèse',
  'exode': 'Exode',
  'levitique': 'Lévitique',
  'nombres': 'Nombres',
  'deuteronome': 'Deutéronome',
  'josue': 'Josué',
  'juges': 'Juges',
  'ruth': 'Ruth',
  'esdras': 'Esdras',
  'nehemie': 'Néhémie',
  'esther': 'Esther',
  'job': 'Job',
  'psaumes': 'Psaumes',
  'psaume': 'Psaume',
  'proverbes': 'Proverbes',
  'ecclesiaste': 'Ecclésiaste',
  'cantique': 'Cantique',
  'cantiques': 'Cantique',
  'esaie': 'Ésaïe',
  'esaie': 'Ésaïe',
  'jeremie': 'Jérémie',
  'lamentations': 'Lamentations',
  'ezechiel': 'Ézéchiel',
  'ezechiel': 'Ézéchiel',
  'daniel': 'Daniel',
  'osee': 'Osée',
  'joel': 'Joël',
  'joel': 'Joël',
  'amos': 'Amos',
  'abdias': 'Abdias',
  'jonas': 'Jonas',
  'michee': 'Michée',
  'nahum': 'Nahum',
  'habacuc': 'Habacuc',
  'sophonie': 'Sophonie',
  'aggee': 'Aggée',
  'aggee': 'Aggée',
  'zacharie': 'Zacharie',
  'malachie': 'Malachie',
  'matthieu': 'Matthieu',
  'mathieu': 'Matthieu',
  'marc': 'Marc',
  'luc': 'Luc',
  'jean': 'Jean',
  'actes': 'Actes',
  'romains': 'Romains',
  'corinthiens': 'Corinthiens',
  'galates': 'Galates',
  'ephesiens': 'Éphésiens',
  'ephesiens': 'Éphésiens',
  'philippiens': 'Philippiens',
  'philipiens': 'Philippiens',
  'colossiens': 'Colossiens',
  'thessaloniciens': 'Thessaloniciens',
  'timothee': 'Timothée',
  'timothee': 'Timothée',
  'tite': 'Tite',
  'philemon': 'Philémon',
  'philemon': 'Philémon',
  'hebreux': 'Hébreux',
  'hebreux': 'Hébreux',
  'jacques': 'Jacques',
  'pierre': 'Pierre',
  'jude': 'Jude',
  'apocalypse': 'Apocalypse',
  'moise': 'Moïse',
  'moise': 'Moïse',
  'abraham': 'Abraham',
  'isaac': 'Isaac',
  'jacob': 'Jacob',
  'joseph': 'Joseph',
  'david': 'David',
  'salomon': 'Salomon',
  'elie': 'Élie',
  'elie': 'Élie',
  'elisee': 'Élisée',
  'elisée': 'Élisée',
  'samuel': 'Samuel',
  'saul': 'Saül',
  'saul': 'Saül',
  'jonathan': 'Jonathan',
  'goliath': 'Goliath',
  'bethsheba': 'Bethsabée',
  'bethsabee': 'Bethsabée',
  'esther': 'Esther',
  'job': 'Job',
  'jonas': 'Jonas',
  'marie': 'Marie',
  'marie madeleine': 'Marie Madeleine',
  'lazare': 'Lazare',
  'zachee': 'Zachée',
  'zachee': 'Zachée',
  'barnabas': 'Barnabé',
  'barnabe': 'Barnabé',
  'silas': 'Silas',
  'timothee': 'Timothée',
  'apollos': 'Apollos',
  'luc': 'Luc',
  'marc': 'Marc',
  'matthieu': 'Matthieu',
  'judas': 'Judas',
  'thomas': 'Thomas',
  'philippe': 'Philippe',
  'andre': 'André',
  'jacques': 'Jacques',
  'barthelemy': 'Barthélemy',
  'barthelemy': 'Barthélemy',
  'matthias': 'Matthias',
  'simon': 'Simon',
  'jesus': 'Jésus',
  'jesus': 'Jésus',
  'christ': 'Christ',
  'emmanuel': 'Emmanuel',
  'messie': 'Messie',
  'jerusalem': 'Jérusalem',
  'jerusalem': 'Jérusalem',
  'nazareth': 'Nazareth',
  'bethleem': 'Bethléem',
  'bethleem': 'Bethléem',
  'galilee': 'Galilée',
  'galilee': 'Galilée',
  'judee': 'Judée',
  'judee': 'Judée',
  'samarie': 'Samarie',
  'damas': 'Damas',
  'antioche': 'Antioche',
  'corinthe': 'Corinthe',
  'ephese': 'Ephèse',
  'ephese': 'Ephèse',
  'philippi': 'Philippi',
  'colosses': 'Colosses',
  'thessalonique': 'Thessalonique',
  'rome': 'Rome',
  'egypte': 'Égypte',
  'egypte': 'Égypte',
  'babylone': 'Babylone',
  'ninive': 'Ninive',
  'sodome': 'Sodome',
  'gomorrhe': 'Gomorrhe',
  'canaan': 'Canaan',
  'sinai': 'Sinaï',
  'sinai': 'Sinaï',
  'temple': 'Temple',
  'synagogue': 'Synagogue',
  'mont des oliviers': 'Mont des Oliviers',
  'golgotha': 'Golgotha',
  'calvaire': 'Calvaire',
  'jardin de gethsemane': 'Jardin de Gethsémané',
  'gethsemane': 'Gethsémané',
  'gethsemane': 'Gethsémané',
  'mer de galilee': 'Mer de Galilée',
  'lac de tiberiade': 'Lac de Tibériade',
  'jourdain': 'Jourdain',
  'jordan': 'Jourdain',
  'peche': 'Péché',
  'peche': 'Péché',
  'peches': 'Péchés',
  'peches': 'Péchés',
  'redemption': 'Rédemption',
  'redemption': 'Rédemption',
  'racheter': 'Racheter',
  'justification': 'Justification',
  'sanctification': 'Sanctification',
  'regeneration': 'Régénération',
  'regeneration': 'Régénération',
  'conversion': 'Conversion',
  'repentance': 'Repentance',
  'foi': 'Foi',
  'grace': 'Grâce',
  'grace': 'Grâce',
  'salut': 'Salut',
  'delivrance': 'Délivrance',
  'delivrance': 'Délivrance',
  'guerison': 'Guérison',
  'guerison': 'Guérison',
  'miracle': 'Miracle',
  'benediction': 'Bénédiction',
  'benediction': 'Bénédiction',
  'alliance': 'Alliance',
  'covenant': 'Alliance',
  'sacrifice': 'Sacrifice',
  'expiation': 'Expiation',
  'propitiation': 'Propitiation',
  'resurrection': 'Résurrection',
  'resurrection': 'Résurrection',
  'ascension': 'Ascension',
  'pentecote': 'Pentecôte',
  'pentecote': 'Pentecôte',
  'paraclet': 'Paraclet',
  'consolateur': 'Consolateur',
  'esprit saint': 'Esprit Saint',
  'saint esprit': 'Saint-Esprit',
  'pere eternel': 'Père Éternel',
  'fils unique': 'Fils Unique',
  'parole de dieu': 'Parole de Dieu',
  'parole vivante': 'Parole Vivante',
  'evangile': 'Évangile',
  'evangile': 'Évangile',
  'bonne nouvelle': 'Bonne Nouvelle',
  'nouveau testament': 'Nouveau Testament',
  'ancien testament': 'Ancien Testament',
  'loi de moise': 'Loi de Moïse',
  'dix commandements': 'Dix Commandements',
  'sermon sur la montagne': 'Sermon sur la Montagne',
  'beatitudes': 'Béatitudes',
  'beatitudes': 'Béatitudes',
  'fruits de l esprit': "Fruits de l'Esprit",
  'don du spirit': "Don de l'Esprit",
  'armure de dieu': 'Armure de Dieu',
  'fruits de l\'esprit': "Fruits de l'Esprit",
  'don du spirit': "Don de l'Esprit",
  'armure de dieu': 'Armure de Dieu',
};

// -----------------------------------------------------------------------
// FAST mode: Dictionary-based replacement
// -----------------------------------------------------------------------
function correctFast(text) {
  let result = text;
  const phrases = Object.keys(CORRECTIONS).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const regex = new RegExp(`\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'gi');
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

  const hasBiblicalTerm = /(?:jesus|christ|dieu|seigneur|bible|evangile|apôtre|prophète|moïse|david|paul|pierre|marie|esprit|temple|église|verset|chapitre|psaume|jean|luc|marc|matthieu|romains|corinthiens|galates|ephesiens|philippiens|colossiens|hebreux|jacques|apocalypse)/i.test(text);
  if (!hasBiblicalTerm) return text;

  try {
    const prompt = `You are a biblical transcription corrector. Fix ONLY obvious biblical name/term errors in this French sermon transcript. Keep everything else identical.

Transcript: "${text}"

Rules:
1. Only fix clear STT errors on biblical names, places, or theological terms
2. Do NOT rephrase, summarize, or change the speaker's wording
3. Do NOT add content that wasn't transcribed
4. If unsure, leave the text unchanged
5. Output ONLY the corrected text, nothing else`;

    const response = await groqWrapper.chatCompletion(prompt, {
      model: 'llama-3.1-8b-instant',
      temperature: 0.05,
      max_tokens: Math.min(text.length + 50, 500),
    });

    const corrected = (response.text || response).trim();
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
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
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
    if ((mode === 'auto' || mode === 'smart') && this.groq && typeof this.groq.chatCompletion === 'function') {
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
