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
        // Use the book name from the reference, not the code
        const verses = reference.verseEnd && reference.verseEnd !== reference.verseStart 
          ? `-${reference.verseEnd}` 
          : (reference.verseStart ? `-${reference.verseStart}` : '');
        return `/${reference.book}%20${reference.chapter}${verses}?translation=louis-segond`;
      },
      extractText: (json) => {
        // bible-api.com returns { text: "..." }
        if (json.text) return json.text.trim();
        
        // Alternative format: { verses: [...] }
        if (json.verses && Array.isArray(json.verses)) {
          return json.verses.map(v => v.text || '').join(' ').trim();
        }
        
        // Alternative format: { verses: { "1": "...", "2": "..." } }
        if (json.verses && typeof json.verses === 'object') {
          return Object.values(json.verses)
            .map(v => typeof v === 'string' ? v : (v.text || ''))
            .join(' ').trim();
        }
        
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
        try {
          // getbible.net returns complex nested structure
          if (json.book && Array.isArray(json.book) && json.book.length > 0) {
            const book = json.book[0];
            if (book.chapter) {
              // Format: { book: [{ chapter: { "1": { verse: "..." }, ... } }] }
              if (typeof book.chapter === 'object' && !Array.isArray(book.chapter)) {
                return Object.values(book.chapter)
                  .map(v => typeof v === 'object' ? (v.verse || '') : String(v))
                  .join(' ').trim();
              }
              // Format: { book: [{ chapter: "text" }] }
              return String(book.chapter).trim();
            }
          }
          
          // Alternative: direct text field
          if (json.text) return json.text.trim();
          
        } catch (e) {
          throw new Error(`Erreur extraction getbible.net: ${e.message}`);
        }
        
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
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
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
          return reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 100)}`)); 
        }
        try { 
          resolve(JSON.parse(body)); 
        } catch (e) { 
          // Try to extract useful info even from non-JSON responses
          if (body.includes('text')) {
            const match = body.match(/"text"\s*:\s*"([^"]+)"/);
            if (match) resolve({ text: match[1] });
          }
          reject(new Error(`réponse JSON invalide: ${body.substring(0, 200)}`)); 
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
  if (cache.has(key)) return cache.get(key);
  
  let lastError = null;
  
  for (const provider of CONFIG.providers) {
    if (!isProviderAvailable(provider)) {
      console.log(`[bible-lookup] Provider ${provider.name} ignoré (récemment échoué)`);
      continue;
    }
    
    try {
      const path = provider.buildPath(code, reference);
      const url = `${provider.useHttps ? 'https' : 'http'}://${provider.host}${path}`;
      console.log(`[bible-lookup] Tentative avec provider: ${provider.name}`);
      console.log(`[bible-lookup] URL: ${url}`);
      
      const json = await getJson(url);
      console.log(`[bible-lookup] Réponse reçue de ${provider.name}:`, JSON.stringify(json).substring(0, 200));
      
      const text = provider.extractText(json);
      
      if (!text) throw new Error('passage absent de la réponse');
      
      const result = { reference: label(reference), text, provider: provider.name };
      cache.set(key, result);
      
      if (cache.size > CONFIG.cacheMaxEntries) {
        cache.delete(cache.keys().next().value);
      }
      
      failedProviders.delete(provider.name);
      console.log(`[bible-lookup] Succès avec provider: ${provider.name}`);
      return result;
      
    } catch (error) {
      lastError = error;
      console.warn(`[bible-lookup] Échec avec provider ${provider.name}:`, error.message);
      markProviderFailed(provider);
    }
  }
  
  const errorMessage = `Impossible de récupérer ${label(reference)} : tous les providers ont échoué. Dernière erreur: ${lastError ? lastError.message : 'inconnue'}`;
  if (onError) onError(new Error(errorMessage));
  throw new Error(errorMessage);
}

// Quick test when run directly
if (require.main === module) {
  console.log('=== Testing bible-lookup.js ===\n');
  
  const tests = [
    { book: 'jean', chapter: 3, verseStart: 4 },
    { book: 'jean', chapter: 3, verseStart: 16 },
    { book: 'psaumes', chapter: 23, verseStart: 1 },
  ];
  
  (async () => {
    for (const test of tests) {
      try {
        console.log(`\nTesting: ${label(test)}`);
        const result = await getVerse(test);
        console.log('✅ Success:', result.reference);
        console.log('   Text:', result.text.substring(0, 100) + '...');
        console.log('   Provider:', result.provider);
      } catch (error) {
        console.error('❌ Failed:', error.message);
      }
    }
    
    console.log('\n=== Test complete ===');
    process.exit(0);
  })();
}

module.exports = { 
  getVerse, 
  on: (callbacks) => { onError = callbacks && callbacks.onError; }, 
  clearCache: () => cache.clear(), 
  buildReferenceLabel: label, 
  getApiBookCodes: () => ({ ...API_BOOK_CODES }),
  getProviders: () => CONFIG.providers.map(p => p.name),
  resetFailedProviders: () => failedProviders.clear()
};
