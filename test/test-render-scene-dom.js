/**
 * ============================================================================
 *  test-render-scene-dom.js — Tests pour scene-render.js (renderSceneDom)
 * ----------------------------------------------------------------------------
 *  AJOUT (studio de scènes, lot 5/6) : renderSceneDom() est désormais LE
 *  SEUL endroit où une scène devient du DOM — utilisé À LA FOIS par
 *  overlay.html (déjà verrouillé par integration-scene-overlay-lifecycle.js,
 *  lot 4) et par l'aperçu du studio dans le tableau de bord (ce lot). Ce
 *  test verrouille la fonction ELLE-MÊME, isolément (pas de server.js, pas
 *  de WebSocket) — une scène fixture en entrée, le DOM produit en sortie.
 *
 *  Nécessite un vrai DOM (renderSceneDom manipule document.createElement) —
 *  Playwright/Chromium, comme integration-scene-overlay-lifecycle.js, mais
 *  ici contre une page blanche : aucun serveur, aucun réseau, juste la
 *  fonction pure chargée via scene-render.js.
 * ============================================================================
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

(async () => {
  let passed = 0,
    failed = 0;
  function check(name, cond, detail) {
    if (cond) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`);
      failed++;
    }
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.setContent('<!doctype html><html><body><div id="c"></div></body></html>');
  await page.addScriptTag({ path: path.join(__dirname, '..', 'scene-render.js') });

  try {
    console.log('\n=== Test 1 : scène null vide le conteneur, aucun crash ===\n');
    let result = await page.evaluate(() => {
      const c = document.getElementById('c');
      c.innerHTML = '<span>reliquat</span>';
      window.renderSceneDom(null, c);
      return { childCount: c.children.length, background: c.style.background };
    });
    check('le conteneur est vidé', result.childCount === 0);
    check('le fond en ligne est réinitialisé', result.background === '');

    console.log('\n=== Test 2 : fond image + éléments texte et image ===\n');
    result = await page.evaluate(() => {
      const c = document.getElementById('c');
      window.renderSceneDom(
        {
          background: { type: 'media', mediaUrl: '/media/fond.png' },
          elements: [
            {
              type: 'text',
              text: 'Bienvenue',
              position: 'top-center',
              align: 'center',
              fontFamily: 'Manrope',
              fontSizePct: 8,
              fontWeight: 700,
              color: '#FFD700',
            },
            { type: 'image', mediaUrl: '/media/logo.png', position: 'bottom-right', widthPct: 20 },
          ],
        },
        c
      );
      const bg = c.querySelector('.scene-background-img');
      const text = c.querySelector('.scene-text');
      const img = c.querySelector('.scene-image img');
      return {
        bgSrc: bg ? bg.getAttribute('src') : null,
        text: text ? text.textContent : null,
        textFontFamily: text ? text.style.fontFamily : null,
        textFontSize: text ? text.style.fontSize : null,
        textColor: text ? text.style.color : null,
        textLeft: text ? text.style.left : null,
        textTop: text ? text.style.top : null,
        imgSrc: img ? img.getAttribute('src') : null,
        imgWrapperWidth: c.querySelector('.scene-image').style.width,
        imgWrapperLeft: c.querySelector('.scene-image').style.left,
      };
    });
    check('le fond image est bien rendu', result.bgSrc === '/media/fond.png');
    check('le texte est bien rendu', result.text === 'Bienvenue');
    check('la police du texte est appliquée', result.textFontFamily === 'Manrope');
    check(
      'la taille de police est en vh (pourcentage de la HAUTEUR du cadre)',
      result.textFontSize === '8vh'
    );
    check('la couleur du texte est appliquée', result.textColor === 'rgb(255, 215, 0)');
    check(
      "la position 'top-center' est résolue en 50%/10% (voir SCENE_POSITION_PCT)",
      result.textLeft === '50%' && result.textTop === '10%'
    );
    check("la position 'bottom-right' est résolue en 90%/90%", result.imgWrapperLeft === '90%');
    check("l'image logo est bien rendue", result.imgSrc === '/media/logo.png');
    check(
      'la largeur de l’élément image (widthPct) est appliquée',
      result.imgWrapperWidth === '20%'
    );

    console.log('\n=== Test 3 : fond couleur (pas d’image de fond) ===\n');
    result = await page.evaluate(() => {
      const c = document.getElementById('c');
      window.renderSceneDom(
        { background: { type: 'color', color: 'rgb(10, 20, 30)' }, elements: [] },
        c
      );
      return {
        hasBgImg: !!c.querySelector('.scene-background-img'),
        background: c.style.background,
      };
    });
    check('aucune image de fond avec un fond couleur', result.hasBgImg === false);
    check(
      'la couleur de fond est appliquée au conteneur',
      result.background.includes('10, 20, 30')
    );

    console.log('\n=== Test 4 : fond "none" — ni image ni couleur ===\n');
    result = await page.evaluate(() => {
      const c = document.getElementById('c');
      c.style.background = 'red'; // reliquat d’un test précédent, doit être réinitialisé
      window.renderSceneDom({ background: { type: 'none' }, elements: [] }, c);
      return {
        hasBgImg: !!c.querySelector('.scene-background-img'),
        background: c.style.background,
      };
    });
    check('aucune image de fond avec type "none"', result.hasBgImg === false);
    check('le fond en ligne reste réinitialisé (pas de rouge résiduel)', result.background === '');

    console.log(
      '\n=== Test 5 : élément image sans mediaUrl (mediaId supprimé) est ignoré, pas de crash ===\n'
    );
    result = await page.evaluate(() => {
      const c = document.getElementById('c');
      window.renderSceneDom(
        {
          background: { type: 'none' },
          elements: [
            { type: 'text', text: 'Toujours là' },
            { type: 'image' /* mediaUrl absente */ },
          ],
        },
        c
      );
      return { elementCount: c.children.length, text: c.querySelector('.scene-text').textContent };
    });
    check(
      'un seul élément rendu (le texte) — l’image sans mediaUrl est ignorée silencieusement',
      result.elementCount === 1
    );
    check('le texte valide reste rendu normalement', result.text === 'Toujours là');

    console.log('\n=== Test 6 : type d’élément inconnu est ignoré, pas de crash ===\n');
    result = await page.evaluate(() => {
      const c = document.getElementById('c');
      window.renderSceneDom(
        { background: { type: 'none' }, elements: [{ type: 'video-inconnu', text: 'x' }] },
        c
      );
      return { elementCount: c.children.length };
    });
    check("un type d'élément inconnu ne produit aucun DOM", result.elementCount === 0);

    console.log(
      '\n=== Test 7 : valeurs par défaut appliquées quand les champs optionnels sont absents ===\n'
    );
    result = await page.evaluate(() => {
      const c = document.getElementById('c');
      window.renderSceneDom(
        { background: { type: 'none' }, elements: [{ type: 'text', text: 'x' }] },
        c
      );
      const text = c.querySelector('.scene-text');
      return {
        fontFamily: text.style.fontFamily,
        fontSize: text.style.fontSize,
        color: text.style.color,
        left: text.style.left,
        top: text.style.top,
        transform: text.style.transform,
      };
    });
    check("police par défaut 'Merriweather'", result.fontFamily === 'Merriweather');
    check('taille par défaut 6vh', result.fontSize === '6vh');
    check('couleur par défaut blanc', result.color === 'rgb(255, 255, 255)');
    check(
      "position par défaut 'center' (50%/50%) quand non précisée",
      result.left === '50%' && result.top === '50%'
    );
    check('rotation par défaut 0deg dans la transform', result.transform.includes('rotate(0deg)'));

    console.log(`\nErreurs console cumulées sur tout le test : ${consoleErrors.length}`);
    check(
      'aucune erreur console déclenchée sur l’ensemble du test',
      consoleErrors.length === 0,
      JSON.stringify(consoleErrors)
    );
  } finally {
    await browser.close();
  }

  console.log(`\n=== Résultat renderSceneDom : ${passed} passés, ${failed} échoués ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Erreur fatale:', err);
  console.error(err.stack);
  process.exit(1);
});
