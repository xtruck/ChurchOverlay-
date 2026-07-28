/**
 * ============================================================================
 * transcription-corrector.js — AI Post-Processor for Biblical STT
 * ============================================================================
 * Fixes common Speech-to-Text errors on biblical names, places, and terms.
 * Works in two modes:
 *   1. FAST: Dictionary-based replacement (local, instant)
 *   2. SMART: Groq LLM correction for ambiguous cases
 * 
 * Integration: Call after groq.transcribeWithFallback(), before detector.
 * ============================================================================
 */

'use strict';

// -----------------------------------------------------------------------
// Dictionary of common STT errors → correct biblical terms
// Generated from real-world church transcription logs
// -----------------------------------------------------------------------
const CORRECTIONS = {
  // French biblical names & places
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
  'saint andré': 'Saint André',
  'saint thomas': 'Saint Thomas',

  // Book name corrections
  'genèse': 'Genèse',
  'exode': 'Exode',
  'lévitique': 'Lévitique',
  'nombres': 'Nombres',
  'deutéronome': 'Deutéronome',
  'josue': 'Josué',
  'juges': 'Juges',
  'ruth': 'Ruth',
  'esdras': 'Esdras',
  'néhémie': 'Néhémie',
  'esther': 'Esther',
  'job': 'Job',
  'psaumes': 'Psaumes',
  'psaume': 'Psaume',
  'proverbes': 'Proverbes',
  'ecclésiaste': 'Ecclésiaste',
  'cantique': 'Cantique',
  'cantiques': 'Cantique',
  'ésaïe': 'Ésaïe',
  'esaie': 'Ésaïe',
  'jérémie': 'Jérémie',
  'lamentations': 'Lamentations',
  'ézéchiel': 'Ézéchiel',
  'ezechiel': 'Ézéchiel',
  'daniel': 'Daniel',
  'osée': 'Osée',
  'joël': 'Joël',
  'joel': 'Joël',
  'amos': 'Amos',
  'abdias': 'Abdias',
  'jonas': 'Jonas',
  'michée': 'Michée',
  'nahum': 'Nahum',
  'habacuc': 'Habacuc',
  'sophonie': 'Sophonie',
  'aggée': 'Aggée',
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
  'éphésiens': 'Éphésiens',
  'ephesiens': 'Éphésiens',
  'philippiens': 'Philippiens',
  'philipiens': 'Philippiens',
  'colossiens': 'Colossiens',
  'thessaloniciens': 'Thessaloniciens',
  'timothée': 'Timothée',
  'timothee': 'Timothée',
  'tite': 'Tite',
  'philémon': 'Philémon',
  'philemon': 'Philémon',
  'hébreux': 'Hébreux',
  'hebreux': 'Hébreux',
  'jacques': 'Jacques',
  'pierre': 'Pierre',
  'jude': 'Jude',
  'apocalypse': 'Apocalypse',

  // People & places
  'moïse': 'Moïse',
  'moise': 'Moïse',
  'abraham': 'Abraham',
  'isaac': 'Isaac',
  'jacob': 'Jacob',
  'joseph': 'Joseph',
  'david': 'David',
  'salomon': 'Salomon',
  'élie': 'Élie',
  'elie': 'Élie',
  'élise': 'Élisée',
  'elisée': 'Élisée',
  'samuel': 'Samuel',
  'saül': 'Saül',
  'saul': 'Saül',
  'jonathan': 'Jonathan',
  'goliath': 'Goliath',
  'bathsheba': 'Bethsabée',
  'bethsabée': 'Bethsabée',
  'esther': 'Esther',
  'job': 'Job',
  'jonas': 'Jonas',
  'marie': 'Marie',
  'marie madeleine': 'Marie Madeleine',
  'lazare': 'Lazare',
  'zachée': 'Zachée',
  'zachee': 'Zachée',
  'barnabas': 'Barnabé',
  'barnabé': 'Barnabé',
  'silas': 'Silas',
  'timothée': 'Timothée',
  'apollos': 'Apollos',
  'luc': 'Luc',
  'marc': 'Marc',
  'matthieu': 'Matthieu',
  'judas': 'Judas',
  'thomas': 'Thomas',
  'philippe': 'Philippe',
  'andré': 'André',
  'jacques': 'Jacques',
  'barthélemy': 'Barthélemy',
  'barthelemy': 'Barthélemy',
  'matthias': 'Matthias',
  'simon': 'Simon',
  'jésus': 'Jésus',
  'jesus': 'Jésus',
  'christ': 'Christ',
  'emmanuel': 'Emmanuel',
  'messie': 'Messie',

  // Places
  'jérusalem': 'Jérusalem',
  'jerusalem': 'Jérusalem',
  'nazareth': 'Nazareth',
  'bethléem': 'Bethléem',
  'bethleem': 'Bethléem',
  'galilée': 'Galilée',
  'galilee': 'Galilée',
  'judée': 'Judée',
  'judee': 'Judée',
  'samarie': 'Samarie',
  'damas': 'Damas',
  'antioche': 'Antioche',
  'corinthe': 'Corinthe',
  'ephèse': 'Ephèse',
  'ephese': 'Ephèse',
  'philippi': 'Philippi',
  'colosses': 'Colosses',
  'thessalonique': 'Thessalonique',
  'rome': 'Rome',
  'egypte': 'Égypte',
  'égypte': 'Égypte',
  'babylone': 'Babylone',
  'ninive': 'Ninive',
  'sodome': 'Sodome',
  'gomorrhe': 'Gomorrhe',
  'canaan': 'Canaan',
  'sinaï': 'Sinaï',
  'sinai': 'Sinaï',
  'temple': 'Temple',
  'synagogue': 'Synagogue',
  'mont des oliviers': 'Mont des Oliviers',
  'golgotha': 'Golgotha',
  'calvaire': 'Calvaire',
  'jardin de gethsemané': 'Jardin de Gethsémané',
  'gethsemané': 'Gethsémané',
  'gethsemane': 'Gethsémané',
  'mer de galilée': 'Mer de Galilée',
  'lac de tibériade': 'Lac de Tibériade',
  'jourdain': 'Jourdain',
  'jordan': 'Jourdain',

  // Theological terms
  'péché': 'Péché',
  'peche': 'Péché',
  'péchés': 'Péchés',
  'peches': 'Péchés',
  'rédemption': 'Rédemption',
  'redemption': 'Rédemption',
  'racheter': 'Racheter',
  'justification': 'Justification',
  'sanctification': 'Sanctification',
  'régénération': 'Régénération',
  'regeneration': 'Régénération',
  'conversion': 'Conversion',
  'repentance': 'Repentance',
  'foi': 'Foi',
  'grâce': 'Grâce',
  'grace': 'Grâce',
  'salut': 'Salut',
  'délivrance': 'Délivrance',
  'delivrance': 'Délivrance',
  'guérison': 'Guérison',
  'guerison': 'Guérison',
  'miracle': 'Miracle',
  'bénédiction': 'Bénédiction',
  'benediction': 'Bénédiction',
  'alliance': 'Alliance',
  'covenant': 'Alliance',
  'sacrifice': 'Sacrifice',
  'expiation': 'Expiation',
  'propitiation': 'Propitiation',
  'résurrection': 'Résurrection',
  'resurrection': 'Résurrection',
  'ascension': 'Ascension',
  'pentecôte': 'Pentecôte',
  'pentecote': 'Pentecôte',
  'paraclet': 'Paraclet',
  'consolateur': 'Consolateur',
  'esprit saint': 'Esprit Saint',
  'saint esprit': 'Saint-Esprit',
  'père éternel': 'Père Éternel',
  'fils unique': 'Fils Unique',
  'parole de dieu': 'Parole de Dieu',
  'parole vivante': 'Parole Vivante',
  'évangile': 'Évangile',
  'evangile': 'Évangile',
  'bonne nouvelle': 'Bonne Nouvelle',
  'nouveau testament': 'Nouveau Testament',
  'ancien testament': 'Ancien Testament',
  'loi de moïse': 'Loi de Moïse',
  'dix commandements': 'Dix Commandements',
  'sermon sur la montagne': 'Sermon sur la Montagne',
  'béatitudes': 'Béatitudes',
  'beatitudes': 'Béatitudes',
  'fruits de l esprit': 'Fruits de l\'Esprit',
  'don du spirit': 'Don de l\'Esprit',
  'armure de dieu': 'Armure de Dieu',
  'fruits de l'esprit': 'Fruits de l\'Esprit',
  'don du spirit': 'Don de l\'Esprit',
  'armure de dieu': 'Armure de Dieu',
};

// Build a fast lookup trie for prefix matching
function buildCorrectionTrie() {
  const trie = {};
  for (const [key, value] of Object.entries(CORRECTIONS)) {
    let node = trie;
    const words = key.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!node[w]) node[w] = {};
      node = node[w];
      if (i === words.length - 1) node._value = value;
    }
  }
  return trie;
}

const correctionTrie = buildCorrectionTrie();

// -----------------------------------------------------------------------
// FAST mode: Dictionary-based replacement
// -----------------------------------------------------------------------
function correctFast(text) {
  let result = text;
  const words = text.toLowerCase().split(/(\s+)/);

  // Multi-word phrase matching (longest match first)
  const phrases = Object.keys(CORRECTIONS).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const regex = new RegExp(`\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'gi');
    result = result.replace(regex, (match) => {
      // Preserve original casing style
      const correction = CORRECTIONS[phrase.toLowerCase()];
      if (match === match.toUpperCase()) return correction.toUpperCase();
      if (match[0] === match[0].toUpperCase()) return correction;
      return correction.toLowerCase();
    });
  }

  return result;
}

// -----------------------------------------------------------------------
// SMART mode: Groq LLM correction for ambiguous biblical names
// Only runs when FAST mode detects potential biblical content
// -----------------------------------------------------------------------
async function correctSmart(text, groqWrapper) {
  // Skip if no biblical terms detected
  const hasBiblicalTerm = /\b(?:jesus|christ|dieu|seigneur|bible|evangile|apôtre|prophète|moïse|david|paul|pierre|marie|esprit|temple|église|verset|chapitre|psaume|jean|luc|marc|matthieu|romains|corinthiens|galates|ephésiens|philippiens|colossiens|hébreux|jacques|apocalypse)\b/i.test(text);
  if (!hasBiblicalTerm) return text;

  try {
    const prompt = `You are a biblical transcription corrector. Fix ONLY obvious biblical name/term errors in this French sermon transcript. Keep everything else identical.

Transcript: "${text}"

Rules:
1. Only fix clear STT errors on biblical names, places, or theological terms
2. Do NOT rephrase, summarize, or change the speaker's wording
3. Do NOT add content that wasn't transcribed
4. If unsure, leave the text unchanged
5. Output ONLY the corrected text, nothing else

Examples of fixes:
- "jean le baptiseur" → "Jean-Baptiste"
- "philipiens" → "Philippiens"  
- "ephese" → "Ephèse"
- "moise" → "Moïse"
- "gethsemane" → "Gethsémané"`;

    const response = await groqWrapper.chatCompletion(prompt, {
      model: 'llama-3.1-8b-instant',
      temperature: 0.05,
      max_tokens: Math.min(text.length + 50, 500),
    });

    const corrected = (response.text || response).trim();

    // Safety: if LLM returns something wildly different, reject it
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

// Simple word-based similarity
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

    // Run SMART mode if available and mode is auto/smart
    if ((mode === 'auto' || mode === 'smart') && this.groq) {
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
