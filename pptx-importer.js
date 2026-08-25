/**
 * ============================================================================
 * pptx-importer.js — Extraction du texte d'un .pptx (Partie 7.1.1, portée
 * réduite et assumée)
 * ----------------------------------------------------------------------------
 * Le document mission demandait un "importeur ProPresenter/PowerPoint". Audit
 * fait en cours de session : propresenter-controller.js existant est un
 * client de télécommande à DISTANCE (WebSocket vers une instance ProPresenter
 * qui tourne déjà) — il ne lit aucun fichier .pro6/.pro et ne peut donc pas
 * servir de base à un import de fichier. Le format ProPresenter lui-même
 * (plist binaire, non documenté publiquement) resterait de la rétro-ingénierie
 * pure — jugé hors de portée d'une session, comme noté précédemment.
 *
 * Le format .pptx, lui, EST un standard ouvert documenté (OOXML/ECMA-376) :
 * une archive ZIP contenant du XML. Portée assumée ici, volontairement
 * réduite pour rester honnête : LE TEXTE des diapositives uniquement (les
 * paroles de chant/plan de prédication préparés dans PowerPoint sont
 * l'usage réel le plus courant en église) — PAS les images, la mise en forme,
 * les transitions ni le rendu visuel des diapositives elles-mêmes (les
 * reproduire fidèlement exigerait un moteur de rendu PowerPoint complet,
 * hors de portée). Chaque diapositive avec du texte devient une scène du
 * studio de scènes existant (scene-store.js) — pas un nouveau système de
 * stockage.
 *
 * Aucune nouvelle dépendance npm : le dézippage (ZIP est un format ouvert,
 * documenté, non "propriétaire" contrairement à .pro6) est réimplémenté ici
 * en ~80 lignes avec le module `zlib` déjà présent dans Node — dans le même
 * esprit que le reste du projet ("pas de build step", dépendances minimales).
 * ============================================================================
 */
'use strict';

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const LOCAL_FILE_SIG = 0x04034b50;

/**
 * Localise l'enregistrement "End Of Central Directory" en balayant depuis la
 * fin du buffer (un commentaire de zip, rare mais permis par le format,
 * peut décaler cette signature de jusqu'à 65535 octets avant la toute fin).
 */
function findEndOfCentralDirectory(buf) {
  const maxScan = Math.min(buf.length, 65535 + 22);
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('.pptx invalide : fin de répertoire central introuvable (pas un vrai .zip)');
}

/**
 * Lit toutes les entrées d'une archive ZIP en mémoire.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} nom d'entrée -> contenu décompressé
 */
function readZipEntries(buf) {
  const eocdOffset = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = new Map();
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIG) {
      throw new Error('.pptx invalide : répertoire central corrompu');
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraFieldLength = buf.readUInt16LE(offset + 30);
    const fileCommentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const fileName = buf.toString('utf8', offset + 46, offset + 46 + fileNameLength);

    entries.set(fileName, {
      compressionMethod,
      compressedSize,
      localHeaderOffset,
    });

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  const result = new Map();
  for (const [fileName, meta] of entries) {
    if (buf.readUInt32LE(meta.localHeaderOffset) !== LOCAL_FILE_SIG) {
      continue; // en-tête local corrompu pour cette entrée — ignorée, pas fatal pour les autres
    }
    const localNameLen = buf.readUInt16LE(meta.localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(meta.localHeaderOffset + 28);
    const dataStart = meta.localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + meta.compressedSize);

    let content;
    if (meta.compressionMethod === 0) {
      content = Buffer.from(compressed); // STORED — aucune compression
    } else if (meta.compressionMethod === 8) {
      content = zlib.inflateRawSync(compressed); // DEFLATE — méthode quasi-universelle des .pptx
    } else {
      continue; // méthode non gérée (rare dans un .pptx généré par PowerPoint) — entrée ignorée
    }
    result.set(fileName, content);
  }
  return result;
}

// Entités XML minimales — un slideN.xml de PowerPoint n'utilise que celles-ci
// (jamais de DOCTYPE avec entités personnalisées dans un OOXML valide).
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&'); // en dernier : ne doit pas re-décoder les entités déjà résolues ci-dessus
}

/**
 * Extrait le texte d'une diapositive (un fichier ppt/slides/slideN.xml) —
 * un paragraphe <a:p> par ligne, les runs <a:t> d'un même paragraphe
 * concaténés sans séparateur (comme PowerPoint les affiche).
 * @param {string} xml
 * @returns {string}
 */
function extractSlideText(xml) {
  const paragraphs = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) || [];
  const lines = paragraphs.map((p) => {
    const runs = p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
    return runs
      .map((r) => decodeXmlEntities(r.replace(/^<a:t>/, '').replace(/<\/a:t>$/, '')))
      .join('');
  });
  return lines.filter((line) => line.trim().length > 0).join('\n');
}

/**
 * Reconstruit l'ordre RÉEL d'affichage des diapositives (celui du diaporama,
 * pas l'ordre alphabétique des noms de fichiers) : PowerPoint peut réordonner
 * des diapositives sans jamais renommer slideN.xml, ppt/presentation.xml
 * (<p:sldIdLst>) + ppt/_rels/presentation.xml.rels sont la seule source de
 * vérité pour l'ordre. Se tromper d'ordre reviendrait à afficher les paroles
 * d'un chant dans le désordre pendant un culte — inacceptable, même dans une
 * fonctionnalité "meilleur effort" (même exigence de fond que l'A.3 du
 * document mission : jamais un contenu faux plutôt que rien).
 * @param {Map<string, Buffer>} entries
 * @returns {string[]} noms de fichiers ("ppt/slides/slideN.xml") dans l'ordre d'affichage
 */
function resolveSlideOrder(entries) {
  const presentationXml = entries.get('ppt/presentation.xml');
  const relsXml = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presentationXml || !relsXml) {
    throw new Error('.pptx invalide : présentation ou relations introuvables');
  }

  const relIdToTarget = new Map();
  const relRegex = /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let relMatch;
  const relsStr = relsXml.toString('utf8');
  while ((relMatch = relRegex.exec(relsStr))) {
    relIdToTarget.set(relMatch[1], relMatch[2]);
  }

  const order = [];
  const sldIdRegex = /<p:sldId\b[^>]*r:id="([^"]+)"[^>]*\/?>/g;
  const presStr = presentationXml.toString('utf8');
  let sldMatch;
  while ((sldMatch = sldIdRegex.exec(presStr))) {
    const target = relIdToTarget.get(sldMatch[1]);
    if (target) {
      // Target est relatif à ppt/ (ex. "slides/slide3.xml")
      order.push('ppt/' + target.replace(/^\.?\//, ''));
    }
  }
  return order;
}

/**
 * Point d'entrée : buffer d'un .pptx -> liste ordonnée du texte de chaque
 * diapositive (diapositives sans aucun texte incluses, avec text: '' —
 * l'appelant décide de les ignorer ou non).
 * @param {Buffer} pptxBuffer
 * @returns {Array<{slideIndex: number, text: string}>}
 */
function extractPptxSlidesText(pptxBuffer) {
  const entries = readZipEntries(pptxBuffer);
  const order = resolveSlideOrder(entries);
  return order.map((fileName, i) => {
    const xml = entries.get(fileName);
    const text = xml ? extractSlideText(xml.toString('utf8')) : '';
    return { slideIndex: i + 1, text };
  });
}

module.exports = { extractPptxSlidesText, readZipEntries, extractSlideText, resolveSlideOrder };
