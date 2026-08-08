/**
 * ============================================================================
 *  test-song-library.js — Tests pour song-library.js
 * ----------------------------------------------------------------------------
 *  Tests purs (aucun Electron/IPC/WebSocket), même isolation et même style
 *  que test-media-library.js : dossier userData temporaire.
 * ============================================================================
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const songLibrary = require('../song-library');

console.log('=== Test Song Library ===\n');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'churchoverlay-song-test-'));
songLibrary.setUserDataDir(userDataDir);

// Test 1 : parseSections() découpe sur les lignes vides.
console.log('[TEST] Test 1: parseSections()...');
const sections = songLibrary.parseSections(
  'Premier couplet\nsur deux lignes\n\nRefrain ici\n\n\nDeuxième couplet'
);
assert.strictEqual(sections.length, 3, 'trois blocs séparés par ligne(s) vide(s)');
assert.strictEqual(sections[0].text, 'Premier couplet\nsur deux lignes');
assert.strictEqual(sections[0].label, 'Couplet 1');
assert.strictEqual(sections[1].text, 'Refrain ici');
assert.strictEqual(sections[2].label, 'Couplet 3');
console.log('[TEST] ✓ Découpage en sections correct\n');

// Test 2 : addSong() stocke titre/artiste/sections/phrases.
console.log('[TEST] Test 2: addSong()...');
const song = songLibrary.addSong({
  title: '  Comme un Souffle Fragile  ',
  artist: 'IPG Massy',
  lyrics: 'Couplet un\n\nRefrain',
  triggerPhrases: ['on se lève', '  chantons ensemble  '],
});
assert.strictEqual(
  song.title,
  'Comme un Souffle Fragile',
  'le titre doit être débarrassé des espaces superflus'
);
assert.strictEqual(song.artist, 'IPG Massy');
assert.strictEqual(song.sections.length, 2);
assert.deepStrictEqual(song.triggerPhrases, ['on se lève', 'chantons ensemble']);
console.log('[TEST] ✓ Chant ajouté avec les bonnes métadonnées\n');

// Test 3 : addSong() rejette un titre ou des paroles manquantes.
console.log('[TEST] Test 3: addSong() valide les champs requis...');
assert.throws(
  () => songLibrary.addSong({ title: '', lyrics: 'x' }),
  /Titre manquant/,
  'un titre vide doit être rejeté'
);
assert.throws(
  () => songLibrary.addSong({ title: 'x', lyrics: '   ' }),
  /Aucune parole fournie/,
  'des paroles vides doivent être rejetées'
);
console.log('[TEST] ✓ Validation des champs requis\n');

// Test 4 : listSongs()/getSong().
console.log('[TEST] Test 4: listSongs() / getSong()...');
const list = songLibrary.listSongs();
assert.strictEqual(list.length, 1);
assert.strictEqual(
  list[0].sectionCount,
  2,
  'listSongs() renvoie le nombre de sections, pas leur texte'
);
assert.strictEqual(
  list[0].sections,
  undefined,
  'listSongs() ne renvoie pas le texte complet (liste légère)'
);
const full = songLibrary.getSong(song.id);
assert.strictEqual(full.sections[0].text, 'Couplet un', 'getSong() renvoie lui le texte complet');
assert.strictEqual(songLibrary.getSong('id-inexistant'), null);
console.log('[TEST] ✓ Liste légère vs accès complet corrects\n');

// Test 5 : matchTriggerPhrase() — correspondance normalisée (accents/casse).
console.log('[TEST] Test 5: matchTriggerPhrase()...');
const match = songLibrary.matchTriggerPhrase("Debout, ON SE LÈVE pour l'adoration");
assert(match !== null, 'une phrase contenant la phrase déclencheuse doit matcher');
assert.strictEqual(match.song.id, song.id);
assert.strictEqual(
  match.sectionIndex,
  0,
  'un déclenchement vocal démarre toujours à la première section'
);
assert.strictEqual(
  songLibrary.matchTriggerPhrase('Ceci ne correspond à rien'),
  null,
  'un texte sans rapport ne doit déclencher aucun chant'
);
console.log('[TEST] ✓ Correspondance normalisée détectée\n');

// Test 6 : deleteSong().
console.log('[TEST] Test 6: deleteSong()...');
assert.strictEqual(songLibrary.deleteSong(song.id), true);
assert.strictEqual(songLibrary.getSong(song.id), null);
assert.strictEqual(songLibrary.listSongs().length, 0);
assert.strictEqual(
  songLibrary.deleteSong('id-inexistant'),
  false,
  'supprimer un id inconnu doit renvoyer false sans planter'
);
console.log('[TEST] ✓ Suppression correcte\n');

fs.rmSync(userDataDir, { recursive: true, force: true });
console.log('=== Tous les tests song-library sont passés ===');
