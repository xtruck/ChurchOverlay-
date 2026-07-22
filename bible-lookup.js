/**
 * Recherche d'un passage biblique avec mécanisme de fallback multiple.
 * Le fournisseur est isolé ici : changez CONFIG.providers si votre église
 * utilise un autre service/une Bible locale.
 */
'use strict';
const http = require('http');
const https = require('https');

const CONFIG = { 
  timeoutMs: 6000, 
  cacheMaxEntries: 200, 
  // Liste des fournisseurs avec fallback automatique
  providers: [
    'bibleapi.appspot.com',
    'api.scripture.api.bible',  // API Bible (requiert une clé, configuré en backup)
    'bible-api.com'             // Autre API de secours
  ]
};

const API_BOOK_CODES = { genese:'gn',exode:'ex',levitique:'lv',nombres:'nb',deuteronome:'dt',josue:'jos',juges:'jg',ruth:'rt','1samuel':'1s','2samuel':'2s','1rois':'1r','2rois':'2r','1chroniques':'1ch','2chroniques':'2ch',esdras:'esd',nehemie:'ne',esther:'est',job:'jb',psaumes:'ps',proverbes:'pr',ecclesiaste:'qo',cantique:'ct',esaie:'is',jeremie:'jr',lamentations:'lm',ezechiel:'ez',daniel:'dn',osee:'os',joel:'jl',amos:'am',abdias:'ab',jonas:'jon',michee:'mi',nahum:'na',habacuc:'ha',sophonie:'so',aggee:'ag',zacharie:'za',malachie:'ml',matthieu:'mt',marc:'mc',luc:'lc',jean:'jn',actes:'ac',romains:'rm','1corinthiens':'1co','2corinthiens':'2co',galates:'ga',ephesiens:'ep',philippiens:'ph',colossiens:'col','1thessaloniciens':'1th','2thessaloniciens':'2th','1timothee':'1tm','2timothee':'2tm',tite:'tt',philemon:'phm',hebreux:'he',jacques:'jc','1pierre':'1pi','2pierre':'2pi','1jean':'1jn','2jean':'2jn','3jean':'3jn',jude:'jude',apocalypse:'ap' };
const DISPLAY_NAMES = { ...Object.fromEntries(Object.keys(API_BOOK_CODES).map((key) => [key, key])), jean:'Jean', matthieu:'Matthieu', marc:'Marc', luc:'Luc', actes:'Actes', romains:'Romains', psaumes:'Psaumes', proverbes:'Proverbes', genese:'Genèse', exode:'Exode', ephesiens:'Éphésiens', philippiens:'Philippiens', hebreux:'Hébreux', apocalypse:'Apocalypse' };

const cache = new Map();
let onError = null;

// Suivi des providers échoués pour éviter de réessayer
const failedProviders = new Map(); // provider -> timestamp

function label({ book, chapter, verseStart, verseEnd }) { 
  const name = DISPLAY_NAMES[book] || book; 
  return !verseStart ? `${name} ${chapter}` : `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`; 
}

function getJson(useHttps, host, path) { 
  return new Promise((resolve, reject) => { 
    const req = (useHttps ? https : http).get({ host, path, timeout: CONFIG.timeoutMs }, (res) => { 
      let body=''; 
      res.on('data', (chunk) => { body += chunk; }); 
      res.on('end', () => { 
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`)); 
        try { resolve(JSON.parse(body)); } catch { reject(new Error('réponse JSON invalide')); } 
      }); 
    }); 
    req.on('timeout', () => req.destroy(new Error('timeout API Bible'))); 
    req.on('error', reject); 
  }); 
}

/**
 * Vérifie si un provider est disponible (pas récemment échoué)
 */
function isProviderAvailable(provider) {
  const lastFailure = failedProviders.get(provider);
  if (!lastFailure) return true;
  
  // Réessayer après 5 minutes
  const cooldownMs = 5 * 60 * 1000;
  return (Date.now() - lastFailure) > cooldownMs;
}

/**
 * Marque un provider comme échoué
 */
function markProviderFailed(provider) {
  failedProviders.set(provider, Date.now());
  console.warn(`[bible-lookup] Provider marqué comme échoué: ${provider}`);
}

/**
 * Extrait le texte de la réponse selon le format de l'API
 */
function extractTextFromResponse(json) {
  // Format bibleapi.appspot.com
  if (Array.isArray(json.verses)) {
    return json.verses.map((verse) => String(verse.text || '').trim()).filter(Boolean).join(' ');
  }
  // Format alternatif
  if (json.text) {
    return String(json.text || '').trim();
  }
  // Format API Bible
  if (json.data && json.data.content) {
    return String(json.data.content || '').trim();
  }
  throw new Error('format de réponse non reconnu');
}

/**
 * Construit le chemin API selon le provider
 */
function buildApiPath(provider, code, reference) {
  const verses = reference.verseEnd && reference.verseEnd !== reference.verseStart 
    ? `${reference.verseStart}-${reference.verseEnd}` 
    : (reference.verseStart || '');
  
  // Format par défaut (bibleapi.appspot.com)
  if (provider === 'bibleapi.appspot.com') {
    return `/${code},${reference.chapter}${verses ? `,${verses}` : ''}?o=json`;
  }
  
  // Format API Bible (simplifié - nécessiterait une clé API réelle)
  if (provider.includes('scripture.api.bible')) {
    return `/v1/bibles/fr-STR/passages/${code}.${reference.chapter}${verses ? `-${verses}` : ''}?content-type=text&include-verse-numbers=false`;
  }
  
  // Format générique
  return `/${code}/${reference.chapter}${verses ? `/${verses}` : ''}`;
}

async function getVerse(reference) {
  const code = API_BOOK_CODES[reference.book]; 
  if (!code || !reference.chapter) throw new Error('Référence biblique invalide');
  
  const key = `${code}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`; 
  if (cache.has(key)) return cache.get(key);
  
  let lastError = null;
  
  // Essayer chaque provider dans l'ordre
  for (const provider of CONFIG.providers) {
    if (!isProviderAvailable(provider)) {
      console.log(`[bible-lookup] Provider ${provider} ignoré (récemment échoué)`);
      continue;
    }
    
    try {
      const path = buildApiPath(provider, code, reference);
      console.log(`[bible-lookup] Tentative avec provider: ${provider}`);
      
      let json;
      // Essayer HTTPS d'abord, puis HTTP
      try { 
        json = await getJson(true, provider, path); 
      } catch (httpsError) {
        console.log(`[bible-lookup] HTTPS échoué, tentative HTTP pour ${provider}`);
        try { 
          json = await getJson(false, provider, path); 
        } catch (httpError) {
          throw new Error(`HTTPS et HTTP ont échoué: ${httpError.message}`);
        }
      }
      
      const text = extractTextFromResponse(json);
      if (!text) throw new Error('passage absent de la réponse');
      
      const result = { reference: label(reference), text, provider };
      cache.set(key, result);
      
      if (cache.size > CONFIG.cacheMaxEntries) {
        cache.delete(cache.keys().next().value);
      }
      
      // Succès : réinitialiser le statut d'échec pour ce provider
      failedProviders.delete(provider);
      console.log(`[bible-lookup] Succès avec provider: ${provider}`);
      return result;
      
    } catch (error) {
      lastError = error;
      console.warn(`[bible-lookup] Échec avec provider ${provider}:`, error.message);
      markProviderFailed(provider);
      // Continuer avec le provider suivant
    }
  }
  
  // Tous les providers ont échoué
  const errorMessage = `Impossible de récupérer ${label(reference)} : tous les providers ont échoué. Dernière erreur: ${lastError ? lastError.message : 'inconnue'}`;
  if (onError) onError(new Error(errorMessage));
  throw new Error(errorMessage);
}

module.exports = { 
  getVerse, 
  on: (callbacks) => { onError = callbacks && callbacks.onError; }, 
  clearCache: () => cache.clear(), 
  buildReferenceLabel: label, 
  getApiBookCodes: () => ({ ...API_BOOK_CODES }),
  getProviders: () => [...CONFIG.providers],
  resetFailedProviders: () => failedProviders.clear()
};