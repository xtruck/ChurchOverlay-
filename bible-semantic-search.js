/**
 * ============================================================================
 * bible-semantic-search.js — Semantic/Vector Search for Bible Verses
 * ============================================================================
 * Find Bible verses by TOPIC or DESCRIPTION, not just reference.
 * 
 * Uses a pre-computed embedding index (no API calls at runtime).
 * Index is ~15MB for all 31,000 verses, loads once at startup.
 * 
 * Features:
 *   - "What does the Bible say about forgiveness?" → finds relevant verses
 *   - "Passage about the prodigal son" → Luke 15:11-32
 *   - Offline-capable once index is downloaded
 * 
 * Integration: Add "search" action to WebSocket API, or use in semantic detector.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------
const CONFIG = {
  // Pre-computed embedding index URL (hosted on GitHub Releases or your CDN)
  INDEX_URL: 'https://github.com/xtruck/xtruck/releases/download/semantic-index/bible-semantic-index.json',
  // Local cache path
  INDEX_PATH: path.join(require('os').homedir(), '.churchoverlay', 'bible-semantic-index.json'),
  // Vector dimensions (using lightweight sentence embeddings)
  VECTOR_DIM: 384,
  // Top-K results to return
  TOP_K: 5,
  // Similarity threshold (cosine similarity)
  MIN_SIMILARITY: 0.55,
};

// -----------------------------------------------------------------------
// Simple in-memory vector operations (no external ML libraries needed)
// -----------------------------------------------------------------------
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v) {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

function cosineSimilarity(a, b) {
  return dotProduct(a, b) / (magnitude(a) * magnitude(b));
}

// -----------------------------------------------------------------------
// Keyword-based fallback (works without index, always available)
// -----------------------------------------------------------------------
const TOPIC_INDEX = {
  'love': ['Jean 3:16', '1 Corinthiens 13:4-8', 'Romains 5:8', '1 Jean 4:8', 'Jean 15:13'],
  'amour': ['Jean 3:16', '1 Corinthiens 13:4-8', 'Romains 5:8', '1 Jean 4:8', 'Jean 15:13'],
  'faith': ['Hébreux 11:1', 'Romains 10:17', 'Éphésiens 2:8', 'Marc 11:24', 'Jacques 2:17'],
  'foi': ['Hébreux 11:1', 'Romains 10:17', 'Éphésiens 2:8', 'Marc 11:24', 'Jacques 2:17'],
  'forgiveness': ['Éphésiens 4:32', 'Colossiens 3:13', 'Matthieu 6:14', '1 Jean 1:9', 'Psaume 103:12'],
  'pardon': ['Éphésiens 4:32', 'Colossiens 3:13', 'Matthieu 6:14', '1 Jean 1:9', 'Psaume 103:12'],
  'grace': ['Éphésiens 2:8', 'Romains 3:24', 'Tite 2:11', '2 Corinthiens 12:9', 'Jean 1:16'],
  'grâce': ['Éphésiens 2:8', 'Romains 3:24', 'Tite 2:11', '2 Corinthiens 12:9', 'Jean 1:16'],
  'peace': ['Philippiens 4:7', 'Jean 14:27', 'Romains 5:1', 'Colossiens 3:15', 'Ésaïe 26:3'],
  'paix': ['Philippiens 4:7', 'Jean 14:27', 'Romains 5:1', 'Colossiens 3:15', 'Ésaïe 26:3'],
  'hope': ['Romains 15:13', 'Jérémie 29:11', 'Hébreux 6:19', 'Romains 8:24', 'Psaume 39:7'],
  'espoir': ['Romains 15:13', 'Jérémie 29:11', 'Hébreux 6:19', 'Romains 8:24', 'Psaume 39:7'],
  'strength': ['Ésaïe 40:31', 'Philippiens 4:13', 'Ésaïe 41:10', 'Psaume 46:1', '2 Corinthiens 12:9'],
  'force': ['Ésaïe 40:31', 'Philippiens 4:13', 'Ésaïe 41:10', 'Psaume 46:1', '2 Corinthiens 12:9'],
  'healing': ['Ésaïe 53:5', 'Jacques 5:15', '1 Pierre 2:24', 'Psaume 103:3', 'Marc 16:18'],
  'guérison': ['Ésaïe 53:5', 'Jacques 5:15', '1 Pierre 2:24', 'Psaume 103:3', 'Marc 16:18'],
  'salvation': ['Romains 10:9', 'Actes 4:12', 'Jean 3:16', 'Éphésiens 2:8', 'Tite 3:5'],
  'salut': ['Romains 10:9', 'Actes 4:12', 'Jean 3:16', 'Éphésiens 2:8', 'Tite 3:5'],
  'prayer': ['Philippiens 4:6', 'Matthieu 7:7', '1 Thessaloniciens 5:17', 'Jacques 5:16', 'Marc 11:24'],
  'prière': ['Philippiens 4:6', 'Matthieu 7:7', '1 Thessaloniciens 5:17', 'Jacques 5:16', 'Marc 11:24'],
  'wisdom': ['Proverbes 3:5-6', 'Jacques 1:5', 'Proverbes 9:10', 'Éphésiens 5:15-16', 'Colossiens 3:16'],
  'sagesse': ['Proverbes 3:5-6', 'Jacques 1:5', 'Proverbes 9:10', 'Éphésiens 5:15-16', 'Colossiens 3:16'],
  'fear': ['2 Timothée 1:7', '1 Jean 4:18', 'Psaume 23:4', 'Ésaïe 41:10', 'Psaume 27:1'],
  'peur': ['2 Timothée 1:7', '1 Jean 4:18', 'Psaume 23:4', 'Ésaïe 41:10', 'Psaume 27:1'],
  'joy': ['Psaume 16:11', 'Jean 15:11', 'Romains 15:13', 'Galates 5:22', 'Philippiens 4:4'],
  'joie': ['Psaume 16:11', 'Jean 15:11', 'Romains 15:13', 'Galates 5:22', 'Philippiens 4:4'],
  'patience': ['Romains 12:12', 'Galates 6:9', 'Jacques 1:4', 'Psaume 37:7', 'Proverbes 14:29'],
  'humility': ['Philippiens 2:3', 'Jacques 4:10', '1 Pierre 5:6', 'Matthieu 23:12', 'Proverbes 22:4'],
  'humilité': ['Philippiens 2:3', 'Jacques 4:10', '1 Pierre 5:6', 'Matthieu 23:12', 'Proverbes 22:4'],
  'temptation': ['1 Corinthiens 10:13', 'Jacques 1:12-15', 'Matthieu 26:41', 'Hébreux 2:18', '2 Pierre 2:9'],
  'tentation': ['1 Corinthiens 10:13', 'Jacques 1:12-15', 'Matthieu 26:41', 'Hébreux 2:18', '2 Pierre 2:9'],
  'anxiety': ['Philippiens 4:6-7', '1 Pierre 5:7', 'Matthieu 6:34', 'Psaume 55:22', 'Jean 14:27'],
  'anxiété': ['Philippiens 4:6-7', '1 Pierre 5:7', 'Matthieu 6:34', 'Psaume 55:22', 'Jean 14:27'],
  'depression': ['Psaume 34:18', 'Psaume 42:11', 'Matthieu 11:28', 'Ésaïe 41:10', '2 Corinthiens 1:3-4'],
  'dépression': ['Psaume 34:18', 'Psaume 42:11', 'Matthieu 11:28', 'Ésaïe 41:10', '2 Corinthiens 1:3-4'],
  'marriage': ['Éphésiens 5:25', 'Proverbes 18:22', '1 Corinthiens 13:4-8', 'Genèse 2:24', 'Colossiens 3:18-19'],
  'mariage': ['Éphésiens 5:25', 'Proverbes 18:22', '1 Corinthiens 13:4-8', 'Genèse 2:24', 'Colossiens 3:18-19'],
  'money': ['Matthieu 6:24', '1 Timothée 6:10', 'Proverbes 3:9', 'Malachie 3:10', 'Luc 16:13'],
  'argent': ['Matthieu 6:24', '1 Timothée 6:10', 'Proverbes 3:9', 'Malachie 3:10', 'Luc 16:13'],
  'work': ['Colossiens 3:23', 'Proverbes 16:3', 'Éphésiens 6:7', '1 Corinthiens 10:31', 'Psaume 90:17'],
  'travail': ['Colossiens 3:23', 'Proverbes 16:3', 'Éphésiens 6:7', '1 Corinthiens 10:31', 'Psaume 90:17'],
  'children': ['Proverbes 22:6', 'Éphésiens 6:4', 'Psaume 127:3', 'Deutéronome 6:6-7', 'Marc 10:14'],
  'enfants': ['Proverbes 22:6', 'Éphésiens 6:4', 'Psaume 127:3', 'Deutéronome 6:6-7', 'Marc 10:14'],
  'death': ['Jean 11:25', 'Psaume 23:4', '1 Corinthiens 15:55', 'Apocalypse 21:4', 'Romains 6:23'],
  'mort': ['Jean 11:25', 'Psaume 23:4', '1 Corinthiens 15:55', 'Apocalypse 21:4', 'Romains 6:23'],
  'holy spirit': ['Jean 14:26', 'Actes 1:8', 'Galates 5:22-23', 'Romains 8:26', '1 Corinthiens 2:10-11'],
  'esprit saint': ['Jean 14:26', 'Actes 1:8', 'Galates 5:22-23', 'Romains 8:26', '1 Corinthiens 2:10-11'],
  'baptism': ['Matthieu 28:19', 'Actes 2:38', 'Romains 6:4', 'Colossiens 2:12', '1 Pierre 3:21'],
  'baptême': ['Matthieu 28:19', 'Actes 2:38', 'Romains 6:4', 'Colossiens 2:12', '1 Pierre 3:21'],
  'communion': ['Luc 22:19', '1 Corinthiens 11:24-25', 'Jean 6:53-58', 'Actes 2:42', '1 Corinthiens 10:16'],
  'repentance': ['Actes 3:19', 'Luc 13:3', '2 Pierre 3:9', 'Matthieu 4:17', 'Ézéchiel 18:30'],
  'repentir': ['Actes 3:19', 'Luc 13:3', '2 Pierre 3:9', 'Matthieu 4:17', 'Ézéchiel 18:30'],
  'eternal life': ['Jean 3:16', 'Jean 10:28', 'Romains 6:23', '1 Jean 5:11', 'Jean 17:3'],
  'vie éternelle': ['Jean 3:16', 'Jean 10:28', 'Romains 6:23', '1 Jean 5:11', 'Jean 17:3'],
  'prodigal son': ['Luc 15:11-32'],
  'fils prodigue': ['Luc 15:11-32'],
  'good samaritan': ['Luc 10:25-37'],
  'bon samaritain': ['Luc 10:25-37'],
  'sermon on the mount': ['Matthieu 5-7'],
  'sermon sur la montagne': ['Matthieu 5-7'],
  'lords prayer': ['Matthieu 6:9-13', 'Luc 11:2-4'],
  'notre père': ['Matthieu 6:9-13', 'Luc 11:2-4'],
  'ten commandments': ['Exode 20:1-17', 'Deutéronome 5:6-21'],
  'dix commandements': ['Exode 20:1-17', 'Deutéronome 5:6-21'],
  'creation': ['Genèse 1:1', 'Jean 1:1-3', 'Colossiens 1:16', 'Psaume 19:1', 'Romains 1:20'],
  'création': ['Genèse 1:1', 'Jean 1:1-3', 'Colossiens 1:16', 'Psaume 19:1', 'Romains 1:20'],
  'second coming': ['Jean 14:3', 'Actes 1:11', '1 Thessaloniciens 4:16-17', 'Apocalypse 22:20', 'Matthieu 24:30'],
  'retour de jésus': ['Jean 14:3', 'Actes 1:11', '1 Thessaloniciens 4:16-17', 'Apocalypse 22:20', 'Matthieu 24:30'],
  'resurrection': ['1 Corinthiens 15:3-4', 'Luc 24:6', 'Romains 6:5', '1 Pierre 1:3', 'Apocalypse 1:18'],
  'résurrection': ['1 Corinthiens 15:3-4', 'Luc 24:6', 'Romains 6:5', '1 Pierre 1:3', 'Apocalypse 1:18'],
  'cross': ['Galates 2:20', 'Philippiens 2:8', '1 Pierre 2:24', 'Colossiens 2:14', 'Jean 19:17'],
  'croix': ['Galates 2:20', 'Philippiens 2:8', '1 Pierre 2:24', 'Colossiens 2:14', 'Jean 19:17'],
  'new birth': ['Jean 3:3', 'Jean 3:7', '1 Pierre 1:23', '2 Corinthiens 5:17', 'Tite 3:5'],
  'nouvelle naissance': ['Jean 3:3', 'Jean 3:7', '1 Pierre 1:23', '2 Corinthiens 5:17', 'Tite 3:5'],
};

// -----------------------------------------------------------------------
// Semantic Search Class
// -----------------------------------------------------------------------
class BibleSemanticSearch {
  constructor() {
    this.vectorIndex = null;
    this.loaded = false;
  }

  /**
   * Load the vector index (async, call once at startup)
   */
  async loadIndex() {
    // Try local cache first
    if (fs.existsSync(CONFIG.INDEX_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(CONFIG.INDEX_PATH, 'utf8'));
        this.vectorIndex = data;
        this.loaded = true;
        console.log('[semantic-search] Loaded local index:', data.verses?.length || 0, 'verses');
        return;
      } catch (err) {
        console.warn('[semantic-search] Failed to load local index:', err.message)<response clipped><NOTE>Result is longer than **10000 characters**, will be **truncated**.</NOTE>
