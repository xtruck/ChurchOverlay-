/**
 * Recherche d'un passage biblique avec mécanisme de fallback multiple.
 * Version corrigée avec providers fonctionnels et gestion des redirections.
 */
'use strict';
const http = require('http');
const https = require('https');

const CONFIG = { 
  timeoutMs: 6000, 
  cacheMaxEntries: 200,
  providers: [
    {
      name: 'bible-api.com',
      host: 'bible-api.com',
      useHttps: true,
      buildPath: (code, reference) => {
        // Use the display book name for bible-api.com
        const bookName = DISPLAY_NAMES[reference.book] || reference.book;
        const verses = reference.verseEnd && reference.verseEnd !== reference.verseStart 
          ? `-${reference.verseEnd}` 
          : (reference.verseStart ? `-${reference.verseStart}` : '');
        return `/${encodeURIComponent(bookName)}%20${reference.chapter}${verses}?translation=louis-segond`;
      },
      extractText: (json) => {
        // Primary format: { text: "..." }
        if (json.text && typeof json.text === 'string') {
          return json.text.trim();
        }
        
        // Alternative format: { verses: [{ text: "..." }] }
        if (json.verses && Array.isArray(json.verses)) {
          return json.verses
            .map(v => v.text || '')
            .join(' ')
            .trim();
        }
        
        // Alternative format: { verses: { "1": "text", "2": "text" } }
        if (json.verses && typeof json.verses === 'object') {
          return Object.values(json.verses)
            .map(v => typeof v === 'string' ? v : (v.text || v.verse || ''))
            .join(' ')
            .trim();
        }
        
        // Debug: show what we received
        throw new Error(`format bible-api.com non reconnu: ${JSON.stringify(json).substring(0, 200)}`);
      }
    },
    {
      name: 'getbible.net',
      host: 'getbible.net',
      useHttps: true,
      buildPath: (code, reference) => {
        const verses = reference.verseEnd && reference.verseEnd !== reference.verseStart 
          ? `${reference.verseStart}-${reference.verseEnd}` 
          : (reference.verseStart || '1');
        return `/json?passage=${code}${reference.chapter}:${verses}&v=lsg`;
      },
      extractText: (json) => {
        // Format: { book: [{ chapter: { "1": { verse: "..." }, ... } }] }
        if (json.book && Array.isArray(json.book) && json.book.length > 0) {
          const book = json.book[0];
          
          // chapter is an object with numbered keys
          if (book.chapter && typeof book.chapter === 'object' && !Array.isArray(book.chapter)) {
            return Object.values(book.chapter)
              .map(v => {
                if (typeof v === 'string') return v;
                if (v && v.verse) return v.verse;
                if (v && v.text) return v.text;
                return '';
              })
              .filter(Boolean)
              .join(' ')
              .trim();
          }
          
          // chapter is a string
          if (typeof book.chapter === 'string') {
            return book.chapter.trim();
          }
        }
        
        // Alternative: { text: "..." }
        if (json.text) return json.text.trim();
        
        // Alternative: { verses: "..." }
        if (json.verses) return String(json.verses).trim();
        
        // Debug
        throw new Error(`format getbible.net non reconnu: ${JSON.stringify(json).substring(0, 200)}`);
      }
    }
  ]
};

const API_BOOK_CODES = { 
  genese:'gn', exode:'ex', levitique:'lv', nombres:'nb', deuteronome:'dt',
  josue:'jos', juges:'jg', ruth:'rt', '1samuel':'1s', '2samuel':'2s',
  '1rois':'1r', '2rois':'2r', '1chroniques':'1ch', '2chroniques':'2ch',
  esdras:'esd', nehemie:'ne', esther:'est', job:'jb', psaumes:'ps',
  proverbes:'pr', ecclesiaste:'ec', cantique:'ca', esaie:'es', jeremie:'jr',
  lamentations:'la', ezechiel:'ez', daniel:'da', osee:'os', joel:'jl',
  amos:'am', abdias:'ab', jonas:'jon', michee:'mi', nahum:'na',
  habacuc:'ha', sophonie:'so', aggee:'ag', zacharie:'za', malachie:'ml',
  matthieu:'mt', marc:'mr', luc:'lu', jean:'jn', actes:'ac', romains:'ro',
  '1corinthiens':'1co', '2corinthiens':'2co', galates:'ga', ephesiens:'ep',
  philippiens:'ph', colossiens:'co', '1thessaloniciens':'1th',
  '2thessaloniciens':'2th', '1timothee':'1ti', '2timothee':'2ti',
  tite:'tt', philemon:'phm', hebreux:'he', jacques:'ja', '1pierre':'1pi',
  '2pierre':'2pi', '1jean':'1jn', '2jean':'2jn', '3jean':'3jn',
  jude:'jud', apocalypse:'ap'
};

const DISPLAY_NAMES = { 
  ...Object.fromEntries(Object.keys(API_BOOK_CODES).map((key) => [key, key])),
  jean:'Jean', matthieu:'Matthieu', marc:'Marc', luc:'Luc',
  actes:'Actes', romains:'Romains', psaumes:'Psaumes', proverbes:'Proverbes',
  genese:'Genèse', exode:'Exode', ephesiens:'Éphésiens',
  philippiens:'Philippiens', hebreux:'Hébreux', apocalypse:'Apocalypse'
};

const cache = new Map();
let onError = null;
const failedProviders = new Map();

function label({ book, chapter, verseStart, verseEnd }) { 
  const name = DISPLAY_NAMES[book] || book; 
  return !verseStart ? `${name} ${chapter}` : 
    `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`; 
}

function getJson(url, redirectCount = 0) { 
  return new Promise((resolve, reject) => { 
    // Prevent infinite redirects
    if (redirectCount > 5) {
      return reject(new Error('Trop de redirections'));
    }
    
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: CONFIG.timeoutMs }, (res) => { 
      // Handle all redirect status codes
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          // Handle relative URLs
          let resolvedUrl = redirectUrl;
          if (!redirectUrl.startsWith('http')) {
            const urlObj = new URL(url);
            resolvedUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl.startsWith('/') ? '' : '/'}${redirectUrl}`;
          }
          console.log(`[bible-lookup] Redirection ${res.statusCode} vers: ${resolvedUrl}`);
          return getJson(resolvedUrl, redirectCount + 1).then(resolve).catch(reject);
        }
        return reject(new Error(`Redirection sans URL (${res.statusCode})`));
      }
      
      let body = ''; 
      res.on('data', (chunk) => { body += chunk; }); 
      res.on('end', () => { 
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Include response body in error for debugging
          const preview = body.substring(0, 200).replace(/\n/g, ' ');
          return reject(new Error(`HTTP ${res.statusCode}: ${preview}`)); 
        }
        try { 
          resolve(JSON.parse(body)); 
        } catch (e) { 
          // Try to extract text from malformed responses
          const textMatch = body.match(/"text"\s*:\s*"([^"]+)"/);
          if (textMatch) {
            console.log('[bible-lookup] Extracted text from malformed JSON');
            resolve({ text: textMatch[1].replace(/\\n/g, ' ') });
          } else {
            reject(new Error(`réponse JSON invalide: ${body.substring(0, 200)}`)); 
          }
        } 
      }); 
    }); 
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout API Bible'));
    }); 
    req.on('error', reject); 
  }); 
}

function isProviderAvailable(provider) {
  const lastFailure = failedProviders.get(provider.name);
  if (!lastFailure) return true;
  const cooldownMs = 5 * 60 * 1000;
  return (Date.now() - lastFailure) > cooldownMs;
}

function markProviderFailed(provider) {
  failedProviders.set(provider.name, Date.now());
  console.warn(`[bible-lookup] Provider marqué comme échoué: ${provider.name}`);
}

async function getVerse(reference) {
  const code = API_BOOK_CODES[reference.book]; 
  if (!code || !reference.chapter) throw new Error('Référence biblique invalide');
  
  const key = `${code}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`; 
  if (cache.has(key)) {
    console.log(`[bible-lookup] Cache hit: ${label(reference)}`);
    return cache.get(key);
  }
  
  let lastError = null;
  
  for (const provider of CONFIG.providers) {
    if (!isProviderAvailable(provider)) {
      console.log(`[bible-lookup] Provider ${provider.name} ignoré (récemment échoué)`);
      continue;
    }
    
    try {
      // We need to pass the full reference object to buildPath for book name
      const path = provider.buildPath(code, { ...reference, book: reference.book });
      const url = `${provider.useHttps ? 'https' : 'http'}://${provider.host}${path}`;
      console.log(`[bible-lookup] Tentative avec provider: ${provider.name}`);
      console.log(`[bible-lookup] URL: ${url}`);
      
      const json = await getJson(url);
      console.log(`[bible-lookup] Réponse reçue (${provider.name}):`, JSON.stringify(json).substring(0, 200));
      
      const text = provider.extractText(json);
      
      if (!text) throw new Error('passage absent de la réponse');
      
      const result = { 
        reference: label(reference), 
        text: text.replace(/\s+/g, ' ').trim(), // Normalize whitespace
        provider: provider.name 
      };
      
      // Cache the result
      cache.set(key, result);
      if (cache.size > CONFIG.cacheMaxEntries) {
        cache.delete(cache.keys().next().value);
      }
      
      // Reset failure tracking for this provider
      failedProviders.delete(provider.name);
      console.log(`[bible-lookup] Succès avec provider: ${provider.name}`);
      return result;
      
    } catch (error) {
      lastError = error;
      console.warn(`[bible-lookup] Échec avec provider ${provider.name}:`, error.message);
      markProviderFailed(provider);
    }
  }
  
  // All providers failed
  const errorMessage = `Impossible de récupérer ${label(reference)} : tous les providers ont échoué. Dernière erreur: ${lastError ? lastError.message : 'inconnue'}`;
  if (onError) onError(new Error(errorMessage));
  throw new Error(errorMessage);
}

// Test mode when run directly
if (require.main === module) {
  console.log('=== Testing bible-lookup.js ===\n');
  console.log('Providers:', CONFIG.providers.map(p => p.name).join(', '));
  console.log('');
  
  const tests = [
    { book: 'jean', chapter: 3, verseStart: 4 },
    { book: 'jean', chapter: 3, verseStart: 16 },
    { book: 'psaumes', chapter: 23, verseStart: 1 },
    { book: 'matthieu', chapter: 5, verseStart: 3, verseEnd: 5 },
  ];
  
  (async () => {
    let success = 0;
    let failed = 0;
    
    for (const test of tests) {
      try {
        console.log(`Test: ${label(test)}`);
        const result = await getVerse(test);
        console.log(`  ✅ Succès (${result.provider})`);
        console.log(`  📖 ${result.text.substring(0, 150)}...\n`);
        success++;
      } catch (error) {
        console.log(`  ❌ Échec: ${error.message}\n`);
        failed++;
      }
    }
    
    console.log(`=== Résultats: ${success} succès, ${failed} échecs ===`);
    
    if (failed > 0) {
      console.log('\n⚠️  Les providers pourraient être indisponibles.');
      console.log('Vérifiez manuellement avec:');
      console.log('  curl "https://bible-api.com/Jean%203:4?translation=louis-segond"');
      console.log('  curl "https://getbible.net/json?passage=jn3:4&v=lsg"');
    }
    
    process.exit(failed > 0 ? 1 : 0);
  })();
}

module.exports = { 
  getVerse, 
  on: (callbacks) => { onError = callbacks && callbacks.onError; }, 
  clearCache: () => cache.clear(), 
  buildReferenceLabel: label, 
  getApiBookCodes: () => ({ ...API_BOOK_CODES }),
  getProviders: () => CONFIG.providers.map(p => p.name),
  resetFailedProviders: () => failedProviders.clear(),
  getCacheSize: () => cache.size // Added for diagnostics
};
