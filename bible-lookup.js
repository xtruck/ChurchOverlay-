/**
 * Recherche d'un passage biblique. Le fournisseur est isolé ici : changez
 * seulement CONFIG.provider si votre église utilise un autre service/une Bible locale.
 */
'use strict';
const http = require('http');
const https = require('https');

const CONFIG = { timeoutMs: 6000, cacheMaxEntries: 200, provider: 'bibleapi.appspot.com' };
const API_BOOK_CODES = { genese:'gn',exode:'ex',levitique:'lv',nombres:'nb',deuteronome:'dt',josue:'jos',juges:'jg',ruth:'rt','1samuel':'1s','2samuel':'2s','1rois':'1r','2rois':'2r','1chroniques':'1ch','2chroniques':'2ch',esdras:'esd',nehemie:'ne',esther:'est',job:'jb',psaumes:'ps',proverbes:'pr',ecclesiaste:'qo',cantique:'ct',esaie:'is',jeremie:'jr',lamentations:'lm',ezechiel:'ez',daniel:'dn',osee:'os',joel:'jl',amos:'am',abdias:'ab',jonas:'jon',michee:'mi',nahum:'na',habacuc:'ha',sophonie:'so',aggee:'ag',zacharie:'za',malachie:'ml',matthieu:'mt',marc:'mc',luc:'lc',jean:'jn',actes:'ac',romains:'rm','1corinthiens':'1co','2corinthiens':'2co',galates:'ga',ephesiens:'ep',philippiens:'ph',colossiens:'col','1thessaloniciens':'1th','2thessaloniciens':'2th','1timothee':'1tm','2timothee':'2tm',tite:'tt',philemon:'phm',hebreux:'he',jacques:'jc','1pierre':'1pi','2pierre':'2pi','1jean':'1jn','2jean':'2jn','3jean':'3jn',jude:'jude',apocalypse:'ap' };
const DISPLAY_NAMES = { ...Object.fromEntries(Object.keys(API_BOOK_CODES).map((key) => [key, key])), jean:'Jean', matthieu:'Matthieu', marc:'Marc', luc:'Luc', actes:'Actes', romains:'Romains', psaumes:'Psaumes', proverbes:'Proverbes', genese:'Genèse', exode:'Exode', ephesiens:'Éphésiens', philippiens:'Philippiens', hebreux:'Hébreux', apocalypse:'Apocalypse' };
const cache = new Map();
let onError = null;
function label({ book, chapter, verseStart, verseEnd }) { const name = DISPLAY_NAMES[book] || book; return !verseStart ? `${name} ${chapter}` : `${name} ${chapter}:${verseStart}${verseEnd && verseEnd !== verseStart ? `-${verseEnd}` : ''}`; }
function getJson(useHttps, host, path) { return new Promise((resolve, reject) => { const req = (useHttps ? https : http).get({ host, path, timeout: CONFIG.timeoutMs }, (res) => { let body=''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body)); } catch { reject(new Error('réponse JSON invalide')); } }); }); req.on('timeout', () => req.destroy(new Error('timeout API Bible'))); req.on('error', reject); }); }
async function getVerse(reference) {
  const code = API_BOOK_CODES[reference.book]; if (!code || !reference.chapter) throw new Error('Référence biblique invalide');
  const key = `${code}:${reference.chapter}:${reference.verseStart || ''}-${reference.verseEnd || ''}`; if (cache.has(key)) return cache.get(key);
  const verses = reference.verseEnd && reference.verseEnd !== reference.verseStart ? `${reference.verseStart}-${reference.verseEnd}` : (reference.verseStart || '');
  const path = `/${code},${reference.chapter}${verses ? `,${verses}` : ''}?o=json`;
  try {
    let json; try { json = await getJson(true, CONFIG.provider, path); } catch { json = await getJson(false, CONFIG.provider, path); }
    const text = Array.isArray(json.verses) ? json.verses.map((verse) => String(verse.text || '').trim()).filter(Boolean).join(' ') : String(json.text || '').trim();
    if (!text) throw new Error('passage absent de la réponse');
    const result = { reference: label(reference), text }; cache.set(key, result); if (cache.size > CONFIG.cacheMaxEntries) cache.delete(cache.keys().next().value); return result;
  } catch (error) { if (onError) onError(error); throw new Error(`Impossible de récupérer ${label(reference)} : ${error.message}`); }
}
module.exports = { getVerse, on: (callbacks) => { onError = callbacks && callbacks.onError; }, clearCache: () => cache.clear(), buildReferenceLabel: label, getApiBookCodes: () => ({ ...API_BOOK_CODES }) };
