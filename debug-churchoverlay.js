#!/usr/bin/env node
/**
 * ============================================================================
 * debug-churchoverlay.js — Diagnostic & Compatibility Checker
 * ============================================================================
 * Run this in your repo root: node debug-churchoverlay.js
 * It checks:
 *   1. Syntax of all .js files
 *   2. Required exports from existing modules (detector, reading-mode, etc.)
 *   3. Missing dependencies
 *   4. File existence
 *   5. API compatibility between old and new code
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

let errors = 0;
let warnings = 0;

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); errors++; }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`); warnings++; }
function info(msg) { console.log(`${CYAN}ℹ${RESET} ${msg}`); }

console.log('\n' + '='.repeat(70));
console.log('  ChurchOverlay Diagnostic Tool');
console.log('='.repeat(70) + '\n');

// ── 1. Check Node version ──
const nodeVersion = process.version;
info(`Node.js version: ${nodeVersion}`);
const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
if (major < 18) {
  fail('Node.js 18+ required (worker_threads, fetch API)');
} else {
  ok('Node.js version OK');
}

// ── 2. Syntax check all .js files ──
console.log('\n--- Syntax Check ---');
const jsFiles = fs.readdirSync('.').filter(f => f.endsWith('.js'));
if (jsFiles.length === 0) {
  fail('No .js files found in current directory');
} else {
  for (const file of jsFiles.sort()) {
    try {
      // Check for obvious corruption markers
      const content = fs.readFileSync(file, 'utf8');
      const badMarkers = ['<response clipped>', '<NOTE>', 'Result is longer than'];
      const found = badMarkers.filter(m => content.includes(m));
      if (found.length > 0) {
        fail(`${file} contains corruption markers: ${found.join(', ')}`);
        continue;
      }

      // Node syntax check
      execSync(`node --check "${file}"`, { stdio: 'pipe' });
      ok(`${file} — syntax valid`);
    } catch (e) {
      fail(`${file} — SYNTAX ERROR`);
      const match = e.message.match(/SyntaxError: (.+)/);
      if (match) {
        console.log(`    ${RED}→${RESET} ${match[1]}`);
      }
      // Try to find the line
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const errMatch = e.message.match(/:(\d+)$/);
      if (errMatch) {
        const lineNum = parseInt(errMatch[1], 10);
        if (lines[lineNum - 1]) {
          console.log(`    ${RED}→${RESET} Line ${lineNum}: ${lines[lineNum - 1].trim().substring(0, 80)}`);
        }
      }
    }
  }
}

// ── 3. Check critical file existence ──
console.log('\n--- File Existence ---');
const requiredFiles = [
  'server.js', 'main.js', 'overlay.html', 'dashboard.html',
  'preload.js', 'setup.html', 'detector.js', 'bible-lookup-with-api.js',
  'reading-mode.js', 'audio-capture.js', 'groq-wrapper.js',
  'theme-loader.js', 'features-store.js', 'obs-controller.js',
  'perf-monitor.js', 'package.json'
];

const newFiles = [
  'semantic-detector.js', 'voice-commands.js', 'transcription-corrector.js',
  'bible-semantic-search.js', 'plugin-system.js', 'ai-theme-generator.js',
  'auto-updater.js'
];

for (const file of requiredFiles) {
  if (fs.existsSync(file)) {
    ok(`${file} exists`);
  } else {
    fail(`${file} MISSING — app will not start`);
  }
}

for (const file of newFiles) {
  if (fs.existsSync(file)) {
    ok(`${file} exists (AI pack)`);
  } else {
    warn(`${file} missing — AI feature disabled but app still works`);
  }
}

// ── 4. Check package.json dependencies ──
console.log('\n--- Dependencies ---');
try {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const required = ['ws', 'obs-websocket-js', 'form-data'];
  const optional = ['electron-updater'];

  for (const dep of required) {
    if (deps[dep]) ok(`${dep} installed (${deps[dep]})`);
    else fail(`${dep} MISSING — npm install required`);
  }

  for (const dep of optional) {
    if (deps[dep]) ok(`${dep} installed (${deps[dep]})`);
    else warn(`${dep} not installed — auto-updater disabled`);
  }
} catch (e) {
  fail('Cannot read package.json');
}

// ── 5. Check API compatibility (CRITICAL) ──
console.log('\n--- API Compatibility ---');

function checkExports(file, expectedExports) {
  if (!fs.existsSync(file)) {
    fail(`${file} not found — cannot check exports`);
    return;
  }

  try {
    // Clear require cache
    delete require.cache[require.resolve(path.resolve(file))];
    const mod = require(path.resolve(file));

    for (const exp of expectedExports) {
      if (mod[exp] !== undefined) {
        ok(`${file} exports "${exp}"`);
      } else {
        fail(`${file} MISSING export "${exp}" — my server.js will crash`);
      }
    }
  } catch (e) {
    fail(`${file} cannot be required: ${e.message}`);
  }
}

// These are what my server.js expects from YOUR existing files
checkExports('./detector.js', ['detectBilingual', 'parseReference']);
checkExports('./reading-mode.js', ['start', 'stop']);
checkExports('./theme-loader.js', ['listThemes', 'getActiveTheme', 'setActiveTheme', 'themeToCss', 'setUserDataDir']);
checkExports('./features-store.js', ['readFeatures', 'writeFeatures']);
checkExports('./obs-controller.js', ['connect', 'listScenes', 'switchScene', 'toggleRecording']);
checkExports('./bible-lookup-with-api.js', ['getVerseMultilang', 'setTranslation', 'listTranslations', 'setCacheDir', 'findByQuotedText', 'getChapterVerses']);
checkExports('./groq-wrapper.js', ['transcribeWithFallback']);
checkExports('./audio-capture.js', ['startBrowserCapture', 'feedPcmChunk', 'stopRecording', 'on', 'cleanupTempFiles']);

// Check new AI files
checkExports('./semantic-detector.js', ['SemanticDetector']);
checkExports('./voice-commands.js', ['detectCommand']);
checkExports('./transcription-corrector.js', ['TranscriptionCorrector']);
checkExports('./plugin-system.js', ['PluginSystem']);
checkExports('./ai-theme-generator.js', ['AIThemeGenerator']);

// ── 6. Check for common copy-paste corruption ──
console.log('\n--- Corruption Check ---');
const allJsFiles = [...requiredFiles.filter(f => f.endsWith('.js')), ...newFiles];
let corruptionFound = false;

for (const file of allJsFiles) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');

  // Check for chat truncation markers
  const markers = ['<response clipped>', '<NOTE>', 'Result is longer than', 'clipped', 'Unexpected identifier'];
  for (const marker of markers) {
    if (content.includes(marker)) {
      fail(`${file} contains chat truncation marker: "${marker}"`);
      corruptionFound = true;
    }
  }

  // Check for broken template literals
  const brokenTemplates = content.match(/`[^`]*<response[^`]*`/g);
  if (brokenTemplates) {
    fail(`${file} has broken template literal near: ${brokenTemplates[0].substring(0, 50)}`);
    corruptionFound = true;
  }
}

if (!corruptionFound) {
  ok('No chat truncation corruption detected');
}

// ── 7. Try to require server.js (the big test) ──
console.log('\n--- Server.js Load Test ---');
if (fs.existsSync('server.js')) {
  try {
    // We can't actually run it (it starts a WebSocket server), but we can parse it
    execSync('node --check server.js', { stdio: 'pipe' });
    ok('server.js parses successfully');
  } catch (e) {
    fail('server.js has syntax errors');
    console.log(`    ${RED}→${RESET} ${e.message}`);
  }
} else {
  fail('server.js not found');
}

// ── 8. Try to require main.js ──
console.log('\n--- Main.js Load Test ---');
if (fs.existsSync('main.js')) {
  try {
    execSync('node --check main.js', { stdio: 'pipe' });
    ok('main.js parses successfully');
  } catch (e) {
    fail('main.js has syntax errors');
    console.log(`    ${RED}→${RESET} ${e.message}`);
  }
} else {
  fail('main.js not found');
}

// ── Summary ──
console.log('\n' + '='.repeat(70));
console.log('  SUMMARY');
console.log('='.repeat(70));

if (errors === 0 && warnings === 0) {
  console.log(`${GREEN}✓ ALL CHECKS PASSED${RESET} — Your app should work!`);
} else {
  console.log(`${RED}${errors} error(s)${RESET}, ${YELLOW}${warnings} warning(s)${RESET}`);
  console.log('\nFix the RED errors first, then test with: npm start');
}

if (errors > 0) {
  process.exit(1);
}
