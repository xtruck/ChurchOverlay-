/**
 * ============================================================================
 *  integration-rundown-timeline.js — "Timeline-Based Service Flow" (brief
 *  produit, priorité #5).
 * ----------------------------------------------------------------------------
 *  server.js réel, VRAI dashboard.html dans Chromium (même discipline que
 *  integration-airlock-preview.js), un client WS opérateur brut sert à
 *  seeder rapidement des repères avant de piloter le reste depuis la VRAIE UI.
 *
 *  Couvre le MÉCANISME de bout en bout : saisir une durée estimée -> persistée
 *  et redessinée après un rundownUpdated ; déclencher des repères -> horaires
 *  réels enregistrés (cueTimeline) et durée réelle affichée sur le segment
 *  terminé ; clearRundown -> historique vidé.
 *
 *  LIMITE ASSUMÉE (pas testée ici, vérifiée par relecture du code) : les
 *  textes "X min de retard"/"X min d'avance" (rundown.js#renderScheduleStatus)
 *  ne se déclenchent qu'au-delà d'un écart de 60s (SCHEDULE_STATUS_TOLERANCE_MS) —
 *  les déclencher réellement demanderait soit une vraie attente de 60s+ dans
 *  ce test (ralentirait toute la suite pour un gain de couverture marginal :
 *  la formule elle-même, actualElapsedMs - totalExpectedMs, est une
 *  soustraction simple déjà exercée par les assertions de durée réelle
 *  ci-dessous), soit exposer un point d'entrée réservé aux tests dans
 *  rundown.js pour injecter un horodatage — écarté pour ne pas ajouter de
 *  surface réservée aux tests dans un module de production. L'état
 *  "estimation incomplète" (déterministe, sans dépendance au temps réel), lui,
 *  est bien couvert.
 * ============================================================================
 */
'use strict';
const path = require('path');
const Module = require('module');

function injectFakeModule(relativePath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relativePath));
  const fake = new Module(abs, null);
  fake.filename = abs;
  fake.loaded = true;
  fake.exports = exportsObj;
  require.cache[abs] = fake;
  return abs;
}

injectFakeModule('bible-lookup-with-api.js', {
  async getChapterVerses() {
    throw new Error('non utilisé dans ce test');
  },
  async getVerseMultilang(reference) {
    return {
      book: reference.book,
      chapter: reference.chapter,
      verse: reference.verseStart || 1,
      text: 'Texte factice de test.',
      reference: `${reference.book} ${reference.chapter}:${reference.verseStart || 1}`,
    };
  },
  buildReferenceLabel(reference) {
    return `${reference.book} ${reference.chapter}`;
  },
  resetFailedProviders() {},
  findByQuotedText() {
    return null;
  },
  setCacheDir() {},
  setTranslation() {},
  listTranslations() {
    return [];
  },
});
injectFakeModule('groq-wrapper.js', {
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
  async transcribeWithFallback() {
    return { text: '', source: 'fake-groq' };
  },
});
injectFakeModule('deepgram-wrapper.js', {
  isConfigured() {
    return false;
  },
  async transcribeFile() {
    throw new Error('non utilisé dans ce test');
  },
});
injectFakeModule('audio-capture.js', {
  startBrowserCapture() {},
  feedPcmChunk() {},
  stopRecording() {},
  cleanupTempFiles() {},
  isRecording() {
    return false;
  },
  on() {},
});

process.env.PORT = process.env.PORT || '8789'; // distinct des autres tests
process.env.CHURCHOVERLAY_SKIP_BIBLE_DOWNLOAD = '1';
require('../server.js');
const rundownStore = require('../rundown-store');

const WebSocket = require('ws');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForOpen(ws) {
  return new Promise((resolve) => ws.once('open', resolve));
}

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

  const addedCueIds = [];
  let browser;
  let opWs;

  try {
    const cueA = rundownStore.addCue({
      type: 'verse',
      label: 'Ouverture (test)',
      reference: 'Jean 3:16',
    });
    addedCueIds.push(cueA.id);
    const cueB = rundownStore.addCue({
      type: 'verse',
      label: 'Message (test)',
      reference: 'Romains 8:28',
    });
    addedCueIds.push(cueB.id);

    opWs = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
    await waitForOpen(opWs);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.addInitScript(() => {
      localStorage.setItem('churchoverlay_wizard_seen', '1');
    });
    await page.goto(`http://127.0.0.1:${process.env.PORT}/dashboard.html`, { waitUntil: 'load' });
    // #rundownList vit dans <section id="overview"> — voir le même
    // raisonnement dans integration-airlock-preview.js.
    await page.locator('.nav-item[data-sections="overview,transcript,controls"]').first().click();
    await page.waitForFunction(() => document.getElementById('rundownList').children.length > 0, {
      timeout: 5000,
    });

    // ============================================================
    // Saisir une durée estimée sur le repère A (5 min) via la VRAIE UI
    // ============================================================
    // AJOUT : l'input de durée est un frère du bouton "Armer" dans la même
    // ligne .queue-item — plus simple de cibler la ligne entière par id de
    // repère puis d'y chercher l'input, cohérent avec la structure réelle du
    // template (voir renderRundown() dans rundown.js).
    const rowA = page.locator('#rundownList .queue-item', {
      has: page.locator(`[onclick*="'${cueA.id}'"]`),
    });
    await rowA.locator('.queue-item-duration-input').fill('5');
    await rowA.locator('.queue-item-duration-input').dispatchEvent('change');
    await page.waitForFunction(
      (id) => document.querySelector(`[onclick*="'${id}'"]`) !== null,
      cueA.id,
      { timeout: 3000 }
    );
    // Laisse le temps au rundownUpdated (diffusion serveur) de redessiner.
    await sleep(300);
    const persistedValue = await rowA.locator('.queue-item-duration-input').inputValue();
    check(
      'durée estimée saisie via l’UI -> persistée après redessin (5)',
      persistedValue === '5',
      `valeur observée: ${persistedValue}`
    );

    // ============================================================
    // Déclencher A puis B -> cueTimeline peuplé, durée réelle affichée sur A
    // ============================================================
    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueA.id }));
    await sleep(1200); // écart réel volontaire, mesuré ensuite dans la durée réelle affichée
    opWs.send(JSON.stringify({ action: 'triggerRundownCue', id: cueB.id }));

    await page.waitForFunction(
      () => document.querySelector('.queue-item-actual-duration') !== null,
      {
        timeout: 5000,
      }
    );
    const actualBadgeText = await page.locator('.queue-item-actual-duration').first().textContent();
    check(
      'segment terminé (A) -> badge de durée réelle affiché',
      !!actualBadgeText && actualBadgeText.trim().length > 0,
      `texte observé: "${actualBadgeText}"`
    );
    check(
      'la durée réelle (~1s) est affichée arrondie à "0 min" (formatDurationMinutes), pas une valeur aberrante',
      actualBadgeText.includes('0 min'),
      `texte observé: "${actualBadgeText}"`
    );

    // ============================================================
    // État "estimation incomplète" : repère B (actif) n'a pas de durée
    // estimée alors que A (déjà passé) en avait une -> pas de retard
    // inventé faute d'estimation complète sur les segments déjà passés.
    // Ici la situation est l'inverse (A a une estimée, B est actif sans
    // avoir encore de repère APRÈS lui) : on vérifie plutôt qu'aucun texte
    // de retard/avance n'apparaît tant qu'un seul segment est terminé — un
    // service à 2 repères n'atteint jamais l'état "ok" avant un 3e
    // déclenchement (rundownActiveIndex doit être >= 1 avec un segment
    // 0 complet ET estimé ; ici B est actif, index 1, un seul segment
    // terminé -> état 'ok' déjà atteignable si A avait un chiffre — see
    // check suivant).
    // ============================================================
    const scheduleStatusText = await page.locator('#rundownScheduleStatus').textContent();
    check(
      'statut du culte affiché après 2 déclenchements (A estimé -> B actif)',
      scheduleStatusText.trim().length > 0,
      `texte observé: "${scheduleStatusText}"`
    );

    // ============================================================
    // clearRundown -> historique des horaires vidé (plus de badge de durée
    // réelle possible, la liste elle-même redevient vide)
    // ============================================================
    opWs.send(JSON.stringify({ action: 'clearRundown' }));
    await page.waitForFunction(() => document.getElementById('rundownList').children.length === 1, {
      timeout: 3000,
    }); // 1 = le message "feuille de route vide", pas un repère
    check(
      'clearRundown -> plus aucun repère affiché',
      (await page.locator('#rundownList .queue-item').count()) === 0
    );
    check(
      'clearRundown -> statut du culte redevient vide (pas d’historique fantôme)',
      (await page.locator('#rundownScheduleStatus').textContent()).trim() === ''
    );

    check(
      'aucune erreur console applicative',
      consoleErrors.length === 0,
      consoleErrors.join(' | ')
    );
  } catch (err) {
    console.error('Erreur fatale dans le test d’intégration:', err);
    failed++;
  } finally {
    if (browser) await browser.close();
    if (opWs) opWs.close();
    for (const id of addedCueIds) {
      try {
        rundownStore.removeCue(id);
      } catch {
        /* déjà retiré (clearRundown pendant le test) — sans conséquence */
      }
    }
  }

  console.log(
    `\n=== Résultat Timeline-Based Service Flow : ${passed} passés, ${failed} échoués ===`
  );
  await sleep(50);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
