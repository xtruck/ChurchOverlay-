/**
 * ============================================================================
 *  test-pptx-importer.js — Tests pour pptx-importer.js
 * ----------------------------------------------------------------------------
 *  Aucun vrai fichier .pptx nécessaire (aucun n'est disponible dans ce
 *  bac à sable) : un mini-écrivain ZIP local (buildZip ci-dessous, méthode
 *  STORED — pas de compression, CRC laissé à 0 puisque readZipEntries() ne
 *  le vérifie pas) construit une archive .pptx minimale mais structurellement
 *  fidèle (mêmes chemins/relations qu'un vrai fichier généré par PowerPoint)
 *  pour valider le lecteur ZIP et l'extraction de texte de bout en bout.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const { extractPptxSlidesText, readZipEntries, extractSlideText } = require('../pptx-importer');

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// --- Mini-écrivain ZIP (STORED uniquement) — fixtures de test seulement ---
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method = STORED
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (non vérifié par le lecteur)
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralChunks);
  offset += centralDir.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function slideXml(...texts) {
  const paragraphs = texts.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('');
  return `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${paragraphs}</p:spTree></p:cSld></p:sld>`;
}

const PRESENTATION_XML = (rIds) =>
  `<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${rIds
    .map((id) => `<p:sldId id="256" r:id="${id}"/>`)
    .join('')}</p:sldIdLst></p:presentation>`;

const RELS_XML = (pairs) =>
  `<?xml version="1.0"?><Relationships xmlns="rels">${pairs
    .map(([id, target]) => `<Relationship Id="${id}" Type="slide" Target="${target}"/>`)
    .join('')}</Relationships>`;

check("extrait le texte de diapositives dans l'ordre alphabétique simple", () => {
  const zip = buildZip([
    ['ppt/presentation.xml', PRESENTATION_XML(['rId1', 'rId2'])],
    [
      'ppt/_rels/presentation.xml.rels',
      RELS_XML([
        ['rId1', 'slides/slide1.xml'],
        ['rId2', 'slides/slide2.xml'],
      ]),
    ],
    ['ppt/slides/slide1.xml', slideXml('Grand est le Seigneur')],
    ['ppt/slides/slide2.xml', slideXml("Digne est l'Agneau")],
  ]);

  const slides = extractPptxSlidesText(zip);
  assert.strictEqual(slides.length, 2);
  assert.strictEqual(slides[0].text, 'Grand est le Seigneur');
  assert.strictEqual(slides[1].text, "Digne est l'Agneau");
});

check("respecte l'ORDRE RÉEL du diaporama, pas l'ordre des noms de fichiers", () => {
  // Diapositive affichée en 1er = slide2.xml, en 2e = slide1.xml — un
  // réordonnancement PowerPoint typique (glisser-déposer dans le panneau des
  // diapositives) qui ne renomme jamais les fichiers XML sous-jacents.
  const zip = buildZip([
    ['ppt/presentation.xml', PRESENTATION_XML(['rId2', 'rId1'])],
    [
      'ppt/_rels/presentation.xml.rels',
      RELS_XML([
        ['rId1', 'slides/slide1.xml'],
        ['rId2', 'slides/slide2.xml'],
      ]),
    ],
    ['ppt/slides/slide1.xml', slideXml('Deuxième dans le diaporama')],
    ['ppt/slides/slide2.xml', slideXml('Première dans le diaporama')],
  ]);

  const slides = extractPptxSlidesText(zip);
  assert.strictEqual(slides[0].text, 'Première dans le diaporama');
  assert.strictEqual(slides[1].text, 'Deuxième dans le diaporama');
});

check('concatène plusieurs paragraphes sur des lignes séparées', () => {
  const zip = buildZip([
    ['ppt/presentation.xml', PRESENTATION_XML(['rId1'])],
    ['ppt/_rels/presentation.xml.rels', RELS_XML([['rId1', 'slides/slide1.xml']])],
    ['ppt/slides/slide1.xml', slideXml('Ligne 1', 'Ligne 2', 'Ligne 3')],
  ]);

  const slides = extractPptxSlidesText(zip);
  assert.strictEqual(slides[0].text, 'Ligne 1\nLigne 2\nLigne 3');
});

check('diapositive sans texte -> chaîne vide (pas une erreur)', () => {
  const zip = buildZip([
    ['ppt/presentation.xml', PRESENTATION_XML(['rId1'])],
    ['ppt/_rels/presentation.xml.rels', RELS_XML([['rId1', 'slides/slide1.xml']])],
    ['ppt/slides/slide1.xml', slideXml()],
  ]);

  const slides = extractPptxSlidesText(zip);
  assert.strictEqual(slides[0].text, '');
});

check('décode les entités XML (accents/apostrophes déjà couverts, & explicite ici)', () => {
  const zip = buildZip([
    ['ppt/presentation.xml', PRESENTATION_XML(['rId1'])],
    ['ppt/_rels/presentation.xml.rels', RELS_XML([['rId1', 'slides/slide1.xml']])],
    ['ppt/slides/slide1.xml', slideXml('Vous &amp; moi &lt;3')],
  ]);

  const slides = extractPptxSlidesText(zip);
  assert.strictEqual(slides[0].text, 'Vous & moi <3');
});

check('readZipEntries lit aussi les entrées non-XML telles quelles', () => {
  const zip = buildZip([['test.txt', 'hello world']]);
  const entries = readZipEntries(zip);
  assert.strictEqual(entries.get('test.txt').toString('utf8'), 'hello world');
});

check('extractSlideText ignore les diapositives sans balises <a:p>', () => {
  assert.strictEqual(extractSlideText('<p:sld></p:sld>'), '');
});

check('.pptx invalide (pas un vrai zip) lève une erreur explicite', () => {
  assert.throws(() => extractPptxSlidesText(Buffer.from('not a zip')), /invalide/);
});

console.log('\n=== Résultat pptx-importer ===');
