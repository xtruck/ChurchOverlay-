/**
 * dashboard/main.js — point d'entrée du tableau de bord (chargé via
 * <script type="module"> dans dashboard.html).
 *
 * legacy-core.js (l'ancien dashboard.js, encore en grande partie non
 * démantelé) importé en premier pour préserver l'ordre d'exécution relatif
 * de ce qu'il lui reste — les modules dashboard/features/*.js ci-dessous
 * sont chacun des IIFE auto-suffisantes (gardées par des vérifications DOM,
 * document déjà entièrement parsé au moment où un <script type="module">
 * s'exécute), donc leur ordre relatif entre elles n'a pas d'importance.
 */
import './legacy-core.js';
import './utils.js';
import './features/api-settings.js';
import './features/camera-panel.js';
import './features/ui-effects.js';
import './features/perf-pill.js';
import './features/companion-link.js';
// AJOUT (lot 6) : mood-theme.js/song-library.js/offline-bible.js sont déjà
// chargés indirectement (legacy-core.js les importe pour renderMoodPicker/
// setActiveMoodButton/renderSongLibrary/renderOfflineBibleStatus) — pas
// besoin de les lister ici aussi (un module ES ne s'évalue qu'une fois,
// peu importe par combien de chemins il est importé). verse-queue.js, lui,
// n'est importé par personne d'autre : sans cette ligne, son
// renderQueue() initial et ses window.x ne s'exécuteraient jamais.
import './features/verse-queue.js';
// AJOUT (lot 7) : preservice-ai.js est déjà chargé indirectement (legacy-core.js
// l'importe pour renderAiEnricherOutput/renderSessionStats/etc.).
// propresenter-planning-center.js, comme verse-queue.js, n'est importé par
// personne d'autre : sans cette ligne, ses appels loadProPresenterConfig()/
// loadPlanningCenterConfig() au chargement et ses window.x ne
// s'exécuteraient jamais.
import './features/propresenter-planning-center.js';
// AJOUT : obs-scenes.js, comme propresenter-planning-center.js et
// verse-queue.js, n'est importé par personne d'autre — sans cette ligne,
// son loadObsConfig() initial et ses window.x ne s'exécuteraient jamais.
import './features/obs-scenes.js';
