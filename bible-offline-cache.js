'use strict';
/**
 * ============================================================================
 * bible-offline-cache.js — Base biblique locale complète (hors-ligne)
 * ----------------------------------------------------------------------------
 * AJOUT (cahier des charges — Point 1B, "offline-first"). Distinct du petit
 * cache verset-par-verset déjà présent dans bible-lookup-with-api.js (500
 * versets max, alimenté au fil des cultes) : ce module télécharge une
 * traduction ENTIÈRE en arrière-plan (tous les livres, tous les chapitres),
 * une seule fois, pour que la coupure de connexion PENDANT un culte tombe
 * sur une base déjà là plutôt que sur une erreur de recherche.
 *
 * Ne remplace PAS les fournisseurs réseau (helloao/getbible restent
 * PRIORITAIRES — voir bible-lookup-with-api.js/getVerse — pour toujours
 * profiter d'un contenu à jour tant que la connexion fonctionne) : ce
 * module n'intervient qu'en DERNIER recours, quand les deux fournisseurs
 * réseau ont échoué.
 *
 * Volontairement PAS utilisé pour findByQuotedText() (détection par
 * citation) : comparer chaque segment transcrit aux dizaines de milliers de
 * versets de la base complète, à chaque phrase prononcée, serait un coût
 * CPU réel et récurrent — hors du principe "gratuit/léger" suivi dans tout
 * ce projet. Cette base ne sert qu'à la RÉSOLUTION d'une référence déjà
 * identifiée (une seule consultation directe par verset affiché).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

// Nombre de chapitres par livre — structure canonique de la Bible,
// identique quelle que soit la traduction. Clés alignées sur
// detector.js/BOOKS et bible-lookup-with-api.js/HELLOAO_BOOK_CODES.
const CHAPTER_COUNTS = {
  genese: 50,
  exode: 40,
  levitique: 27,
  nombres: 36,
  deuteronome: 34,
  josue: 24,
  juges: 21,
  ruth: 4,
  '1samuel': 31,
  '2samuel': 24,
  '1rois': 22,
  '2rois': 25,
  '1chroniques': 29,
  '2chroniques': 36,
  esdras: 10,
  nehemie: 13,
  esther: 10,
  job: 42,
  psaumes: 150,
  proverbes: 31,
  ecclesiaste: 12,
  cantique: 8,
  esaie: 66,
  jeremie: 52,
  lamentations: 5,
  ezechiel: 48,
  daniel: 12,
  osee: 14,
  joel: 3,
  amos: 9,
  abdias: 1,
  jonas: 4,
  michee: 7,
  nahum: 3,
  habacuc: 3,
  sophonie: 3,
  aggee: 2,
  zacharie: 14,
  malachie: 4,
  matthieu: 28,
  marc: 16,
  luc: 24,
  jean: 21,
  actes: 28,
  romains: 16,
  '1corinthiens': 16,
  '2corinthiens': 13,
  galates: 6,
  ephesiens: 6,
  philippiens: 4,
  colossiens: 4,
  '1thessaloniciens': 5,
  '2thessaloniciens': 3,
  '1timothee': 6,
  '2timothee': 4,
  tite: 3,
  philemon: 1,
  hebreux: 13,
  jacques: 5,
  '1pierre': 5,
  '2pierre': 3,
  '1jean': 5,
  '2jean': 1,
  '3jean': 1,
  jude: 1,
  apocalypse: 22,
};

const DEFAULT_TRANSLATION = 'fra_lsg';
const REQUEST_DELAY_MS = 300; // rythme poli envers l'API gratuite helloao, évite une rafale

let dirPath = null;
let loadedData = null; // { translation, books: { [bookKey]: { [chapter]: { [verse]: text } } } }
let downloadState = { status: 'idle', downloaded: 0, total: 0, translation: null };
// AJOUT (Chantier 0 — cause réelle du crash libuv à l'arrêt) : les fetch()
// undici en vol d'un téléchargement en arrière-plan déclenchent sur Windows
// une assertion libuv ("Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)", src\win\async.c) quand le process s'arrête vite
// (process.exit). L'env var CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD=1 évite déjà
// le téléchargement dans les tests ; côté production, on offre à la sortie
// propre (SIGINT/SIGTERM/exit) de ABANDONNER les fetch en cours via un
// AbortController — le signal est passé à chaque requête, et l'abort fait
// sortir la boucle immédiatement (voir downloadFullBible).
let activeAbort = null;

/**
 * AJOUT (Chantier 0 — arrêt propre du téléchargement en arrière-plan) :
 * abandonne les fetch() en vol du téléchargement complet en cours. Sans
 * effet si aucun téléchargement n'actif. À appeler sur SIGINT/SIGTERM/exit
 * (voir server.js) pour ne jamais laisser un fetch undici "en l'air" au
 * moment où le process se termine.
 */
function abortDownload() {
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/**
 * @param {string} userDataDir - Dossier utilisateur de l'app (hors app.asar)
 */
function setUserDataDir(userDataDir) {
  dirPath = path.join(userDataDir, 'bible-offline');
}

function filePathFor(translation) {
  return path.join(dirPath, `${translation}.json`);
}

/**
 * @param {string} [translation]
 * @returns {boolean} true si une base complète est déjà sur disque pour cette traduction
 */
function isAvailable(translation = DEFAULT_TRANSLATION) {
  if (loadedData && loadedData.translation === translation) return true;
  if (!dirPath) return false;
  try {
    return fs.existsSync(filePathFor(translation));
  } catch (_e) {
    return false;
  }
}

function loadIntoMemory(translation) {
  if (loadedData && loadedData.translation === translation) return true;
  try {
    const raw = fs.readFileSync(filePathFor(translation), 'utf8');
    loadedData = { translation, books: JSON.parse(raw) };
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * @returns {{status: 'idle'|'downloading'|'done'|'error', downloaded: number, total: number, translation: string|null}}
 */
function getStatus() {
  return { ...downloadState };
}

/**
 * Cherche un verset (ou un chapitre entier si verseStart absent) dans la
 * base hors-ligne déjà téléchargée. Ne déclenche AUCUN téléchargement —
 * renvoie simplement null si la base n'est pas encore prête.
 * @param {{book: string, chapter: number, verseStart?: number, verseEnd?: number}} reference
 * @param {string} [translation]
 * @returns {string|null}
 */
function getOfflineVerse(reference, translation = DEFAULT_TRANSLATION) {
  if (!loadedData || loadedData.translation !== translation) {
    if (!loadIntoMemory(translation)) return null;
  }
  const chapterVerses =
    loadedData.books &&
    loadedData.books[reference.book] &&
    loadedData.books[reference.book][reference.chapter];
  if (!chapterVerses) return null;

  if (!reference.verseStart) {
    const text = Object.keys(chapterVerses)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => chapterVerses[n])
      .join(' ')
      .trim();
    return text || null;
  }

  const start = reference.verseStart;
  const end = reference.verseEnd || start;
  const parts = [];
  for (let v = start; v <= end; v++) {
    if (chapterVerses[v]) parts.push(chapterVerses[v]);
  }
  return parts.length ? parts.join(' ').trim() : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseVerseContent(contentItem) {
  return (Array.isArray(contentItem) ? contentItem : [])
    .map((part) => (typeof part === 'string' ? part : part.text || ''))
    .join(' ')
    .replace(/¶\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Télécharge une traduction complète en arrière-plan, chapitre par
 * chapitre, avec une pause entre chaque requête. Idempotent : si le fichier
 * local existe déjà, ne relance rien (voir isAvailable()) — pensé pour être
 * appelé sans condition au démarrage de l'app, pas seulement au premier
 * lancement.
 * @param {string} [translation]
 */
async function downloadFullBible(translation = DEFAULT_TRANSLATION) {
  if (!dirPath) throw new Error('bible-offline-cache: setUserDataDir() non appelé');
  if (isAvailable(translation)) {
    downloadState = { status: 'done', downloaded: 0, total: 0, translation };
    return;
  }

  // Requis en retard (pas en haut du fichier) pour éviter une dépendance
  // circulaire au chargement : bible-lookup-with-api.js requiert lui-même
  // ce module pour son repli hors-ligne (voir plus bas dans ce fichier /
  // getVerse() dans bible-lookup-with-api.js).
  const bibleLookup = require('./bible-lookup-with-api');
  const bookCodes = bibleLookup.HELLOAO_BOOK_CODES;
  // Défensif : un test peut injecter un module bible-lookup-with-api.js
  // factice sans ce champ (voir test/integration-*.js, injectFakeModule) —
  // dans ce cas comme dans tout autre où le mapping manquerait, on
  // abandonne proprement plutôt que de planter sur Object.keys(undefined).
  if (!bookCodes || typeof bookCodes !== 'object') {
    downloadState = { status: 'error', downloaded: 0, total: 0, translation };
    console.warn('[bible-offline] HELLOAO_BOOK_CODES indisponible, téléchargement abandonné.');
    return;
  }
  const bookKeys = Object.keys(bookCodes);
  const totalChapters = bookKeys.reduce((sum, b) => sum + (CHAPTER_COUNTS[b] || 0), 0);
  downloadState = { status: 'downloading', downloaded: 0, total: totalChapters, translation };
  console.log(
    `[bible-offline] Téléchargement en arrière-plan de la base biblique complète (${translation}, ${totalChapters} chapitres)...`
  );

  // AJOUT (Chantier 0) : chaque téléchargement a son propre AbortController ;
  // abortDownload() (ci-dessus) peut l'abandonner à tout moment pour fermer
  // proprement les fetch undici avant l'arrêt du process.
  activeAbort = new AbortController();
  const signal = activeAbort.signal;

  const books = {};
  let downloaded = 0;

  for (const bookKey of bookKeys) {
    const bookCode = bookCodes[bookKey];
    const chapterCount = CHAPTER_COUNTS[bookKey];
    if (!bookCode || !chapterCount) continue;
    books[bookKey] = {};

    for (let chapter = 1; chapter <= chapterCount; chapter++) {
      try {
        const url = `https://bible.helloao.org/api/${translation}/${bookCode}/${chapter}.json`;
        const res = await fetch(url, { signal });
        if (res.ok) {
          const data = await res.json();
          const content = data && data.chapter && data.chapter.content;
          if (Array.isArray(content)) {
            const verses = {};
            for (const item of content) {
              if (item.type === 'verse' && Number.isInteger(item.number)) {
                const text = parseVerseContent(item.content);
                if (text) verses[item.number] = text;
              }
            }
            books[bookKey][chapter] = verses;
          }
        }
      } catch (_e) {
        // AJOUT (Chantier 0) : abandon demandé (arrêt du process) — on sort
        // immédiatement des deux boucles sans rien écrire : le prochain
        // démarrage retentera (downloadFullBible est idempotent, isAvailable()
        // vérifie que le fichier local existe, donc un téléchargement
        // interrompu ne sera pas considéré comme complet).
        if (signal.aborted) {
          activeAbort = null;
          return;
        }
        // Chapitre manqué (réseau, format inattendu...) : tant pis, le
        // reste du téléchargement continue plutôt que de tout interrompre —
        // un trou ponctuel dans le cache hors-ligne reste préférable à
        // n'avoir aucune base du tout.
      }
      downloaded++;
      downloadState.downloaded = downloaded;
      await sleep(REQUEST_DELAY_MS);
    }
  }

  activeAbort = null;

  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePathFor(translation), JSON.stringify(books), 'utf8');
    loadedData = { translation, books };
    downloadState = { status: 'done', downloaded, total: totalChapters, translation };
    console.log(
      `[bible-offline] Base biblique complète (${translation}) téléchargée et disponible hors-ligne.`
    );
  } catch (err) {
    downloadState = { ...downloadState, status: 'error' };
    console.warn('[bible-offline] Échec écriture du cache hors-ligne:', err.message);
  }
}

module.exports = {
  setUserDataDir,
  isAvailable,
  getOfflineVerse,
  downloadFullBible,
  abortDownload,
  getStatus,
  DEFAULT_TRANSLATION,
  // AJOUT (chantier ASR, Étape 4 — validation des références reconstruites
  // par fusion de fragments) : nombre réel de chapitres par livre, utilisé
  // pour rejeter une référence impossible (ex. « 2e Timothée chapitre 13
  // verset 4 » — 2 Timothée n'a que 4 chapitres), signe d'une contamination
  // inter-énoncés (résidu du fragment précédent fusionné par erreur).
  CHAPTER_COUNTS,
};
