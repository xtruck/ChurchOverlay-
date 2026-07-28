/**
 * ============================================================================
 *  multi-language.js — Multi-language support for xtruck
 * ----------------------------------------------------------------------------
 *  Provides language detection, multi-language Bible verse detection,
 *  and translation capabilities.
 * ============================================================================
 */

'use strict';

// Language configurations
const LANGUAGES = {
  fr: {
    name: 'Français',
    code: 'fr',
    books: {
      genese: ['genese', 'gen'], exode: ['exode', 'exo'], levitique: ['levitique', 'lev'],
      nombres: ['nombres', 'nom'], deuteronome: ['deuteronome', 'deut'], josue: ['josue', 'jos'],
      juges: ['juges', 'jug'], ruth: ['ruth'], '1samuel': ['1 samuel', 'premier samuel'],
      '2samuel': ['2 samuel', 'deuxieme samuel'], '1rois': ['1 rois', 'premier rois'],
      '2rois': ['2 rois', 'deuxieme rois'], '1chroniques': ['1 chroniques', 'premier chroniques'],
      '2chroniques': ['2 chroniques', 'deuxieme chroniques'], esdras: ['esdras'], nehemie: ['nehemie'],
      esther: ['esther'], job: ['job'], psaumes: ['psaumes', 'psaume', 'ps'], proverbes: ['proverbes', 'prov'],
      ecclesiaste: ['ecclesiaste', 'qohélet', 'qohelet'], cantique: ['cantique'], esaie: ['esaie', 'es'],
      jeremie: ['jeremie', 'jer'], lamentations: ['lamentations', 'lam'], ezechiel: ['ezechiel', 'ez'],
      daniel: ['daniel', 'dan'], osee: ['osee', 'os'], joel: ['joel'], amos: ['amos'], abdias: ['abdias'],
      jonas: ['jonas'], michee: ['michee', 'mi'], nahum: ['nahum'], habacuc: ['habacuc', 'ha'],
      sophonie: ['sophonie', 'so'], aggee: ['aggee', 'ag'], zacharie: ['zacharie', 'za'], malachie: ['malachie', 'ml'],
      matthieu: ['matthieu', 'mathieu', 'mt'], marc: ['marc', 'mc'], luc: ['luc', 'lc'], jean: ['jean', 'jn'],
      actes: ['actes', 'ac'], romains: ['romains', 'rom', 'rm'], '1corinthiens': ['1 corinthiens', 'premier corinthiens'],
      '2corinthiens': ['2 corinthiens', 'deuxieme corinthiens'], galates: ['galates', 'ga'], ephesiens: ['ephesiens', 'ep'],
      philippiens: ['philippiens', 'php'], colossiens: ['colossiens', 'col'], '1thessaloniciens': ['1 thessaloniciens', 'premier thessaloniciens'],
      '2thessaloniciens': ['2 thessaloniciens', 'deuxieme thessaloniciens'], '1timothee': ['1 timothee', 'premier timothee'],
      '2timothee': ['2 timothee', 'deuxieme timothee'], tite: ['tite'], philemon: ['philemon'], hebreux: ['hebreux', 'heb'],
      jacques: ['jacques', 'jc'], '1pierre': ['1 pierre', 'premier pierre'], '2pierre': ['2 pierre', 'deuxieme pierre'],
      '1jean': ['1 jean', 'premier jean'], '2jean': ['2 jean', 'deuxieme jean'], '3jean': ['3 jean', 'troisieme jean'],
      jude: ['jude'], apocalypse: ['apocalypse', 'ap']
    },
    numberWords: {
      zero: 0, un: 1, une: 1, premier: 1, premiere: 1, deux: 2, trois: 3,
      quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
      onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
      dixsept: 17, dixhuit: 18, dixneuf: 19, vingt: 20, trente: 30,
      quarante: 40, cinquante: 50, soixante: 60, cent: 100, cents: 100,
    }
  },
  en: {
    name: 'English',
    code: 'en',
    books: {
      genesis: ['genesis', 'gen'], exodus: ['exodus', 'ex'], leviticus: ['leviticus', 'lev'],
      numbers: ['numbers', 'num'], deuteronomy: ['deuteronomy', 'deut'], joshua: ['joshua', 'josh'],
      judges: ['judges', 'judg'], ruth: ['ruth'], '1samuel': ['1 samuel', '1 sam', 'first samuel'],
      '2samuel': ['2 samuel', '2 sam', 'second samuel'], '1kings': ['1 kings', '1 kgs', 'first kings'],
      '2kings': ['2 kings', '2 kgs', 'second kings'], '1chronicles': ['1 chronicles', '1 chr', 'first chronicles'],
      '2chronicles': ['2 chronicles', '2 chr', 'second chronicles'], ezra: ['ezra'], nehemiah: ['nehemiah'],
      esther: ['esther'], job: ['job'], psalms: ['psalms', 'psalm', 'ps'], proverbs: ['proverbs', 'prov'],
      ecclesiastes: ['ecclesiastes', 'eccl'], songofsolomon: ['song of solomon', 'song', 'sos'], isaiah: ['isaiah', 'isa'],
      jeremiah: ['jeremiah', 'jer'], lamentations: ['lamentations', 'lam'], ezekiel: ['ezekiel', 'ezek'],
      daniel: ['daniel', 'dan'], hosea: ['hosea', 'hos'], joel: ['joel'], amos: ['amos'], obadiah: ['obadiah', 'obad'],
      jonah: ['jonah'], micah: ['micah', 'mic'], nahum: ['nahum'], habakkuk: ['habakkuk', 'hab'],
      zephaniah: ['zephaniah', 'zeph'], haggai: ['haggai', 'hag'], zechariah: ['zechariah', 'zech'], malachi: ['malachi', 'mal'],
      matthew: ['matthew', 'matt', 'mt'], mark: ['mark', 'mk'], luke: ['luke', 'lk'], john: ['john', 'jn'],
      acts: ['acts', 'act'], romans: ['romans', 'rom', 'rm'], '1corinthians': ['1 corinthians', '1 cor', 'first corinthians'],
      '2corinthians': ['2 corinthians', '2 cor', 'second corinthians'], galatians: ['galatians', 'gal'], ephesians: ['ephesians', 'eph'],
      philippians: ['philippians', 'phil'], colossians: ['colossians', 'col'], '1thessalonians': ['1 thessalonians', '1 thess', 'first thessalonians'],
      '2thessalonians': ['2 thessalonians', '2 thess', 'second thessalonians'], '1timothy': ['1 timothy', '1 tim', 'first timothy'],
      '2timothy': ['2 timothy', '2 tim', 'second timothy'], titus: ['titus'], philemon: ['philemon', 'phlm'], hebrews: ['hebrews', 'heb'],
      james: ['james', 'jas'], '1peter': ['1 peter', '1 pet', 'first peter'], '2peter': ['2 peter', '2 pet', 'second peter'],
      '1john': ['1 john', 'first john'], '2john': ['2 john', 'second john'], '3john': ['3 john', 'third john'],
      jude: ['jude'], revelation: ['revelation', 'rev']
    },
    numberWords: {
      zero: 0, one: 1, first: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
      twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
      forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80,
      ninety: 90, hundred: 100
    }
  },
  es: {
    name: 'Español',
    code: 'es',
    books: {
      genesis: ['genesis', 'gen'], exodo: ['exodo', 'ex'], levitico: ['levitico', 'lev'],
      numeros: ['numeros', 'num'], deuteronomio: ['deuteronomio', 'deut'], josue: ['josue', 'jos'],
      jueces: ['jueces', 'jue'], rut: ['rut'], '1samuel': ['1 samuel', '1 sam', 'primero samuel'],
      '2samuel': ['2 samuel', '2 sam', 'segundo samuel'], '1reyes': ['1 reyes', '1 rey', 'primero reyes'],
      '2reyes': ['2 reyes', '2 rey', 'segundo reyes'], '1cronicas': ['1 cronicas', '1 cron', 'primero cronicas'],
      '2cronicas': ['2 cronicas', '2 cron', 'segundo cronicas'], esdras: ['esdras'], nehemias: ['nehemias'],
      ester: ['ester'], job: ['job'], salmos: ['salmos', 'salm', 'sal'], proverbios: ['proverbios', 'prov'],
      eclesiastes: ['eclesiastes', 'ecle'], cantares: ['cantares', 'cant'], isaias: ['isaias', 'isa'],
      jeremias: ['jeremias', 'jer'], lamentaciones: ['lamentaciones', 'lam'], ezequiel: ['ezequiel', 'ezq'],
      daniel: ['daniel', 'dan'], oseas: ['oseas', 'os'], joel: ['joel'], amos: ['amos'], abdias: ['abdias'],
      jonas: ['jonas'], mieas: ['mieas', 'mie'], nahum: ['nahum'], habacuc: ['habacuc', 'hab'],
      sofonias: ['sofonias', 'sof'], hageo: ['hageo', 'hag'], zacarias: ['zacarias', 'zac'], malaquias: ['malaquias', 'mal'],
      mateo: ['mateo', 'mt'], marcos: ['marcos', 'mc'], lucas: ['lucas', 'lc'], juan: ['juan', 'jn'],
      hechos: ['hechos', 'hech'], romanos: ['romanos', 'rom'], '1corintios': ['1 corintios', '1 cor', 'primero corintios'],
      '2corintios': ['2 corintios', '2 cor', 'segundo corintios'], galatas: ['galatas', 'gal'], efesios: ['efesios', 'ef'],
      filipenses: ['filipenses', 'fil'], colosenses: ['colosenses', 'col'], '1tesalonicenses': ['1 tesalonicenses', '1 tes', 'primero tesalonicenses'],
      '2tesalonicenses': ['2 tesalonicenses', '2 tes', 'segundo tesalonicenses'], '1timoteo': ['1 timoteo', '1 tim', 'primero timoteo'],
      '2timoteo': ['2 timoteo', '2 tim', 'segundo timoteo'], tito: ['tito'], filemon: ['filemon', 'flm'], hebreos: ['hebreos', 'heb'],
      santiago: ['santiago', 'stg'], '1pedro': ['1 pedro', '1 ped', 'primero pedro'], '2pedro': ['2 pedro', '2 ped', 'segundo pedro'],
      '1juan': ['1 juan', 'primero juan'], '2juan': ['2 juan', 'segundo juan'], '3juan': ['3 juan', 'tercero juan'],
      judas: ['judas'], apocalipsis: ['apocalipsis', 'apoc']
    },
    numberWords: {
      cero: 0, uno: 1, una: 1, primero: 1, primera: 1, dos: 2, tres: 3,
      cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
      once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
      diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, treinta: 30,
      cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80,
      noventa: 90, cien: 100
    }
  }
};

class MultiLanguageSupport {
  constructor() {
    this.currentLanguage = 'fr';
    this.detectedLanguage = 'fr';
    this.languagePatterns = this.buildLanguagePatterns();
  }

  /**
   * Build patterns for language detection
   */
  buildLanguagePatterns() {
    return {
      fr: /\b(le|la|les|un|une|des|et|ou|mais|donc|or|ni|car|comme|si|lorsque|que|qui|quoi|où|dont)\b/i,
      en: /\b(the|a|an|and|or|but|so|because|if|when|that|which|what|where|whose)\b/i,
      es: /\b(el|la|los|las|un|una|unos|unas|y|o|pero|porque|si|cuando|que|quien|que|donde|cuyo)\b/i
    };
  }

  /**
   * Detect language from text
   */
  detectLanguage(text) {
    const scores = {};
    const sampleText = text.slice(0, 500); // Analyze first 500 characters
    
    for (const [lang, pattern] of Object.entries(this.languagePatterns)) {
      const matches = sampleText.match(pattern);
      scores[lang] = matches ? matches.length : 0;
    }
    
    // Find language with highest score
    let maxScore = 0;
    let detectedLang = 'fr'; // Default to French
    
    for (const [lang, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        detectedLang = lang;
      }
    }
    
    this.detectedLanguage = detectedLang;
    return detectedLang;
  }

  /**
   * Set current language
   */
  setLanguage(lang) {
    if (LANGUAGES[lang]) {
      this.currentLanguage = lang;
      console.log(`[MultiLanguage] Language set to: ${LANGUAGES[lang].name}`);
    } else {
      console.warn(`[MultiLanguage] Language not supported: ${lang}`);
    }
  }

  /**
   * Get current language
   */
  getLanguage() {
    return this.currentLanguage;
  }

  /**
   * Get supported languages
   */
  getSupportedLanguages() {
    return Object.keys(LANGUAGES).map(code => ({
      code,
      name: LANGUAGES[code].name
    }));
  }

  /**
   * Detect Bible reference in specific language
   */
  detectReference(text, lang = null) {
    const language = lang || this.currentLanguage;
    const config = LANGUAGES[language];
    
    if (!config) {
      console.warn(`[MultiLanguage] Language not configured: ${language}`);
      return null;
    }

    const normalized = this.normalizeText(text);
    const aliases = Object.entries(config.books).flatMap(([book, names]) => 
      names.map((name) => ({ book, name }))
    ).sort((a, b) => b.name.length - a.name.length);

    for (const { book, name } of aliases) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const pattern = new RegExp(
        `(?:^|\\s)${escaped}\\s+(?:chapter|chapitre|capítulo\\s+)?(\\d{1,3})(?:\\s*(?::|,|\\s+verse(?:s)?|verseto|versículo\\s+|\\s+)(\\d{1,3})(?:\\s*(?:-|to|a|à|al)\\s*(\\d{1,3}))?)?(?=$|[\\s,.;!?)])`, 
        'i'
      );
      
      const match = normalized.match(pattern);
      if (!match) continue;
      
      const chapter = Number(match[1]);
      const verseStart = match[2] ? Number(match[2]) : undefined;
      const verseEnd = match[3] ? Number(match[3]) : verseStart;
      
      if (chapter > 0 && (!verseStart || verseStart > 0) && (!verseEnd || verseEnd >= verseStart)) {
        return { 
          book, 
          chapter, 
          verseStart, 
          verseEnd, 
          raw: match[0].trim(),
          language: language
        };
      }
    }
    
    return null;
  }

  /**
   * Normalize text for processing
   */
  normalizeText(text) {
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Convert number words to digits for specific language
   */
  numberWordsToDigits(text, lang = null) {
    const language = lang || this.currentLanguage;
    const config = LANGUAGES[language];
    
    if (!config || !config.numberWords) {
      return text;
    }

    const numberWords = config.numberWords;
    const numberWordPattern = Object.keys(numberWords).join('|');
    
    return text.replace(
      new RegExp(`\\b(?:${numberWordPattern})(?:[\\s-]+(?:and|y|et\\s+)?(?:${numberWordPattern}))*\\b`, 'g'), 
      (words) => {
        const tokens = words.replace(/-/g, ' ').split(/\s+/).filter((token) => 
          !['and', 'y', 'et'].includes(token.toLowerCase())
        );
        let total = 0;
        let current = 0;
        
        for (const token of tokens) {
          const value = numberWords[token.toLowerCase()];
          if (value === 100) current = Math.max(1, current) * 100;
          else current += value;
        }
        
        return String(total + current);
      }
    );
  }

  /**
   * Get language-specific configuration
   */
  getLanguageConfig(lang = null) {
    const language = lang || this.currentLanguage;
    return LANGUAGES[language] || null;
  }
}

// Create singleton instance
const multiLanguage = new MultiLanguageSupport();

module.exports = {
  MultiLanguageSupport,
  detectLanguage: (text) => multiLanguage.detectLanguage(text),
  setLanguage: (lang) => multiLanguage.setLanguage(lang),
  getLanguage: () => multiLanguage.getLanguage(),
  getSupportedLanguages: () => multiLanguage.getSupportedLanguages(),
  detectReference: (text, lang) => multiLanguage.detectReference(text, lang),
  numberWordsToDigits: (text, lang) => multiLanguage.numberWordsToDigits(text, lang),
  getLanguageConfig: (lang) => multiLanguage.getLanguageConfig(lang)
};